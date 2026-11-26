import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { open, seal, withCodex } from "../src/server/codex.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { Github } from "../src/server/github.ts";
import { createSandboxes } from "../src/server/provider.ts";
import { Docker, prelude, type ProcessStatus, type Ran, runLong, type Sandboxes, ShellSandboxes, spawnCollect, Ssh, words } from "../src/server/sandbox.ts";
import { processJob } from "../src/server/worker.ts";

/** The shell layer on this machine: each sandbox is a temp directory used as HOME. */
class LocalShell extends ShellSandboxes {
  protected shell(id: string, script: string, opts: { input?: string; timeoutMs: number }): Promise<Ran> {
    return spawnCollect("bash", ["-c", `${prelude(id)}\n${script}`], opts);
  }
}

test("SANDBOX_DOCKER_ARGS splits into words; quotes group", () => {
  assert.deepEqual(words(`--privileged -v /var/run/docker.sock:/var/run/docker.sock --label "a b" ''`), ["--privileged", "-v", "/var/run/docker.sock:/var/run/docker.sock", "--label", "a b", ""]);
  assert.deepEqual(words("  "), []);
  assert.throws(() => words(`--label "open`), /unclosed/);
});

test("config: the provider comes from SANDBOX_PROVIDER, none otherwise", () => {
  assert.equal(loadConfig({}).sandboxProvider, "");
  assert.equal(loadConfig({ SANDBOX_PROVIDER: "module:./my-sandboxes.js" }).sandboxProvider, "module:./my-sandboxes.js");
  const docker = loadConfig({ SANDBOX_PROVIDER: "docker", SANDBOX_IMAGE: "ghcr.io/acme/sandbox:1", SANDBOX_DOCKER_ARGS: "--privileged --cpus 4", SANDBOX_COMMAND: "sleep infinity" });
  assert.deepEqual(docker.docker, { image: "ghcr.io/acme/sandbox:1", args: ["--privileged", "--cpus", "4"], command: ["sleep", "infinity"], user: "", home: "/home/user" });
  const ssh = loadConfig({ SANDBOX_PROVIDER: "ssh", SSH_HOST: "ci@ci.example.com", SSH_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----" });
  assert.equal(ssh.ssh.key, "-----BEGIN-----\nabc\n-----END-----");
  assert.equal(ssh.ssh.root, "~/gespann-sandboxes");
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER: "docker" }), /SANDBOX_IMAGE/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER: "ssh" }), /SSH_HOST/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER: "jenkins" }), /not docker, ssh or module:<path>/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER: "module:" }), /module:<path>/);
  assert.throws(() => loadConfig({ SANDBOX_PROVIDER: "docker", SANDBOX_IMAGE: "i", SANDBOX_HOME: "/srv/CI Jobs" }), /SANDBOX_HOME/);
});

test("ssh provider: the key from the environment is written with mode 600, the host key is pinned or strict", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "gespann-ssh-"));
  const sb = await createSandboxes(loadConfig({ DATA_DIR: dataDir, SANDBOX_PROVIDER: "ssh", SSH_HOST: "ci", SSH_PRIVATE_KEY: "KEY" }));
  assert.ok(sb instanceof Ssh);
  assert.equal(statSync(join(dataDir, "ssh", "id")).mode & 0o777, 0o600);
  assert.equal(sb.home("/srv/gespann-x"), "/srv/gespann-x");
  assert.equal(await createSandboxes(loadConfig({ DATA_DIR: dataDir })), null);
});

test("module provider: SANDBOX_PROVIDER=module:<path> loads the module's default export with the environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gespann-module-"));
  const methods = ["create", "exists", "home", "ensureRunning", "keepAlive", "stop", "remove", "exec", "start", "status", "kill", "readFile", "writeFile", "download"];
  writeFileSync(join(dir, "mine.mjs"), `export default (env) => ({ kind: "mine:" + env.MINE_REGION, ${methods.map((m) => `${m}: async () => null`).join(", ")} });`);
  writeFileSync(join(dir, "half.mjs"), `export default () => ({ kind: "half", exec: async () => null });`);
  const sb = await createSandboxes(loadConfig({ SANDBOX_PROVIDER: `module:${join(dir, "mine.mjs")}` }), { MINE_REGION: "eu" });
  assert.equal(sb?.kind, "mine:eu");
  await assert.rejects(createSandboxes(loadConfig({ SANDBOX_PROVIDER: `module:${join(dir, "half.mjs")}` })), /lacks create, exists/);
});

test("ssh provider: remove only deletes directories it made", async () => {
  const sb = new Ssh({ host: "nowhere.invalid", strictHostKeys: false, root: "~/x", controlDir: tmpdir() });
  await assert.rejects(sb.remove("/home/ci"), /refusing/);
  await assert.rejects(sb.remove("/"), /refusing/);
  assert.equal(await sb.exists("sandbox-123"), false, "an id of another provider is not a directory here");
});

