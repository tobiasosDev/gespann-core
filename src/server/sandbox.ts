import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Where gespann runs PR code: one sandbox per project, kept between jobs, plus a short-lived one for
 * each Codex sign-in. `SANDBOX_PROVIDER` picks the implementation: Docker (local, or a CI server
 * through `DOCKER_HOST`), a plain SSH host, or a module of your own (`module:<path>`).
 */
export interface Sandboxes {
  /** Name for logs, e.g. "docker". */
  readonly kind: string;
  /**
   * `purpose` lets a provider size the sandbox: "project" builds and runs the app, "login" only runs
   * `codex login`. `ttlSeconds` is how long it may run unattended, where the provider stops idle sandboxes.
   */
  create(opts: { name: string; purpose: "project" | "login"; labels?: Record<string, string>; ttlSeconds?: number | null }): Promise<{ id: string }>;
  /** False only when the sandbox is gone for good: deleted, or made by another provider. Other errors throw. */
  exists(id: string): Promise<boolean>;
  /** The sandbox's home directory; the repo, the recipe and the Codex sign-in live below it. */
  home(id: string): string;
  /** Starts or resumes the sandbox and waits until it runs commands. */
  ensureRunning(id: string, ttlSeconds?: number, timeoutMs?: number): Promise<void>;
  /** Pushes an auto-stop deadline out, where the provider has one. */
  keepAlive(id: string, ttlSeconds?: number): Promise<void>;
  stop(id: string): Promise<void>;
  /** Deletes a sandbox and its disk for good. */
  remove(id: string): Promise<void>;
  exec(id: string, command: string, timeoutSeconds?: number): Promise<CommandResult>;
  /** Starts a command in the background and returns a handle for `status` and `kill`. */
  start(id: string, command: string): Promise<number>;
  status(id: string, processId: number, tailBytes?: number): Promise<ProcessStatus>;
  kill(id: string, processId: number): Promise<void>;
  /** The file's text, or null when it does not exist. */
  readFile(id: string, path: string): Promise<string | null>;
  writeFile(id: string, path: string, content: string): Promise<void>;
  download(id: string, path: string): Promise<Buffer>;
  /** Optional: records the sandbox's screen to an mp4 at `file` while the tester works. */
  startRecording?(id: string, file: string): Promise<void>;
  stopRecording?(id: string): Promise<void>;
  /**
   * Optional: a shell script that runs in the sandbox before every job, after gespann is installed. It
   * may write \`<home>/gespann/env.sh\`, which every recipe and Codex command sources, e.g. to select a
   * build cache that survives the sandbox stopping. Its lines starting with "gespann: " go into the job
   * log. A failure only fails the job when the script exits non-zero, so let it fall back and exit 0.
   */
  jobScript?(home: string): string;
  /** Optional: how to drive the browser this sandbox provides; the tester, setup and repair prompts include it. */
  readonly testerNote?: string;
}

/**
 * A module named by `SANDBOX_PROVIDER=module:<path>` default-exports this. It gets the server's
 * environment, so it reads its own settings from it.
 */
