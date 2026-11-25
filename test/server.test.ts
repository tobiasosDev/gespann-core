import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { appJwt, Github, verifySignature } from "../src/server/github.ts";

test("webhook signatures are checked in constant time", () => {
  const body = '{"a":1}';
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.ok(verifySignature("s3cret", body, sig));
  assert.ok(!verifySignature("other", body, sig));
  assert.ok(!verifySignature("s3cret", body, undefined));
});

test("the app JWT is a valid RS256 token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt("123", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 1_000_000);
  const [h, b, s] = jwt.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url").toString()), { iat: 999_940, exp: 1_000_540, iss: "123" });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url")));
});

test("one job per project at a time; a newer push cancels queued runs of the same PR", () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const a = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  const u2 = db.upsertUser({ github_id: 2, login: "u2", name: null, avatar: null });
  const b = db.createProject({ owner_id: u2.id, installation_id: 9, repo: "o/b", repo_id: 2, default_branch: "main" });
  const j1 = db.enqueue(a, "setup");
  db.enqueue(a, "login");
  const j3 = db.enqueue(b, "login");
  assert.equal(db.nextJob()?.id, j1);
  db.startJob(j1);
  assert.equal(db.nextJob()?.id, j3, "project a is busy, b of another owner goes next");
  const r1 = db.createRun({ project_id: a, pr: 4, title: "t", head: "h1", base: "b", base_ref: "main", token: "0".repeat(32) });
  db.enqueue(a, "run", r1);
  assert.deepEqual(db.cancelQueuedRuns(a, 4).map((r) => r.id), [r1]);
  assert.equal(db.run_(r1)?.status, "cancelled");
  assert.equal(db.claimJob(j1), false, "a running job is not taken twice");
  // j1's server still beats: nothing goes back into the queue.
  assert.deepEqual(db.requeueStale(new Date(Date.now() - 60_000).toISOString()), []);
  assert.equal(db.job(j1)?.status, "running");
});

test("API: anonymous me, setup hidden without the admin token, auth needed, CSRF header, webhook signature, SPA fallback", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data", ADMIN_TOKEN: "adm" });
  const db = new Db(":memory:");
  const app = { appId: "1", slug: "gespann-test", privateKey: "x", webhookSecret: "whs", clientId: "cid", clientSecret: "cs" };
  db.setSetting("github_app", JSON.stringify(app));
  const server = createApp({ config, db, github: () => new Github(app), githubReady: () => true });
  const me = await (await server.request("/api/me")).json();
  assert.deepEqual(me, { user: null, githubReady: true, installUrl: "https://github.com/apps/gespann-test/installations/new" });
  assert.equal((await server.request("/setup")).status, 404);
  assert.equal((await server.request("/setup/github/created?state=x&code=y")).status, 409, "an instance with an app never replaces it");
  assert.equal((await server.request("/api/projects", { headers: { "x-gespann": "1" } })).status, 401);
  const auth = await server.request("/auth/github");
  assert.match(auth.headers.get("location") ?? "", /^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=cid/);
  const hook = await server.request("/github/webhook", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } });
  assert.equal(hook.status, 401);
  assert.equal((await server.request(`/proof/${"a".repeat(32)}/x.png`)).status, 404);
  const spa = await server.request("/projects/12");
  assert.ok(spa.status === 200 || spa.status === 503, "index.html for client routes (503 when the web app is not built)");
  assert.match(spa.headers.get("content-security-policy") ?? "", /script-src 'self'/);
});