test("shell sandboxes: exec, files, binary download, background commands with status, kill and runLong", async () => {
  const sb = new LocalShell();
  const id = mkdtempSync(join(tmpdir(), "gespann-shell-"));
  const r = await sb.exec(id, `echo "$HOME"; echo err >&2; exit 3`);
  assert.deepEqual([r.exitCode, r.stdout.trim(), r.stderr.trim()], [3, id, "err"]);
  assert.equal((await sb.exec(id, "sleep 5", 1)).timedOut, true);

  assert.equal(await sb.readFile(id, `${id}/nope.txt`), null);
  await sb.writeFile(id, `${id}/a/b/it's.txt`, "héllo\n$HOME `x`");
  assert.equal(await sb.readFile(id, `${id}/a/b/it's.txt`), "héllo\n$HOME `x`");
  await sb.exec(id, `printf '\\x89PNG\\x00\\xff' > ${id}/x.png`);
  assert.deepEqual([...(await sb.download(id, `${id}/x.png`))], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await assert.rejects(sb.download(id, `${id}/missing.png`), /could not download/);

  const pid = await sb.start(id, `echo started; echo warn >&2; sleep 30`);
  await new Promise((ok) => setTimeout(ok, 300));
  const running = await sb.status(id, pid);
  assert.deepEqual([running.status, running.running, running.stdout, running.stderr], ["running", true, "started\n", "warn\n"]);
  await sb.kill(id, pid);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal((await sb.status(id, pid)).running, false);

  const done = await runLong(sb as unknown as Sandboxes, id, `for i in 1 2 3; do echo line $i; done; exit 7`, { timeoutMs: 10_000, pollMs: 200 });
  assert.deepEqual([done.exitCode, done.timedOut], [7, false]);
  assert.match(done.tail, /line 3/);
  const slow = await runLong(sb as unknown as Sandboxes, id, `sleep 30`, { timeoutMs: 300, pollMs: 200 });
  assert.equal(slow.timedOut, true);
});

test("shell sandboxes: the machine user's Codex config (its MCP tools) is linked into each sandbox", async () => {
  const user = mkdtempSync(join(tmpdir(), "gespann-user-"));
  mkdirSync(join(user, ".codex"));
  writeFileSync(join(user, ".codex", "config.toml"), '[mcp_servers.browser]\ncommand = "mcp-browser"\n');
  const id = mkdtempSync(join(tmpdir(), "gespann-shell-"));
  const r = await spawnCollect("bash", ["-c", `${prelude(id)}\ncat "$CODEX_HOME/config.toml"; echo "$HOME"; echo "\${_gespann_user_home:-unset}"`], { timeoutMs: 10_000, env: { ...process.env, HOME: user } });
  assert.deepEqual(r.stdout.toString().trim().split("\n"), ["[mcp_servers.browser]", 'command = "mcp-browser"', id, "unset"]);
});

test("shell sandboxes: the screen recording starts on the sandbox's DISPLAY, ends with SIGTERM so the mp4 is complete, and says why it cannot start", async () => {
  // A stand-in for ffmpeg: notes its arguments, writes the file only when it is stopped with SIGTERM.
  const bin = mkdtempSync(join(tmpdir(), "gespann-bin-"));
  writeFileSync(join(bin, "ffmpeg"), `#!/usr/bin/env bash\nout="\${@: -1}"\necho "$*" > "$HOME/ffmpeg-args"\ntrap 'echo mp4 > "$out"; exit 0' TERM\nwhile :; do sleep 0.05; done\n`, { mode: 0o755 });
  const env = (extra: NodeJS.ProcessEnv) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra });
  class Recording extends ShellSandboxes {
    private readonly e: NodeJS.ProcessEnv;
    constructor(e: NodeJS.ProcessEnv) {
      super();
      this.e = e;
    }
    protected shell(id: string, script: string, opts: { input?: string; timeoutMs: number }): Promise<Ran> {
      return spawnCollect("bash", ["-c", `${prelude(id)}\n${script}`], { ...opts, env: this.e });
    }
  }
  const id = mkdtempSync(join(tmpdir(), "gespann-shell-"));
  const file = join(id, "run", "out", "recording.mp4");
  // A sandbox with its own screen records that one, not the machine's.
  writeFileSync(join(id, ".gespann-display"), ":91\n");
  const sb = new Recording(env({ DISPLAY: ":77" }));
  await sb.startRecording(id, file);
  assert.match(readFileSync(join(id, "ffmpeg-args"), "utf8"), /-f x11grab .*-i :91 .*recording\.mp4/);
  await sb.stopRecording(id);
  assert.equal(readFileSync(file, "utf8"), "mp4\n", "SIGTERM let ffmpeg finish the file");
  await sb.stopRecording(id);

  const bare = mkdtempSync(join(tmpdir(), "gespann-shell-"));
  await assert.rejects(new Recording(env({ DISPLAY: "" })).startRecording(bare, join(bare, "r.mp4")), /no screen/);
  // A PATH with nothing but bash: no ffmpeg on this machine.
  const only = mkdtempSync(join(tmpdir(), "gespann-bin-"));
  symlinkSync(spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(), join(only, "bash"));
  await assert.rejects(new Recording({ PATH: only, HOME: bare, DISPLAY: ":1" }).startRecording(bare, join(bare, "r.mp4")), /ffmpeg is not installed/);
  // On a shared machine (SSH), a sandbox without a screen of its own is not recorded: the machine's screen may show other jobs.
  class SharedRecording extends Recording {
    protected override readonly sharedScreen = true;
  }
  await assert.rejects(new SharedRecording(env({ DISPLAY: ":77" })).startRecording(bare, join(bare, "r.mp4")), /no screen of its own/);
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;

test("docker provider: create, run, keep files across stop and start, remove", { skip: hasDocker ? false : "no docker engine" }, async () => {
  const sb = new Docker({ image: "node:24-slim", args: [], command: ["sleep", "infinity"], user: "node", home: "/home/user" });
  const { id } = await sb.create({ name: "gespann-test", purpose: "project", labels: { gespann_test: "1" } });
  try {
    assert.ok(await sb.exists(id));
    const who = await sb.exec(id, `echo "$HOME $(pwd) $(id -un)"`);
    assert.equal(who.stdout.trim(), "/home/user /home/user node");
    await sb.writeFile(id, "/home/user/gespann/x.txt", "kept");
    const pid = await sb.start(id, "echo hi; exit 4");
    await new Promise((ok) => setTimeout(ok, 1000));
    assert.deepEqual([(await sb.status(id, pid)).exitCode, (await sb.status(id, pid)).stdout], [4, "hi\n"]);
    await sb.stop(id);
    await assert.rejects(sb.exec(id, "true"), /docker exec/);
    await sb.ensureRunning(id);
    assert.equal(await sb.readFile(id, "/home/user/gespann/x.txt"), "kept");
  } finally {
    await sb.remove(id);
  }
  assert.equal(await sb.exists(id), false);
  await sb.remove(id);
});

test("docker provider: an image whose command exits says how to keep it running", { skip: hasDocker ? false : "no docker engine" }, async () => {
  const sb = new Docker({ image: "node:24-slim", args: [], command: ["true"], user: "", home: "/home/user" });
  await assert.rejects(sb.create({ name: "gespann-test-exit", purpose: "project" }), /SANDBOX_COMMAND="sleep infinity"/);
});

/** Records every command; answers like a sandbox where everything works. */
class FakeSandboxes implements Sandboxes {
  readonly kind = "docker" as const;
  readonly commands: string[] = [];
  readonly created: string[] = [];
  readonly files = new Map<string, string>();
  async create(opts: { name: string }) {
    this.created.push(opts.name);
    return { id: "fresh" };
  }
  async exists(id: string) {
    return id === "fresh";
  }
  home(id: string) {
    return `/srv/${id}`;
  }
  async ensureRunning() {}
  async keepAlive() {}
  async stop() {}
  async remove() {}
  async exec(_id: string, command: string) {
    this.commands.push(command);
    if (command.startsWith("rm -f ")) this.files.delete(command.slice(6));
    const missing = command.startsWith("test -d") || (command.startsWith("test -f ") && !this.files.has(command.slice(8)));
    return { exitCode: missing ? 1 : 0, stdout: command.includes("rev-parse HEAD 2>/dev/null") ? "" : "ok", stderr: "" };
  }
  /** What the stand-in for Codex's setup writes as the recipe. */
  setupRecipe: string | null = null;
  async start(_id: string, command: string) {
    this.commands.push(command);
    if (this.setupRecipe !== null && command.includes("setup-prompt.txt")) this.files.set("/srv/fresh/gespann/project/verify.yml", this.setupRecipe);
    return 1;
  }
  async status(_id: string, _processId: number): Promise<ProcessStatus> {
    return { running: false, status: "exited", exitCode: 0, stdout: "", stderr: "" };
  }
  async kill(_id: string, _processId: number) {}
  async readFile(_id: string, path: string) {
    return this.files.get(path) ?? null;
  }
  async writeFile(_id: string, path: string, content: string) {
    this.files.set(path, content);
  }
  async download(_id: string, _path: string) {
    return Buffer.from("");
  }
}

test("worker: a sandbox that is gone (or from another provider) is replaced, and every path follows the sandbox's home", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_state: "connected", codex_auth: seal(config.sessionSecret, '{"tokens":{}}') });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "sandbox-old" });
  const sb = new FakeSandboxes();
  sb.files.set("/srv/fresh/gespann/suggested-checks.md", "Sign in works.");
  const github = { installationToken: async () => "tok" } as unknown as Github;
  const job = db.job(db.enqueue(p, "suggest"))!;
  await processJob({ db, sandboxes: sb, github: () => github, config }, job);
  assert.equal(db.job(job.id)?.status, "done", db.job(job.id)?.error ?? "");
  assert.deepEqual(sb.created, ["gespann-acme-shop"]);
  assert.equal(db.project(p)?.sandbox_id, "fresh");
  assert.equal(db.project(p)?.suggestion, "Sign in works.");
  assert.match(db.job(job.id)?.log ?? "", /sandbox-old no longer exists on docker/);
  const all = sb.commands.join("\n");
  assert.match(all, /clone --quiet https:\/\/github\.com\/acme\/shop\.git \/srv\/fresh\/repo/);
  assert.match(all, /cd \/srv\/fresh\/repo && codex exec/);
  assert.doesNotMatch(all, /\/home\/user/);
  assert.ok(sb.files.has("/srv/fresh/.codex/auth.json"), "the Codex sign-in goes into the sandbox's home");
});

