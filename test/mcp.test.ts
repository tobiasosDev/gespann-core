import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { Github, PullRequest } from "../src/server/github.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f3d2b50000000049454e44ae426082", "hex");

function setup(gh?: unknown) {
  const dataDir = mkdtempSync(join(tmpdir(), "gespann-mcp-"));
  const config = loadConfig({ DATA_DIR: dataDir, ADMIN_TOKEN: "adm-token", BASE_URL: "http://localhost:3000" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { if (!gh) throw new Error("no github in this test"); return gh as Github; }, githubReady: () => !!gh });
  const tobi = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const eve = db.upsertUser({ github_id: 2, login: "eve", name: null, avatar: null });
  db.setRepos(tobi.id, [{ repo_id: 1, installation_id: 9, account: "acme", full_name: "acme/shop", private: true, default_branch: "main" }]);
  db.setRepos(eve.id, [{ repo_id: 2, installation_id: 9, account: "evil", full_name: "evil/other", private: true, default_branch: "main" }]);
  const shop = db.createProject({ owner_id: tobi.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const other = db.createProject({ owner_id: eve.id, installation_id: 9, repo: "evil/other", repo_id: 2, default_branch: "main" });

  const old = db.createRun({ project_id: shop, pr: 7, title: "Checkout", head: "a".repeat(40), base: "b".repeat(40), base_ref: "main", token: "1".repeat(32) });
  db.updateRun(old, { status: "done", outcome: "PASS" });
  const run = db.createRun({ project_id: shop, pr: 7, title: "Checkout", head: "c".repeat(40), base: "b".repeat(40), base_ref: "main", token: "2".repeat(32) });
  const judged = {
    outcome: "FAIL",
    problems: [],
    verdict: {
      verdict: "FAIL",
      summary: "The pay button does nothing.",
      proof: ["cart.png"],
      checks: [
        { expect: "Cart shows the item", observed: "It does", result: "pass", proof: ["cart.png"] },
        { expect: "Pay opens the payment page", observed: "Nothing happens on click", result: "fail", proof: ["pay.png"] },
      ],
    },
  };
  db.updateRun(run, { status: "done", outcome: "FAIL", verdict: JSON.stringify(judged), files: JSON.stringify(["cart.png", "pay.png", "recording.mp4", "verdict.json"]) });
  const dir = join(dataDir, "runs", String(run));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cart.png"), PNG);
  writeFileSync(join(dir, "pay.png"), PNG);
  writeFileSync(join(dir, "recording.mp4"), Buffer.alloc(2048));
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(judged.verdict));
  const job = db.enqueue(shop, "run", run);
  db.appendLog(job, "copy up");
  db.appendLog(job, "verdict: FAIL");
  const foreign = db.createRun({ project_id: other, pr: 1, title: "secret", head: "d".repeat(40), base: "e".repeat(40), base_ref: "main", token: "3".repeat(32) });

  let n = 0;
  const rpc = async (token: string | null, method: string, params?: unknown, extra: Record<string, string> = {}) => {
    const res = await server.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as { result?: any; error?: { code: number; message: string } }) };
  };
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, "tools/call", { name, arguments: args })).body?.result;
  return { db, server, tobi, eve, shop, run, old, foreign, rpc, call };
}

