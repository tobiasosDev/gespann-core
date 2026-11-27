import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parse, stringify } from "smol-toml";

/**
 * Tester agents besides Codex: Claude Code, GitHub Copilot CLI and Grok. The orchestrator runs every
 * agent step as `gespann agent <name> …` in the sandbox (Codex keeps its own `codex exec`). This command
 * installs the CLI on first use, reads the user's key from a file and deletes that file before the agent
 * starts, gives the agent the browser tools Codex has (the MCP servers in Codex's config.toml), and
 * writes the agent's last message where `codex exec -o` would.
 */
export const TESTER_AGENTS = ["claude", "copilot", "grok"] as const;
export type TesterAgent = (typeof TESTER_AGENTS)[number];

export function isTesterAgent(s: string): s is TesterAgent {
  return (TESTER_AGENTS as readonly string[]).includes(s);
}

/** An MCP server from Codex's config, with `env_vars` and header variables read from the environment. */
export interface McpServer {
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** The enabled `[mcp_servers.*]` of a Codex config.toml. `env` is the environment they would get from Codex. */
export function mcpServersFromCodex(toml: string, env: NodeJS.ProcessEnv): McpServer[] {
  const servers = (parse(toml) as { mcp_servers?: Record<string, Record<string, unknown>> }).mcp_servers ?? {};
  const out: McpServer[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object" || s.enabled === false) continue;
    const command = typeof s.command === "string" ? s.command : undefined;
    const url = typeof s.url === "string" ? s.url : undefined;
    if (!command && !url) continue;
    const vars: Record<string, string> = {};
    for (const k of strs(s.env_vars)) if (env[k] !== undefined) vars[k] = env[k] as string;
    const headers = strMap(s.http_headers);
    for (const [h, k] of Object.entries(strMap(s.env_http_headers))) if (env[k] !== undefined) headers[h] = env[k] as string;
    if (typeof s.bearer_token_env_var === "string" && env[s.bearer_token_env_var]) headers.Authorization = `Bearer ${env[s.bearer_token_env_var]}`;
    out.push({
      name,
      command,
      args: strs(s.args),
      env: { ...vars, ...strMap(s.env) },
      cwd: typeof s.cwd === "string" ? s.cwd : undefined,
      url,
      headers,
      startupTimeoutSec: num(s.startup_timeout_sec),
      toolTimeoutSec: num(s.tool_timeout_sec),
    });
  }
  return out;
}

/** Claude Code's `--mcp-config` file. */
export function claudeMcpConfig(servers: McpServer[]): string {
  const mcpServers = Object.fromEntries(
    servers.map((s) => [s.name, s.command ? { type: "stdio", command: s.command, args: s.args, env: s.env } : { type: "http", url: s.url, headers: s.headers }]),
  );
  return JSON.stringify({ mcpServers });
}

/** Copilot CLI's `--additional-mcp-config` file: every tool of each server allowed. */
export function copilotMcpConfig(servers: McpServer[]): string {
  const mcpServers = Object.fromEntries(
    servers.map((s) => [
      s.name,
      s.command
        ? { type: "local", command: s.command, args: s.args, env: s.env, ...(s.cwd ? { cwd: s.cwd } : {}), tools: ["*"] }
        : { type: "http", url: s.url, headers: s.headers, tools: ["*"] },
    ]),
  );
  return JSON.stringify({ mcpServers });
}

/** Grok's `config.toml` with its `[mcp_servers]` replaced by `servers`; the installer's settings stay. */
export function grokConfig(existing: string, servers: McpServer[]): string {
  let base: Record<string, unknown> = {};
  try {
    base = existing.trim() ? (parse(existing) as Record<string, unknown>) : {};
  } catch {
    // A config Grok cannot read either: start over, Grok writes its own settings again.
  }
  const mcp_servers = Object.fromEntries(
    servers.map((s) => {
      const t: Record<string, unknown> = s.command ? { command: s.command, args: s.args, env: s.env } : { url: s.url, headers: s.headers };
      if (s.startupTimeoutSec) t.startup_timeout_sec = s.startupTimeoutSec;
      if (s.toolTimeoutSec) t.tool_timeout_sec = s.toolTimeoutSec;
      return [s.name, t];
    }),
  );
  return stringify({ ...base, mcp_servers });
}

/** The environment variable that carries the user's key to the agent. */
export function keyVariable(agent: TesterAgent, key: string): string {
  if (agent === "claude") return key.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  if (agent === "copilot") return "COPILOT_GITHUB_TOKEN";
  return "XAI_API_KEY";
}

/** Copilot takes its prompt as an argument; one argument may hold at most 128 KiB on Linux. */
const MAX_ARG = 100_000;

export interface Launch {
  bin: string;
  args: string[];
  /** Written to the agent's stdin; otherwise stdin is empty. */
  stdin?: string;
  env: Record<string, string>;
}

export interface LaunchOpts {
  model?: string;
  effort?: string;
  prompt: string;
  promptFile: string;
  /** Claude Code's MCP config file, Copilot's; Grok reads its config.toml. */
  mcpFile?: string;
}

/** How each CLI runs one prompt headless, with every tool allowed and nothing asked. */
export function launch(agent: TesterAgent, o: LaunchOpts): Launch {
  const model = o.model ? ["--model", o.model] : [];
  if (agent === "claude") {
    return {
      bin: "claude",
      // Only the user's settings: hooks and settings the PR puts into .claude/ do not run in the tester.
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--setting-sources",
        "user",
        ...model,
        ...(o.effort ? ["--effort", o.effort] : []),
        ...(o.mcpFile ? ["--mcp-config", o.mcpFile, "--strict-mcp-config"] : []),
      ],
      stdin: o.prompt,
      // IS_SANDBOX lets it skip permissions as root. Its key scrub stays off: it forces every command
      // into Claude Code's own sandbox (bubblewrap, socat, no Docker socket), where the copy cannot run.
      // Like Codex's OpenRouter key, the key is within reach of the commands the agent runs.
      env: { IS_SANDBOX: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    };
  }
  if (agent === "copilot") {
    const prompt = o.prompt.length <= MAX_ARG ? o.prompt : `Your task is in the file ${o.promptFile}. Read all of it first, then do exactly what it says.`;
    return {
      bin: "copilot",
      args: [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--allow-all",
        "--no-ask-user",
        "--no-color",
        "--no-auto-update",
        // Its own GitHub tools would act with the user's token; the tester needs none of them.
        "--disable-builtin-mcps",
        "--secret-env-vars",
        "COPILOT_GITHUB_TOKEN",
        ...model,
        ...(o.mcpFile ? ["--additional-mcp-config", `@${o.mcpFile}`] : []),
      ],
      env: { COPILOT_AUTO_UPDATE: "false" },
    };
  }
  return {
    bin: "grok",
    args: ["--prompt-file", o.promptFile, "--output-format", "json", "--always-approve", "--no-memory", ...(o.model ? ["-m", o.model] : []), ...(o.effort ? ["--effort", o.effort] : [])],
    env: { GROK_MEMORY: "0" },
  };
}

/** Grok prints one JSON document at the end; more than this is not its answer. */
const MAX_DOC = 4 * 1024 * 1024;

/** Reads the agent's output line by line and keeps its last message. */
export class LastMessage {
  private last = "";
  private plain: string[] = [];
  private doc: string[] = [];
  private docSize = 0;
  private readonly agent: TesterAgent;
  constructor(agent: TesterAgent) {
    this.agent = agent;
  }

