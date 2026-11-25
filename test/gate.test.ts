import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { createApp, sendFile } from "../src/server/app.ts";
import { renderComment } from "../src/server/comment.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { applyGate, gateLine } from "../src/server/gate.ts";
import type { Github, PullRequest } from "../src/server/github.ts";
import { judge } from "../src/verify/verdict.ts";

const RECIPE = `
version: 1
trigger:
  paths: ["src/**"]
env:
  up: "true"
  down: "true"
  url: http://127.0.0.1:3000
`;

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    node_id: "PR_7",
    title: "t",
    body: null,
    draft: false,
    state: "open",
    head: { sha: "a".repeat(40), ref: "f", repo: { full_name: "o/r" } },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
    labels: [],
    html_url: "",
    ...over,
  };
}

/** Records what gespann asks of GitHub; the PR is whatever the test sets. */
class FakeGithub {
  calls: string[] = [];
  current = pr();
  async changedFiles() {
    return ["docs/readme.md"]; // does not match the recipe's paths: only the label starts a run
  }
  async createCheck() {
    this.calls.push("check");
    return 1;
  }
  async updateCheck() {}
  async setDraft(_i: number, _id: string, draft: boolean) {
    this.calls.push(draft ? "draft" : "ready");
    this.current = { ...this.current, draft };
  }
  async comment(_i: number, _r: string, _n: number, body: string) {
    this.calls.push(`comment:${body.slice(0, 20)}`);
    return 5;
  }
  async pull() {
    return this.current;
  }
  async updateComment() {
    this.calls.push("edit");
  }
}

function setup() {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-gate-")) });
  const db = new Db(":memory:");
  const app = { appId: "1", slug: "gespann-test", privateKey: "x", webhookSecret: "whs", clientId: "c", clientSecret: "s" };
  db.setSetting("github_app", JSON.stringify(app));
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const id = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/r", repo_id: 42, default_branch: "main" });
  db.updateProject(id, { setup: "ready", active: 1, recipe: RECIPE, gate: 1 });
  const gh = new FakeGithub();
  const github = () => gh as unknown as Github;
  const server = createApp({ config, db, github, githubReady: () => true });
  const send = async (event: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ repository: { id: 42 }, ...payload });
    const sig = `sha256=${createHmac("sha256", "whs").update(body).digest("hex")}`;
    assert.equal((await server.request("/github/webhook", { method: "POST", body, headers: { "x-github-event": event, "x-hub-signature-256": sig } })).status, 202);
    await new Promise((ok) => setTimeout(ok, 30)); // the handler runs after the 202
  };
  return { db, gh, github, send, project: () => db.project(id)! };
}

const person = { login: "tobi", type: "User" };
const bot = { login: "gespann-test[bot]", type: "Bot" };

