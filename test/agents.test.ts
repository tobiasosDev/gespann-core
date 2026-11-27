import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { checkAgentKey } from "../src/server/agentkeys.ts";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { open } from "../src/server/openrouter.ts";
import { claudeMcpConfig, copilotMcpConfig, grokConfig, keyVariable, LastMessage, launch, mcpServersFromCodex, runAgent } from "../src/verify/agents.ts";

// The browser tool as docs/self-host.md sets it up for Codex, plus one HTTP server and a disabled one.
const CODEX_CONFIG = `
model = "gpt-6.1-terra"

[mcp_servers.browser]
command = "/home/gespann/.local/bin/playwright-mcp"
args = ["--browser", "chromium", "--viewport-size", "1440x900"]
env_vars = ["DISPLAY"]
env = { PLAYWRIGHT_BROWSERS_PATH = "/home/gespann/.cache/ms-playwright" }
tool_timeout_sec = 120

[mcp_servers.docs]
url = "https://docs.example.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"
http_headers = { "X-Team" = "qa" }

[mcp_servers.off]
command = "nope"
enabled = false
`;

test("the browser tools of Codex's config reach Claude Code, Copilot and Grok", () => {
  const servers = mcpServersFromCodex(CODEX_CONFIG, { DISPLAY: ":91", DOCS_TOKEN: "t0k" });
  assert.deepEqual(
    servers.map((s) => s.name),
    ["browser", "docs"],
    "a disabled server stays off",
  );
  const [browser, docs] = servers;
  assert.deepEqual(browser?.env, { DISPLAY: ":91", PLAYWRIGHT_BROWSERS_PATH: "/home/gespann/.cache/ms-playwright" }, "the sandbox's own DISPLAY, as Codex passes it");
  assert.deepEqual(docs?.headers, { "X-Team": "qa", Authorization: "Bearer t0k" });

  const claude = JSON.parse(claudeMcpConfig(servers));
  assert.deepEqual(claude.mcpServers.browser, { type: "stdio", command: "/home/gespann/.local/bin/playwright-mcp", args: ["--browser", "chromium", "--viewport-size", "1440x900"], env: browser?.env });
  assert.deepEqual(claude.mcpServers.docs, { type: "http", url: "https://docs.example.com/mcp", headers: docs?.headers });

  const copilot = JSON.parse(copilotMcpConfig(servers));
  assert.equal(copilot.mcpServers.browser.type, "local");
  assert.deepEqual(copilot.mcpServers.browser.tools, ["*"], "Copilot offers only the tools it is told to");

  const grok = parse(grokConfig('installer_source = "script"\n[mcp_servers.old]\ncommand = "x"\n', servers)) as Record<string, Record<string, Record<string, unknown>>>;
  assert.equal((grok as unknown as Record<string, unknown>).installer_source, "script", "the installer's settings stay");
  assert.deepEqual(Object.keys(grok.mcp_servers ?? {}), ["browser", "docs"], "servers from an earlier run are replaced");
  assert.equal(grok.mcp_servers?.browser?.tool_timeout_sec, 120);
  assert.equal(JSON.stringify(parse(grokConfig("not = [toml", []))), JSON.stringify({ mcp_servers: {} }), "a broken config starts over");
});

