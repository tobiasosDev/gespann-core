import { conflictNote } from "./comment.ts";
import type { Config } from "./config.ts";
import type { Db, Job, Project, Run } from "./db.ts";
import type { ServerModule } from "./extension.ts";
import { applyGate, approvedHead, gated, gateLine, gateState, type GateState, runComment, upsertComment, withPrLock } from "./gate.ts";
import type { Github, LinkedIssue, OtherChecks } from "./github.ts";
import type { Judged } from "../verify/verdict.ts";

/**
 * The parts of a job that talk to GitHub or the server module. The orchestrator runs every job
 * (docs/orchestrator.md) and calls these through the internal API (internal.ts).
 */

export interface JobDeps {
  db: Db;
  github: () => Github;
  config: Config;
  /** `SERVER_MODULE`: asked before each job starts, told when it ended. */
  module?: ServerModule | null;
}

const CONCLUSION = { PASS: "success", SKIP: "neutral", BLOCKED: "neutral", FAIL: "failure" } as const;

/**
 * The PR text and the issues it resolves, as the tester reads them. The issues set the PR's goal.
 * When GitHub does not list them, the tester judges from diff and PR text alone, as for a PR without
 * issues, and `unread` says so.
 */
export async function prContext(gh: Github, p: Project, pr: number): Promise<{ prText: string; issues: LinkedIssue[]; unread: string | null }> {
  const pull = await gh.pull(p.installation_id, p.repo, pr);
  let unread: string | null = null;
  const issues = await gh.linkedIssues(p.installation_id, p.repo, pr, pull.body).catch((err: Error) => {
    unread = `Issue goals not checked: GitHub did not list the issues this PR resolves (${err.message.slice(0, 300)})`;
    return [];
  });
  return { prText: `# ${pull.title}\n\n${pull.body ?? ""}\n`, issues, unread };
}

/** Title and description of each linked issue, for the tester. */
export function issuesText(issues: LinkedIssue[]): string {
  return `${issues.map((i) => `# ${i.ref}: ${i.title}\n\n${i.url}\n\n${i.body.trim() || "(no description)"}\n`).join("\n---\n\n")}`;
}

/** What reporting a run needs. */
export type ReportDeps = Pick<JobDeps, "db" | "github" | "config">;

/** Gate, check and PR comment for a finished run. */
export async function report(d: ReportDeps, started: Project, run: Run, judged: Judged | null, files: string[], log: (s: string) => void): Promise<void> {
  const gh = d.github();
  const outcome = run.outcome ?? "FAIL";
  const gate = { db: d.db, github: d.github, baseUrl: d.config.baseUrl };
  // Gate, check and comment together under the PR lock, so an approval cannot interleave.
  await withPrLock(started, run.pr, async () => {
    // The merge gate as it is now: a person may switch it while the test runs.
    const p = d.db.project(started.id) ?? started;
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
    const conflict = run.conflict ? conflictNote(run.base_ref, JSON.parse(run.conflict) as string[]) : null;
    const conclusion = checkConclusion({ outcome, tested: !conflict && !!judged?.verdict, gate: p.gate === 1, approved: approvedHead(d.db, p, run.pr, run.head) });
    const checkId = d.db.run_(run.id)?.check_run_id ?? run.check_run_id;
    if (checkId) {
      await gh
        .updateCheck(p.installation_id, p.repo, checkId, {
          status: "completed",
          conclusion,
          title: conflict ? conflict.title.slice(0, 200) : !judged?.verdict ? `gespann could not test this PR: ${(run.error ?? "no verdict").slice(0, 160)}` : `${outcome}${judged.verdict.summary ? `: ${judged.verdict.summary.slice(0, 200)}` : ""}`,
          summary: body.slice(0, 60_000),
        })
        .catch((err: Error) => log(`could not complete the GitHub check: ${err.message}`));
    }
    // A comment when there is something to read: a verdict, or a held PR that needs a person. Runs of
    // one PR run side by side; one of an older push that ends last must not replace the newer result.
    const current = pull?.head.sha === run.head;
    if (!current) log(pull ? "the PR has a newer push: its comment stays with the newer run" : "could not read the PR: its comment stays as it is");
    // A PR with merge conflicts gets the comment too: it tells the PR's agent to update the branch.
    else if ((outcome !== "SKIP" && judged?.verdict) || conflict || state === "failed" || state === "skipped") {
      const commentId = await upsertComment(gate, p, run.pr, body).catch((err: Error) => {
        log(`could not comment on the PR: ${err.message}`);
        return null;
      });
      if (commentId) d.db.updateRun(run.id, { comment_id: commentId });
    }
  });
}