test("worker: a PR run in a sandbox without the recipe (replaced, even after a suggestion) prepares the environment again; the project stays ready", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_state: "connected", codex_auth: seal(config.sessionSecret, '{"tokens":{}}') });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "sandbox-old", setup: "ready", recipe: "version: 1" });
  const sb = new FakeSandboxes();
  const github = { installationToken: async () => "tok", pull: async () => ({ title: "t", body: "", state: "open", head: { sha: "h" }, labels: [] }), linkedIssues: async () => [] } as unknown as Github;
  // A suggestion made the new sandbox first; the PR run after it still finds no recipe there.
  sb.files.set("/srv/fresh/gespann/suggested-checks.md", "Sign in works.");
  await processJob({ db, sandboxes: sb, github: () => github, config }, db.job(db.enqueue(p, "suggest"))!);
  const run = db.createRun({ project_id: p, pr: 4, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  const job = db.job(db.enqueue(p, "run", run))!;
  await processJob({ db, sandboxes: sb, github: () => github, config }, job);
  const log = db.job(job.id)?.log ?? "";
  assert.match(log, /the sandbox has no recipe yet: preparing the environment again/);
  assert.deepEqual(sb.created, ["gespann-acme-shop"], "setup uses the new sandbox, it does not make another");
  assert.ok(sb.files.has("/srv/fresh/gespann/setup-prompt.txt"), "setup ran in the new sandbox");
  // The fake Codex writes no recipe, so setup fails and the PR is not tested on an empty sandbox,
  // but the project stays ready so later PRs still queue.
  assert.equal(db.project(p)?.setup, "ready");
  assert.equal(db.job(job.id)?.status, "failed");
  assert.doesNotMatch(log, /bringing the copy up/);

  // Setup writes a recipe that fails its check: it is removed, so the next PR prepares again.
  sb.setupRecipe = "not: a recipe";
  const run2 = db.createRun({ project_id: p, pr: 5, title: "t", head: "h2", base: "b", base_ref: "main", token: "1".repeat(32) });
  const job2 = db.job(db.enqueue(p, "run", run2))!;
  await processJob({ db, sandboxes: sb, github: () => github, config }, job2);
  assert.match(db.job(job2.id)?.error ?? "", /invalid recipe/);
  assert.equal(sb.files.has("/srv/fresh/gespann/project/verify.yml"), false);
  assert.match(db.job(job2.id)?.log ?? "", /no recipe yet/);
});

