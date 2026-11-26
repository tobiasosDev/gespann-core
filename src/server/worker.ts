import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { repairPrompt, setupPrompt, suggestPrompt, testerPrompt } from "../verify/prompt.ts";
import { parseRecipe, RecipeError } from "../verify/recipe.ts";
import { parseThumbs, sameScreens, thumbCommand, withAliases } from "../verify/similar.ts";
import { copyGaps, type Check, type Judged } from "../verify/verdict.ts";
import { applyGate, gated, gateLine, gateState, type GateState, runComment, skipClosedRuns, upsertComment, withPrLock } from "./gate.ts";
import type { Config } from "./config.ts";
import type { Db, Job, Project, Run, Slot } from "./db.ts";
import type { ServerModule } from "./extension.ts";
import { withCodex } from "./codex.ts";
import type { Github, LinkedIssue } from "./github.ts";
import { finishRecordingScript, q, runLong, type Sandboxes } from "./sandbox.ts";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(mp4|webm)$/i;

export interface Deps {
  db: Db;
  sandboxes: Sandboxes;
  github: () => Github;
  config: Config;
  /** `SERVER_MODULE`: asked before each job starts, told when it ended. */
  module?: ServerModule | null;
}

/** A project's sandbox and the places in it: the repo checkout, gespann's files, the recipe. */
interface Box {
  id: string;
  slot: Slot;
  repo: string;
  gespann: string;
  project: string;
  recipe: string;
  core: string;
}

function box(sb: Sandboxes, slot: Slot): Box {
  const id = slot.sandbox_id;
  const home = sb.home(id);
  const gespann = `${home}/gespann`;
  return { id, slot, repo: `${home}/repo`, gespann, project: `${gespann}/project`, recipe: `${gespann}/project/verify.yml`, core: `${gespann}/core` };
}

/**
 * A sandbox of the project for this job, reused across jobs: it keeps the repo, the images and the
 * build caches. Each job holds its own, so jobs of one project run side by side without sharing a
 * checkout; a project gets another sandbox when all of its sandboxes are busy.
 */
