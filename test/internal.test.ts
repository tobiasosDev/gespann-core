import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { ModuleJobEnd, ServerModule } from "../src/server/extension.ts";
import type { Github, LinkedIssue, PullRequest } from "../src/server/github.ts";
import { hostSizeFor, internalToken, type OrchestratorState, unservedBy } from "../src/server/internal.ts";
import { endJob, startJob } from "./jobs.ts";
import { issuesText } from "../src/server/jobs.ts";
import { repairPrompt, setupPrompt, suggestPrompt, testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe, recipeLine } from "../src/verify/recipe.ts";
import { judge } from "../src/verify/verdict.ts";

const SECRET = "internal-test-secret";
const AUTH = { Authorization: `Bearer ${internalToken(SECRET)}` };

function pull(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 4,
    node_id: "PR_4",
    title: "Add checkout",
    body: "Fixes #2",
    draft: false,
    state: "open",
    merged: false,
    head: { sha: "a".repeat(40), ref: "f", repo: { full_name: "acme/shop" } },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "acme/shop" } },
    labels: [],
    html_url: "",
    ...over,
  };
}

/** Records what the internal API asks of GitHub. */
class FakeGithub {
  current: PullRequest | null = pull();
  issues: LinkedIssue[] | Error = [{ ref: "#2", title: "Checkout", body: "Users pay.", url: "https://github.com/acme/shop/issues/2" }];
  checks: { id: number; status: string; conclusion?: string; title?: string; summary?: string }[] = [];
  comments: string[] = [];
  tokens: [number, boolean][] = [];
  other = { pending: [] as string[], failed: [] as string[], passed: ["ci"], statuses: true };
  async otherChecks() {
    return this.other;
  }
  async pull() {
    if (!this.current) throw new Error("GitHub is down");
    return this.current;
  }
  async linkedIssues() {
    if (this.issues instanceof Error) throw this.issues;
    return this.issues;
  }
  async updateCheck(_i: number, _r: string, id: number, f: { status: string; conclusion?: string; title?: string; summary?: string }) {
    this.checks.push({ id, ...f });
  }
  async comment(_i: number, _r: string, _pr: number, body: string) {
    this.comments.push(body);
    return 77;
  }
  async updateComment() {}
  async setDraft() {}
  async installationToken(installationId: number, readOnly = false) {
    this.tokens.push([installationId, readOnly]);
    return "ghs_token";
  }
}