test("restart: lost jobs go back into the queue with their run and setup, stop what they left running, and fail after too many restarts", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_state: "connected", codex_auth: seal(config.sessionSecret, '{"tokens":{}}') });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const p2 = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/two", repo_id: 2, default_branch: "main" });
  const later = () => new Date(Date.now() + 1000).toISOString();

  // A run whose job ran when the server stopped, and a setup of another project.
  const run = db.createRun({ project_id: p, pr: 4, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  const rj = db.enqueue(p, "run", run);
  db.startJob(rj);
  db.updateRun(run, { status: "running" });
  const sj = db.enqueue(p2, "setup");
  db.startJob(sj);
  db.updateProject(p2, { setup: "running" });
  // A run left running without a job (its job was cancelled) has nothing to wait for.
  const orphan = db.createRun({ project_id: p, pr: 5, title: "t", head: "h", base: "b", base_ref: "main", token: "1".repeat(32) });
  db.endJob(db.enqueue(p, "run", orphan), "cancelled");
  db.updateRun(orphan, { status: "running" });

  assert.deepEqual(db.requeueStale(later()), [rj, sj]);
  assert.equal(db.job(rj)?.status, "queued");
  assert.equal(db.job(rj)?.restarts, 1);
  assert.match(db.job(rj)?.log ?? "", /the server restarted during this job; it starts again/);
  assert.equal(db.run_(run)?.status, "queued", "the PR's check stays open: the run starts again");
  assert.equal(db.project(p2)?.setup, "queued");
  assert.equal(db.run_(orphan)?.status, "failed");

  // The attempt before the restart left Codex running in the sandbox: the next attempt stops it.
  db.updateProject(p, { sandbox_id: "fresh" });
  class Leftover extends FakeSandboxes {
    readonly killed: number[] = [];
    override async status(_id: string, processId: number): Promise<ProcessStatus> {
      return processId === 7 && !this.killed.includes(7)
        ? { running: true, status: "running", exitCode: null, stdout: "", stderr: "" }
        : { running: false, status: "exited", exitCode: 0, stdout: "", stderr: "" };
    }
    override async kill(_id: string, processId: number) {
      this.killed.push(processId);
    }
  }
  const sb = new Leftover();
  sb.files.set("/srv/fresh/gespann/suggested-checks.md", "Sign in works.");
  const github = { installationToken: async () => "tok" } as unknown as Github;
  const sug = db.enqueue(p, "suggest");
  db.startJob(sug);
  db.addProc(sug, "fresh", 7);
  db.addProc(sug, "fresh", 8);
  db.requeueStale(later());
  await processJob({ db, sandboxes: sb, github: () => github, config }, db.job(sug)!);
  assert.equal(db.job(sug)?.status, "done", db.job(sug)?.error ?? "");
  assert.deepEqual(sb.killed, [7], "only the command still running is stopped");
  assert.match(db.job(sug)?.log ?? "", /stopped a command the attempt before the restart left running \(7\)/);
  assert.deepEqual(JSON.parse(db.job(sug)?.procs ?? ""), [["fresh", 1]], "this attempt's commands are recorded for the next restart");

  // A PR run lost while its copy was up takes that copy down before it brings a fresh one up.
  db.updateProject(p, { setup: "ready", recipe: "version: 1" });
  sb.files.set("/srv/fresh/gespann/project/verify.yml", "version: 1");
  sb.files.set("/srv/fresh/gespann/runs/000000000000/work/state.json", "{}");
  const prGithub = { installationToken: async () => "tok", pull: async () => ({ title: "t", body: "", state: "open", head: { sha: "h" }, labels: [] }), linkedIssues: async () => [] } as unknown as Github;
  await processJob({ db, sandboxes: sb, github: () => prGithub, config }, db.job(rj)!);
  const cmds = sb.commands.join("\n");
  assert.match(db.job(rj)?.log ?? "", /taking down the copy that the attempt before the restart left up/);
  assert.match(cmds, /gespann verify finish .* --run 000000000000 --dir \/srv\/fresh\/gespann\/runs\/000000000000 --wait 0/);
  assert.ok(cmds.indexOf("--wait 0") < cmds.indexOf("verify prepare"), "down first, then up");
  assert.match(cmds, /rm -rf \/srv\/fresh\/gespann\/runs\/000000000000 && mkdir -p/, "the lost attempt's proof is gone");

  // A job the server keeps losing (it may be what crashes it) stops starting again.
  for (let i = 0; i < 2; i++) {
    db.startJob(sj);
    db.updateProject(p2, { setup: "running" });
    db.requeueStale(later());
  }
  assert.equal(db.job(sj)?.restarts, 3);
  await processJob({ db, sandboxes: sb, github: () => github, config }, db.job(sj)!);
  assert.equal(db.job(sj)?.status, "failed");
  assert.match(db.job(sj)?.error ?? "", /restarted during this job 3 times/);
  assert.equal(db.project(p2)?.setup, "failed");
});

