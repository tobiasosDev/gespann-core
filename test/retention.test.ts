import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { Github } from "../src/server/github.ts";
import { sweepMedia } from "../src/server/retention.ts";

const DAY = 86_400_000;

test("screenshots and recordings go 10 days after the PR closed; verdicts, open and reopened PRs stay", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gespann-retention-"));
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  const t = Date.parse("2026-11-26T12:00:00Z");
  const run = (pr: number, status: "done" | "running" = "done") => {
    const id = db.createRun({ project_id: p, pr, title: "t", head: "h", base: "b", base_ref: "main", token: String(pr).padStart(32, "0") + String(Math.random()).slice(2, 4) });
    const files = ["recording.mp4", "a.png", "verdict.json"];
    mkdirSync(join(dataDir, "runs", String(id)), { recursive: true });
    for (const f of files) writeFileSync(join(dataDir, "runs", String(id), f), "x");
    db.updateRun(id, { status, files: JSON.stringify(files) });
    return id;
  };
  // PR 1 closed 11 days ago (two runs), PR 2 closed 9 days ago, PR 3 open, PR 4 reopened after an old close.
  const old1 = run(1);
  const old2 = run(1);
  const recent = run(2);
  const open = run(3);
  const reopened = run(4);
  const closed: Record<number, { state: string; closed_at: string | null }> = {
    1: { state: "closed", closed_at: new Date(t - 11 * DAY).toISOString() },
    2: { state: "closed", closed_at: new Date(t - 9 * DAY).toISOString() },
    3: { state: "open", closed_at: null },
    4: { state: "open", closed_at: new Date(t - 30 * DAY).toISOString() },
  };
  const asked: number[] = [];
  const github = { pull: async (_i: number, _r: string, pr: number) => (asked.push(pr), { number: pr, ...closed[pr] }) } as unknown as Github;

  const deps = { db, github: () => github, dataDir, days: 10, now: () => t };
  assert.deepEqual(await sweepMedia(deps), [old1, old2]);
  assert.deepEqual(asked, [1, 2, 3, 4], "one GitHub call per PR, not per run");
  for (const id of [old1, old2]) {
    assert.deepEqual(JSON.parse(db.run_(id)!.files), ["verdict.json"]);
    assert.ok(db.run_(id)!.media_cleared);
    assert.deepEqual(readdirSync(join(dataDir, "runs", String(id))), ["verdict.json"]);
  }
  for (const id of [recent, open, reopened]) {
    assert.equal(db.run_(id)!.media_cleared, null);
    assert.ok(existsSync(join(dataDir, "runs", String(id), "recording.mp4")));
  }

  // Two days later PR 2 is past the limit; cleared runs are not asked about again.
  asked.length = 0;
  assert.deepEqual(await sweepMedia({ ...deps, now: () => t + 2 * DAY }), [recent]);
  assert.deepEqual(asked, [2, 3, 4]);
});

test("a PR GitHub cannot answer for keeps its media", async () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  const id = db.createRun({ project_id: p, pr: 1, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  db.updateRun(id, { status: "done", files: JSON.stringify(["recording.mp4"]) });
  const github = { pull: async () => Promise.reject(new Error("Not Found")) } as unknown as Github;
  assert.deepEqual(await sweepMedia({ db, github: () => github, dataDir: "/nonexistent", days: 10 }), []);
  assert.equal(db.run_(id)!.media_cleared, null);
});

test("MEDIA_RETENTION_DAYS: 10 by default, off keeps media, anything else is refused", () => {
  assert.equal(loadConfig({}).mediaRetentionDays, 10);
  assert.equal(loadConfig({ MEDIA_RETENTION_DAYS: "30" }).mediaRetentionDays, 30);
  assert.equal(loadConfig({ MEDIA_RETENTION_DAYS: "off" }).mediaRetentionDays, null);
  assert.throws(() => loadConfig({ MEDIA_RETENTION_DAYS: "ten" }), /MEDIA_RETENTION_DAYS/);
});