async function ensureSandbox(d: Deps, p: Project, job: Job, log: (s: string) => void): Promise<Box> {
  let slot = d.db.takeSlot(p.id, job.id);
  // A sandbox deleted by hand, or made by the provider the instance used before, is replaced.
  while (slot && !(await d.sandboxes.exists(slot.sandbox_id))) {
    log(`sandbox ${slot.sandbox_id} no longer exists on ${d.sandboxes.kind}; creating a new one`);
    d.db.dropSlot(slot.id);
    slot = d.db.takeSlot(p.id, job.id);
  }
  if (!slot) {
    const n = d.db.slots(p.id).length;
    const s = await d.sandboxes.create({ name: `gespann-${p.repo.replace(/[^A-Za-z0-9-]+/g, "-")}`.slice(0, 60), purpose: "project", labels: { gespann_project: String(p.id) } });
    slot = d.db.addSlot(p.id, s.id, job.id);
    if (!n) d.db.updateProject(p.id, { sandbox_id: s.id });
    log(`created sandbox ${s.id} (${d.sandboxes.kind})${n ? `, the project's sandbox number ${n + 1}: the others are busy` : ""}`);
  } else if (d.db.slots(p.id).length > 1) log(`using sandbox ${slot.sandbox_id}`);
  await d.sandboxes.ensureRunning(slot.sandbox_id);
  const b = box(d.sandboxes, slot);
  try {
    await installGespann(d, b, log);
  } catch (err) {
    await stopSandbox(d, b);
    throw err;
  }
  return b;
}

const bundleFile = (d: Deps, projectId: number) => join(d.config.dataDir, "projects", String(projectId), "recipe.tgz");

/**
 * Keeps the sandbox's recipe dir (recipe, scripts, notes) as the project's current bundle on the
 * server, so the project's other sandboxes take it over. Called after a setup or repair passed.
 */
async function saveBundle(d: Deps, p: Project, b: Box): Promise<void> {
  const tgz = `${b.gespann}/project.tgz`;
  const r = await d.sandboxes.exec(b.id, `tar -czf ${tgz} -C ${b.gespann} project 2>&1`, 120);
  if (r.exitCode !== 0) throw new Error(`could not pack the recipe: ${r.stdout.slice(-300)}`);
  const data = await d.sandboxes.download(b.id, tgz);
  await d.sandboxes.exec(b.id, `rm -f ${tgz}`, 30).catch(() => undefined);
  const file = bundleFile(d, p.id);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
  const version = (d.db.project(p.id)?.bundle ?? 0) + 1;
  d.db.updateProject(p.id, { bundle: version });
  d.db.setSlotBundle(b.slot.id, version);
  b.slot.bundle = version;
}

/** Projects whose first bundle is being made from a sandbox that has the recipe. */
const bootstrapping = new Map<number, Promise<void>>();

/**
 * Brings the project's current recipe into this sandbox when it has an older one or none. Projects
 * from before bundles get theirs from a sandbox that has a recipe. True when the sandbox has a recipe.
 */
async function syncRecipe(d: Deps, p: Project, b: Box, log: (s: string) => void): Promise<boolean> {
  const has = async (box: Box) => (await d.sandboxes.exec(box.id, `test -f ${box.recipe}`, 30)).exitCode === 0;
  const saved = () => !!d.db.project(p.id)?.bundle && existsSync(bundleFile(d, p.id));
  while (!saved() && bootstrapping.has(p.id)) await bootstrapping.get(p.id);
  if (!saved()) {
    const made = (async () => {
      // Not from a sandbox another job is using: its recipe may be a setup's unchecked draft.
      const busy = (s: Slot) => s.job_id !== null && ["queued", "running"].includes(d.db.job(s.job_id)?.status ?? "");
      for (const s of [b.slot, ...d.db.slots(p.id).filter((s) => s.id !== b.slot.id && !busy(s))]) {
        const other = s.id === b.slot.id ? b : box(d.sandboxes, s);
        if (!(await d.sandboxes.exists(other.id).catch(() => false)) || !(await has(other).catch(() => false))) continue;
        await saveBundle(d, p, other);
        return;
      }
    })();
    bootstrapping.set(p.id, made.catch(() => undefined));
    try {
      await made;
    } finally {
      bootstrapping.delete(p.id);
    }
  }
  b.slot.bundle = d.db.slot(b.slot.id)?.bundle ?? b.slot.bundle;
  const version = d.db.project(p.id)?.bundle ?? 0;
  if (version && b.slot.bundle !== version && existsSync(bundleFile(d, p.id))) {
    const data = readFileSync(bundleFile(d, p.id));
    const tgz = `${b.gespann}/project.tgz`;
    await d.sandboxes.exec(b.id, `mkdir -p ${b.gespann}`, 30);
    await d.sandboxes.writeFile(b.id, `${tgz}.b64`, data.toString("base64"));
    // Unpacked next to it and swapped in, so nothing ever sees half a recipe.
    const r = await d.sandboxes.exec(
      b.id,
      `set -e; cd ${b.gespann}; base64 -d < project.tgz.b64 > project.tgz; rm -rf project.new; mkdir project.new; tar -xzf project.tgz -C project.new; rm -rf project.old; if [ -d project ]; then mv project project.old; fi; mv project.new/project project; rm -rf project.new project.old project.tgz project.tgz.b64`,
      120,
    );
    if (r.exitCode !== 0) throw new Error(`could not unpack the recipe: ${r.stdout}${r.stderr}`.slice(0, 500));
    d.db.setSlotBundle(b.slot.id, version);
    b.slot.bundle = version;
    log("took over the project's current recipe");
  }
  return has(b);
}

/** The sandbox runs the same gespann as this server; then the provider's own job script, if it has one. */
async function installGespann(d: Deps, b: Box, log: (s: string) => void): Promise<void> {
  const home = d.sandboxes.home(b.id);
  const script = [installScript(d.config.gespannRef, { core: b.core, url: "https://github.com/tobiasosDev/gespann-core.git", bin: `"$(npm prefix -g)/bin/gespann"` })];
  // env.sh is the provider's to fill; emptied first, so a job never sources what an older script left.
  script.push(`: > ${b.gespann}/env.sh`);
  const extra = d.sandboxes.jobScript?.(home);
  if (extra) script.push(`(\n${extra}\n)`);
  const r = await d.sandboxes.exec(b.id, script.join("\n"), 600);
  if (r.exitCode !== 0) throw new Error(`gespann install failed: ${r.stdout}${r.stderr}`);
  for (const line of r.stdout.split("\n")) if (line.startsWith("gespann: ")) log(line.slice(9));
}

/**
 * Checks out gespann at `ref` and runs it by Node directly. Checkout and `npm ci` run only when the ref
 * moved since the last complete install or the lockfile changed (before, every job reinstalled).
 */
export function installScript(ref: string, at: { core: string; url: string; bin: string }): string {
  const { core } = at;
  return [
    `set -e; mkdir -p ${q(dirname(core))}`,
    `if [ ! -d ${core}/.git ]; then git clone --quiet ${q(at.url)} ${core}; fi`,
    // The commit of the last complete install; removed before a checkout, written after npm ci succeeded.
    `old="$(cat ${core}/.gespann-installed 2>/dev/null || true)"`,
    `git -C ${core} fetch --quiet origin ${q(ref)}`,
    `new="$(git -C ${core} rev-parse FETCH_HEAD)"`,
    `bin=${at.bin}`,
    `if [ "$old" != "$new" ] || [ ! -x "$bin" ] || [ ! -d ${core}/node_modules ]; then`,
    `  echo "gespann: installing gespann ${ref.replace(/[^A-Za-z0-9._/-]/g, "")} in the sandbox"`,
    `  rm -f ${core}/.gespann-installed; git -C ${core} checkout --quiet --force FETCH_HEAD`,
    `  if [ -z "$old" ] || [ ! -d ${core}/node_modules ] || ! git -C ${core} diff --quiet "$old" "$new" -- package-lock.json 2>/dev/null; then (cd ${core} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent); fi`,
    `  mkdir -p "$(dirname "$bin")"; printf '#!/bin/sh\\nexec node ${core}/src/bin.ts "$@"\\n' > "$bin"; chmod +x "$bin"; "$bin" --version; echo "$new" > ${core}/.gespann-installed`,
    `fi`,
  ].join("\n");
}

/** Sourced before every recipe and Codex command: the provider's job script may set variables there. */
const withEnv = (b: Box, command: string) => `. ${b.gespann}/env.sh 2>/dev/null; ${command}`;

/** Fetches with a short-lived installation token that never appears on a command line. */
async function git(d: Deps, b: Box, p: Project, command: string, timeout = 600): Promise<void> {
  const token = await d.github().installationToken(p.installation_id, true);
  const tokenFile = `${b.gespann}/.git-token`;
  await d.sandboxes.exec(b.id, `mkdir -p ${b.gespann} && umask 077 && : > ${tokenFile}`, 30);
  await d.sandboxes.writeFile(b.id, tokenFile, token);
  const helper = `!f() { echo username=x-access-token; echo password=$(cat ${tokenFile}); }; f`;
  try {
    const r = await d.sandboxes.exec(b.id, `git -c credential.helper= -c credential.helper=${q(helper)} ${command} 2>&1`, timeout);
    if (r.exitCode !== 0) throw new Error(`git ${command.split(" ")[0]} failed: ${r.stdout.slice(-1500)}`);
  } finally {
    await d.sandboxes.exec(b.id, `rm -f ${tokenFile}`, 30).catch(() => undefined);
  }
}

async function ensureRepo(d: Deps, b: Box, p: Project): Promise<void> {
  const present = await d.sandboxes.exec(b.id, `test -d ${b.repo}/.git`, 30);
  if (present.exitCode !== 0) await git(d, b, p, `clone --quiet https://github.com/${p.repo}.git ${b.repo}`, 600);
}

/** Frees the job's sandboxes, stopped first, also when the job failed halfway. */
async function releaseSlots(d: Deps, job: Job): Promise<void> {
  for (const s of d.db.slots(job.project_id).filter((s) => s.job_id === job.id)) await d.sandboxes.stop(s.sandbox_id).catch(() => undefined);
  d.db.releaseSlots(job.id);
}

/** Stops the sandbox after its job; the next job that takes it starts it again. */
async function stopSandbox(d: Deps, b: Box): Promise<void> {
  await d.sandboxes.stop(b.id).catch(() => undefined);
}

/** Runs `fn` for one key at a time in this process; later callers wait for the earlier ones. */
async function oneAtATime<T>(locks: Map<number, Promise<unknown>>, key: number, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(fn);
  const tail = mine.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await mine;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** Projects whose environment a run prepares again, and projects whose copy a run fixes. */
const recovering = new Map<number, Promise<unknown>>();
const repairing = new Map<number, Promise<unknown>>();

function codexExec(b: Box, promptFile: string, lastFile: string, jsonlFile: string, model: string | null): string {
  const m = model ? ` -m ${q(model)}` : "";
  return withEnv(b, `cd ${b.repo} && codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${m} -c model_reasoning_effort=high -o ${q(lastFile)} - < ${q(promptFile)} > ${q(jsonlFile)} 2>&1`);
}

/** Codex reads the repo and proposes concrete checks; the user takes them over in the UI. */
async function suggest(d: Deps, job: Job, p: Project, log: (s: string) => void): Promise<void> {
  const b = await ensureSandbox(d, p, job, log);
  try {
    await ensureRepo(d, b, p);
    await git(d, b, p, `-C ${b.repo} fetch --quiet origin ${q(p.default_branch)}`);
    const co = await d.sandboxes.exec(b.id, `cd ${b.repo} && git checkout --quiet --force --detach FETCH_HEAD 2>&1 && rm -f ${b.gespann}/suggested-checks.md`, 120);
    if (co.exitCode !== 0) throw new Error(`checkout of ${p.default_branch} failed: ${co.stdout.slice(-800)}`);
    await d.sandboxes.writeFile(b.id, `${b.gespann}/suggest-prompt.txt`, suggestPrompt(p.repo, b.repo, `${b.gespann}/suggested-checks.md`, p.criteria));
    log("Codex reads the repository and proposes checks");
    const r = await withCodex(d.db, d.sandboxes, d.config, p.owner_id, b.id, () =>
      runLong(d.sandboxes, b.id, codexExec(b, `${b.gespann}/suggest-prompt.txt`, `${b.gespann}/suggest-last.txt`, `${b.gespann}/suggest.jsonl`, p.model), { timeoutMs: 20 * 60_000 }),
    );
    const text = ((await d.sandboxes.readFile(b.id, `${b.gespann}/suggested-checks.md`)) ?? (await d.sandboxes.readFile(b.id, `${b.gespann}/suggest-last.txt`)) ?? "").trim();
    if (!text) throw new Error(r.timedOut ? "Codex took longer than 20 minutes" : `Codex proposed nothing (exit ${r.exitCode}): ${r.tail.slice(-500)}`);
    d.db.updateProject(p.id, { suggestion: text.slice(0, 8000) });
    log("suggestion ready");
  } finally {
    await stopSandbox(d, b);
  }
}

/** Codex explores the repo once and writes the recipe and scripts for a fast production-near copy. */
async function setup(d: Deps, job: Job, p: Project, log: (s: string) => void, again = false): Promise<void> {
  // Again (a PR run found its sandbox without the recipe): the project stays ready, so PRs keep queueing.
  if (!again) d.db.updateProject(p.id, { setup: "running", setup_error: null });
  let b: Box | null = null;
  try {
    b = await ensureSandbox(d, p, job, log);
    await ensureRepo(d, b, p);
    await git(d, b, p, `-C ${b.repo} fetch --quiet origin ${q(p.default_branch)}`);
    const co = await d.sandboxes.exec(b.id, `cd ${b.repo} && git checkout --quiet --force --detach FETCH_HEAD && git clean -fdq && mkdir -p ${b.project} 2>&1`, 120);
    if (co.exitCode !== 0) throw new Error(`checkout of ${p.default_branch} failed: ${co.stdout.slice(-800)}`);
    await d.sandboxes.writeFile(b.id, `${b.gespann}/setup-prompt.txt`, setupPrompt({ testerNote: d.sandboxes.testerNote, repo: p.repo, repoDir: b.repo, projectDir: b.project, criteria: p.criteria }));
    log("Codex prepares the environment (this can take a while on the first build)");
    const sb = b;
    const r = await withCodex(d.db, d.sandboxes, d.config, p.owner_id, sb.id, () =>
      runLong(d.sandboxes, sb.id, codexExec(sb, `${sb.gespann}/setup-prompt.txt`, `${sb.gespann}/setup-last.txt`, `${sb.gespann}/setup.jsonl`, p.model), {
        timeoutMs: 120 * 60_000,
        isCancelled: () => d.db.job(job.id)?.status === "cancelled",
      }),
    );
    const last = (await d.sandboxes.readFile(b.id, `${b.gespann}/setup-last.txt`)) ?? "";
    if (last) log(`Codex: ${last.slice(0, 4000)}`);
    if (r.exitCode !== 0) throw new Error(r.timedOut ? "setup took longer than 2 hours" : `codex exited ${r.exitCode}: ${r.tail.slice(-800)}`);
    const recipe = await d.sandboxes.readFile(b.id, b.recipe);
    if (!recipe) throw new Error(`Codex wrote no ${b.recipe}`);
    try {
      parseRecipe(recipe);
    } catch (err) {
      throw new Error(err instanceof RecipeError ? err.message : String(err));
    }
    const notes = await d.sandboxes.readFile(b.id, `${b.project}/NOTES.md`);
    const checks = ((await d.sandboxes.readFile(b.id, `${b.project}/CHECKS.md`)) ?? "").trim();
    const proofDir = join(d.config.dataDir, "projects", String(p.id));
    mkdirSync(proofDir, { recursive: true });
    try {
      writeFileSync(join(proofDir, "setup-proof.png"), await d.sandboxes.download(b.id, `${b.project}/setup-proof.png`));
    } catch {
      log("no setup-proof.png");
    }
    await checkCopy(d, b, log);
    await saveBundle(d, p, b);
    // Codex's concrete checks become the project's checks unless the team wrote their own.
    const own = d.db.project(p.id)?.criteria.trim();
    d.db.updateProject(p.id, { setup: "ready", recipe, notes, setup_error: null, ...(!own && checks ? { criteria: checks.slice(0, 8000) } : {}) });
  } catch (err) {
    if (!again) d.db.updateProject(p.id, { setup: "failed", setup_error: (err as Error).message.slice(0, 4000) });
    // A recipe that failed its check must not count as set up: the next PR tries again.
    else if (b) await d.sandboxes.exec(b.id, `rm -f ${b.recipe}`, 30).catch(() => undefined);
    throw err;
  } finally {
    if (b) await stopSandbox(d, b);
  }
}

/**
 * Independent check that the copy comes up from the recipe without Codex, answers, and goes down
 * without teardown errors. Runs on whatever the checkout has at HEAD.
 */
async function checkCopy(d: Deps, b: Box, log: (s: string) => void, isCancelled?: () => boolean): Promise<void> {
  log("checking the recipe without Codex: prepare, open the URL, tear down");
  const prep = await runLong(d.sandboxes, b.id, withEnv(b, `cd ${b.repo} && gespann verify prepare --recipe ${b.recipe} --pr 0 --head HEAD --base HEAD`), { timeoutMs: 60 * 60_000, ...(isCancelled ? { isCancelled } : {}) });
  const line = lastJson<{ ok: boolean; url?: string; error?: string; run: string }>(prep.tail);
  let http = "";
  try {
    if (prep.timedOut) throw new Error(isCancelled?.() ? "cancelled" : "the copy took longer than an hour to come up");
    if (!line?.ok || !line.url) throw new Error(`the recipe did not bring the copy up: ${line?.error ?? prep.tail.slice(-800)}`);
    http = (await d.sandboxes.exec(b.id, `curl -s -o /dev/null -w '%{http_code}' --max-time 30 ${q(line.url)}`, 60)).stdout.trim();
  } finally {
    await tearDown(d, b, line?.run);
  }
  if (!/^[23]\d\d$/.test(http)) throw new Error(`the copy answered HTTP ${http || "nothing"} at ${line?.url}`);
  log(`the copy came up at ${line?.url} (HTTP ${http}) and went down cleanly`);
}

/** Tears a copy down (the newest one without `run`) and throws when its teardown reported errors. */
async function tearDown(d: Deps, b: Box, run?: string): Promise<void> {
  const fin = await runLong(d.sandboxes, b.id, withEnv(b, `cd ${b.repo} && gespann verify finish --recipe ${b.recipe}${run ? ` --run ${q(run)}` : ""} --wait 5`), { timeoutMs: 20 * 60_000 });
  const out = lastJson<{ teardownErrors?: string[] }>(fin.tail);
  if (out?.teardownErrors?.length) throw new Error(`the copy did not go down cleanly: ${out.teardownErrors.join("; ").slice(0, 800)}`);
}

function lastJson<T>(text: string): T | undefined {
  for (const line of text.trim().split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      // not the summary line
    }
  }
  return undefined;
}

const CONCLUSION = { PASS: "success", SKIP: "neutral", BLOCKED: "neutral", FAIL: "failure" } as const;

/**
 * One PR run: copy up, tester, verdict, copy down; then the check and the PR comment. When the tester
 * was blocked only by gaps in the copy (a site not built, a provider not faked), Codex fixes the copy
 * once and the tester starts again; the PR gets the result of the second attempt.
 */
async function verifyRun(d: Deps, job: Job, p: Project, run: Run, log: (s: string) => void): Promise<void> {
  const gh = d.github();
  const runId = run.token.slice(0, 12);
  const runUrl = `${d.config.baseUrl}/runs/${run.id}`;
  d.db.updateRun(run.id, { status: "running", started: new Date().toISOString() });
  const progress = (title: string, summary: string) =>
    run.check_run_id ? gh.updateCheck(p.installation_id, p.repo, run.check_run_id, { status: "in_progress", title, summary: `${summary} Follow it at ${runUrl}.` }).catch(() => undefined) : undefined;
  await progress("Testing the change", "An agent is testing this PR on a production-near copy.");
  let b = await ensureSandbox(d, p, job, log);
  // A new sandbox, or one with an older recipe, takes over the project's current one; a replaced
  // sandbox of a project without a saved recipe needs the setup again.
  const hasRecipe = await syncRecipe(d, p, b, log).catch(async (err: Error) => {
    await stopSandbox(d, b);
    throw err;
  });
  if (!hasRecipe) {
    // One run at a time prepares it; runs waiting meanwhile take over the recipe it saved.
    await oneAtATime(recovering, p.id, async () => {
      if (await syncRecipe(d, p, b, log)) return;
      log("the sandbox has no recipe yet: preparing the environment again before the test");
      const current = d.db.project(p.id) ?? p;
      await setup(d, job, current, log, true);
      b = await ensureSandbox(d, d.db.project(p.id) ?? current, job, log);
    });
  }
  const cancelled = () => d.db.job(job.id)?.status === "cancelled";
  let prText: string | null = null;
  let issues: LinkedIssue[] = [];
  let unread: string | null = null;
  try {
    await ensureRepo(d, b, p);
    await git(d, b, p, `-C ${b.repo} fetch --quiet origin ${q(run.head)} ${q(run.base)}`);
    const merge = await d.sandboxes.exec(
      b.id,
      `cd ${b.repo} && git checkout --quiet --force --detach ${run.base} && git clean -fdq && git -c user.name=gespann -c user.email=verify@gespann.app merge --quiet --no-edit ${run.head} 2>&1`,
      120,
    );
    if (merge.exitCode !== 0) throw new Error(`PR head does not merge onto ${run.base_ref}: ${merge.stdout.slice(-500)}`);
    const pr = await gh.pull(p.installation_id, p.repo, run.pr);
    prText = `# ${pr.title}\n\n${pr.body ?? ""}\n`;
    // The issues the PR resolves set its goal. When GitHub does not list them, the tester judges from
    // diff and PR text alone, as for a PR without issues, and the run says so.
    issues = await gh.linkedIssues(p.installation_id, p.repo, run.pr, pr.body).catch((err: Error) => {
      unread = `Issue goals not checked: GitHub did not list the issues this PR resolves (${err.message.slice(0, 300)})`;
      log(`✗ ${unread}`);
      return [];
    });
    if (issues.length) log(`linked ${issues.length === 1 ? "issue" : "issues"}: ${issues.map((i) => i.ref).join(", ")}`);
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    d.db.updateRun(run.id, { error: (err as Error).message.slice(0, 4000) });
  }

  if (job.restarts > 0) await downLeftovers(d, b, run, log);
  let dir = `${b.gespann}/runs/${runId}`;
  let a: Attempt = { judged: null, outcome: "FAIL", clean: true };
  if (prText !== null) {
    a = await attempt(d, job, p, run, b, runId, dir, prText, issues, log);
    const gaps = copyGaps(a.judged);
    if (gaps.length && a.clean && !cancelled()) {
      for (const g of gaps) log(`blocked by the copy, not the change: ${g.expect} → ${g.fix}`);
      await progress("Fixing the test environment", "The copy lacked something the test needs. Codex adds it, then the test runs again.");
      // One fix at a time per project, each on the recipe the fix before it saved, so none is lost.
      const fixed = await oneAtATime(repairing, p.id, async () => {
        try {
          await syncRecipe(d, p, b, log);
        } catch (err) {
          log(`✗ could not take over the project's current recipe before the fix: ${(err as Error).message}. The result of the first test stands.`);
          return false;
        }
        return repair(d, job, p, run, b, gaps, log);
      });
      if (fixed && !cancelled()) {
        await progress("Testing the change again", "The copy was fixed; the agent tests this PR again.");
        // gespann run ids are 12 hex characters: the second attempt takes the next 12 of the token.
        const again = run.token.slice(12, 24);
        const before = d.db.run_(run.id)?.error ?? null;
        d.db.updateRun(run.id, { error: null });
        const second = await attempt(d, job, p, run, b, again, `${b.gespann}/runs/${again}`, prText, issues, log);
        if (second.judged?.verdict) {
          a = second;
          dir = `${b.gespann}/runs/${again}`;
        } else {
          log("the second test produced no verdict; the result of the first test stands");
          d.db.updateRun(run.id, { error: before });
        }
      }
    }
  }
  let judged = a.judged;
  const outcome = a.outcome;
  const { files, alias } = await collect(d, b, run, `${dir}/out`, log);
  if (judged) judged = withAliases(judged, alias);
  // A verdict without the issue goals says why, on the run page and over MCP.
  if (unread && judged?.verdict) {
    const before = d.db.run_(run.id)?.error;
    d.db.updateRun(run.id, { error: before ? `${before}\n${unread}` : unread });
  }
  const error = d.db.run_(run.id)?.error ?? null;
  d.db.updateRun(run.id, { status: error && !judged?.verdict ? "failed" : "done", outcome, verdict: judged ? JSON.stringify(judged) : null, files: JSON.stringify(files), finished: new Date().toISOString() });
  await stopSandbox(d, b);
  await report(d, p, { ...run, outcome, error }, judged, files, log);
}

/** A run lost in a restart may have left its copy up: finish tears it down before the run starts again. */
async function downLeftovers(d: Deps, b: Box, run: Run, log: (s: string) => void): Promise<void> {
  // gespann run ids: the first attempt takes the token's first 12 characters, a second one the next 12.
  for (const id of [run.token.slice(0, 12), run.token.slice(12, 24)]) {
    const dir = `${b.gespann}/runs/${id}`;
    if ((await d.sandboxes.exec(b.id, `test -f ${dir}/work/state.json`, 30)).exitCode !== 0) continue;
    log("taking down the copy that the attempt before the restart left up");
    await runLong(d.sandboxes, b.id, withEnv(b, `cd ${b.repo} && gespann verify finish --recipe ${b.recipe} --pr ${run.pr} --head ${run.head} --base ${run.base} --run ${id} --dir ${dir} --wait 0`), { timeoutMs: 20 * 60_000 }).catch(
      (err: Error) => log(`could not take the old copy down: ${err.message}`),
    );
  }
}

/** Title and description of each linked issue, for the tester. */
export function issuesText(issues: LinkedIssue[]): string {
  return `${issues.map((i) => `# ${i.ref}: ${i.title}\n\n${i.url}\n\n${i.body.trim() || "(no description)"}\n`).join("\n---\n\n")}`;
}

interface Attempt {
  judged: Judged | null;
  outcome: NonNullable<Run["outcome"]>;
  /** The copy went down without teardown errors. */
  clean: boolean;
}

/** Copy up, tester, then always finish: verdict and teardown, even when the copy or the tester failed. */
async function attempt(d: Deps, job: Job, p: Project, run: Run, b: Box, runId: string, dir: string, prText: string, issues: LinkedIssue[], log: (s: string) => void): Promise<Attempt> {
  try {
    // Fresh each time: a run that starts again after a restart must not show the lost attempt's proof.
    await d.sandboxes.exec(b.id, `rm -rf ${dir} && mkdir -p ${dir}/work ${dir}/out`, 30);
    await d.sandboxes.writeFile(b.id, `${dir}/work/pr.md`, prText);
    if (issues.length) {
      await d.sandboxes.writeFile(b.id, `${dir}/work/issues.md`, issuesText(issues));
      // finish reads the refs to require one goal per issue.
      await d.sandboxes.writeFile(b.id, `${dir}/work/issues.json`, `${JSON.stringify(issues.map((i) => ({ ref: i.ref, url: i.url })))}\n`);
    }
    log("bringing the copy up");
    const prep = await runLong(d.sandboxes, b.id, withEnv(b, `cd ${b.repo} && gespann verify prepare --recipe ${b.recipe} --pr ${run.pr} --head ${run.head} --base ${run.base} --run ${runId} --dir ${dir}`), {
      timeoutMs: 60 * 60_000,
      isCancelled: () => d.db.job(job.id)?.status === "cancelled",
    });
    const prepared = lastJson<{ ok: boolean; url?: string; error?: string }>(prep.tail);
    if (!prepared?.ok || !prepared.url) throw new Error(`the copy did not come up: ${prepared?.error ?? prep.tail.slice(-800)}`);
    log(`copy is up at ${prepared.url}`);

    const current = d.db.project(p.id) ?? p;
    const recipe = parseRecipe(current.recipe ?? (await d.sandboxes.readFile(b.id, b.recipe)) ?? "");
    const addendum = recipe.prompt ? ((await d.sandboxes.readFile(b.id, `${b.project}/${recipe.prompt}`)) ?? (await d.sandboxes.readFile(b.id, `${b.repo}/${recipe.prompt}`)) ?? "") : "";
    const notes = (await d.sandboxes.readFile(b.id, `${b.project}/NOTES.md`)) ?? "";
    const prompt = testerPrompt({
      testerNote: d.sandboxes.testerNote,
      repo: p.repo,
      pr: run.pr,
      head: run.head,
      base: run.base,
      url: prepared.url,
      out: `${dir}/out`,
      work: `${dir}/work`,
      criteria: current.criteria,
      recipe,
      addendum: [notes, addendum].filter(Boolean).join("\n\n"),
      issues: issues.map((i) => i.ref),
    });
    await d.sandboxes.writeFile(b.id, `${dir}/work/prompt.txt`, prompt);
    const rec = `${dir}/out/recording.mp4`;
    // Every run should come with a video of the tester's screen; when there is none, the log says why.
    const recording = d.sandboxes.startRecording
      ? await d.sandboxes.startRecording(b.id, rec).then(
          () => true,
          (err: Error) => (log(`✗ no recording of this run: ${err.message}`), false),
        )
      : (log(`✗ no recording of this run: the ${d.sandboxes.kind} sandboxes cannot record the screen`), false);
    log("the tester is working");
    let tester: Awaited<ReturnType<typeof runLong>>;
    try {
      tester = await withCodex(d.db, d.sandboxes, d.config, p.owner_id, b.id, () =>
        runLong(d.sandboxes, b.id, codexExec(b, `${dir}/work/prompt.txt`, `${dir}/work/last.txt`, `${dir}/work/codex.jsonl`, p.model), {
          timeoutMs: recipe.timeout * 60_000,
          isCancelled: () => d.db.job(job.id)?.status === "cancelled",
        }),
      );
    } finally {
      if (recording) {
        await d.sandboxes.stopRecording?.(b.id).catch((err: Error) => log(`could not stop the recording: ${err.message}`));
        await d.sandboxes.exec(b.id, finishRecordingScript(rec), 300).catch(() => undefined);
      }
    }
    log(tester.timedOut ? `the tester ran out of time (${recipe.timeout} min)` : `the tester finished (exit ${tester.exitCode})`);
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    d.db.updateRun(run.id, { error: (err as Error).message.slice(0, 4000) });
  }

  const fin = await runLong(d.sandboxes, b.id, withEnv(b, `cd ${b.repo} && gespann verify finish --recipe ${b.recipe} --pr ${run.pr} --head ${run.head} --base ${run.base} --run ${runId} --dir ${dir} --wait 600`), { timeoutMs: 30 * 60_000 }).catch((err: Error) => ({ tail: err.message, exitCode: null, timedOut: false }));
  const result = (await d.sandboxes.readFile(b.id, `${dir}/work/result.json`).catch(() => null)) ?? null;
  const teardownErrors = lastJson<{ teardownErrors?: string[] }>(fin.tail)?.teardownErrors ?? [];
  if (teardownErrors.length) log(`✗ the copy did not go down cleanly: ${teardownErrors.join("; ").slice(0, 800)}`);
  if (!result) {
    log(`finish did not report: ${fin.tail.slice(-400)}`);
    return { judged: null, outcome: "FAIL", clean: !teardownErrors.length };
  }
  const r = JSON.parse(result) as { judged: Judged; outcome: Judged["outcome"] };
  log(`verdict: ${r.outcome}`);
  return { judged: r.judged, outcome: r.outcome, clean: !teardownErrors.length };
}

/**
 * Codex adds what the copy lacked to the recipe and scripts. The recipe serves every later PR, so it
 * is checked without Codex on the base branch before it is kept. When anything fails, the previous
 * recipe comes back, so a bad fix never breaks later runs. Leaves the checkout at the PR merge.
 */
async function repair(d: Deps, job: Job, p: Project, run: Run, b: Box, gaps: Check[], log: (s: string) => void): Promise<boolean> {
  const backup = `${b.gespann}/project.before-repair`;
  const cancelled = () => d.db.job(job.id)?.status === "cancelled";
  const merged = (await d.sandboxes.exec(b.id, `cd ${b.repo} && git rev-parse HEAD`, 30)).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(merged)) {
    log("✗ could not read the merged checkout; the result of the first test stands");
    return false;
  }
  const checkout = (sha: string) => d.sandboxes.exec(b.id, `cd ${b.repo} && git checkout --quiet --force --detach ${sha} && git clean -fdq 2>&1`, 120);
  let saved = false;
  try {
    const save = await d.sandboxes.exec(b.id, `rm -rf ${backup}.tmp && cp -a ${b.project} ${backup}.tmp && rm -rf ${backup} && mv ${backup}.tmp ${backup} 2>&1`, 120);
    if (save.exitCode !== 0) throw new Error(`could not back up the recipe: ${save.stdout.slice(-300)}`);
    saved = true;
    await d.sandboxes.exec(b.id, `rm -f ${b.gespann}/repair-last.txt`, 30);
    await d.sandboxes.writeFile(b.id, `${b.gespann}/repair-prompt.txt`, repairPrompt({ testerNote: d.sandboxes.testerNote, repo: p.repo, repoDir: b.repo, projectDir: b.project, gaps: gaps.map((g) => ({ expect: g.expect, observed: g.observed, fix: g.fix ?? "" })) }));
    log("Codex fixes the copy");
    const r = await withCodex(d.db, d.sandboxes, d.config, p.owner_id, b.id, () =>
      runLong(d.sandboxes, b.id, codexExec(b, `${b.gespann}/repair-prompt.txt`, `${b.gespann}/repair-last.txt`, `${b.gespann}/repair.jsonl`, p.model), { timeoutMs: 60 * 60_000, isCancelled: cancelled }),
    );
    // Codex may have left its own copy up; it may also have touched the checkout.
    await tearDown(d, b);
    const last = ((await d.sandboxes.readFile(b.id, `${b.gespann}/repair-last.txt`)) ?? "").trim();
    if (last) log(`Codex: ${last.slice(0, 2000)}`);
    if (cancelled()) throw new Error("cancelled");
    if (/^cannot:/i.test(last)) throw new Error("the copy cannot provide it");
    if (r.exitCode !== 0) throw new Error(r.timedOut ? "the fix took longer than an hour" : `codex exited ${r.exitCode}: ${r.tail.slice(-500)}`);
    const recipe = (await d.sandboxes.readFile(b.id, b.recipe)) ?? "";
    try {
      parseRecipe(recipe);
    } catch (err) {
      throw new Error(err instanceof RecipeError ? err.message : String(err));
    }
    const co = await checkout(run.base);
    if (co.exitCode !== 0) throw new Error(`checkout of ${run.base_ref} failed: ${co.stdout.slice(-300)}`);
    log(`the fixed recipe has to work for every PR: checking it on ${run.base_ref}`);
    await checkCopy(d, b, log, cancelled);
    // The project's other sandboxes take the fixed recipe over before their next job.
    await saveBundle(d, p, b);
    d.db.updateProject(p.id, { recipe, notes: await d.sandboxes.readFile(b.id, `${b.project}/NOTES.md`) });
    log("the copy is fixed; the test runs again");
    return true;
  } catch (err) {
    log(`✗ could not fix the copy: ${(err as Error).message}. The result of the first test stands.`);
    await tearDown(d, b).catch(() => undefined);
    if (saved) await d.sandboxes.exec(b.id, `rm -rf ${b.project} && cp -a ${backup} ${b.project}`, 120).catch(() => undefined);
    return false;
  } finally {
    // The tester runs on the PR exactly as merged.
    await checkout(merged).catch(() => undefined);
  }
}