test("worker: the provider's job script runs after the install, and every recipe and Codex command sources env.sh", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_state: "connected", codex_auth: seal(config.sessionSecret, '{"tokens":{}}') });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "fresh" });
  class WithHooks extends FakeSandboxes {
    readonly testerNote = "Drive the browser with the drive tool.";
    jobScript(home: string) {
      return `echo prepared ${home}`;
    }
  }
  const sb = new WithHooks();
  sb.files.set("/srv/fresh/gespann/suggested-checks.md", "Sign in works.");
  const github = { installationToken: async () => "tok" } as unknown as Github;
  const job = db.job(db.enqueue(p, "suggest"))!;
  await processJob({ db, sandboxes: sb, github: () => github, config }, job);
  assert.equal(db.job(job.id)?.status, "done", db.job(job.id)?.error ?? "");
  const install = sb.commands.find((c) => c.includes("gespann-installed")) ?? "";
  assert.match(install, /: > \/srv\/fresh\/gespann\/env\.sh\n\(\necho prepared \/srv\/fresh\n\)$/, "env.sh is emptied, then the script runs");
  assert.match(sb.commands.find((c) => c.includes("codex exec")) ?? "", /^\. \/srv\/fresh\/gespann\/env\.sh 2>\/dev\/null; cd \/srv\/fresh\/repo && codex exec/);
});

