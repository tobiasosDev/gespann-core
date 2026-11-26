import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { Github, PullRequest } from "../src/server/github.ts";

const RECIPE = `
version: 1
trigger:
  paths: ["src/**"]
env:
  up: "true"
  down: "true"
  url: http://127.0.0.1:3000
`;

const HEAD = "a".repeat(40);

function pr(sha = HEAD): PullRequest {
  return {
    number: 7,
    node_id: "PR_7",
    title: "t",
    body: null,
    draft: false,
    state: "open",
    head: { sha, ref: "f", repo: { full_name: "o/r" } },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
    labels: [],
    html_url: "",
  };
}

/** GitHub answers after a short delay, like the real one, so callers overlap. */
class SlowGithub {
  current = pr();
  checks = 0;
  cancelled: number[] = [];
  private wait = () => new Promise((ok) => setTimeout(ok, 5));
  async pull() {
    await this.wait();
    return this.current;
  }
  async changedFiles() {
    await this.wait();
    return ["src/a.ts"];
  }
  async createCheck() {
    await this.wait();
    return ++this.checks;
  }
  async updateCheck(_i: number, _r: string, id: number, f: { conclusion?: string }) {
    if (f.conclusion === "cancelled") this.cancelled.push(id);
  }
}

function setup() {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-same-head-")), ADMIN_TOKEN: "adm" });
  const db = new Db(":memory:");
  db.setSetting("github_app", JSON.stringify({ appId: "1", slug: "gespann-test", privateKey: "x", webhookSecret: "whs", clientId: "c", clientSecret: "s" }));
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const id = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/r", repo_id: 42, default_branch: "main" });
  db.updateProject(id, { setup: "ready", active: 1, recipe: RECIPE });
  const gh = new SlowGithub();
  const server = createApp({ config, db, github: () => gh as unknown as Github, githubReady: () => true });
  const webhook = async (action: string) => {
    const body = JSON.stringify({ repository: { id: 42 }, action, pull_request: gh.current, sender: { login: "x", type: "User" } });
    const sig = `sha256=${createHmac("sha256", "whs").update(body).digest("hex")}`;
    assert.equal((await server.request("/github/webhook", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": sig } })).status, 202);
    await new Promise((ok) => setTimeout(ok, 60)); // the handler runs after the 202
  };
  const start = async () => {
    const res = await server.request(`/ops/projects/${id}/runs`, { method: "POST", body: JSON.stringify({ pr: 7 }), headers: { Authorization: "Bearer adm", "content-type": "application/json" } });
    assert.equal(res.status, 200);
    return ((await res.json()) as { runId: number }).runId;
  };
  return { db, gh, webhook, start, runs: () => db.runsOfPr(id, 7, 50) };
}

test("a second start for the PR head that is already being tested joins that run instead of starting another", async () => {
  const { db, gh, webhook, start, runs } = setup();
  await webhook("opened");
  const [first] = runs();
  assert.ok(first);
  db.updateRun(first.id, { status: "running" });

  // Seconds later: a manual start and a second event for the same head.
  const [manual] = await Promise.all([start(), webhook("synchronize")]);
  assert.equal(manual, first.id, "the start returns the run that already tests this head");
  assert.deepEqual(
    runs().map((r) => [r.id, r.status]),
    [[first.id, "running"]],
    "one run, still running, not cancelled",
  );
  assert.equal(gh.checks, 1, "no second check on GitHub");
  assert.deepEqual(gh.cancelled, []);
});

test("two starts at once for one head make one run", async () => {
  const { gh, start, runs } = setup();
  const ids = await Promise.all([start(), start(), start()]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(runs().length, 1);
  assert.equal(runs()[0]?.status, "queued");
  assert.equal(gh.checks, 1);
});

test("a finished head can be tested again, and a newer head still replaces the running test", async () => {
  const { db, gh, start, runs } = setup();
  const first = await start();
  db.updateRun(first, { status: "done", outcome: "FAIL" });
  const again = await start();
  assert.notEqual(again, first, "a rerun after the result starts a new run");
  db.updateRun(again, { status: "running" });

  gh.current = pr("c".repeat(40));
  const newer = await start();
  assert.notEqual(newer, again);
  assert.deepEqual(
    runs().map((r) => [r.id, r.status]),
    [
      [newer, "queued"],
      [again, "cancelled"],
      [first, "done"],
    ],
  );
});