/**
 * Copies the run's proof to the server. Screenshots of the same screen are copied once; `alias`
 * maps each skipped one to the screenshot that was kept.
 */
async function collect(d: Deps, b: Box, run: Run, out: string, log: (s: string) => void): Promise<{ files: string[]; alias: Map<string, string> }> {
  const ls = await d.sandboxes.exec(b.id, `cd ${q(out)} 2>/dev/null && find . -maxdepth 1 -type f -size -104857601c -printf '%f\\n'`, 30);
  const big = await d.sandboxes.exec(b.id, `cd ${q(out)} 2>/dev/null && find . -maxdepth 1 -type f -size +104857600c -printf '%f %s\\n'`, 30).catch(() => null);
  for (const line of big?.stdout.split("\n").filter(Boolean) ?? []) log(`✗ ${line.split(" ")[0]} is too large to keep (${Math.round(Number(line.split(" ")[1]) / 1024 ** 2)} MB, limit 100 MB)`);
  const all = ls.stdout.split("\n").filter((f) => /^[A-Za-z0-9._-]+$/.test(f) && (IMAGE.test(f) || VIDEO.test(f) || f === "verdict.json"));
  const images = all.filter((f) => IMAGE.test(f));
  const thumbs = images.length ? await d.sandboxes.exec(b.id, `cd ${q(out)} && { ${thumbCommand(images)}; }`, 120).catch(() => null) : null;
  const alias = sameScreens(parseThumbs(thumbs?.stdout ?? ""));
  if (alias.size) log(`${alias.size} of ${images.length} screenshots show the same screen as another one; kept one of each`);
  // The recording first: it is the run's main proof and must not fall behind a long list of screenshots.
  const names = all.filter((f) => !alias.has(f)).sort((a, b) => Number(VIDEO.test(b)) - Number(VIDEO.test(a)));
  const dir = join(d.config.dataDir, "runs", String(run.id));
  mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  for (const f of names.slice(0, 60)) {
    try {
      writeFileSync(join(dir, f), await d.sandboxes.download(b.id, `${out}/${f}`));
      saved.push(f);
    } catch (err) {
      log(`could not copy ${f}: ${(err as Error).message}`);
    }
  }
  return { files: saved, alias };
}