test("MCP: a token is needed; a revoked or wrong token is refused; the admin token sees every project", async () => {
  const { db, server, tobi, rpc, call } = setup();
  assert.equal((await rpc(null, "ping")).status, 401);
  assert.equal((await rpc("gsp_nope", "ping")).status, 401);
  assert.equal((await rpc("adm-token-x", "ping")).status, 401);
  const { id, token } = db.createToken(tobi.id, "laptop");
  assert.match(token, /^gsp_[0-9a-f]{48}$/);
  assert.equal((await rpc(token, "ping")).status, 200);
  assert.ok(db.tokens(tobi.id)[0]?.last_used, "use is noted");
  assert.ok(!JSON.stringify(db.tokens(tobi.id)).includes(token.slice(4, 40)), "only a hash is stored");
  const all = await call("adm-token", "list_projects");
  assert.deepEqual(all.structuredContent.projects.map((p: { repo: string }) => p.repo), ["acme/shop", "evil/other"]);
  // Repository access comes from the last sign-in; after 7 days the token waits for a new one.
  db.sql.prepare("update users set repos_synced = ? where id = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), tobi.id);
  const stale = await rpc(token, "ping");
  assert.equal(stale.status, 401);
  assert.match(stale.body?.error?.message ?? "", /sign in to gespann again/);
  db.setRepos(tobi.id, db.repos(tobi.id));
  assert.equal((await rpc(token, "ping")).status, 200, "a new sign-in restores access");
  db.deleteToken(tobi.id, id);
  assert.equal((await rpc(token, "ping")).status, 401);
  // A foreign web page in the user's browser cannot use the endpoint.
  assert.equal((await rpc("adm-token", "ping", undefined, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await server.request("/mcp")).status, 405);
  assert.equal((await server.request("/.well-known/openid-configuration")).status, 404, "no web app page for other discovery documents");
});

test("MCP: handshake and tool list; every tool but rerun is read-only", async () => {
  const { db, tobi, rpc, server } = setup();
  const { token } = db.createToken(tobi.id, "x");
  const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.body?.result.protocolVersion, "2025-06-18");
  assert.equal(init.body?.result.serverInfo.name, "gespann");
  assert.equal((await rpc(token, "initialize", { protocolVersion: "2024-11-05" })).body?.result.protocolVersion, "2025-11-25", "versions without resource_link are not offered");
  const note = await server.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const tools = (await rpc(token, "tools/list")).body?.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
  assert.deepEqual(tools.map((t) => t.name), ["list_projects", "list_runs", "get_run", "get_review", "get_run_file", "get_run_log", "rerun"]);
  assert.ok(tools.every((t) => !t.annotations.destructiveHint));
  assert.deepEqual(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ["rerun"]);
  assert.equal((await rpc(token, "tools/call", { name: "cancel", arguments: {} })).body?.error?.code, -32602);
  assert.equal((await rpc(token, "resources/list")).body?.error?.code, -32601);
});

test("MCP: an agent reads the newest run of its PR: status, issues, review, screenshot, recording and log", async () => {
  const { db, tobi, run, call } = setup();
  const { token } = db.createToken(tobi.id, "x");

  const r = (await call(token, "get_run", { repo: "acme/shop", pr: 7 })).structuredContent;
  assert.equal(r.run_id, run, "the newest run of the PR");
  assert.equal(r.status, "done");
  assert.equal(r.outcome, "FAIL");
  assert.equal(r.summary, "The pay button does nothing.");
  assert.deepEqual(r.issues, [{ kind: "check_failed", text: "Pay opens the payment page", observed: "Nothing happens on click", proof: ["pay.png"] }]);
  assert.equal(r.checks.length, 2);
  assert.deepEqual(r.files.map((f: { kind: string }) => f.kind), ["image", "image", "video", "data"]);
  assert.equal(r.files[2].url, `http://localhost:3000/proof/${"2".repeat(32)}/recording.mp4`);

  const runs = (await call(token, "list_runs", { project: "acme/shop", pr: 7 })).structuredContent.runs;
  assert.equal(runs.length, 2);

  assert.match((await call(token, "get_review", { run_id: run })).content[0].text, /^Not posted on the pull request/, "no comment id: an ungated SKIP or a failed post");
  db.updateRun(run, { comment_id: 99 });
  const review = (await call(token, "get_review", { run_id: run })).content[0].text as string;
  assert.match(review, /^### ❌ gespann: FAIL · 1\/2 checks passed/);
  assert.match(review, /Pay opens the payment page/);

  const shot = await call(token, "get_run_file", { run_id: run, file: "pay.png" });
  assert.equal(shot.content[0].type, "image");
  assert.equal(shot.content[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(shot.content[0].data, "base64"), PNG);

  const video = await call(token, "get_run_file", { run_id: run, file: "recording.mp4" });
  assert.match(video.content[0].text, /screen recording \(2048 bytes, video\/mp4\)/);
  assert.equal(video.content[1].type, "resource_link");
  assert.equal(video.content[1].uri, `http://localhost:3000/proof/${"2".repeat(32)}/recording.mp4`);

  assert.match((await call(token, "get_run_file", { run_id: run, file: "verdict.json" })).content[0].text, /pay button/);
  const traversal = await call(token, "get_run_file", { run_id: run, file: "../../etc/passwd" });
  assert.equal(traversal.isError, true, "only files the run kept");

  assert.deepEqual(r.merge_gate, { on: false });
  db.updateProject(db.run_(run)!.project_id, { gate: 1 });
  db.setHold(db.run_(run)!.project_id, 7, { held: 1 });
  assert.deepEqual((await call(token, "get_run", { run_id: run })).structuredContent.merge_gate, { on: true, held_as_draft: true, approved_by: null, approved_head: null });
  const queued = db.createRun({ project_id: db.run_(run)!.project_id, pr: 7, title: "t", head: "f".repeat(40), base: "b".repeat(40), base_ref: "main", token: "4".repeat(32) });
  db.cancelQueuedRuns(db.run_(run)!.project_id, 7);
  assert.match((await call(token, "get_review", { run_id: queued })).content[0].text, /was cancelled .*no review/);

  const log = (await call(token, "get_run_log", { run_id: run })).content[0].text as string;
  assert.match(log, /copy up\n.*verdict: FAIL/);
});

test("MCP: a run with merge conflicts tells the agent to update the branch; it is not a FAIL", async () => {
  const { db, tobi, shop, call } = setup();
  const { token } = db.createToken(tobi.id, "x");
  const run = db.createRun({ project_id: shop, pr: 8, title: "Sizes", head: "9".repeat(40), base: "b".repeat(40), base_ref: "main", token: "5".repeat(32) });
  db.updateRun(run, { status: "done", outcome: null, conflict: JSON.stringify(["web/src/pages/Project.tsx"]) });
  const r = (await call(token, "get_run", { repo: "acme/shop", pr: 8 })).structuredContent;
  assert.equal(r.outcome, null);
  assert.deepEqual(r.conflict, ["web/src/pages/Project.tsx"]);
  assert.deepEqual(r.issues, [
    {
      kind: "merge_conflict",
      text: "Not tested: the PR has merge conflicts with main in `web/src/pages/Project.tsx`",
      fix: "Merge main into the PR branch (or rebase onto it), resolve the conflicts in `web/src/pages/Project.tsx` and push. gespann tests the new head when the push starts a run; if none starts (a draft, or a PR outside the recipe's triggers), use Rerun on the run page.",
    },
  ]);
  const review = (await call(token, "get_review", { run_id: run })).content[0].text as string;
  assert.match(review, /### 🔀 gespann: not tested, merge conflict/);
  assert.match(review, /`9999999` does not merge onto `main`/);
});

test("MCP: a user never reads runs of projects they cannot see", async () => {
  const { db, tobi, foreign, call } = setup();
  const { token } = db.createToken(tobi.id, "x");
  assert.deepEqual((await call(token, "list_projects")).structuredContent.projects.map((p: { repo: string }) => p.repo), ["acme/shop"]);
  for (const [name, args] of [
    ["get_run", { run_id: foreign }],
    ["get_run", { repo: "evil/other", pr: 1 }],
    ["get_review", { run_id: foreign }],
    ["get_run_log", { run_id: foreign }],
    ["get_run_file", { run_id: foreign, file: "x.png" }],
    ["list_runs", { project: "evil/other" }],
  ] as const) {
    const res = await call(token, name, args);
    assert.equal(res.isError, true, name);
    assert.doesNotMatch(JSON.stringify(res), /secret/);
  }
});

test("API: tokens are created, listed without the secret, and revoked only by their owner", async () => {
  const { db, server, tobi, eve } = setup();
  db.createSession("t".repeat(64), tobi.id);
  db.createSession("e".repeat(64), eve.id);
  const as = (sid: string) => ({ Cookie: `gs=${sid}`, "x-gespann": "1", "Content-Type": "application/json" });
  const created = (await (await server.request("/api/tokens", { method: "POST", headers: as("t".repeat(64)), body: JSON.stringify({ name: "laptop" }) })).json()) as { id: number; token: string };
  assert.match(created.token, /^gsp_/);
  const list = (await (await server.request("/api/tokens", { headers: as("t".repeat(64)) })).json()) as { tokens: { name: string; hint: string }[]; mcpUrl: string };
  assert.equal(list.mcpUrl, "http://localhost:3000/mcp");
  assert.deepEqual(list.tokens.map((t) => [t.name, t.hint]), [["laptop", created.token.slice(-4)]]);
  assert.ok(!JSON.stringify(list).includes(created.token));
  await server.request(`/api/tokens/${created.id}/revoke`, { method: "POST", headers: as("e".repeat(64)), body: "{}" });
  assert.equal(db.tokens(tobi.id).length, 1, "another user cannot revoke it");
  await server.request(`/api/tokens/${created.id}/revoke`, { method: "POST", headers: as("t".repeat(64)), body: "{}" });
  assert.equal(db.tokens(tobi.id).length, 0);
});

test("MCP OAuth: an agent discovers the sign-in, registers, gets the user's consent and reads runs; refresh rotates", async () => {
  const { db, server, tobi, rpc, call } = setup();
  const base = "http://localhost:3000";
  // 1. The 401 points at the protected-resource metadata, which names gespann as authorization server.
  const denied = await server.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = (await (await server.request("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string; authorization_servers: string[] };
  assert.deepEqual(prm, { ...prm, resource: `${base}/mcp`, authorization_servers: [base] });
  const asm = (await (await server.request("/.well-known/oauth-authorization-server")).json()) as Record<string, string & string[]>;
  assert.equal(asm.issuer, base);
  assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

  // 2. Dynamic client registration: loopback http is fine, plain http elsewhere is not.
  const reg = async (body: unknown) => server.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await reg({ redirect_uris: ["http://evil.example/cb"] })).status, 400);
  const registered = await reg({ client_name: "Claude Code (gespann)", redirect_uris: ["http://localhost:61234/callback"], token_endpoint_auth_method: "none" });
  assert.equal(registered.status, 201);
  const client = (await registered.json()) as { client_id: string };
  const forged = client.client_id.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA");

  const verifier = "v".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "http://localhost:50000/callback"; // loopback: any port
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st8", resource: `${base}/mcp`, scope: "read" });

  // 3. Not signed in: off to GitHub, and back here afterwards.
  const anon = await server.request(`/oauth/authorize?${q}`);
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/auth/github");
  assert.match(anon.headers.get("set-cookie") ?? "", /gs_next=%2Foauth%2Fauthorize%3F/);
  // A forged client id or an unregistered return address is shown, never redirected to.
  assert.equal((await server.request(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), client_id: forged })}`)).status, 400);
  assert.equal((await server.request(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example/cb" })}`)).status, 400);
  assert.equal((await server.request(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://localhost:50000/callback" })}`)).status, 400, "loopback: only the port may differ");
  // Other request errors are shown too: anyone can register a client, so no error redirects.
  assert.equal((await server.request(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), code_challenge: "" })}`)).status, 400);

  // 4. Signed in: the consent page names the agent; its policy lets the form return to the agent.
  db.createSession("sid-tobi", tobi.id);
  const cookie = { Cookie: "gs=sid-tobi" };
  const consent = await server.request(`/oauth/authorize?${q}`, { headers: cookie });
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get("content-security-policy") ?? "", /form-action 'self' http:\/\/localhost:50000;/);
  const pageHtml = await consent.text();
  assert.match(pageHtml, /Allow <b>Claude Code \(gespann\)<\/b> to read your gespann runs\?/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(pageHtml)?.[1] ?? "";
  const post = (fields: Record<string, string>) => server.request("/oauth/authorize", { method: "POST", headers: { ...cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(q), ...fields }).toString() });
  assert.equal((await post({ csrf: "wrong", decision: "allow" })).status, 400, "a cross-site form cannot approve");
  const no = await post({ csrf, decision: "deny" });
  assert.equal(no.status, 200, "cancel stays on gespann");
  assert.match(await no.text(), /href="http:\/\/localhost:50000\/callback\?state=st8&amp;iss=[^"]*&amp;error=access_denied"/);
  const yes = new URL((await post({ csrf, decision: "allow" })).headers.get("location") ?? "");
  assert.equal(`${yes.origin}${yes.pathname}`, redirect);
  assert.equal(yes.searchParams.get("state"), "st8");
  assert.equal(yes.searchParams.get("iss"), base);
  const code = yes.searchParams.get("code") ?? "";

  // 5. Code for tokens: PKCE is checked, a code works once.
  const token = async (fields: Record<string, string>) => {
    const res = await server.request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client.client_id, resource: `${base}/mcp`, ...fields }).toString() });
    return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
  };
  assert.equal((await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: "w".repeat(50) })).body.error, "invalid_grant");
  // The wrong verifier burnt the code: the client has to start over, as with a stolen code.
  const again = await post({ csrf, decision: "allow" });
  const code2 = new URL(again.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const code3 = new URL((await post({ csrf, decision: "allow" })).headers.get("location") ?? "").searchParams.get("code") ?? "";
  assert.equal((await token({ grant_type: "authorization_code", code: code3, redirect_uri: redirect })).body.error, "invalid_grant", "no verifier, no token");
  const t1 = await token({ grant_type: "authorization_code", code: code2, redirect_uri: redirect, code_verifier: verifier });
  assert.equal(t1.status, 200);
  assert.equal(t1.body.expires_in, 3600);
  assert.equal((await token({ grant_type: "authorization_code", code: code2, redirect_uri: redirect, code_verifier: verifier })).body.error, "invalid_grant", "a code works once");

  // 6. The access token reads only the user's projects; the sign-in shows up under Agent access.
  const projects = await call(t1.body.access_token, "list_projects");
  assert.deepEqual(projects.structuredContent.projects.map((p: { repo: string }) => p.repo), ["acme/shop"]);
  const listed = db.tokens(tobi.id);
  assert.deepEqual(listed.map((t) => [t.name, t.client]), [["Claude Code (gespann)", client.client_id]]);

  // 7. Refresh rotates both tokens; the old ones stop working.
  const t2 = await token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token });
  assert.equal(t2.status, 200);
  assert.equal((await rpc(t1.body.access_token, "ping")).status, 401);
  assert.equal((await rpc(t2.body.access_token, "ping")).status, 200);
  // An expired access token is refused, which makes the agent refresh.
  db.sql.prepare("update api_tokens set expires = ? where client is not null").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await rpc(t2.body.access_token, "ping")).status, 401);
  // A stale repository list makes the refresh fail, so the agent sends the user through GitHub again.
  db.sql.prepare("update users set repos_synced = ? where id = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), tobi.id);
  assert.match((await token({ grant_type: "refresh_token", refresh_token: t2.body.refresh_token })).body.error ?? "", /invalid_grant/);
  // Revoking under Settings ends the sign-in.
  db.setRepos(tobi.id, db.repos(tobi.id));
  const t3 = await token({ grant_type: "refresh_token", refresh_token: t2.body.refresh_token });
  assert.equal(t3.status, 200);
  db.deleteToken(tobi.id, listed[0]!.id);
  assert.equal((await rpc(t3.body.access_token, "ping")).status, 401);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: t3.body.refresh_token })).body.error, "invalid_grant");

  // A made-up refresh token for someone's sign-in changes nothing.
  const s0 = await token({ grant_type: "authorization_code", code: new URL((await post({ csrf, decision: "allow" })).headers.get("location") ?? "").searchParams.get("code") ?? "", redirect_uri: redirect, code_verifier: verifier });
  const forgedRefresh = s0.body.refresh_token.replace(/_[0-9a-f]{32}_/, `_${"0".repeat(32)}_`);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: forgedRefresh })).body.error, "invalid_grant");
  assert.equal((await rpc(s0.body.access_token, "ping")).status, 200, "the sign-in survives");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: s0.body.refresh_token })).status, 200);
  // An out-of-range port is refused, not a server error.
  assert.equal((await server.request(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "http://localhost:99999/callback" })}`, { headers: cookie })).status, 400);

  // A spent refresh token, even from two renewals ago, ends the sign-in for whoever holds the newest one.
  const again2 = await post({ csrf, decision: "allow" });
  const c4 = new URL(again2.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const s1 = await token({ grant_type: "authorization_code", code: c4, redirect_uri: redirect, code_verifier: verifier });
  const s2 = await token({ grant_type: "refresh_token", refresh_token: (await token({ grant_type: "refresh_token", refresh_token: s1.body.refresh_token })).body.refresh_token });
  assert.equal(s2.status, 200, "renewed twice");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: s1.body.refresh_token })).body.error, "invalid_grant");
  assert.equal((await rpc(s2.body.access_token, "ping")).status, 401, "the successor is revoked");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: s2.body.refresh_token })).body.error, "invalid_grant");
});

