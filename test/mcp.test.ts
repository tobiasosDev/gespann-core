import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f3d2b50000000049454e44ae426082", "hex");

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "gespann-mcp-"));
  const config = loadConfig({ DATA_DIR: dataDir, ADMIN_TOKEN: "adm-token", BASE_URL: "http://localhost:3000" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no github in this test"); }, githubReady: () => false });
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
  assert.equal((await server.request("/.well-known/oauth-protected-resource")).status, 404, "no web app page for OAuth discovery");
});

test("MCP: handshake and tool list; every tool is read-only", async () => {
  const { db, tobi, rpc, server } = setup();
  const { token } = db.createToken(tobi.id, "x");
  const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.body?.result.protocolVersion, "2025-06-18");
  assert.equal(init.body?.result.serverInfo.name, "gespann");
  assert.equal((await rpc(token, "initialize", { protocolVersion: "2024-11-05" })).body?.result.protocolVersion, "2025-11-25", "versions without resource_link are not offered");
  const note = await server.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
  const tools = (await rpc(token, "tools/list")).body?.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
  assert.deepEqual(tools.map((t) => t.name), ["list_projects", "list_runs", "get_run", "get_review", "get_run_file", "get_run_log"]);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  assert.equal((await rpc(token, "tools/call", { name: "rerun", arguments: {} })).body?.error?.code, -32602);
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