async function report(d: Deps, p: Project, run: Run, judged: Judged | null, files: string[], log: (s: string) => void): Promise<void> {
  const gh = d.github();
  const outcome = run.outcome ?? "FAIL";
  const gate = { db: d.db, github: d.github, baseUrl: d.config.baseUrl };
  // Gate, check and comment together under the PR lock, so an approval cannot interleave.
  await withPrLock(p, run.pr, async () => {
    // The gate follows the result only for the PR's current head; a newer push has its own run.
    let state = "off" as GateState;
    let gateText = "";
    const pull = await gh.pull(p.installation_id, p.repo, run.pr).catch(() => null);
    if (pull && pull.state === "open" && gated(p, pull) && pull.head.sha === run.head) {
      try {
        state = await applyGate(gate, p, pull);
        gateText = gateLine(state, d.db.hold(p.id, run.pr)?.approved_by);
      } catch (err) {
        state = gateState(d.db, p, pull);
        gateText = `⚠️ gespann could not change the PR's draft state: ${(err as Error).message.slice(0, 200)}`;
      }
      log(`merge gate: ${state}`);
    }
    const body = runComment(d.config.baseUrl, run, judged, files, gateText);
    const conclusion = !judged?.verdict
      ? "neutral" // gespann itself failed (sandbox, copy, Codex): never a FAIL on the PR
      : outcome === "FAIL" && (state !== "off" || !isShadow(p))
        ? "failure"
        : outcome === "FAIL"
          ? "neutral"
          : CONCLUSION[outcome];
    const checkId = d.db.run_(run.id)?.check_run_id ?? run.check_run_id;
    if (checkId) {
      await gh
        .updateCheck(p.installation_id, p.repo, checkId, {
          status: "completed",
          conclusion,
          title: !judged?.verdict ? `gespann could not test this PR: ${(run.error ?? "no verdict").slice(0, 160)}` : `${outcome}${judged.verdict.summary ? `: ${judged.verdict.summary.slice(0, 200)}` : ""}`,
          summary: body.slice(0, 60_000),
        })
        .catch((err: Error) => log(`could not complete the GitHub check: ${err.message}`));
    }
    // A comment when there is something to read: a verdict, or a held PR that needs a person. Runs of
    // one PR run side by side; one of an older push that ends last must not replace the newer result.
    const current = pull?.head.sha === run.head;
    if (!current) log(pull ? "the PR has a newer push: its comment stays with the newer run" : "could not read the PR: its comment stays as it is");
    else if ((outcome !== "SKIP" && judged?.verdict) || state === "failed" || state === "skipped") {
      const commentId = await upsertComment(gate, p, run.pr, body).catch((err: Error) => {
        log(`could not comment on the PR: ${err.message}`);
        return null;
      });
      if (commentId) d.db.updateRun(run.id, { comment_id: commentId });
    }
  });
}