  line(l: string): void {
    if (this.agent === "grok") {
      // `--output-format json` pretty-prints one object over many lines, after any warnings.
      if (this.doc.length || l.startsWith("{")) {
        this.docSize += l.length + 1;
        if (this.docSize <= MAX_DOC) this.doc.push(l);
      }
    }
    const t = l.trim();
    if (!t) return;
    let ev: Record<string, unknown> | undefined;
    if (t.startsWith("{")) {
      try {
        ev = JSON.parse(t) as Record<string, unknown>;
      } catch {
        ev = undefined;
      }
    }
    if (!ev) {
      // Kept short: only a fallback when the agent printed no event at all.
      this.plain.push(l);
      if (this.plain.length > 200) this.plain.shift();
      return;
    }
    const data = (ev.data ?? {}) as Record<string, unknown>;
    if (this.agent === "claude") {
      if (ev.type === "result" && typeof ev.result === "string") this.last = ev.result;
      else if (ev.type === "assistant") {
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        const text = Array.isArray(content) ? content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("") : "";
        if (text.trim()) this.last = text;
      }
    } else if (this.agent === "copilot") {
      if (ev.type === "assistant.message" && typeof data.content === "string" && data.content.trim()) this.last = data.content;
    } else if (typeof ev.text === "string") {
      this.last = ev.text;
    }
  }