test("merge gate: the label holds the PR as a draft until its head passes", async () => {
  const { db, gh, github, send, project } = setup();
  const deps = { db, github, baseUrl: "https://x" };
  const labeled = pr({ labels: [{ name: "gespann" }] });
  gh.current = labeled;
  await send("pull_request", { action: "labeled", label: { name: "gespann" }, pull_request: labeled, sender: person });
  assert.deepEqual(gh.calls, ["draft", "check"], "held first, then the label alone starts a run");
  const run = db.runForHead(project().id, 7, labeled.head.sha)!;
  assert.equal(run.status, "queued");
  assert.equal(db.hold(project().id, 7)?.held, 1);

  // Our own draft change comes back as a webhook from the bot: no approval, no second run.
  await send("pull_request", { action: "converted_to_draft", pull_request: gh.current, sender: bot });
  await send("pull_request", { action: "labeled", label: { name: "gespann" }, pull_request: labeled, sender: person });
  assert.deepEqual(gh.calls, ["draft", "check"]);

  // A failed or skipped test keeps it held; only a pass releases it.
  db.updateRun(run.id, { status: "done", outcome: "FAIL" });
  assert.equal(await applyGate(deps, project(), gh.current), "failed");
  db.updateRun(run.id, { status: "done", outcome: "SKIP" });
  assert.equal(await applyGate(deps, project(), gh.current), "skipped");
  assert.deepEqual(gh.calls, ["draft", "check"]);

  // A release GitHub refuses keeps the hold, so the next attempt retries it.
  db.updateRun(run.id, { status: "done", outcome: "PASS" });
  const ok = gh.setDraft;
  gh.setDraft = async () => {
    throw new Error("GitHub 502");
  };
  await assert.rejects(applyGate(deps, project(), gh.current));
  assert.equal(db.hold(project().id, 7)?.held, 1);
  gh.setDraft = ok;
  assert.equal(await applyGate(deps, project(), gh.current), "passed");
  assert.deepEqual(gh.calls, ["draft", "check", "ready"]);
  assert.equal(db.hold(project().id, 7)?.held, 0);

  // A new push has to pass again.
  gh.current = { ...gh.current, head: { ...gh.current.head, sha: "c".repeat(40) } };
  await send("pull_request", { action: "synchronize", pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls.slice(3), ["draft", "check"]);
});

test("merge gate: events that arrive together or late act on the PR as it is now", async () => {
  const { db, gh, send, project } = setup();
  const before = pr(); // the "opened" snapshot, without the label
  gh.current = pr({ labels: [{ name: "gespann" }] });
  await Promise.all([
    send("pull_request", { action: "opened", pull_request: before, sender: person }),
    send("pull_request", { action: "labeled", label: { name: "gespann" }, pull_request: gh.current, sender: person }),
  ]);
  assert.deepEqual(gh.calls, ["draft", "check"], "one hold, one run, not undone by the stale snapshot");
  assert.equal(db.hold(project().id, 7)?.held, 1);
  // A late "Ready for review" click for an older head does not release the current one.
  await send("pull_request", { action: "ready_for_review", pull_request: { ...before, head: { ...before.head, sha: "9".repeat(40) } }, sender: person });
  assert.equal(db.hold(project().id, 7)?.held, 1);
  assert.equal(db.hold(project().id, 7)?.approved_head ?? null, null);
  // A late synchronize for an old head neither cancels nor duplicates the current head's run.
  await send("pull_request", { action: "synchronize", pull_request: { ...before, head: { ...before.head, sha: "0".repeat(40) } }, sender: person });
  assert.deepEqual(gh.calls, ["draft", "check"]);
  assert.equal(db.runForHead(project().id, 7, gh.current.head.sha)?.status, "queued");
});

test("merge gate: a person releases a held PR by comment, by Ready for review, or by removing the label", async () => {
  const { db, gh, send, project } = setup();
  gh.current = pr({ labels: [{ name: "gespann" }] });
  await send("pull_request", { action: "opened", pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls, ["draft", "check"]);

  // Comments from people without access, other text, and bots do nothing.
  const say = (body: string, author_association: string, sender = person) => send("issue_comment", { action: "created", issue: { number: 7, pull_request: {} }, comment: { body, author_association }, sender });
  await say("/gespann approve", "NONE");
  await say("looks good", "OWNER");
  await say("/gespann approve", "OWNER", bot);
  assert.deepEqual(gh.calls, ["draft", "check"]);
  await say("/gespann approve", "OWNER");
  assert.equal(gh.calls[2], "ready");
  assert.match(gh.calls[3] ?? "", /^comment:🔓 Released by @tobi/);
  assert.equal(db.hold(project().id, 7)?.approved_head, gh.current.head.sha);

  // Ready for review by a person on a held PR counts as approval of that head.
  gh.current = { ...gh.current, head: { ...gh.current.head, sha: "d".repeat(40) } };
  await send("pull_request", { action: "synchronize", pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls.slice(4), ["draft", "check"]);
  gh.current = { ...gh.current, draft: false };
  await send("pull_request", { action: "ready_for_review", pull_request: gh.current, sender: person });
  assert.equal(db.hold(project().id, 7)?.approved_head, gh.current.head.sha);
  assert.equal(db.hold(project().id, 7)?.held, 0);

  // Removing the label releases a held PR.
  gh.current = { ...gh.current, head: { ...gh.current.head, sha: "e".repeat(40) } };
  await send("pull_request", { action: "synchronize", pull_request: gh.current, sender: person });
  assert.equal(gh.calls.at(-1), "check");
  assert.equal(db.hold(project().id, 7)?.held, 1);
  gh.current = { ...gh.current, labels: [] };
  await send("pull_request", { action: "unlabeled", label: { name: "gespann" }, pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls.slice(-2), ["ready", "edit"], "released, and the one gespann comment says so");

  // Without the label, an approve comment is not recorded for later.
  gh.current = { ...gh.current, head: { ...gh.current.head, sha: "f".repeat(40) }, draft: false };
  await say("/gespann approve", "OWNER");
  assert.notEqual(db.hold(project().id, 7)?.approved_head, gh.current.head.sha);
});

test("merge gate: PRs without the label and the author's own drafts are left alone", async () => {
  const { gh, send } = setup();
  await send("pull_request", { action: "opened", pull_request: pr(), sender: person });
  await send("pull_request", { action: "opened", pull_request: pr({ draft: true, labels: [{ name: "gespann" }] }), sender: person });
  assert.deepEqual(gh.calls, [], "no matching paths, no label: nothing; a draft by its author: not tested, not touched");
});

test("files answer byte ranges, which Safari on iOS needs to play a video", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-range-"));
  writeFileSync(join(dir, "v.mp4"), "0123456789");
  const app = new Hono();
  app.get("/v", (c) => sendFile(c, join(dir, "v.mp4"), "no-cache"));
  const full = await app.request("/v");
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(await full.text(), "0123456789");
  const part = await app.request("/v", { headers: { Range: "bytes=0-1" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 0-1/10");
  assert.equal(await part.text(), "01");
  assert.equal(await (await app.request("/v", { headers: { Range: "bytes=7-" } })).text(), "789");
  assert.equal(await (await app.request("/v", { headers: { Range: "bytes=-2" } })).text(), "89");
  assert.equal((await app.request("/v", { headers: { Range: "bytes=20-" } })).status, 416);
});

test("the PR comment shows what needs a person and folds the rest away", () => {
  const judged = judge(
    JSON.stringify({
      verdict: "BLOCKED",
      summary: "Most flows work. The landing page is not on the copy. " + "Filler that makes the summary long. ".repeat(5) + "A third sentence that is cut off because the summary only keeps what fits.",
      checks: [
        { expect: "Sign in works", observed: "Dashboard opened", result: "pass", proof: ["a.png"] },
        { expect: "Pricing | shows the new plan", observed: "Landing not built", result: "blocked", proof: ["b.png"] },
      ],
      proof: ["a.png", "b.png"],
    }),
    () => true,
  );
  const body = renderComment({ outcome: judged.outcome, judged, files: ["a.png", "b.png", "recording.mp4"], fileUrl: (f) => `https://x/${f}`, runUrl: "https://x/runs/1", head: "abcdef123", baseRef: "main", gate: gateLine("failed") });
  assert.match(body, /^### ⛔ gespann: BLOCKED · 1\/2 checks passed/);
  assert.match(body, /Held as draft/);
  // The blocked check is in the open, the passed one inside <details>.
  const open = body.slice(0, body.indexOf("<details>"));
  assert.match(open, /\| ⛔ \| Pricing \\\| shows the new plan \| Landing not built \|/);
  assert.doesNotMatch(open, /Sign in works/);
  assert.match(body, /<summary>✅ 1 passed check<\/summary>/);
  assert.match(body, /<summary>📸 2 screenshots<\/summary>/);
  assert.match(body, /Full run and recording/);
  assert.ok(!body.includes("A third sentence"), "the summary keeps whole sentences that fit");
  const none = renderComment({ outcome: "FAIL", judged: null, error: "sandbox 502", files: [], fileUrl: (f) => f, runUrl: "u", head: "h", baseRef: "main" });
  assert.match(none, /could not test this PR[\s\S]*sandbox 502/);
});

test("a hold table from before comment ids gets the column", () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-db-"));
  const old = new Db(join(dir, "g.db"));
  old.sql.exec("drop table holds; create table holds (project_id integer not null, pr integer not null, held integer not null default 0, approved_by text, approved_head text, updated text not null, primary key (project_id, pr))");
  const db = new Db(join(dir, "g.db"));
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const id = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/r", repo_id: 42, default_branch: "main" });
  db.setHold(id, 7, { comment_id: 5 });
  assert.equal(db.prComment(id, 7), 5);
});


test("merge gate: when GitHub refuses the draft switch, the PR is still tested", async () => {
  const { db, gh, send, project } = setup();
  gh.setDraft = async () => {
    throw new Error("GitHub 422: convertPullRequestToDraft: Resource not accessible by integration");
  };
  gh.current = pr({ labels: [{ name: "gespann" }] });
  await send("pull_request", { action: "labeled", label: { name: "gespann" }, pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls, ["check"]);
  assert.equal(db.runForHead(project().id, 7, gh.current.head.sha)?.status, "queued");
  assert.equal(db.hold(project().id, 7)?.held, 0);
});

test("merge gate: off by default; with the gate off the label holds nothing, and switching it off releases held PRs", async () => {
  const { db, gh, github, send, project } = setup();
  db.updateProject(project().id, { gate: 0 });
  gh.current = pr({ labels: [{ name: "gespann" }] });
  await send("pull_request", { action: "labeled", label: { name: "gespann" }, pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls, [], "gate off: the label neither holds nor starts a run");

  db.updateProject(project().id, { gate: 1 });
  await send("pull_request", { action: "labeled", label: { name: "gespann" }, pull_request: gh.current, sender: person });
  assert.deepEqual(gh.calls, ["draft", "check"]);
  const { releaseAll } = await import("../src/server/gate.ts");
  db.updateProject(project().id, { gate: 0 });
  await releaseAll({ db, github, baseUrl: "https://x" }, project());
  assert.equal(gh.calls[2], "ready");
  assert.equal(db.hold(project().id, 7)?.held, 0);
  const fresh = new Db(":memory:");
  const u = fresh.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  assert.equal(fresh.project(fresh.createProject({ owner_id: u.id, installation_id: 9, repo: "o/x", repo_id: 1, default_branch: "main" }))?.gate, 0, "new projects start with the gate off");
});