function isShadow(p: Project): boolean {
  try {
    return (parse(p.recipe ?? "") as { mode?: string } | null)?.mode !== "gate";
  } catch {
    return true;
  }
}

/** A job that the server lost this often (a restart, a crash during it) fails instead of starting again. */
export const MAX_RESTARTS = 2;
/** A running job whose server has not beaten for this long is taken to be lost and goes back into the queue. */
export const STALE_MS = 60_000;

export async function processJob(d: Deps, job: Job): Promise<void> {
  const p = d.db.project(job.project_id);
  if (!p) return d.db.endJob(job.id, "failed", "project gone");
  d.db.startJob(job.id);
  const log = (s: string) => d.db.appendLog(job.id, s);
  try {
    if (job.restarts > MAX_RESTARTS) throw new Error(`the server restarted during this job ${job.restarts} times; it does not start again`);
    if (job.restarts > 0) await stopLeftovers(d, job, log);
    // Every background command is recorded, so a restart can stop what this attempt left running.
    d = { ...d, sandboxes: tracked(d.sandboxes, (sandboxId, processId) => d.db.addProc(job.id, sandboxId, processId)) };
    if (job.kind === "login") throw new Error("Codex sign-in moved to Settings");
    else if (job.kind === "setup") await admit(d, job, p).then(() => setup(d, job, p, log));
    else if (job.kind === "suggest") await admit(d, job, p).then(() => suggest(d, job, p, log));
    else {
      const run = job.run_id ? d.db.run_(job.run_id) : undefined;
      if (!run) throw new Error("run gone");
      if (run.status === "cancelled") return d.db.endJob(job.id, "cancelled");
      // A PR merged or closed while its run waited (also before gespann heard of it) is not tested.
      // When GitHub does not answer, the run goes ahead as before.
      const pr = await d.github().pull(p.installation_id, p.repo, run.pr).catch(() => null);
      if (pr && pr.state !== "open") {
        // Only this run: an answer that is already stale must not cancel a run queued after a reopen.
        await withPrLock(p, run.pr, () => skipClosedRuns(d, p, pr, run.id));
        log(`skipped: the PR was ${pr.merged ? "merged" : "closed"} before its test started`);
        return d.db.endJob(job.id, "cancelled");
      }
      const refused = await admit(d, job, p).then(() => null, (err: Error) => err);
      // Closed or superseded while GitHub (or the server module) answered; verifyRun marks the run running before its first await.
      if (d.db.run_(run.id)?.status === "cancelled") return d.db.endJob(job.id, "cancelled");
      if (refused) throw refused;
      await verifyRun(d, job, p, run, log);
    }
    // Stopped and freed while the job still counts as running, so no other job takes a sandbox mid-stop.
    await releaseSlots(d, job);
    d.db.endJob(job.id, d.db.job(job.id)?.status === "cancelled" ? "cancelled" : "done");
    await ended(d, job, p);
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
    await releaseSlots(d, job);
    d.db.endJob(job.id, "failed", (err as Error).message.slice(0, 4000));
    if (job.kind === "setup" && d.db.project(p.id)?.setup === "queued") d.db.updateProject(p.id, { setup: "failed", setup_error: (err as Error).message.slice(0, 4000) });
    if (job.kind === "run" && job.run_id) {
      const run = d.db.run_(job.run_id);
      if (run && run.status !== "done") {
        d.db.updateRun(run.id, { status: "failed", outcome: "FAIL", error: (err as Error).message.slice(0, 4000), finished: new Date().toISOString() });
        await report(d, p, { ...run, outcome: "FAIL", error: (err as Error).message }, null, [], log).catch(() => undefined);
      }
    }
    await ended(d, job, p);
  }
}

