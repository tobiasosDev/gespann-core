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

test("a newer push cancels queued runs of the same PR", () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const a = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  const r1 = db.createRun({ project_id: a, pr: 4, title: "t", head: "h1", base: "b", base_ref: "main", token: "0".repeat(32) });
  db.enqueue(a, "run", r1);
  assert.deepEqual(db.cancelQueuedRuns(a, 4).map((r) => r.id), [r1]);
  assert.equal(db.run_(r1)?.status, "cancelled");
});

test("a newer push supersedes the PR's queued and running runs; its job keeps the sandbox until the orchestrator stops it", () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const a = db.createProject({ owner_id: u.id, installation_id: 9, repo: "o/a", repo_id: 1, default_branch: "main" });
  const mk = (pr: number, head: string) => db.createRun({ project_id: a, pr, title: "t", head, base: "b", base_ref: "main", token: head.padEnd(32, "0") });
  const running = mk(4, "h1");
  const rj = db.enqueue(a, "run", running);
  // The orchestrator runs it.
  db.sql.prepare("update jobs set status = 'running', started = ? where id = ?").run(new Date().toISOString(), rj);
  db.updateRun(running, { status: "running" });
  const queued = mk(4, "h2");
  const qj = db.enqueue(a, "run", queued);
  const other = mk(5, "h3");
  db.updateRun(other, { status: "running" });
  assert.deepEqual(db.supersedeRuns(a, 4).map((r) => r.id).sort(), [running, queued]);
  for (const r of [running, queued]) assert.deepEqual([db.run_(r)?.status, db.run_(r)?.error], ["cancelled", "superseded by a newer push"]);
  assert.equal(db.job(qj)?.status, "cancelled", "the queued one never starts");
  assert.equal(db.job(rj)?.status, "running", "the running one still holds its sandbox while it stops");
  assert.equal(db.run_(other)?.status, "running", "another PR's run goes on");
});

test("API: anonymous me, setup hidden without the admin token, auth needed, CSRF header, webhook signature, SPA fallback", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data", ADMIN_TOKEN: "adm" });
  const db = new Db(":memory:");
  const app = { appId: "1", slug: "gespann-test", privateKey: "x", webhookSecret: "whs", clientId: "cid", clientSecret: "cs" };
  db.setSetting("github_app", JSON.stringify(app));
  const server = createApp({ config, db, github: () => new Github(app), githubReady: () => true });
  const me = await (await server.request("/api/me")).json();
  assert.deepEqual(me, { user: null, githubReady: true, installUrl: "https://github.com/apps/gespann-test/installations/new", links: [] });
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
  db.setSetting("orchestrator", JSON.stringify({ kind: "ssh", parallel: 2, why: "", instance: "i", beat: new Date().toISOString() }));
  assert.equal((await post("/settings/codex/login", {})).status, 200);
  assert.equal(db.codex(u.id)?.codex_state, "pending", "the orchestrator runs the sign-in");
  db.setCodex(u.id, { codex_state: "pending", codex_login: JSON.stringify({ url: "https://auth.openai.com/codex/device", code: "ABCD-12345", lines: "" }) });
  assert.equal((await (await get("/settings")).json()).codex.login.code, "ABCD-12345");
  db.setCodex(u.id, { codex_state: "connected", codex_account: "tobi@example.test", codex_login: null, codex_auth: "sealed" });
  const detail = await (await get(`/projects/${p}`)).json();
  assert.equal(detail.codex, "connected");
  assert.equal(detail.codex_model, null);
  assert.equal(detail.codex_auth, undefined, "the sealed sign-in never leaves the server");
  const settings0 = await (await get("/settings")).json();
  assert.equal(JSON.stringify(settings0).includes("sealed"), false);
  assert.equal(settings0.codex.model, null);
  assert.ok(Array.isArray(settings0.codex.models) && settings0.codex.models.some((m: { id: string }) => m.id === "gpt-6.2-sol"));
  assert.equal((await post("/settings/codex/model", { model: "bad model!" })).status, 400);
  assert.equal((await post("/settings/codex/model", { model: "gpt-6.2-astra" })).status, 200);
  assert.equal((await (await get("/settings")).json()).codex.model, "gpt-6.2-astra");
  assert.equal((await (await get(`/projects/${p}`)).json()).codex_model, "gpt-6.2-astra");
  assert.equal((await post("/settings/codex/model", { model: "" })).status, 200);
  assert.equal((await (await get("/settings")).json()).codex.model, null);
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

test("ALLOWED_USERS: only listed GitHub logins sign in; others' sessions and tokens stop working", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data", ALLOWED_USERS: " Tobi , ops" });
  assert.deepEqual(config.allowedUsers, ["tobi", "ops"]);
  assert.deepEqual(loadConfig({ DATA_DIR: "/tmp/gespann-test-data" }).allowedUsers, [], "unset lets everyone in");
  assert.throws(() => loadConfig({ ALLOWED_USERS: " , " }), /names no GitHub login/, "an empty list never opens the instance");
  const db = new Db(":memory:");
  let who = { id: 2, login: "eve", name: null, avatar_url: "" };
  const gh = { exchangeCode: async () => "tok", user: async () => who, userInstallations: async () => [], userRepos: async () => [], installUrl: () => "https://github.com/apps/x/installations/new" } as unknown as Github;
  const server = createApp({ config, db, github: () => gh, githubReady: () => true });
  const callback = () => server.request("/auth/github/callback?state=st&code=c", { headers: { Cookie: "gs_oauth=st" } });

  const denied = await callback();
  assert.equal(denied.headers.get("location"), "/?closed=1");
  assert.equal(denied.headers.get("set-cookie")?.includes("gs="), false, "no session for a login not on the list");
  assert.deepEqual({ ...db.sql.prepare("select (select count(*) from users) u, (select count(*) from sessions) s").get() }, { u: 0, s: 0 }, "no user and no session for a login not on the list");

  who = { id: 1, login: "tobi", name: null, avatar_url: "" };
  const ok = await callback();
  assert.equal(ok.headers.get("location"), "/projects/new");
  assert.match(ok.headers.get("set-cookie") ?? "", /gs=[0-9a-f]{64}/);

  // Eve signed in before the instance was closed: her session and her agent token are refused now.
  const eve = db.upsertUser({ github_id: 2, login: "eve", name: null, avatar: null });
  db.setRepos(eve.id, []);
  db.createSession("e".repeat(64), eve.id);
  const cookie = { Cookie: `gs=${"e".repeat(64)}`, "x-gespann": "1" };
  assert.equal((await (await server.request("/api/me", { headers: cookie })).json()).user, null);
  assert.equal((await server.request("/api/projects", { headers: cookie })).status, 401);
  const { token } = db.createToken(eve.id, "agent");
  const mcp = await server.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(mcp.status, 401);
});
