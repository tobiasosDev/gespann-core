import assert from "node:assert/strict";
import { test } from "node:test";
import { counts, groupByPr, type RunLike, usualSeconds } from "../web/src/runs.ts";
import { Db } from "../src/server/db.ts";
import type { Github } from "../src/server/github.ts";
import { syncClosedPrs } from "../src/server/pulls.ts";

let id = 100;
function run(pr: number, status: RunLike["status"], outcome: RunLike["outcome"] = null, minutes = 5): RunLike {
  const started = "2026-11-25T10:00:00Z";
  const finished = status === "done" || status === "failed" ? new Date(Date.parse(started) + minutes * 60_000).toISOString() : null;
  return { id: id--, pr, title: `PR ${pr}`, status, outcome, started, finished };
}

test("runs fold into one row per PR, ordered by each PR's newest run, with the newest run deciding the section", () => {
  // Newest first, as the API sends them.
  const runs = [
    run(9, "running"),
    run(8, "done", "PASS"),
    run(5, "done", "PASS"),
    run(5, "done", "PASS"),
    run(14, "failed"),
    run(5, "done", "FAIL"),
    run(14, "done", "PASS"),
    run(13, "done", "BLOCKED"),
    run(2, "cancelled"),
    run(3, "cancelled"),
    run(3, "done", "SKIP"),
  ];
  const g = groupByPr(runs);
  assert.deepEqual(
    g.map((x) => [x.pr, x.state, x.runs.length]),
    [
      [9, "running", 1],
      [8, "passing", 1],
      [5, "passing", 3],
      [14, "error", 2],
      [13, "attention", 1],
      [2, "cancelled", 1],
      [3, "passing", 2],
    ],
  );
  assert.equal(g.find((x) => x.pr === 3)?.latest.status, "done", "a cancelled run does not hide the verdict before it");
  assert.equal(g.find((x) => x.pr === 5)?.latest, runs[2], "the row opens the PR's newest run");
});

test("the usual length is the median of passed runs, and the counts add up", () => {
  const runs = [run(1, "done", "PASS", 4), run(2, "done", "PASS", 10), run(3, "done", "FAIL", 1), run(4, "done", "PASS", 6), run(5, "running")];
  assert.equal(usualSeconds(runs), 6 * 60);
  assert.equal(usualSeconds(runs.slice(0, 2)), null, "two passed runs are too few to say what is usual");
  const c = counts(runs);
  assert.deepEqual([c.pass, c.fail, c.running], [3, 1, 1]);
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), runs.length);
});

test("a run with merge conflicts is grey: its own section and count, never a FAIL", () => {
  const conflicted = { ...run(21, "done"), conflict: '["web/src/pages/Project.tsx"]' };
  const runs = [conflicted, run(21, "done", "PASS"), run(22, "done", "FAIL")];
  assert.deepEqual(
    groupByPr(runs).map((x) => [x.pr, x.state]),
    [
      [21, "conflict"],
      [22, "attention"],
    ],
  );
  const c = counts(runs);
  assert.deepEqual([c.conflict, c.fail, c.pass], [1, 1, 1]);
});

test("a merged or closed PR leaves Needs a look whatever its last run said, unless a run of it still runs", () => {
  const runs = [run(31, "cancelled"), run(31, "done", "FAIL"), run(32, "done", "BLOCKED"), run(33, "running"), run(33, "done", "FAIL"), run(34, "done", "FAIL")];
  const g = groupByPr(runs, [
    { pr: 31, merged: true },
    { pr: 32, merged: false },
    { pr: 33, merged: true },
  ]);
  assert.deepEqual(
    g.map((x) => [x.pr, x.state, x.closed ?? null]),
    [
      [31, "closed", "merged"],
      [32, "closed", "closed"],
      [33, "running", "merged"],
      [34, "attention", null],
    ],
  );
});

test("a run gespann broke off is an error, not the PR's FAIL", () => {
  const broken = { ...run(41, "failed"), outcome: "FAIL" as const };
  const g = groupByPr([broken, run(42, "done", "FAIL")]);
  assert.deepEqual(
    g.map((x) => [x.pr, x.state]),
    [
      [41, "error"],
      [42, "attention"],
    ],
  );
  assert.deepEqual([counts([broken]).error, counts([broken]).fail], [1, 0]);
});

test("the sync marks PRs merged or closed before gespann stored it, and asks only about the open ones", async () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  for (const pr of [1, 1, 2, 3]) db.createRun({ project_id: p, pr, title: "t", head: "h", base: "b", base_ref: "main", token: `${pr}${Math.random()}` });
  const state: Record<number, { state: string; merged: boolean; closed_at: string | null }> = {
    1: { state: "closed", merged: true, closed_at: "2026-11-26T08:00:00Z" },
    2: { state: "closed", merged: false, closed_at: "2026-11-26T08:00:00Z" },
    3: { state: "open", merged: false, closed_at: null },
  };
  const asked: number[] = [];
  const github = { pull: async (_i: number, _r: string, pr: number) => (asked.push(pr), { number: pr, ...state[pr] }) } as unknown as Github;
  assert.equal(await syncClosedPrs({ db, github: () => github }), 2);
  assert.deepEqual(asked, [1, 2, 3], "one call per PR, not per run");
  assert.deepEqual(db.closedPrs(p), [
    { pr: 1, merged: true },
    { pr: 2, merged: false },
  ]);
  asked.length = 0;
  await syncClosedPrs({ db, github: () => github });
  assert.deepEqual(asked, [3], "PRs already marked closed are not asked about again");
});
