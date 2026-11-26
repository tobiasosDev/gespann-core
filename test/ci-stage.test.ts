import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { type CheckRun, Github, type OtherChecks, otherChecks } from "../src/server/github.ts";
import type { Sandboxes } from "../src/server/sandbox.ts";
import { judge } from "../src/verify/verdict.ts";
import { CI_GRACE_MS, CI_MAX_WAIT_MS, CI_POLL_MS, ciStep, processJob, report } from "../src/server/worker.ts";

const run = (name: string, status: string, conclusion: string | null = null, slug = "github-actions"): CheckRun => ({ name, status, conclusion, app: { slug } });

test("other checks: gespann's own check never counts; check runs and commit statuses sort into pending, failed and passed", () => {
  const c = otherChecks(
    [run("gespann/verify", "in_progress"), run("old name", "queued", null, "gespann-app"), run("check", "completed", "success"), run("lint", "in_progress"), run("e2e", "completed", "timed_out"), run("docs", "completed", "skipped")],
    [
      { context: "buildkite/acme/checks", state: "pending" },
      { context: "buildkite/acme/smoke", state: "error" },
      { context: "gespann/verify", state: "pending" },
      { context: "gespann-integration", state: "failure" },
    ],
    "gespann-app",
  );
  assert.deepEqual(c, { pending: ["lint", "buildkite/acme/checks"], failed: ["e2e", "buildkite/acme/smoke", "gespann-integration"], passed: ["check", "docs"], statuses: true });
  assert.equal(otherChecks([], null).statuses, false);
});

const none: OtherChecks = { pending: [], failed: [], passed: [], statuses: true };

test("ci stage: a red check skips, a running one waits, green goes; no checks get a minute to appear; a stuck check stops holding after an hour", () => {
  assert.deepEqual(ciStep({ ...none, failed: ["check"], pending: ["e2e"] }, 0), { kind: "skip", reason: "the PR's other checks failed first (check); gespann tests once they pass" });
  assert.deepEqual(ciStep({ ...none, pending: ["check"] }, 5 * 60_000), { kind: "wait", ms: CI_POLL_MS, line: "waiting for the PR's other checks: check" });
  assert.deepEqual(ciStep({ ...none, passed: ["check"] }, 0), { kind: "go" });
  assert.deepEqual(ciStep(none, 20_000), { kind: "wait", ms: CI_GRACE_MS - 20_000, line: "no other checks yet: waiting a minute for CI to report" });
  assert.deepEqual(ciStep(none, CI_GRACE_MS), { kind: "go" });
  const late = ciStep({ ...none, pending: ["a", "b", "c", "d", "e", "f", "g"] }, CI_MAX_WAIT_MS);
  assert.equal(late.kind, "go");
  assert.match(late.kind === "go" ? (late.note ?? "") : "", /still run after 60 min \(a, b, c, d, e and 2 more\): testing anyway/);
});

/** Any sandbox call is a failure here: the CI stage decides before a sandbox is touched. */
function noSandboxes(calls: string[]): Sandboxes {
  return new Proxy({} as Sandboxes, {
    get: (_t, key) => (key === "kind" ? "docker" : () => (calls.push(String(key)), Promise.reject(new Error(`sandbox ${String(key)} called`)))),
  });
}