/** The PR on GitHub and the checks gespann creates for it. */
class FakeGithub {
  checks = 0;
  current: PullRequest = {
    number: 7,
    node_id: "PR_7",
    title: "Checkout",
    body: null,
    draft: false,
    state: "open",
    head: { sha: "f".repeat(40), ref: "checkout", repo: { full_name: "acme/shop" } },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "acme/shop" } },
    labels: [],
    html_url: "",
  };
  async pull() {
    return this.current;
  }
  async createCheck() {
    return ++this.checks;
  }
  async updateCheck() {}
}

test("MCP: an agent reruns a failed PR at its current head; no second run while one is queued, none for a closed PR, at most 3 per head", async () => {
  const gh = new FakeGithub();
  const { db, tobi, eve, shop, run, foreign, call } = setup(gh);
  const { token } = db.createToken(tobi.id, "x");

  const notReady = await call(token, "rerun", { run_id: run });
  assert.equal(notReady.isError, true);
  assert.match(notReady.content[0].text, /no prepared environment/);
  db.updateProject(shop, { setup: "ready" });

  const started = await call(token, "rerun", { repo: "acme/shop", pr: 7 });
  assert.equal(started.structuredContent.started, true);
  const fresh = started.structuredContent.run;
  assert.ok(fresh.run_id > run);
  assert.equal(fresh.head, "f".repeat(40), "the PR's current head, not the failed run's");
  assert.equal(fresh.status, "queued");
  assert.equal(db.jobOfRun(fresh.run_id)?.kind, "run", "the worker gets a job");
  assert.equal(gh.checks, 1, "the PR gets its check");

  const again = await call(token, "rerun", { run_id: run });
  assert.equal(again.structuredContent.started, false, "a queued run is not replaced");
  assert.equal(again.structuredContent.run.run_id, fresh.run_id);

  // Up to 3 runs of the same head, then a person decides.
  db.updateRun(fresh.run_id, { status: "done", outcome: "BLOCKED" });
  for (let i = 0; i < 2; i++) {
    const r = (await call(token, "rerun", { run_id: run })).structuredContent;
    assert.equal(r.started, true);
    db.updateRun(r.run.run_id, { status: "failed" });
  }
  const capped = await call(token, "rerun", { run_id: run });
  assert.equal(capped.isError, true);
  assert.match(capped.content[0].text, /already tested 3 times/);
  assert.equal(gh.checks, 3);

  // A new push is a new head: the agent may rerun it.
  gh.current = { ...gh.current, head: { ...gh.current.head, sha: "9".repeat(40) } };
  assert.equal((await call(token, "rerun", { run_id: run })).structuredContent.started, true);
  db.updateRun(db.runsOfPr(shop, 7, 1)[0]!.id, { status: "done", outcome: "PASS" });

  gh.current = { ...gh.current, state: "closed" };
  const closed = await call(token, "rerun", { run_id: run });
  assert.equal(closed.isError, true);
  assert.match(closed.content[0].text, /closed/);

  // Nobody reruns a project they cannot see.
  const { token: eveToken } = db.createToken(eve.id, "x");
  const denied = await call(eveToken, "rerun", { run_id: run });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not found/);
  void foreign;
});

test("MCP: without a GitHub App the instance says it cannot rerun", async () => {
  const { db, tobi, shop, run, call } = setup();
  db.updateProject(shop, { setup: "ready" });
  const { token } = db.createToken(tobi.id, "x");
  const r = await call(token, "rerun", { run_id: run });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no GitHub App/);
});