/**
 * The gespann/verify check's conclusion. Only the project's merge gate lets a FAIL fail the check:
 * with the gate off, results are reported and merging stays free, also under a rule that requires
 * the check. A head a person approved, and a run that could not test (conflict, sandbox, Codex),
 * end neutral.
 */
export function checkConclusion(r: { outcome: NonNullable<Run["outcome"]>; tested: boolean; gate: boolean; approved: boolean }): "success" | "neutral" | "failure" {
  if (!r.tested) return "neutral";
  if (r.outcome === "FAIL") return r.gate && !r.approved ? "failure" : "neutral";
  return CONCLUSION[r.outcome];
}

/** How often a run asks GitHub again while the PR's other checks run. */
export const CI_POLL_MS = 10_000;
/** A PR without any other check yet gets this long for its CI to report, so a slow CI start is not taken for none. */
export const CI_GRACE_MS = 30_000;
/** Checks that still run after this long do not hold the test back any further. */
export const CI_MAX_WAIT_MS = 60 * 60_000;

export type CiStep = { kind: "go"; note?: string } | { kind: "wait"; ms: number; line: string } | { kind: "skip"; reason: string };

/**
 * gespann is the last and most expensive stage: types, lint, tests and build run first, and the agent
 * starts only on a head whose other checks passed. A red check ends the run before it takes a sandbox.
 */
export function ciStep(c: OtherChecks, ageMs: number): CiStep {
  const names = (l: string[]) => (l.length > 5 ? `${l.slice(0, 5).join(", ")} and ${l.length - 5} more` : l.join(", "));
  if (c.failed.length) return { kind: "skip", reason: `the PR's other checks failed first (${names(c.failed)}); gespann tests once they pass` };
  if (c.pending.length) {
    if (ageMs >= CI_MAX_WAIT_MS) return { kind: "go", note: `other checks still run after ${Math.round(ageMs / 60_000)} min (${names(c.pending)}): testing anyway` };
    return { kind: "wait", ms: CI_POLL_MS, line: `waiting for the PR's other checks: ${names(c.pending)}` };
  }
  if (!c.passed.length && ageMs < CI_GRACE_MS) return { kind: "wait", ms: CI_GRACE_MS - ageMs, line: "no other checks yet: waiting 30 s for CI to report" };
  return { kind: "go" };
}

/** A run whose PR failed its other checks ends as SKIP, without a sandbox; a held PR stays held for a person. */
async function skipForChecks(d: ReportDeps, started: Project, run: Run, reason: string, log: (s: string) => void): Promise<void> {
  d.db.updateRun(run.id, { status: "done", outcome: "SKIP", error: reason, finished: new Date().toISOString() });
  log(`skipped: ${reason}`);
  const gate = { db: d.db, github: d.github, baseUrl: d.config.baseUrl };
  await withPrLock(started, run.pr, async () => {
    const p = d.db.project(started.id) ?? started; // the merge gate as it is now
    const checkId = d.db.run_(run.id)?.check_run_id ?? run.check_run_id;
    if (checkId)
      await d
        .github()
        .updateCheck(p.installation_id, p.repo, checkId, { status: "completed", conclusion: "skipped", title: "Skipped: other checks failed first", summary: `${reason[0]?.toUpperCase()}${reason.slice(1)}. Fix them, then push or start gespann again.` })
        .catch((err: Error) => log(`could not complete the GitHub check: ${err.message}`));
    const pull = await d.github().pull(p.installation_id, p.repo, run.pr).catch(() => null);
    if (pull && pull.state === "open" && gated(p, pull) && pull.head.sha === run.head) {
      const state = await applyGate(gate, p, pull).catch((err: Error) => {
        log(`merge gate: ${err.message}`);
        return null;
      });
      const line = state === "approved" ? gateLine(state, d.db.hold(p.id, run.pr)?.approved_by) : state ? gateLine("failed") : "";
      const body = runComment(d.config.baseUrl, { ...run, outcome: "SKIP", error: reason }, null, [], line);
      const commentId = await upsertComment(gate, p, run.pr, body).catch((err: Error) => {
        log(`could not comment on the PR: ${err.message}`);
        return null;
      });
      if (commentId) d.db.updateRun(run.id, { comment_id: commentId });
    }
  });
}