test("each CLI runs headless with every tool allowed, the PR's own agent settings left out", () => {
  const base = { prompt: "test the PR", promptFile: "/w/prompt.txt", mcpFile: "/w/mcp.json" };
  const claude = launch("claude", { ...base, model: "claude-sonnet-5-5", effort: "medium" });
  assert.equal(claude.bin, "claude");
  assert.equal(claude.stdin, "test the PR");
  for (const a of ["-p", "--dangerously-skip-permissions", "--strict-mcp-config"]) assert.ok(claude.args.includes(a), a);
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--setting-sources"), claude.args.indexOf("--setting-sources") + 2), ["--setting-sources", "user"]);
  // The scrub would force every command into Claude Code's own sandbox, without Docker: the copy could not run.
  assert.equal(claude.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
  assert.equal(claude.env.IS_SANDBOX, "1", "sandboxes may run as root");

  const copilot = launch("copilot", { ...base, model: "auto" });
  assert.deepEqual(copilot.args.slice(0, 2), ["-p", "test the PR"]);
  for (const a of ["--allow-all", "--disable-builtin-mcps", "@/w/mcp.json"]) assert.ok(copilot.args.includes(a), a);
  assert.equal(copilot.args[copilot.args.indexOf("--secret-env-vars") + 1], "COPILOT_GITHUB_TOKEN");
  const long = launch("copilot", { ...base, prompt: "x".repeat(200_000) });
  assert.match(long.args[1] as string, /Your task is in the file \/w\/prompt\.txt/, "a prompt too long for one argument goes by file");

  const grok = launch("grok", { ...base, model: "grok-4.7", effort: "high" });
  assert.deepEqual(grok.args.slice(0, 2), ["--prompt-file", "/w/prompt.txt"]);
  for (const a of ["--always-approve", "-m", "grok-4.7", "--effort", "high"]) assert.ok(grok.args.includes(a), a);

  assert.equal(keyVariable("claude", "sk-ant-oat01-abc"), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(keyVariable("claude", "sk-ant-api03-abc"), "ANTHROPIC_API_KEY");
  assert.equal(keyVariable("copilot", "github_pat_x"), "COPILOT_GITHUB_TOKEN");
  assert.equal(keyVariable("grok", "xai-x"), "XAI_API_KEY");
});

test("the last message is the agent's final answer, as codex exec -o writes it", () => {
  const claude = new LastMessage("claude");
  for (const l of [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Opening the page"},{"type":"tool_use","name":"browser_navigate"}]}}',
    '{"type":"result","subtype":"success","result":"cannot: the copy has no mail server"}',
  ])
    claude.line(l);
  assert.equal(claude.text, "cannot: the copy has no mail server");

  // Copilot's JSONL, as `copilot -p … --output-format json` prints it (1.0.116).
  const copilot = new LastMessage("copilot");
  for (const l of [
    '{"type":"assistant.message_delta","data":{"deltaContent":"P"}}',
    '{"type":"assistant.message","data":{"content":"","toolRequests":[{"name":"bash"}]}}',
    '{"type":"assistant.message","data":{"content":"{\\"ok\\":true}","phase":"final_answer"}}',
    '{"type":"result","exitCode":0}',
  ])
    copilot.line(l);
  assert.equal(copilot.text, '{"ok":true}');

  const grok = new LastMessage("grok");
  grok.line('{"text":"done","stopReason":"EndTurn","sessionId":"a"}');
  assert.equal(grok.text, "done");

  // What grok 1.0.92 prints: a warning, then the object over many lines.
  const pretty = new LastMessage("grok");
  const out = `warning: grok-4.20 has no effort levels; ignoring --effort medium\n${JSON.stringify({ text: '{"word": "KUMQUAT"}', stopReason: "end_turn", usage: { output_tokens: 273 } }, null, 2)}`;
  for (const l of out.split("\n")) pretty.line(l);
  assert.equal(pretty.text, '{"word": "KUMQUAT"}');

  const plain = new LastMessage("grok");
  plain.line("Error: not authenticated");
  assert.equal(plain.text, "", "an error is no answer: it would become the suggested checks");
  assert.equal(plain.printed, "Error: not authenticated", "it goes into the failed step's output instead");
  plain.note("401: invalid x-api-key");
  assert.equal(plain.text, "");
  assert.match(plain.printed, /401: invalid x-api-key$/, "stderr counts for the error too");

  // A failed step names the error, not the progress message before it.
  const failed = new LastMessage("copilot");
  failed.line('{"type":"assistant.message","data":{"content":"I will inspect the tests"}}');
  failed.note("Error: rate limit exceeded");
  assert.equal(failed.failure, "Error: rate limit exceeded");
  const claudeError = new LastMessage("claude");
  claudeError.line('{"type":"result","is_error":true,"result":"Invalid API key"}');
  assert.equal(claudeError.failure, "Invalid API key", "without other output: the error result");
});

test("gespann agent: the key file is gone before the agent starts, and the agent gets the key and the browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-agent-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  for (const d of [home, bin, join(home, ".codex")]) (await import("node:fs")).mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), CODEX_CONFIG);
  const keyFile = join(home, ".gespann-agent-key");
  writeFileSync(keyFile, "sk-ant-oat01-secret-token-0123456789abcdef\n");
  // A stand-in for Claude Code: reports what it sees, as stream-json.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
cat > ${JSON.stringify(join(dir, "stdin.txt"))}
printf '%s\\n' "$@" > ${JSON.stringify(join(dir, "args.txt"))}
key_file_left=no; [ -e ${JSON.stringify(keyFile)} ] && key_file_left=yes
echo '{"type":"system","subtype":"init"}'
echo "{\\"type\\":\\"result\\",\\"result\\":\\"token=$CLAUDE_CODE_OAUTH_TOKEN api=\${ANTHROPIC_API_KEY:-none} file=$key_file_left\\"}"
echo "progress on stderr" >&2
exit \${FAKE_EXIT:-0}
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "Test PR 7.");
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, DISPLAY: process.env.DISPLAY };
  Object.assign(process.env, { HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(home, ".codex"), DISPLAY: ":77" });
  try {
    const code = await runAgent({ agent: "claude", model: "claude-sonnet-5-5", effort: "medium", promptFile, lastFile: join(dir, "last.txt"), logFile: join(dir, "claude.jsonl"), keyFile });
    assert.equal(code, 0, "the agent's exit code");
    assert.equal(readFileSync(join(dir, "last.txt"), "utf8"), "token=sk-ant-oat01-secret-token-0123456789abcdef api=none file=no");
    // A failed step leaves no answer, as codex exec -o does.
    writeFileSync(keyFile, "sk-ant-oat01-secret-token-0123456789abcdef\n");
    process.env.FAKE_EXIT = "3";
    assert.equal(await runAgent({ agent: "claude", promptFile, lastFile: join(dir, "last.txt"), logFile: join(dir, "claude2.jsonl"), keyFile }), 3);
    assert.equal(readFileSync(join(dir, "last.txt"), "utf8"), "");
    delete process.env.FAKE_EXIT;
    writeFileSync(keyFile, "sk-ant-oat01-secret-token-0123456789abcdef\n");
    await runAgent({ agent: "claude", model: "claude-sonnet-5-5", effort: "medium", promptFile, lastFile: join(dir, "last.txt"), logFile: join(dir, "claude.jsonl"), keyFile });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  assert.equal(existsSync(keyFile), false);
  assert.equal(readFileSync(join(dir, "stdin.txt"), "utf8"), "Test PR 7.");
  const args = readFileSync(join(dir, "args.txt"), "utf8").split("\n");
  const mcp = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1] as string, "utf8"));
  assert.equal(mcp.mcpServers.browser.env.DISPLAY, ":77", "the browser opens on the sandbox's screen");
  const log = readFileSync(join(dir, "claude.jsonl"), "utf8");
  assert.match(log, /progress on stderr/);
  assert.match(log, /"type":"system"/);
});