export type SandboxModule = (env: NodeJS.ProcessEnv) => Sandboxes | Promise<Sandboxes>;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface ProcessStatus {
  running: boolean;
  status: "running" | "exited" | "lost";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Shell-quotes one argument. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs a long command in the background and waits for it, calling `onTick` with the output so far and
 * keeping the sandbox alive. Resolves with the exit code and the output tail.
 */
export async function runLong(
  sb: Sandboxes,
  id: string,
  command: string,
  opts: { timeoutMs: number; onTick?: (tail: string) => void | Promise<void>; isCancelled?: () => boolean; pollMs?: number },
): Promise<{ exitCode: number | null; tail: string; timedOut: boolean }> {
  const pid = await sb.start(id, command);
  const until = Date.now() + opts.timeoutMs;
  let lastAlive = Date.now();
  for (;;) {
    // Short polls: every run waits on several of these, and each wait loses half an interval on average.
    await sleep(opts.pollMs ?? 2000);
    const s = await sb.status(id, pid);
    const tail = `${s.stdout}${s.stderr ? `\n${s.stderr}` : ""}`;
    await opts.onTick?.(tail);
    if (!s.running) return { exitCode: s.exitCode, tail, timedOut: false };
    if (Date.now() > until || opts.isCancelled?.()) {
      await sb.kill(id, pid).catch(() => undefined);
      return { exitCode: null, tail, timedOut: true };
    }
    if (Date.now() - lastAlive > 10 * 60_000) {
      await sb.keepAlive(id);
      lastAlive = Date.now();
    }
  }
}

export interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

/** Runs a local program, feeds it `input` and collects its output. */
export function spawnCollect(cmd: string, args: string[], opts: { input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<Ran> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    const done = (code: number | null) => {
      clearTimeout(timer);
      ok({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    };
    child.on("close", done);
    // After a timeout, leftover grandchildren may hold the pipes open; do not wait for them.
    child.on("exit", (code) => {
      if (timedOut) done(code);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

/** Splits `SANDBOX_DOCKER_ARGS`-style text into words; single and double quotes group. */
export function words(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${text}`);
  if (has || cur) out.push(cur);
  return out;
}

const MISSING = 44;

/** Sandbox homes end up unquoted in shell commands, so they are limited to these characters. */
export const SAFE_PATH = /^\/[A-Za-z0-9._\/-]+$/;

/**
 * Sets up a sandbox's shell: `HOME` is the sandbox, and Codex's sign-in and global npm installs (the
 * gespann command) live below it, so a sandbox works without root and projects sharing a machine
 * stay apart. The machine user's own `~/.codex/config.toml` (its MCP tools, e.g. a browser) is
 * linked into each sandbox, so the tester gets the browser the machine sets up.
 */
export function prelude(home: string): string {
  const h = q(home);
  return [
    `_gespann_user_home="$HOME"`,
    `export HOME=${h} CODEX_HOME=${h}/.codex NPM_CONFIG_PREFIX=${h}/.npm-global`,
    `export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"`,
    `if [ "$_gespann_user_home" != "$HOME" ] && [ -f "$_gespann_user_home/.codex/config.toml" ] && [ ! -e "$CODEX_HOME/config.toml" ]; then mkdir -p "$CODEX_HOME" && ln -s "$_gespann_user_home/.codex/config.toml" "$CODEX_HOME/config.toml"; fi`,
    `unset _gespann_user_home`,
    `cd "$HOME" || exit 1`,
  ].join("\n");
}

/**
 * A sandbox reached through a shell: Docker and SSH only differ in how a script gets to the machine.
 * Background commands keep their output, pid and exit code in `$HOME/.gespann-proc`.
 */
export abstract class ShellSandboxes {
  private seq = 0;

  /** Runs `script` with bash in the sandbox, after `prelude` for its home. */
  protected abstract shell(id: string, script: string, opts: { input?: string; timeoutMs: number }): Promise<Ran>;

  async exec(id: string, command: string, timeoutSeconds = 120): Promise<CommandResult> {
    // The local timeout ends the docker or ssh client; `timeout` on the machine also ends the command there.
    const limit = `$(command -v timeout >/dev/null 2>&1 && echo "timeout -k 5 ${Math.ceil(timeoutSeconds) + 5}")`;
    const r = await this.shell(id, `${limit} bash -c ${q(command)}`, { timeoutMs: timeoutSeconds * 1000 });
    return { exitCode: r.timedOut ? null : r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), timedOut: r.timedOut };
  }

  async start(id: string, command: string): Promise<number> {
    const n = Date.now() * 100 + (this.seq++ % 100);
    const script = [
      `set -e; d="$HOME/.gespann-proc"; mkdir -p "$d"; f="$d/${n}"`,
      `find "$d" -type f -mtime +2 -delete 2>/dev/null || true`,
      `cat > "$f.cmd"`,
      // setsid gives the command its own process group, so kill reaches everything it started.
      `s="$(command -v setsid || true)"`,
      `nohup $s bash -c 'echo $$ > "$1.pid"; bash "$1.cmd" > "$1.out" 2> "$1.err" < /dev/null; echo $? > "$1.exit.tmp"; mv "$1.exit.tmp" "$1.exit"' _ "$f" > /dev/null 2>&1 < /dev/null &`,
      `i=0; while [ ! -s "$f.pid" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
      `test -s "$f.pid"`,
    ].join("\n");
    const r = await this.shell(id, script, { input: command, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`could not start a background command: ${r.stderr.toString("utf8").slice(0, 300)}`);
    return n;
  }

  async status(id: string, processId: number, tailBytes = 16_000): Promise<ProcessStatus> {
    const t = Math.max(0, Math.floor(tailBytes));
    const script = [
      `f="$HOME/.gespann-proc/${processId}"`,
      `if [ -f "$f.exit" ]; then echo exited; cat "$f.exit"`,
      `elif [ -s "$f.pid" ] && kill -0 "$(cat "$f.pid")" 2>/dev/null; then echo running; echo`,
      `else echo lost; echo; fi`,
      `tail -c ${t} "$f.out" 2>/dev/null | base64 | tr -d '\\n'; echo`,
      `tail -c ${t} "$f.err" 2>/dev/null | base64 | tr -d '\\n'; echo`,
    ].join("\n");
    const r = await this.shell(id, script, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`could not read background command ${processId}: ${r.stderr.toString("utf8").slice(0, 300)}`);
    const [state = "lost", code = "", out = "", err = ""] = r.stdout.toString("utf8").split("\n");
    const status = state === "running" || state === "exited" ? state : "lost";
    const exitCode = status === "exited" && /^\d+$/.test(code.trim()) ? Number(code.trim()) : null;
    const text = (b64: string) => Buffer.from(b64.trim(), "base64").toString("utf8");
    return { running: status === "running", status, exitCode, stdout: text(out), stderr: text(err) };
  }

  async kill(id: string, processId: number): Promise<void> {
    const script = `p="$(cat "$HOME/.gespann-proc/${processId}.pid" 2>/dev/null)" || exit 0; kill -TERM -- "-$p" 2>/dev/null || pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; exit 0`;
    await this.shell(id, script, { timeoutMs: 60_000 });
  }

  async readFile(id: string, path: string): Promise<string | null> {
    const r = await this.shell(id, `[ -f ${q(path)} ] || exit ${MISSING}; cat ${q(path)}`, { timeoutMs: 120_000 });
    if (r.code === MISSING) return null;
    if (r.code !== 0) throw new Error(`could not read ${path}: ${r.stderr.toString("utf8").slice(0, 300)}`);
    return r.stdout.toString("utf8");
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const r = await this.shell(id, `mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, { input: content, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`could not write ${path}: ${r.stderr.toString("utf8").slice(0, 300)}`);
  }

  async download(id: string, path: string): Promise<Buffer> {
    const r = await this.shell(id, `cat ${q(path)}`, { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`could not download ${path}: ${r.stderr.toString("utf8").slice(0, 300)}`);
    return r.stdout;
  }
}

const suffix = () => randomBytes(3).toString("hex");

export interface DockerOptions {
  image: string;
  /** Extra `docker run` arguments, e.g. `--privileged` or a mounted Docker socket for recipes that use Docker. */
  args: string[];
  /** Command the container runs; empty keeps the image's own. It has to keep running. */
  command: string[];
  /** User inside the container; empty keeps the image's. */
  user: string;
  home: string;
  /** The docker binary; `DOCKER_HOST` and `DOCKER_CONTEXT` in the environment pick the engine. */
  bin?: string;
}

/**
 * One container per sandbox, from one image. The engine can be local or a CI server
 * (`DOCKER_HOST=ssh://ci@ci.example.com`). Stopping keeps the container's disk.
 */
export class Docker extends ShellSandboxes implements Sandboxes {
  readonly kind = "docker" as const;
  private readonly o: DockerOptions;

  constructor(o: DockerOptions) {
    super();
    this.o = o;
  }

  private docker(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<Ran> {
    return spawnCollect(this.o.bin ?? "docker", args, { timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.input === undefined ? {} : { input: opts.input }) });
  }

  private async must(args: string[], what: string, timeoutMs = 120_000): Promise<string> {
    const r = await this.docker(args, { timeoutMs });
    if (r.code !== 0) throw new Error(`docker ${what} failed: ${r.stderr.toString("utf8").trim().slice(0, 500) || r.stdout.toString("utf8").slice(0, 500)}`);
    return r.stdout.toString("utf8").trim();
  }

  private user(): string[] {
    return this.o.user ? ["-u", this.o.user] : [];
  }

  async create(opts: { name: string; purpose?: "project" | "login"; labels?: Record<string, string> }): Promise<{ id: string }> {
    const name = `${opts.name.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 50)}-${suffix()}`;
    const labels = Object.entries({ gespann: "1", ...opts.labels }).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    // Images pull on first use, which can take minutes.
    await this.must(["run", "-d", "--init", "--name", name, ...labels, ...this.o.args, this.o.image, ...this.o.command], "run", 30 * 60_000);
    try {
      await this.ensureRunning(name);
      const ids = await this.must(["exec", ...this.user(), name, "sh", "-c", "id -u; id -g"], "exec");
      const [uid, gid] = ids.split("\n");
      await this.must(["exec", "-u", "0", name, "sh", "-c", `mkdir -p ${q(this.o.home)} && chown ${uid}:${gid} ${q(this.o.home)}`], "exec");
    } catch (err) {
      await this.remove(name).catch(() => undefined);
      throw err;
    }
    return { id: name };
  }

  private async state(id: string): Promise<string | null> {
    const r = await this.docker(["inspect", "--type", "container", "-f", "{{.State.Status}}", id]);
    if (r.code === 0) return r.stdout.toString("utf8").trim();
    if (/no such (container|object)/i.test(r.stderr.toString("utf8"))) return null;
    throw new Error(`docker inspect failed: ${r.stderr.toString("utf8").trim().slice(0, 300)}`);
  }

  async exists(id: string): Promise<boolean> {
    return (await this.state(id)) !== null;
  }

  home(): string {
    return this.o.home;
  }

  async ensureRunning(id: string, _ttlSeconds?: number, timeoutMs = 2 * 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    let started = false;
    for (;;) {
      const s = await this.state(id);
      if (s === null) throw new Error(`container ${id} does not exist`);
      if (s === "running") return;
      if (started && s === "exited") {
        const logs = await this.docker(["logs", "--tail", "20", id]);
        throw new Error(
          `container ${id} stops right after it starts; its command has to keep running (for a plain image set SANDBOX_COMMAND="sleep infinity"): ${(logs.stdout.toString("utf8") + logs.stderr.toString("utf8")).slice(-500)}`,
        );
      }
      if (s === "exited" || s === "created") {
        await this.must(["start", id], "start");
        started = true;
      } else if (s === "paused") await this.must(["unpause", id], "unpause");
      if (Date.now() > until) throw new Error(`container ${id} did not start (state ${s})`);
      await sleep(1000);
    }
  }

  async keepAlive(): Promise<void> {}

  async stop(id: string): Promise<void> {
    await this.must(["stop", "-t", "10", id], "stop");
  }

  async remove(id: string): Promise<void> {
    const r = await this.docker(["rm", "-f", "-v", id]);
    if (r.code !== 0 && !/no such container/i.test(r.stderr.toString("utf8"))) throw new Error(`docker rm failed: ${r.stderr.toString("utf8").slice(0, 300)}`);
  }

  protected async shell(id: string, script: string, opts: { input?: string; timeoutMs: number }): Promise<Ran> {
    const r = await this.docker(["exec", "-i", ...this.user(), "-w", this.o.home, id, "bash", "-c", `${prelude(this.o.home)}\n${script}`], opts);
    // The engine's own failures (container gone or stopped, daemon unreachable) are errors, not exit codes.
    const err = r.stderr.toString("utf8");
    if (r.code !== 0 && /^(Error response from daemon|Cannot connect to the Docker daemon|error during connect)/m.test(err)) throw new Error(`docker exec: ${err.trim().slice(0, 300)}`);
    return r;
  }
}

export interface SshOptions {
  /** `user@host` or a host alias. */
  host: string;
  port?: string;
  /** Private key file; empty uses ssh's defaults. */
  keyFile?: string;
  knownHostsFile?: string;
  /** With a known_hosts file from the operator; otherwise a new host key is accepted once and pinned. */
  strictHostKeys: boolean;
  /** Directory on the host that holds one directory per sandbox; may start with `~/`. */
  root: string;
  /** Local directory for the shared connection socket. */
  controlDir: string;
}

/**
 * A Linux machine you already run, e.g. a CI server, reached over SSH. Each sandbox is a directory
 * under `root` that serves as `HOME` for everything gespann runs there, so projects keep their
 * checkout, recipe and Codex sign-in apart. They share the machine's user, tools and Docker engine.
 */
export class Ssh extends ShellSandboxes implements Sandboxes {
  readonly kind = "ssh" as const;
  private readonly o: SshOptions;

  constructor(o: SshOptions) {
    super();
    this.o = o;
  }

  private args(): string[] {
    const o = this.o;
    return [
      "-o", "BatchMode=yes",
      "-o", "LogLevel=ERROR",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${o.controlDir}/%C`,
      "-o", "ControlPersist=600",
      "-o", "ServerAliveInterval=30",
      "-o", `StrictHostKeyChecking=${o.strictHostKeys ? "yes" : "accept-new"}`,
      ...(o.knownHostsFile ? ["-o", `UserKnownHostsFile=${o.knownHostsFile}`] : []),
      ...(o.keyFile ? ["-i", o.keyFile, "-o", "IdentitiesOnly=yes"] : []),
      ...(o.port ? ["-p", o.port] : []),
      o.host,
    ];
  }

  private async raw(script: string, opts: { input?: string; timeoutMs: number }): Promise<Ran> {
    const r = await spawnCollect("ssh", [...this.args(), `bash -c ${q(script)}`], opts);
    // 255 is ssh's own failure (connection, key, host key); the command never ran.
    if (r.code === 255) throw new Error(`ssh ${this.o.host}: ${r.stderr.toString("utf8").trim().slice(0, 300)}`);
    return r;
  }

  private rootExpr(): string {
    const r = this.o.root;
    return r === "~" ? `"$HOME"` : r.startsWith("~/") ? `"$HOME"/${q(r.slice(2))}` : q(r);
  }

  async create(opts: { name: string }): Promise<{ id: string }> {
    const name = `${opts.name.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 50)}-${suffix()}`;
    const r = await this.raw(`set -e; d=${this.rootExpr()}/${q(name)}; mkdir -p "$d"; cd "$d"; pwd -P`, { timeoutMs: 60_000 });
    const dir = r.stdout.toString("utf8").trim();
    if (r.code !== 0 || !dir.startsWith("/")) throw new Error(`could not create the sandbox directory on ${this.o.host}: ${r.stderr.toString("utf8").slice(0, 300)}`);
    if (!SAFE_PATH.test(dir)) throw new Error(`sandbox directory ${dir} has characters gespann does not quote; use a SANDBOX_ROOT of letters, digits, . _ - and /`);
    return { id: dir };
  }

  async exists(id: string): Promise<boolean> {
    if (!id.startsWith("/")) return false;
    const r = await this.raw(`test -d ${q(id)}`, { timeoutMs: 60_000 });
    if (r.code === 0 || r.code === 1) return r.code === 0;
    throw new Error(`ssh ${this.o.host}: could not check ${id}${r.timedOut ? " (timed out)" : ""}`);
  }

  home(id: string): string {
    return id;
  }

  async ensureRunning(id: string): Promise<void> {
    if (!(await this.exists(id))) throw new Error(`sandbox directory ${id} is gone on ${this.o.host}`);
  }

  async keepAlive(): Promise<void> {}

  /** The machine keeps running; the copy is already down when a job ends. */
  async stop(): Promise<void> {}

  async remove(id: string): Promise<void> {
    // Only directories this provider made: absolute, named gespann-…
    if (!/^\/.+\/gespann-[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`refusing to delete ${id}: not a gespann sandbox directory`);
    const r = await this.raw(`chmod -R u+w ${q(id)} 2>/dev/null; rm -rf -- ${q(id)}`, { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`could not delete ${id}: ${r.stderr.toString("utf8").slice(0, 300)}`);
  }

  protected shell(id: string, script: string, opts: { input?: string; timeoutMs: number }): Promise<Ran> {
    return this.raw(`${prelude(id)}\n${script}`, opts);
  }
}
