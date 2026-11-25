import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seal } from "../src/server/codex.ts";
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
  async download() {
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
  const github = { installationToken: async () => "tok", pull: async () => ({ title: "t", body: "", state: "closed", head: { sha: "h" }, labels: [] }) } as unknown as Github;
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
  const prGithub = { installationToken: async () => "tok", pull: async () => ({ title: "t", body: "", state: "open", head: { sha: "h" }, labels: [] }) } as unknown as Github;
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