function moduleJob(d: Deps, job: Job, p: Project) {
  const owner = d.db.user(p.owner_id);
  return { jobId: job.id, kind: job.kind, projectId: p.id, owner: { id: p.owner_id, login: owner?.login ?? "" } };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Throws when the server module does not let this job start. */
async function admit(d: Deps, job: Job, p: Project): Promise<void> {
  if (!d.module?.admit) return;
  let refused: string | null;
  try {
    refused = (await d.module.admit(moduleJob(d, job, p))) ?? null;
  } catch (err) {
    throw new Error(`${d.module.name} could not check this job: ${errText(err)}`);
  }
  if (refused !== null) throw new Error(`not started: ${refused}`);
}

/** Tells the server module a job ended, with its sandbox time. */
async function ended(d: Deps, job: Job, p: Project): Promise<void> {
  if (!d.module?.jobEnded) return;
  const j = d.db.job(job.id);
  if (!j?.started || !j.finished) return;
  const seconds = Math.max(0, (Date.parse(j.finished) - Date.parse(j.started)) / 1000);
  try {
    await d.module.jobEnded({ ...moduleJob(d, job, p), status: j.status, started: j.started, finished: j.finished, seconds });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", at: `${d.module.name} jobEnded`, job: job.id, message: errText(err) }));
  }
}

/** Stops the background commands (Codex, a copy coming up) that the lost attempt left running in the sandbox. */
async function stopLeftovers(d: Deps, job: Job, log: (s: string) => void): Promise<void> {
  for (const [sandboxId, processId] of JSON.parse(job.procs || "[]") as [string, number][]) {
    const s = await d.sandboxes.status(sandboxId, processId).catch(() => null);
    if (!s?.running) continue;
    await d.sandboxes.kill(sandboxId, processId).catch(() => undefined);
    log(`stopped a command the attempt before the restart left running (${processId})`);
  }
  d.db.clearProcs(job.id);
}

/** The same sandboxes, reporting each background command they start. */
function tracked(sb: Sandboxes, onStart: (sandboxId: string, processId: number) => void): Sandboxes {
  return new Proxy(sb, {
    get(target, key) {
      if (key === "start")
        return async (id: string, command: string) => {
          const processId = await target.start(id, command);
          onStart(id, processId);
          return processId;
        };
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Polls the queue. Jobs run side by side, each in its own sandbox, up to `parallel` at once. */
export function startWorker(d: Deps, parallel = 2): () => void {
  let stopped = false;
  const running = new Set<number>();
  const tick = async () => {
    // Jobs of a server that stopped (a deploy, a crash) start again; this one says its jobs still run.
    d.db.beat([...running]);
    for (const id of d.db.requeueStale(new Date(Date.now() - STALE_MS).toISOString())) console.log(JSON.stringify({ level: "info", message: `job ${id} was lost in a restart and is queued again` }));
    while (!stopped && running.size < parallel) {
      const job = d.db.nextJob();
      if (!job || running.has(job.id)) break;
      if (!d.db.claimJob(job.id)) continue;
      running.add(job.id);
      void processJob(d, job).finally(() => running.delete(job.id));
    }
  };
  const timer = setInterval(() => void tick(), 2000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