test("worker: a run whose PR was merged or closed while it waited is skipped, without a sandbox", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "fresh", setup: "ready", recipe: "version: 1" });
  const sb = new FakeSandboxes();
  const checks: unknown[] = [];
  const github = {
    pull: async () => ({ number: 4, state: "closed", merged: false, head: { sha: "h" }, labels: [] }),
    updateCheck: async (_i: number, _r: string, id: number, f: { conclusion?: string }) => void checks.push([id, f.conclusion]),
  } as unknown as Github;
  const run = db.createRun({ project_id: p, pr: 4, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  db.updateRun(run, { check_run_id: 11 });
  // Another queued run of the same PR (e.g. queued after a reopen) is left to the webhook.
  const other = db.createRun({ project_id: p, pr: 4, title: "t", head: "h2", base: "b", base_ref: "main", token: "1".repeat(32) });
  const job = db.job(db.enqueue(p, "run", run))!;
  db.claimJob(job.id);
  await processJob({ db, sandboxes: sb, github: () => github, config }, job);
  assert.equal(db.job(job.id)?.status, "cancelled", db.job(job.id)?.error ?? "");
  assert.equal(db.run_(run)?.status, "cancelled");
  assert.equal(db.run_(run)?.error, "the PR was closed before its test started");
  assert.deepEqual(checks, [[11, "skipped"]]);
  assert.equal(db.run_(other)?.status, "queued");
  assert.deepEqual(sb.commands, [], "no sandbox work for a closed PR");
  assert.match(db.job(job.id)?.log ?? "", /skipped: the PR was closed/);
});

test("worker: a run cancelled while GitHub answers does not start", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "fresh", setup: "ready", recipe: "version: 1" });
  const sb = new FakeSandboxes();
  const run = db.createRun({ project_id: p, pr: 4, title: "t", head: "h", base: "b", base_ref: "main", token: "0".repeat(32) });
  const github = {
    // The close webhook cancels the run while this (older) answer is on its way.
    pull: async () => (db.cancelQueuedRuns(p, 4, "the PR was closed before its test started"), { number: 4, state: "open", head: { sha: "h" }, labels: [] }),
  } as unknown as Github;
  const job = db.job(db.enqueue(p, "run", run))!;
  db.claimJob(job.id);
  await processJob({ db, sandboxes: sb, github: () => github, config }, job);
  assert.equal(db.job(job.id)?.status, "cancelled", db.job(job.id)?.error ?? "");
  assert.equal(db.run_(run)?.status, "cancelled");
  assert.deepEqual(sb.commands, []);
});