function setup(over: { module?: ServerModule; env?: NodeJS.ProcessEnv } = {}) {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-internal-")), SESSION_SECRET: SECRET, ...over.env });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const run = db.createRun({ project_id: p, pr: 4, title: "t", head: "a".repeat(40), base: "b".repeat(40), base_ref: "main", token: "0".repeat(32) });
  const gh = new FakeGithub();
  const server = createApp({ config, db, github: () => gh as unknown as Github, githubReady: () => true, module: over.module ?? null });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, { method, headers: { ...AUTH, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { config, db, u, p, run, gh, server, call };
}

test("internal API: 401 without the token or with a wrong one", async () => {
  const { server, run } = setup();
  assert.equal((await server.request(`/internal/runs/${run}/pull`)).status, 401);
  assert.equal((await server.request(`/internal/runs/${run}/pull`, { headers: { Authorization: `Bearer ${internalToken("other")}` } })).status, 401);
  assert.equal((await server.request(`/internal/jobs/1/admit`, { method: "POST", headers: { Authorization: internalToken(SECRET) } })).status, 401, "the Bearer prefix is part of it");
  assert.equal((await server.request(`/internal/runs/${run}/pull`, { headers: AUTH })).status, 200);
  assert.equal(internalToken("s"), createHash("sha256").update("gespann-internal:s").digest("hex"));
});

test("internal API: pull, skip-closed, check, git-token and context ask GitHub", async () => {
  const { db, p, run, gh, call } = setup();
  assert.deepEqual((await call("GET", `/internal/runs/${run}/pull`)).body, { pull: { state: "open", merged: false, head: "a".repeat(40) } });
  assert.deepEqual((await call("GET", `/internal/runs/999/pull`)).status, 404);

  // An open PR is not skipped.
  assert.deepEqual((await call("POST", `/internal/runs/${run}/skip-closed`)).body, { skipped: false });
  assert.equal(db.run_(run)?.status, "queued");

  // No check yet: nothing is sent. With one: in progress with the text as given.
  assert.deepEqual((await call("POST", `/internal/runs/${run}/check`, { title: "Testing", summary: "An agent tests it." })).body, {});
  assert.deepEqual(gh.checks, []);
  db.updateRun(run, { check_run_id: 31 });
  await call("POST", `/internal/runs/${run}/check`, { title: "Testing", summary: "An agent tests it." });
  assert.deepEqual(gh.checks, [{ id: 31, status: "in_progress", title: "Testing", summary: "An agent tests it." }]);
  // A head a person approved keeps its neutral check.
  db.setHold(p, 4, { approved_by: "tobi", approved_head: "a".repeat(40) });
  await call("POST", `/internal/runs/${run}/check`, { title: "Testing again", summary: "x" });
  assert.equal(gh.checks.length, 1);
  db.setHold(p, 4, { approved_by: null, approved_head: null });

  assert.deepEqual((await call("POST", `/internal/projects/${p}/git-token`)).body, { token: "ghs_token" });
  assert.deepEqual(gh.tokens, [[9, true]], "read-only");

  const ctx = (await call("GET", `/internal/runs/${run}/context`)).body;
  assert.deepEqual(ctx, { prText: "# Add checkout\n\nFixes #2\n", issues: gh.issues, issuesMd: issuesText(gh.issues as LinkedIssue[]), unread: null });
  gh.issues = new Error("timeout");
  const unread = (await call("GET", `/internal/runs/${run}/context`)).body;
  assert.deepEqual([unread.issues, unread.issuesMd], [[], ""]);
  assert.match(String(unread.unread), /^Issue goals not checked: GitHub did not list the issues this PR resolves \(timeout\)$/);

  // GitHub down: pull answers null, the others say so.
  gh.current = null;
  assert.deepEqual((await call("GET", `/internal/runs/${run}/pull`)).body, { pull: null });
  assert.equal((await call("GET", `/internal/runs/${run}/context`)).status, 502);
  assert.deepEqual((await call("POST", `/internal/runs/${run}/skip-closed`)).body, { skipped: false });
  assert.equal(db.run_(run)?.status, "queued", "no answer from GitHub skips nothing");

  // Merged: this run is skipped and its check too.
  gh.current = pull({ state: "closed", merged: true });
  assert.deepEqual((await call("POST", `/internal/runs/${run}/skip-closed`)).body, { skipped: true });
  assert.equal(db.run_(run)?.status, "cancelled");
  assert.deepEqual(gh.checks.at(-1), { id: 31, status: "completed", conclusion: "skipped", title: "Skipped: the PR was merged", summary: "The PR was merged before gespann started its test." });
});

test("internal API: await-checks lets a green PR go, puts a running CI back into the queue, and skips a red one", async () => {
  const { db, p, run, gh, call } = setup();
  const job = () => {
    const id = db.enqueue(p, "run", run);
    startJob(db, id);
    return id;
  };
  const go = job();
  assert.deepEqual((await call("POST", `/internal/runs/${run}/await-checks`, { jobId: go })).body, { step: "go" });
  gh.other = { pending: ["ci"], failed: [], passed: [], statuses: true };
  const later = job();
  assert.deepEqual((await call("POST", `/internal/runs/${run}/await-checks`, { jobId: later })).body, { step: "later" });
  const deferred = db.job(later);
  assert.equal(deferred?.status, "queued");
  assert.ok(deferred?.not_before, "back in the queue until its CI may have finished");
  gh.other = { pending: [], failed: ["ci"], passed: [], statuses: true };
  const red = job();
  assert.deepEqual((await call("POST", `/internal/runs/${run}/await-checks`, { jobId: red })).body, { step: "skipped" });
  assert.equal(db.run_(run)?.outcome, "SKIP");
  assert.equal((await call("POST", `/internal/runs/${run}/await-checks`, { jobId: 999 })).status, 404);
});

test("internal API: report completes the check and comments from the run as the database has it; log lines go to the job", async () => {
  const { db, p, run, gh, call } = setup();
  const job = db.enqueue(p, "run", run);
  db.updateRun(run, { check_run_id: 31 });
  const judged = judge(JSON.stringify({ verdict: "PASS", summary: "Checkout works.", checks: [{ expect: "Pay", observed: "Paid", result: "pass", proof: ["a.png"] }], proof: ["a.png"] }), () => true);
  db.updateRun(run, { status: "done", outcome: "PASS", verdict: JSON.stringify(judged), files: JSON.stringify(["a.png"]) });
  assert.deepEqual((await call("POST", `/internal/runs/${run}/report`, { jobId: job, judged, files: ["a.png"] })).body, {});
  assert.equal(gh.checks.length, 1);
  assert.equal(gh.checks[0]?.conclusion, "success");
  assert.match(gh.checks[0]?.title ?? "", /^PASS: Checkout works\./);
  assert.equal(gh.comments.length, 1);
  assert.equal(db.run_(run)?.comment_id, 77);

  // A newer push: no comment, and the job log says why.
  gh.current = pull({ head: { sha: "c".repeat(40), ref: "f", repo: { full_name: "acme/shop" } } });
  await call("POST", `/internal/runs/${run}/report`, { jobId: job, judged, files: ["a.png"] });
  assert.equal(gh.comments.length, 1);
  assert.match(db.job(job)?.log ?? "", /the PR has a newer push: its comment stays with the newer run/);
});

test("internal API: admit asks the server module; ended tells it once per job", async () => {
  const ends: ModuleJobEnd[] = [];
  let answer: () => string | null = () => null;
  const module: ServerModule = { name: "billing", admit: () => answer(), jobEnded: (e) => void ends.push(e) };
  const { db, p, call } = setup({ module });
  const job = db.enqueue(p, "suggest");
  assert.deepEqual((await call("POST", `/internal/jobs/${job}/admit`)).body, { refused: null });
  answer = () => "choose a plan first";
  assert.deepEqual((await call("POST", `/internal/jobs/${job}/admit`)).body, { refused: "choose a plan first" });
  answer = () => {
    throw new Error("store is down");
  };
  assert.deepEqual((await call("POST", `/internal/jobs/${job}/admit`)).body, { refused: "billing could not check this job: store is down" });
  assert.equal((await call("POST", `/internal/jobs/999/admit`)).status, 404);
  const { call: plainCall, db: plainDb, p: plainP } = setup();
  assert.deepEqual((await plainCall("POST", `/internal/jobs/${plainDb.enqueue(plainP, "suggest")}/admit`)).body, { refused: null }, "no module: null");

  // Not ended yet: nothing to tell, and a later call still tells it.
  assert.deepEqual((await call("POST", `/internal/jobs/${job}/ended`)).body, {});
  assert.equal(ends.length, 0);
  startJob(db, job);
  endJob(db, job, "done");
  await call("POST", `/internal/jobs/${job}/ended`);
  await call("POST", `/internal/jobs/${job}/ended`);
  assert.equal(ends.length, 1);
  assert.deepEqual([ends[0]?.jobId, ends[0]?.status, ends[0]?.owner.login], [job, "done", "tobi"]);
  assert.ok(db.job(job)?.ended_noted);

  // A module that fails is asked again: 503, and the end stays unnoted until it went through.
  const { call: c3, db: db3, p: p3 } = setup({
    module: {
      name: "billing",
      jobEnded: () => {
        if (!down) return;
        throw new Error("store is down");
      },
    },
  });
  let down = true;
  const job3 = db3.enqueue(p3, "suggest");
  startJob(db3, job3);
  endJob(db3, job3, "done");
  assert.equal((await c3("POST", `/internal/jobs/${job3}/ended`)).status, 503);
  assert.equal(db3.job(job3)?.ended_noted, null);
  down = false;
  assert.equal((await c3("POST", `/internal/jobs/${job3}/ended`)).status, 200);
  assert.ok(db3.job(job3)?.ended_noted);

  // A retry that arrives while a slow call still runs bills nothing more.
  let bills = 0;
  const { call: c4, db: db4, p: p4 } = setup({ module: { name: "billing", jobEnded: () => new Promise<void>((ok) => setTimeout(() => (bills++, ok()), 50)) } });
  const job4 = db4.enqueue(p4, "suggest");
  startJob(db4, job4);
  endJob(db4, job4, "done");
  await Promise.all([c4("POST", `/internal/jobs/${job4}/ended`), c4("POST", `/internal/jobs/${job4}/ended`)]);
  assert.equal(bills, 1);
});

test("the server module's caps go into users.job_cap for the orchestrator", () => {
  const { db, u } = setup();
  const other = db.upsertUser({ github_id: 2, login: "eve", name: null, avatar: null });
  db.publishJobCaps((owner) => (owner.login === "tobi" ? 2 : null));
  const cap = (id: number) => (db.sql.prepare("select job_cap from users where id = ?").get(id) as { job_cap: number | null }).job_cap;
  assert.deepEqual([cap(u.id), cap(other.id)], [2, null]);
  db.publishJobCaps(() => null);
  assert.equal(cap(u.id), null);
});

test("host size from settings.orchestrator, Codex sign-in only while the orchestrator beats", async () => {
  const { db, u, server } = setup();
  db.createSession("s".repeat(64), u.id);
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1" };
  const boxes = async () => (await (await server.request("/api/boxes", { headers: h })).json()) as { host: number | null };
  const login = () => server.request("/api/settings/codex/login", { method: "POST", headers: h });
  assert.equal((await boxes()).host, null);
  assert.equal((await login()).status, 409, "no orchestrator yet");

  const beat = (ms: number) => db.setSetting("orchestrator", JSON.stringify({ kind: "ssh", parallel: 3, why: "12 CPUs", instance: "i-1", beat: new Date(Date.now() - ms).toISOString() }));
  beat(90_000);
  assert.equal((await boxes()).host, 3, "read per request");
  assert.equal((await login()).status, 409, "a beat older than 60 s does not count");
  assert.equal(db.codex(u.id)?.codex_state, "none");

  beat(5_000);
  db.setCodex(u.id, { codex_state: "failed", codex_login: "{}" });
  assert.equal((await login()).status, 200);
  assert.deepEqual([db.codex(u.id)?.codex_state, db.codex(u.id)?.codex_login], ["pending", null]);
});

test("Settings: each user's number of jobs at once is the one of the sandbox provider that serves them", () => {
  const providers = [
    { spec: "ssh", kind: "ssh", parallel: 7, why: "32 CPUs", logins: ["tobiasosdev"], default: false },
    { spec: "remote", kind: "cloud", parallel: 200, why: "the sandbox service allows 200 at once", logins: [], default: true },
  ];
  const s: OrchestratorState = { kind: "cloud", parallel: 200, why: "", providers, instance: "i", beat: 0 };
  assert.equal(hostSizeFor(s, "TobiasosDev"), 7, "named, in any case");
  assert.equal(hostSizeFor(s, "acme"), 200, "everyone else");
  assert.equal(hostSizeFor({ ...s, providers: providers.slice(0, 1), kind: null, parallel: null }, "acme"), null, "no provider serves acme");
  assert.equal(hostSizeFor({ kind: "ssh", parallel: 3, why: "", instance: "i", beat: 0 }, "acme"), 3, "an orchestrator from before several providers");
  assert.equal(hostSizeFor(null, "acme"), null);
  // No provider for acme is not an outage: Settings says so instead of "the service is not running".
  assert.equal(unservedBy({ ...s, providers: providers.slice(0, 1) }, "acme"), true);
  assert.equal(unservedBy(s, "acme"), false);
  assert.equal(unservedBy({ kind: "ssh", parallel: 3, why: "", instance: "i", beat: 0 }, "acme"), false, "an orchestrator from before several providers");
  assert.equal(unservedBy(null, "acme"), false, "no orchestrator: an outage");
});

const BIN = join(import.meta.dirname, "..", "src", "bin.ts");
const gespann = (args: string[], cwd: string) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });

test("CLI: verify recipe and verify prompt print exactly what the functions return, outside a git checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-cli-"));
  const yml = "version: 1\ntimeout: 30\nprompt: .gespann/tester.md\ntrigger:\n  paths: ['src/**']\nenv:\n  up: 'true'\n  down: 'true'\n  url: http://127.0.0.1:3000\nlogin:\n  user: a@b.test\n  password: pw\n";
  writeFileSync(join(dir, "verify.yml"), yml);
  writeFileSync(join(dir, "bad.yml"), "version: 1\n");
  const ok = gespann(["verify", "recipe", "--recipe", "verify.yml"], dir);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '{"ok":true,"timeout":30,"prompt":".gespann/tester.md"}\n');
  const bad = gespann(["verify", "recipe", "--recipe", "bad.yml"], dir);
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, `${recipeLine(join(dir, "bad.yml"))}\n`);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.match(JSON.parse(bad.stdout).error, /^invalid recipe:/);

  const tester = { repo: "acme/shop", pr: 4, head: "h", base: "b", url: "http://127.0.0.1:3000", out: "/o", work: "/w", criteria: "", recipeFile: join(dir, "verify.yml"), addendum: "notes", issues: ["#2"], viewports: [] };
  const setupIn = { repo: "acme/shop", repoDir: "/r", projectDir: "/p", criteria: "Pay works", testerNote: "Use the browser." };
  const repairIn = { repo: "acme/shop", repoDir: "/r", projectDir: "/p", gaps: [{ expect: "Landing", observed: "missing", fix: "build it" }] };
  const suggestIn = { repo: "acme/shop", repoDir: "/r", out: "/o/checks.md", current: "" };
  const { recipeFile: _f, ...testerRest } = tester;
  const cases: [string, unknown, string][] = [
    ["tester", tester, testerPrompt({ ...testerRest, recipe: parseRecipe(yml) })],
    ["setup", setupIn, setupPrompt(setupIn)],
    ["repair", repairIn, repairPrompt(repairIn)],
    ["suggest", suggestIn, suggestPrompt(suggestIn.repo, suggestIn.repoDir, suggestIn.out, suggestIn.current)],
  ];
  for (const [kind, input, want] of cases) {
    writeFileSync(join(dir, `${kind}.json`), JSON.stringify(input));
    const r = gespann(["verify", "prompt", kind, "--input", `${kind}.json`], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(want.endsWith("\n"));
    assert.equal(r.stdout, want, kind);
  }
  assert.notEqual(gespann(["verify", "prompt", "other", "--input", "x.json"], dir).status, 0);
});