test("gespann agent: no key, no agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-agent-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "  \n");
  await assert.rejects(runAgent({ agent: "grok", promptFile: join(dir, "p"), lastFile: join(dir, "l"), logFile: join(dir, "j"), keyFile }), /no key for the agent/);
  assert.equal(existsSync(keyFile), false, "even an empty key file goes");
});

/** Anthropic, GitHub and xAI as the key checks need them: one good key each. */
function fakeProviders(seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const h = new Headers(init?.headers);
    if (url.startsWith("https://api.anthropic.com/")) return new Response("{}", { status: h.get("x-api-key") === `sk-ant-api03-${"a".repeat(30)}` ? 200 : 401 });
    if (url === "https://api.github.com/user") return h.get("authorization") === `Bearer github_pat_${"g".repeat(30)}` ? new Response(JSON.stringify({ login: "tobi" })) : new Response("{}", { status: 401 });
    if (url === "https://api.x.ai/v1/api-key") {
      if (h.get("authorization") === `Bearer xai-${"x".repeat(40)}`) return new Response(JSON.stringify({ name: "gespann", redacted_api_key: "xai-…xxxx", api_key_blocked: false, api_key_disabled: false }));
      return new Response("{}", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("keys are checked with their provider; a Claude token by its form", async () => {
  const f = fakeProviders();
  assert.match((await checkAgentKey("claude", ` sk-ant-oat01-${"t".repeat(40)} `, f)).label, /^Claude subscription token sk-ant-oat01…tttt$/);
  assert.match((await checkAgentKey("claude", `sk-ant-api03-${"a".repeat(30)}`, f)).label, /^Anthropic API key/);
  await assert.rejects(checkAgentKey("claude", `sk-ant-api03-${"b".repeat(30)}`, f), /Anthropic does not accept this key/);
  await assert.rejects(checkAgentKey("claude", "sk-or-v1-abc", f), /sk-ant-api/);
  assert.equal((await checkAgentKey("copilot", `github_pat_${"g".repeat(30)}`, f)).label, "GitHub @tobi · github_pat_g…gggg");
  await assert.rejects(checkAgentKey("copilot", `ghp_${"h".repeat(36)}`, f), /GitHub does not accept this token/);
  assert.match((await checkAgentKey("grok", `xai-${"x".repeat(40)}`, f)).label, /^xAI key "gespann"/);
  await assert.rejects(checkAgentKey("grok", `xai-${"y".repeat(40)}`, f), /xAI does not accept this key/);
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  await assert.rejects(checkAgentKey("grok", `xai-${"x".repeat(40)}`, down), (e: Error & { status?: number }) => e.status === 502 && /xAI did not answer/.test(e.message));
});

test("API: Claude Code, Copilot and Grok keys and models; setup starts once the key is there; keys never leave the server", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no github in this test"); }, githubReady: () => false, fetch: fakeProviders() });
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: "T", avatar: null });
  db.setRepos(u.id, [{ repo_id: 1, installation_id: 9, account: "acme", full_name: "acme/shop", private: true, default_branch: "main" }]);
  db.createSession("s".repeat(64), u.id);
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1" };
  const get = async (path: string) => (await server.request(`/api${path}`, { headers: h })).json();
  const post = async (path: string, body: unknown) => server.request(`/api${path}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const s0 = await get("/settings");
  assert.deepEqual(
    s0.keyAgents.map((a: { id: string; connected: boolean }) => [a.id, a.connected]),
    [
      ["claude", false],
      ["copilot", false],
      ["grok", false],
    ],
  );
  db.setCodex(u.id, { codex_state: "connected" });
  assert.equal((await post("/settings/agent", { agent: "claude" })).status, 200);
  assert.equal(db.agentReady(u.id), false, "a Codex sign-in does not run Claude Code");
  assert.equal(db.project(p)?.setup, "none");

  assert.equal((await post("/settings/agents/gemini/key", { key: "x" })).status, 404);
  const refused = await post("/settings/agents/claude/key", { key: `sk-ant-api03-${"b".repeat(30)}` });
  assert.equal(refused.status, 400);
  const token = `sk-ant-oat01-${"t".repeat(40)}`;
  assert.equal((await post("/settings/agents/claude/key", { key: token })).status, 200);
  assert.equal(db.project(p)?.setup, "queued", "the key is all Claude Code needs: the setup starts by itself");
  assert.equal((await post("/settings/agents/claude/model", { model: "bad model" })).status, 400);
  assert.equal((await post("/settings/agents/claude/model", { model: "claude-sonnet-5-5" })).status, 200);

  const s1 = await get("/settings");
  assert.equal(s1.agent, "claude");
  const claude = s1.keyAgents.find((a: { id: string }) => a.id === "claude");
  assert.deepEqual([claude.connected, claude.model, claude.name], [true, "claude-sonnet-5-5", "Claude Code"]);
  const detail = await get(`/projects/${p}`);
  assert.deepEqual([detail.agent, detail.agent_ready, detail.agent_model], ["claude", true, "claude-sonnet-5-5"]);
  for (const body of [s1, detail]) assert.equal(JSON.stringify(body).includes("tttttttttttttttt"), false, "the key never leaves the server");
  const stored = db.sql.prepare("select claude_key from users where id = ?").get(u.id) as { claude_key: string };
  assert.equal(open(config.sessionSecret, stored.claude_key), token, "kept sealed, as the orchestrator opens it");

  // Each agent keeps its own key; switching needs that agent's key.
  assert.equal((await post("/settings/agent", { agent: "grok" })).status, 200);
  assert.equal(db.agentReady(u.id), false);
  assert.equal((await post("/settings/agents/grok/key", { key: `xai-${"x".repeat(40)}` })).status, 200);
  assert.equal(db.agentReady(u.id), true);
  assert.equal((await post("/settings/agent", { agent: "copilot" })).status, 200);
  assert.equal((await post("/settings/agents/copilot/key", { key: `github_pat_${"g".repeat(30)}` })).status, 200);
  assert.equal((await get("/settings")).keyAgents.find((a: { id: string }) => a.id === "copilot").label, "GitHub @tobi · github_pat_g…gggg");
  assert.equal((await post("/settings/agents/copilot/logout", {})).status, 200);
  assert.equal(db.agentReady(u.id), false);
  assert.equal(db.agent(u.id)?.claude.connected, true, "removing one key leaves the others");
});