test("parallel: two PR runs of one project run at once in two sandboxes; the new one takes over the recipe as the project's bundle", async () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_state: "connected", codex_auth: seal(config.sessionSecret, JSON.stringify({ tokens: {}, last_refresh: new Date().toISOString() })) });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { sandbox_id: "first", setup: "ready", recipe: "version: 1" });
  class Pool extends FakeSandboxes {
    readonly live = new Set(["first"]);
    override async create(opts: { name: string }) {
      this.created.push(opts.name);
      this.live.add("second");
      return { id: "second" };
    }
    override async exists(id: string) {
      return this.live.has(id);
    }
    override async exec(id: string, command: string) {
      // Unpacking the bundle brings the recipe into that sandbox.
      if (command.includes("tar -xzf project.tgz")) this.files.set(`/srv/${id}/gespann/project/verify.yml`, "version: 1");
      return super.exec(id, command);
    }
    override async download(_id: string, path: string) {
      return Buffer.from(path.endsWith("project.tgz") ? "TGZ" : "");
    }
  }
  const sb = new Pool();
  sb.files.set("/srv/first/gespann/project/verify.yml", "version: 1");
  const github = { installationToken: async () => "tok", pull: async () => ({ title: "t", body: "", state: "open", head: { sha: "h" }, labels: [] }), linkedIssues: async () => [] } as unknown as Github;
  const jobs = [4, 5].map((pr, i) => {
    const run = db.createRun({ project_id: p, pr, title: "t", head: `h${pr}`, base: "b", base_ref: "main", token: String(i).repeat(32) });
    const id = db.enqueue(p, "run", run);
    db.claimJob(id);
    return db.job(id)!;
  });
  await Promise.all(jobs.map((job) => processJob({ db, sandboxes: sb, github: () => github, config }, job)));
  for (const job of jobs) assert.equal(db.job(job.id)?.status, "done", db.job(job.id)?.error ?? "");
  assert.deepEqual(sb.created, ["gespann-acme-shop"], "one more sandbox, for the second run");
  assert.deepEqual(db.slots(p).map((s) => [s.sandbox_id, s.job_id, s.bundle]), [["first", null, 1], ["second", null, 1]], "both free again, both on the same recipe");
  const second = db.job(jobs[1]!.id)?.log ?? "";
  assert.match(second, /created sandbox second \(docker\), the project's sandbox number 2: the others are busy/);
  assert.match(second, /took over the project's current recipe/);
  assert.doesNotMatch(second, /preparing the environment again/, "no second setup");
  assert.match(second, /the PR has a newer push: its comment stays with the newer run/, "a run of an older head does not touch the PR comment");
  assert.equal(db.project(p)?.bundle, 1);
  assert.equal(readFileSync(join(config.dataDir, "projects", String(p), "recipe.tgz"), "utf8"), "TGZ");
  assert.equal(sb.files.get("/srv/second/gespann/project.tgz.b64"), Buffer.from("TGZ").toString("base64"));
  const all = sb.commands.join("\n");
  assert.match(all, /tar -czf \/srv\/first\/gespann\/project\.tgz -C \/srv\/first\/gespann project/);
  assert.match(all, /cd \/srv\/first\/repo && gespann verify prepare --recipe \/srv\/first\/gespann\/project\/verify\.yml --pr 4 /);
  assert.match(all, /cd \/srv\/second\/repo && gespann verify prepare --recipe \/srv\/second\/gespann\/project\/verify\.yml --pr 5 /, "each run in its own checkout");
  assert.ok(all.indexOf("verify prepare --recipe /srv/second") < all.indexOf("verify finish --recipe /srv/first"), "side by side: the second copy comes up before the first goes down");

  // A later run takes a free sandbox again instead of making a third. Its PR resolves an issue: the
  // tester gets the issue's text and has to judge its goal.
  const issue = { ref: "#12", title: "Export as CSV", body: "Users export all orders as CSV.", url: "https://github.com/acme/shop/issues/12" };
  const withIssue = { ...github, linkedIssues: async () => [issue] } as unknown as Github;
  const run = db.createRun({ project_id: p, pr: 6, title: "t", head: "h6", base: "b", base_ref: "main", token: "2".repeat(32) });
  const job = db.job(db.enqueue(p, "run", run))!;
  db.claimJob(job.id);
  await processJob({ db, sandboxes: sb, github: () => withIssue, config }, job);
  assert.equal(sb.created.length, 1);
  assert.doesNotMatch(db.job(job.id)?.log ?? "", /took over/, "it already has the current recipe");
  assert.match(db.job(job.id)?.log ?? "", /linked issue: #12/);
  const work = [...sb.files.keys()].find((k) => k.endsWith("/runs/222222222222/work/issues.md"))?.replace(/issues\.md$/, "");
  assert.ok(work, "the issue text goes into the run's work dir");
  assert.match(sb.files.get(`${work}issues.md`) ?? "", /# #12: Export as CSV[\s\S]*Users export all orders as CSV/);
  assert.deepEqual(JSON.parse(sb.files.get(`${work}issues.json`) ?? "null"), [{ ref: "#12", url: issue.url }]);
});

/** A sandbox stand-in with files only, for the Codex sign-in. */
function authBox() {
  const files = new Map<string, string>();
  const sb = {
    kind: "test",
    home: (id: string) => `/srv/${id}`,
    exec: async (_id: string, command: string) => {
      const rm = /rm -f ~\/\.codex\/auth\.json/.test(command);
      if (rm) for (const k of [...files.keys()]) if (k.endsWith("/.codex/auth.json")) files.delete(k);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    writeFile: async (_id: string, path: string, content: string) => void files.set(path, content),
    readFile: async (_id: string, path: string) => files.get(path) ?? null,
  } as unknown as Sandboxes;
  return { sb, files };
}

const auth = (token: string, daysAgo: number) => JSON.stringify({ tokens: { refresh_token: token }, last_refresh: new Date(Date.now() - daysAgo * 86_400_000).toISOString() });

test("Codex sign-in: jobs of one owner use it side by side while no refresh is due", async () => {
  const config = loadConfig({});
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_auth: seal(config.sessionSecret, auth("r1", 1)) });
  const { sb } = authBox();
  let meet: () => void = () => {};
  const met = new Promise<void>((ok) => (meet = ok));
  const both = Promise.all([
    withCodex(db, sb, config, u.id, "a", () => met, 10),
    withCodex(db, sb, config, u.id, "b", async () => meet(), 10),
  ]);
  await Promise.race([both, new Promise((_, no) => setTimeout(() => no(new Error("the second job waited for the first")), 2000))]);
});

test("Codex sign-in: while a refresh is due one job refreshes and the others start with the new sign-in; an older refresh never replaces a newer one", async () => {
  const config = loadConfig({});
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_auth: seal(config.sessionSecret, auth("r1", 9)) });
  const { sb, files } = authBox();
  const stored = () => JSON.parse(open(config.sessionSecret, db.codexAuth(u.id)!)) as { tokens: { refresh_token: string } };
  const seen: string[] = [];
  let finishFirst: () => void = () => {};
  const first = withCodex(db, sb, config, u.id, "a", async () => {
    seen.push(`a:${JSON.parse(files.get("/srv/a/.codex/auth.json")!).tokens.refresh_token}`);
    // Codex refreshes: the old refresh token is spent.
    files.set("/srv/a/.codex/auth.json", auth("r2", 0));
    await new Promise<void>((ok) => (finishFirst = ok));
  }, 10);
  await new Promise((ok) => setTimeout(ok, 1));
  const second = withCodex(db, sb, config, u.id, "b", async () => {
    seen.push(`b:${JSON.parse(files.get("/srv/b/.codex/auth.json")!).tokens.refresh_token}`);
  }, 10);
  await second;
  assert.deepEqual(seen, ["a:r1", "b:r2"], "the second job waited for the refresh and got its result, while the first still ran");
  assert.equal(stored().tokens.refresh_token, "r2");
  finishFirst();
  await first;

  // The owner disconnected Codex during a job: its refresh does not bring the sign-in back.
  db.setCodex(u.id, { codex_auth: seal(config.sessionSecret, auth("r5", 0)) });
  await withCodex(db, sb, config, u.id, "d", async () => {
    db.setCodex(u.id, { codex_auth: null });
    files.set("/srv/d/.codex/auth.json", auth("r6", -1));
  }, 10);
  assert.equal(db.codexAuth(u.id), null);

  // A job that started with an older sign-in and refreshed it later than another job stored a newer one.
  db.setCodex(u.id, { codex_auth: seal(config.sessionSecret, auth("r9", 0)) });
  await withCodex(db, sb, config, u.id, "c", async () => void files.set("/srv/c/.codex/auth.json", auth("r3", 2)), 10);
  assert.equal(stored().tokens.refresh_token, "r9");
});