function setup(checks: OtherChecks | Error) {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-ci-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "fresh", setup: "ready", recipe: "version: 1", active: 1 });
  const id = db.createRun({ project_id: p, pr: 4, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  db.updateRun(id, { check_run_id: 11 });
  const updates: { status?: string; conclusion?: string; title?: string }[] = [];
  const github = {
    pull: async () => ({ number: 4, state: "open", draft: false, head: { sha: "h" }, labels: [] }),
    otherChecks: async () => {
      if (checks instanceof Error) throw checks;
      return checks;
    },
    updateCheck: async (_i: number, _r: string, _id: number, f: { status?: string; conclusion?: string; title?: string }) => void updates.push(f),
  } as unknown as Github;
  const calls: string[] = [];
  const job = db.job(db.enqueue(p, "run", id))!;
  db.claimJob(job.id);
  return { db, deps: { db, sandboxes: noSandboxes(calls), github: () => github, config }, job, id, updates, calls };
}

test("worker: a run waiting for CI leaves the neutral check of a head a person approved", async () => {
  const t = setup({ ...none, pending: ["check"] });
  t.db.setHold(1, 4, { approved_by: "tobi", approved_head: "h" });
  await processJob(t.deps, t.job);
  assert.equal(t.db.job(t.job.id)?.status, "queued", "it still waits to test");
  assert.deepEqual(t.updates, [], "no queued check over the approval");
});

test("worker: a run whose PR still runs its other checks goes back into the queue without a sandbox, and the wait is no sandbox time", async () => {
  const t = setup({ ...none, pending: ["check"] });
  await processJob(t.deps, t.job);
  const job = t.db.job(t.job.id)!;
  assert.equal(job.status, "queued");
  assert.equal(job.started, null);
  assert.ok(job.not_before && Date.parse(job.not_before) > Date.now(), "waits before it is taken again");
  assert.equal(t.db.nextJob(), undefined, "the queue skips it until then");
  assert.deepEqual(t.db.queuedJobs(1), { sandbox: 0, checks: 1 }, "Settings says it waits for CI, not for a sandbox");
  assert.deepEqual([...t.db.runsWaitingForChecks(1)], [t.id], "the Runs list says so too");
  assert.equal(t.db.run_(t.id)?.status, "queued");
  assert.deepEqual(t.updates, [{ status: "queued", title: "Waiting for the other checks", summary: "gespann tests this PR once its other checks pass. Waiting for the PR's other checks: check." }]);
  assert.match(job.log, /waiting for the PR's other checks: check/);
  assert.deepEqual(t.calls, []);
  // The same wait again adds no log line and no check update.
  t.db.claimJob(job.id);
  await processJob(t.deps, t.db.job(job.id)!);
  assert.equal(t.db.job(job.id)?.log.match(/waiting for/g)?.length, 1);
  assert.equal(t.updates.length, 1);
});

test("worker: a run whose PR failed its other checks ends as SKIP without a sandbox, and its check says why", async () => {
  const t = setup({ ...none, failed: ["check"] });
  await processJob(t.deps, t.job);
  assert.equal(t.db.job(t.job.id)?.status, "done");
  const r = t.db.run_(t.id)!;
  assert.equal(r.status, "done");
  assert.equal(r.outcome, "SKIP");
  assert.equal(r.error, "the PR's other checks failed first (check); gespann tests once they pass");
  assert.equal(t.updates.at(-1)?.conclusion, "skipped");
  assert.equal(t.updates.at(-1)?.title, "Skipped: other checks failed first");
  assert.deepEqual(t.calls, []);
  assert.equal(t.db.job(t.job.id)?.started, null, "a job that never had a sandbox adds no sandbox time");
  assert.deepEqual([t.db.boxTime(1).jobs, t.db.boxTime(1).monthSeconds], [0, 0]);
});

test("worker: when GitHub does not answer about the other checks, the run waits and asks again instead of starting", async () => {
  const t = setup(new Error("GitHub 502: bad gateway"));
  await processJob(t.deps, t.job);
  assert.equal(t.db.job(t.job.id)?.status, "queued");
  assert.match(t.db.job(t.job.id)?.log ?? "", /could not read the PR's other checks \(GitHub 502: bad gateway\): trying again/);
  assert.deepEqual(t.calls, []);
});

test("worker: a run whose other checks passed takes a sandbox", async () => {
  const t = setup({ ...none, passed: ["check"] });
  await processJob(t.deps, t.job);
  assert.ok(t.calls.length > 0, "the run went on to the sandbox");
  assert.notEqual(t.db.run_(t.id)?.outcome, "SKIP");
});

test("github: a source GitHub refuses for good (404) counts as none; a 502 throws so the run asks again", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let statusCode = 404;
  const fetchImpl = (async (url: string) => {
    const path = new URL(url).pathname;
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (path.endsWith("/access_tokens")) return json({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path.endsWith("/check-runs")) return json({ message: "x" }, statusCode);
    if (path.endsWith("/status")) return json({ statuses: [{ context: "buildkite/acme", state: "success" }] });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  const gh = new Github({ appId: "1", slug: "s", privateKey: key, webhookSecret: "w", clientId: "c", clientSecret: "s" }, fetchImpl);
  assert.deepEqual(await gh.otherChecks(9, "acme/shop", "h"), { pending: [], failed: [], passed: ["buildkite/acme"], statuses: true });
  statusCode = 502;
  await assert.rejects(gh.otherChecks(9, "acme/shop", "h"), /GitHub 502/);
});

test("worker: a merge gate switched off while the test runs makes its FAIL neutral, and switched on makes it fail", async () => {
  const judged = judge(JSON.stringify({ verdict: "FAIL", summary: "The total is wrong.", checks: [{ expect: "Total is 10", observed: "Total is 9", result: "fail", proof: ["a.png"] }], proof: ["a.png"] }), () => true);
  for (const [atStart, atEnd, conclusion] of [[1, 0, "neutral"], [0, 1, "failure"]] as const) {
    const t = setup({ ...none, passed: ["check"] });
    t.db.updateProject(1, { gate: atStart });
    const started = t.db.project(1)!;
    t.db.updateProject(1, { gate: atEnd });
    await report(t.deps, started, { ...t.db.run_(t.id)!, status: "done", outcome: "FAIL" }, judged, ["a.png"], () => undefined);
    assert.equal(t.updates.at(-1)?.conclusion, conclusion, `gate ${atStart} at the start, ${atEnd} at the end`);
  }
});