  get text(): string {
    if (this.agent === "grok" && !this.last && this.doc.length) {
      try {
        const d = JSON.parse(this.doc.join("\n")) as { text?: unknown };
        if (typeof d.text === "string") return d.text;
      } catch {
        // Not one JSON document: fall back to what it printed.
      }
    }
    return this.last || this.plain.join("\n").trim();
  }
}

const say = (s: string): void => {
  process.stderr.write(`gespann: ${s}\n`);
};

function has(bin: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { env, stdio: "ignore" }).status === 0;
}

/** Installs the agent's CLI into the sandbox's home on first use; later jobs find it there. */
export function ensureCli(agent: TesterAgent, env: NodeJS.ProcessEnv): void {
  const bin = agent;
  if (has(bin, env)) return;
  const install =
    agent === "claude" ? "npm install -g --no-audit --no-fund @anthropic-ai/claude-code" : agent === "copilot" ? "npm install -g --no-audit --no-fund @github/copilot" : "curl -fsSL https://x.ai/cli/install.sh | bash";
  say(`installing ${agent === "claude" ? "Claude Code" : agent === "copilot" ? "the Copilot CLI" : "the Grok CLI"}`);
  const r = spawnSync("sh", ["-c", install], { env, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0 || !has(bin, env)) throw new Error(`could not install the ${agent} CLI (${install})`);
}

export interface AgentRun {
  agent: TesterAgent;
  model?: string;
  effort?: string;
  promptFile: string;
  lastFile: string;
  logFile: string;
  keyFile: string;
}

/** Runs one agent step; resolves with the agent's exit code. */
export async function runAgent(r: AgentRun): Promise<number> {
  // The key leaves its file before anything else runs; without one the agent does not start.
  let key = "";
  try {
    key = readFileSync(r.keyFile, "utf8").trim();
  } finally {
    rmSync(r.keyFile, { force: true });
  }
  if (!key) throw new Error("no key for the agent: add it in Settings");
  const home = process.env.HOME ?? homedir();
  // Grok installs into ~/.grok/bin, npm into NPM_CONFIG_PREFIX (on PATH in every sandbox).
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(home, ".grok", "bin")}:${process.env.PATH ?? ""}` };
  ensureCli(r.agent, env);

  const codexConfig = join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
  let servers: McpServer[] = [];
  if (existsSync(codexConfig)) {
    try {
      servers = mcpServersFromCodex(readFileSync(codexConfig, "utf8"), env);
    } catch (err) {
      say(`could not read the browser tools from ${codexConfig}: ${(err as Error).message}`);
    }
  }
  if (servers.length) say(`tools for ${r.agent}: ${servers.map((s) => s.name).join(", ")} (from Codex's config)`);
  let mcpFile: string | undefined;
  if (r.agent === "grok") {
    const file = join(home, ".grok", "config.toml");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, grokConfig(existsSync(file) ? readFileSync(file, "utf8") : "", servers));
  } else if (servers.length) {
    mcpFile = join(dirname(r.logFile), `${r.agent}-mcp.json`);
    writeFileSync(mcpFile, r.agent === "claude" ? claudeMcpConfig(servers) : copilotMcpConfig(servers), { mode: 0o600 });
  }

  const prompt = readFileSync(r.promptFile, "utf8");
  const l = launch(r.agent, { model: r.model, effort: r.effort, prompt, promptFile: r.promptFile, mcpFile });
  const log = createWriteStream(r.logFile);
  const last = new LastMessage(r.agent);
  const child = spawn(l.bin, l.args, { env: { ...env, ...l.env, [keyVariable(r.agent, key)]: key }, stdio: ["pipe", "pipe", "pipe"] });
  key = "";
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onTerm = forward("SIGTERM");
  const onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  child.stdin.on("error", () => {});
  child.stdin.end(l.stdin ?? "");
  child.stderr.pipe(log, { end: false });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    log.write(`${line}\n`);
    last.line(line);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      log.write(`gespann: could not start ${l.bin}: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 1));
  });
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  await new Promise<void>((resolve) => log.end(resolve));
  writeFileSync(r.lastFile, last.text);
  return code;
}