test("parallel: two PR runs that both find no recipe anywhere prepare the environment once; the other takes over the result", async () => {
  const RECIPE = "version: 1\ntrigger:\n  paths: ['**']\nenv:\n  up: ./up.sh\n  down: ./down.sh\n  url: http://copy\n";
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-worker-")) });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "t", name: null, avatar: null });
  db.setCodex(u.id, { codex_state: "connected", codex_auth: seal(config.sessionSecret, JSON.stringify({ tokens: {}, last_refresh: new Date().toISOString() })) });
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  db.updateProject(p, { setup: "ready", recipe: "version: 1" });
  class Pool extends FakeSandboxes {
    private n = 0;
    readonly live = new Set<string>();
    setups = 0;
    override async create(opts: { name: string }) {
      this.created.push(opts.name);
      const id = `box${++this.n}`;
      this.live.add(id);
      return { id };
    }
    override async exists(id: string) {
      return this.live.has(id);
    }
    override async exec(id: string, command: string) {
      if (command.includes("tar -xzf project.tgz")) this.files.set(`/srv/${id}/gespann/project/verify.yml`, "version: 1");
      if (command.startsWith("curl ")) return { exitCode: 0, stdout: "200", stderr: "" };
      return super.exec(id, command);
    }
    private procs: string[] = [];
    override async start(id: string, command: string) {
      if (command.includes("setup-prompt.txt")) {
        this.setups++;
        this.files.set(`/srv/${id}/gespann/project/verify.yml`, RECIPE);
      }
      await super.start(id, command);
      return this.procs.push(command);
    }
    // The setup's check of the copy passes: it comes up and answers.
    override async status(_id: string, processId: number): Promise<ProcessStatus> {
      const up = this.procs[processId - 1]?.includes("verify prepare") && this.procs[processId - 1]?.includes("--pr 0");
      return { running: false, status: "exited", exitCode: 0, stdout: up ? '{"ok":true,"url":"http://copy","run":"r0"}' : "", stderr: "" };
    }
    override async download(_id: string, path: string) {
      return Buffer.from(path.endsWith("project.tgz") ? "TGZ" : "");
    }
  }
  const sb = new Pool();
  const github = { installationToken: async () => "tok", pull: async () => ({ title: "t", body: "", state: "open", head: { sha: "h" }, labels: [] }), linkedIssues: async () => [] } as unknown as Github;
  const jobs = [4, 5].map((pr, i) => {
    const run = db.createRun({ project_id: p, pr, title: "t", head: `h${pr}`, base: "b", base_ref: "main", token: String(i).repeat(32) });
    const id = db.enqueue(p, "run", run);
    db.claimJob(id);
    return db.job(id)!;
  });
  await Promise.all(jobs.map((job) => processJob({ db, sandboxes: sb, github: () => github, config }, job)));
  assert.equal(sb.setups, 1, "one setup for both runs");
  const logs = jobs.map((j) => db.job(j.id)?.log ?? "");
  assert.equal(logs.filter((l) => /preparing the environment again/.test(l)).length, 1);
  assert.equal(logs.filter((l) => /took over the project's current recipe/.test(l)).length, 1);
  assert.equal(db.project(p)?.bundle, 1);
});