/** Marks the run's check as waiting or testing, unless a person approved its head: that check stays neutral. */
export async function pendingCheck(d: ReportDeps, p: Project, run: Run, fields: { status: "queued" | "in_progress"; title: string; summary: string }): Promise<void> {
  // In the PR's lock, so an approval that lands at the same time is not undone.
  await withPrLock(p, run.pr, async () => {
    if (run.check_run_id && !approvedHead(d.db, p, run.pr, run.head)) await d.github().updateCheck(p.installation_id, p.repo, run.check_run_id, fields);
  }).catch(() => undefined);
}

/** "go" when the run may take a sandbox now; otherwise the job went back into the queue or the run ended. */
export async function awaitChecks(d: ReportDeps, job: Job, p: Project, run: Run, log: (s: string) => void): Promise<"go" | "later" | "skipped"> {
  const age = Date.now() - Date.parse(run.created);
  let checks: OtherChecks | null = null;
  let unread = "";
  try {
    checks = await d.github().otherChecks(p.installation_id, p.repo, run.head);
  } catch (err) {
    unread = (err as Error).message.slice(0, 200);
  }
  if (d.db.run_(run.id)?.status === "cancelled") return "go";
  const step: CiStep = checks
    ? ciStep(checks, age)
    : age >= CI_MAX_WAIT_MS
      ? { kind: "go", note: `could not read the PR's other checks for an hour (${unread}): testing anyway` }
      : { kind: "wait", ms: CI_POLL_MS, line: `could not read the PR's other checks (${unread}): trying again` };
  if (step.kind === "go") {
    if (step.note) log(step.note);
    if (checks && !checks.statuses && !job.log.includes("commit statuses")) log("the GitHub App may not read commit statuses: only check runs count as other checks");
    return "go";
  }
  if (step.kind === "skip") {
    await skipForChecks(d, p, run, step.reason, log);
    return "skipped";
  }
  const last = d.db.job(job.id)?.log.trimEnd().split("\n").at(-1) ?? "";
  if (!last.endsWith(step.line)) {
    log(step.line);
    if (run.check_run_id) await pendingCheck(d, p, run, { status: "queued", title: "Waiting for the other checks", summary: `gespann tests this PR once its other checks pass. ${step.line[0]?.toUpperCase()}${step.line.slice(1)}.` });
  }
  d.db.deferJob(job.id, new Date(Date.now() + step.ms).toISOString());
  return "later";
}

/** What the server module's calls need. */
export type ModuleDeps = Pick<JobDeps, "db" | "module">;

function moduleJob(d: ModuleDeps, job: Pick<Job, "id" | "kind">, p: Project) {
  const owner = d.db.user(p.owner_id);
  return { jobId: job.id, kind: job.kind, projectId: p.id, owner: { id: p.owner_id, login: owner?.login ?? "" } };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The server module's reason not to start this job, or null. Throws when the module fails. */
export async function refusal(d: ModuleDeps, job: Pick<Job, "id" | "kind">, p: Project): Promise<string | null> {
  if (!d.module?.admit) return null;
  try {
    return (await d.module.admit(moduleJob(d, job, p))) ?? null;
  } catch (err) {
    throw new Error(`${d.module.name} could not check this job: ${errText(err)}`);
  }
}

/** Tells the server module a job ended, with its sandbox time; once per job. */
// eslint-disable-next-line no-restricted-syntax -- lock: a retry while the first call still runs must not bill twice; after a restart the flag decides
const ending = new Map<number, Promise<void>>();

export async function ended(d: ModuleDeps, job: Pick<Job, "id" | "kind">, p: Project): Promise<void> {
  // One call per job at a time, the flag read inside: the orchestrator's retry may arrive while a slow call still runs.
  const before = ending.get(job.id) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => endOnce(d, job, p));
  const tail = mine.catch(() => undefined);
  ending.set(job.id, tail);
  try {
    await mine;
  } finally {
    if (ending.get(job.id) === tail) ending.delete(job.id);
  }
}

async function endOnce(d: ModuleDeps, job: Pick<Job, "id" | "kind">, p: Project): Promise<void> {
  const j = d.db.job(job.id);
  if (!j?.started || !j.finished || j.ended_noted) return;
  if (d.module?.jobEnded) {
    const seconds = Math.max(0, (Date.parse(j.finished) - Date.parse(j.started)) / 1000);
    try {
      await d.module.jobEnded({ ...moduleJob(d, job, p), status: j.status, started: j.started, finished: j.finished, seconds });
    } catch (err) {
      console.error(JSON.stringify({ level: "error", at: `${d.module.name} jobEnded`, job: job.id, message: errText(err) }));
      // The orchestrator asks again.
      throw err;
    }
  }
  // Noted once the module took it: a call that failed is asked again, one that went through never.
  d.db.noteEnded(job.id);
}