test("API: a signed-in user sees own projects through every step, not others'", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no github in this test"); }, githubReady: () => false });
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: "T", avatar: null });
  db.setRepos(u.id, [{ repo_id: 1, installation_id: 9, account: "acme", full_name: "acme/shop", private: true, default_branch: "main" }]);
  db.createSession("s".repeat(64), u.id);
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1" };
  const get = async (path: string, headers: Record<string, string> = h) => server.request(`/api${path}`, { headers });
  const post = async (path: string, body: unknown, headers: Record<string, string> = h) => server.request(`/api${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await (await get("/projects")).json()).projects[0].repo, "acme/shop");
  assert.equal((await post(`/projects/${p}/setup`, {})).status, 409, "setup needs Codex first");
  let started = 0;
  const withLogin = createApp({ config, db, github: () => { throw new Error("no github"); }, githubReady: () => false, startCodexLogin: () => void started++ });
  assert.equal((await withLogin.request("/api/settings/codex/login", { method: "POST", headers: h })).status, 200);
  assert.equal(started, 1);
  db.setCodex(u.id, { codex_state: "pending", codex_login: JSON.stringify({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345", lines: "" }) });
  assert.equal((await (await get("/settings")).json()).codex.login.code, "ABCD-12345");
  db.setCodex(u.id, { codex_state: "connected", codex_account: "tobi@example.test", codex_login: null, codex_auth: "sealed" });
  const detail = await (await get(`/projects/${p}`)).json();
  assert.equal(detail.codex, "connected");
  assert.equal(detail.codex_auth, undefined, "the sealed sign-in never leaves the server");
  assert.equal(JSON.stringify(await (await get("/settings")).json()).includes("sealed"), false);
  assert.equal((await post(`/projects/${p}/criteria`, { criteria: "Checkout completes", model: "bad model!" })).status, 400);
  assert.equal((await post(`/projects/${p}/criteria`, { criteria: "Checkout completes", model: "gpt-6.2" })).status, 200);
  assert.equal(db.project(p)?.model, "gpt-6.2");
  assert.equal((await post(`/projects/${p}/active`, { active: true })).status, 409, "start needs a prepared environment");
  assert.equal((await post(`/projects/${p}/suggest`, {})).status, 200);
  assert.equal((await post(`/projects/${p}/suggest`, {})).status, 200);
  assert.equal(db.jobs(p).filter((j) => j.kind === "suggest").length, 1, "one suggestion at a time");
  db.updateProject(p, { suggestion: "Upload a DOCX on /upload" });
  assert.equal((await (await get(`/projects/${p}`)).json()).suggestion, "Upload a DOCX on /upload");
  await post(`/projects/${p}/criteria`, { criteria: "Upload a DOCX on /upload" });
  assert.equal(db.project(p)?.suggestion, null, "taking the suggestion clears it");

  const run = db.createRun({ project_id: p, pr: 12, title: "Checkout button", head: "a".repeat(40), base: "b".repeat(40), base_ref: "main", token: "c".repeat(32) });
  db.updateRun(run, { status: "done", outcome: "FAIL", verdict: JSON.stringify({ verdict: { verdict: "FAIL", summary: "Checkout breaks.", checks: [{ expect: "Pay completes", observed: "500 error", result: "fail" }], proof: [] }, outcome: "FAIL", problems: [] }) });
  const r = await (await get(`/runs/${run}`)).json();
  assert.equal(r.verdict.verdict.checks[0].observed, "500 error");
  assert.deepEqual(r.project, { id: p, repo: "acme/shop" });

  const other = db.upsertUser({ github_id: 2, login: "eve", name: null, avatar: null });
  // Eve is in the same installation but has access to a different repository only.
  db.setRepos(other.id, [{ repo_id: 2, installation_id: 9, account: "acme", full_name: "acme/blog", private: true, default_branch: "main" }]);
  db.createSession("e".repeat(64), other.id);
  const eve = { Cookie: `gs=${"e".repeat(64)}`, "x-gespann": "1" };
  assert.equal((await get(`/runs/${run}`, eve)).status, 404, "no access to a repository of the same installation without a grant for it");
  assert.equal((await get(`/projects/${p}`, eve)).status, 404);
  assert.equal((await post("/projects", { installation: 9, repo: 1 }, eve)).status, 404);
  assert.deepEqual((await (await get("/repos", eve)).json()).groups[0].repos.map((r: { full_name: string }) => r.full_name), ["acme/blog"]);
  assert.equal((await post(`/projects/${p}/active`, { active: false }, { Cookie: h.Cookie })).status, 403, "no x-gespann header, no state change");
});

test("the GitHub App setup accepts only the server-side nonce", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data", ADMIN_TOKEN: "adm" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no app"); }, githubReady: () => false });
  const page = await (await server.request("/setup?token=adm")).text();
  const state = /state=([0-9a-f]{32})/.exec(page)?.[1];
  assert.ok(state);
  assert.equal((await server.request("/setup/github/created?state=forged&code=x", { headers: { Cookie: "gs_setup=forged" } })).status, 400);
  assert.equal(JSON.parse(db.setting("setup_state") ?? "null").state, state, "a forged callback does not spend the admin's nonce");
});

test("the Codex sign-in is sealed with AES-GCM and tampering is detected", async () => {
  const { seal, open } = await import("../src/server/codex.ts");
  const sealed = seal("secret", '{"tokens":{"refresh_token":"r"}}');
  assert.ok(!sealed.includes("refresh_token"));
  assert.equal(open("secret", sealed), '{"tokens":{"refresh_token":"r"}}');
  assert.throws(() => open("other", sealed));
});

test("jobs of one owner run one at a time: one Codex sign-in", () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const a = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  const b = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/b", repo_id: 2, default_branch: "main" });
  const ja = db.enqueue(a, "setup");
  db.enqueue(b, "setup");
  db.startJob(ja);
  assert.equal(db.nextJob(), undefined);
});

test("setup starts by itself once the owner's Codex is connected", () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  db.autoSetup(u.id);
  assert.equal(db.project(p)?.setup, "none", "no Codex, no setup");
  db.setCodex(u.id, { codex_state: "connected" });
  db.autoSetup(u.id);
  db.autoSetup(u.id);
  assert.equal(db.project(p)?.setup, "queued");
  assert.equal(db.jobs(p).filter((j) => j.kind === "setup").length, 1, "queued once");
});

test("the operator API needs the exact admin token", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data", ADMIN_TOKEN: "adm" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no app"); }, githubReady: () => false });
  assert.equal((await server.request("/ops/projects")).status, 404);
  assert.equal((await server.request("/ops/projects", { headers: { Authorization: "Bearer ad" } })).status, 404);
  assert.equal((await server.request("/ops/projects", { headers: { Authorization: "Bearer adm" } })).status, 200);
  const none = createApp({ config: loadConfig({ DATA_DIR: "/tmp/gespann-test-data" }), db, github: () => { throw new Error("no app"); }, githubReady: () => false });
  assert.equal((await none.request("/ops/projects", { headers: { Authorization: "Bearer " } })).status, 404, "no admin token, no operator API");
});
