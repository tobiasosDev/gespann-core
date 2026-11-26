import type { Judged } from "../verify/verdict.ts";
import { renderComment } from "./comment.ts";
import type { Db, Project, Run } from "./db.ts";
import { type Github, GithubError, type PullRequest } from "./github.ts";

/**
 * The merge gate. A PR with this label cannot be merged until gespann's test of its current head
 * passes: gespann turns it into a draft, which GitHub never merges, and back once the test passes.
 * This needs no branch protection, so it also works where required checks are not available.
 */
export const GATE_LABEL = "gespann";

/** A comment that releases the PR's current head without a passing test. */
export const APPROVE = /^\s*\/gespann\s+approve\b/i;

/** Comment authors who may release a PR: people with access to the repository. */
export const MAY_APPROVE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type GateState = "off" | "testing" | "failed" | "skipped" | "passed" | "approved";

export interface GateDeps {
  db: Db;
  github: () => Github;
  baseUrl: string;
}

/** The gate applies: switched on for the project, and the PR carries the label. */
export const gated = (p: Pick<Project, "gate">, pr: Pick<PullRequest, "labels">) => p.gate === 1 && pr.labels.some((l) => l.name === GATE_LABEL);

export function gateState(db: Db, p: Project, pr: Pick<PullRequest, "number" | "labels" | "head">): GateState {
  if (!gated(p, pr)) return "off";
  if (db.hold(p.id, pr.number)?.approved_head === pr.head.sha) return "approved";
  const run = db.runForHead(p.id, pr.number, pr.head.sha);
  if (!run || run.status === "queued" || run.status === "running") return "testing";
  if (run.status === "done" && run.outcome === "PASS") return "passed";
  // Nothing tested is not a pass: a person decides.
  return run.status === "done" && run.outcome === "SKIP" ? "skipped" : "failed";
}

/**
 * A merged or closed PR needs no test: its queued runs are cancelled and their checks skipped, so the
 * queue moves on to PRs that are still open.
 */
export async function skipClosedRuns(d: Pick<GateDeps, "db" | "github">, p: Project, pr: Pick<PullRequest, "number" | "merged">, only?: number): Promise<Run[]> {
  const what = pr.merged ? "merged" : "closed";
  const runs = d.db.cancelQueuedRuns(p.id, pr.number, `the PR was ${what} before its test started`, only);
  for (const r of runs) {
    if (!r.check_run_id) continue;
    await d
      .github()
      .updateCheck(p.installation_id, p.repo, r.check_run_id, { status: "completed", conclusion: "skipped", title: `Skipped: the PR was ${what}`, summary: `The PR was ${what} before gespann started its test.` })
      .catch((err: Error) => console.error(JSON.stringify({ level: "error", at: "skip-check", message: err.message })));
  }
  return runs;
}

// eslint-disable-next-line no-restricted-syntax -- lock: serializes webhook handling inside one process; after a restart events re-read the PR
const locks = new Map<string, Promise<unknown>>();

/**
 * Runs gate work for one PR at a time. Webhooks arrive out of order and the worker reports
 * concurrently; each step reads the PR's current state from GitHub inside the lock.
 */
export function withPrLock<T>(p: Project, pr: number, fn: () => Promise<T>): Promise<T> {
  const key = `${p.id}:${pr}`;
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  locks.set(key, next);
  void next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => undefined);
  return next;
}

/**
 * Makes the PR's draft state match the gate: held while the head is untested, failed or skipped;
 * released when it passed, was approved, or lost the label. Only releases drafts gespann made.
 * Call inside withPrLock with the PR as GitHub has it now.
 */
export async function applyGate(d: GateDeps, p: Project, pr: PullRequest): Promise<GateState> {
  const state = gateState(d.db, p, pr);
  const hold = state === "testing" || state === "failed" || state === "skipped";
  const held = d.db.hold(p.id, pr.number)?.held === 1;
  if (hold && !pr.draft) {
    // Recorded first, so the webhook for our own change is known as ours.
    d.db.setHold(p.id, pr.number, { held: 1 });
    try {
      await d.github().setDraft(p.installation_id, pr.node_id, true);
      pr.draft = true; // the caller's PR stays current for later steps
    } catch (err) {
      d.db.setHold(p.id, pr.number, { held: 0 });
      throw err;
    }
  } else if (!hold && held) {
    // The hold stays recorded until GitHub confirms, so a failed release can be retried.
    if (pr.draft) await d.github().setDraft(p.installation_id, pr.node_id, false);
    pr.draft = false;
    d.db.setHold(p.id, pr.number, { held: 0 });
  }
  return state;
}

/** Releases a gated PR's current head without a passing test, on a person's word. */
export async function approve(d: GateDeps, p: Project, pr: PullRequest, login: string): Promise<void> {
  d.db.setHold(p.id, pr.number, { approved_by: login, approved_head: pr.head.sha });
  await applyGate(d, p, pr);
  await refreshComment(d, p, pr);
}

/** The gate's line in the PR comment. */
export function gateLine(state: GateState, approvedBy?: string | null): string {
  const release = "To merge anyway, comment `/gespann approve`, click *Ready for review*, or remove the `gespann` label.";
  switch (state) {
    case "failed":
      return `🔒 **Held as draft** until the test passes. ${release}`;
    case "skipped":
      return `🔒 **Held as draft**: gespann found nothing to test in this change. ${release}`;
    case "testing":
      return "🔒 **Held as draft** while gespann tests the new head.";
    case "passed":
      return "🔓 Test passed: the PR is ready for review and merge.";
    case "approved":
      return `🔓 Released by @${approvedBy ?? "someone"} without a passing test.`;
    default:
      return "";
  }
}

/** The result comment for a finished run, with the gate as it is now. */
export function runComment(baseUrl: string, run: Run, judged: Judged | null, files: string[], gate: string): string {
  return renderComment({
    outcome: run.outcome ?? "FAIL",
    judged,
    error: run.error,
    files,
    fileUrl: (f) => `${baseUrl}/proof/${run.token}/${encodeURIComponent(f)}`,
    runUrl: `${baseUrl}/runs/${run.id}`,
    head: run.head,
    baseRef: run.base_ref,
    gate,
    conflict: run.conflict ? (JSON.parse(run.conflict) as string[]) : null,
  });
}

/** Edits gespann's one comment on the PR, or writes it; remembers its id for the PR. */
export async function upsertComment(d: GateDeps, p: Project, pr: number, body: string): Promise<number> {
  const text = body.slice(0, 60_000);
  const previous = d.db.prComment(p.id, pr);
  if (previous) {
    try {
      await d.github().updateComment(p.installation_id, p.repo, previous, text);
      return previous;
    } catch (err) {
      // Only a deleted comment is replaced; any other error keeps the one comment and fails.
      if (!(err instanceof GithubError && err.status === 404)) throw err;
    }
  }
  const id = await d.github().comment(p.installation_id, p.repo, pr, text);
  d.db.setHold(p.id, pr, { comment_id: id });
  return id;
}

/**
 * Rewrites the PR's gespann comment with the gate's current state (after an approval or a removed
 * label). Without a result yet, the comment is just the gate line; the result replaces it later.
 */
export async function refreshComment(d: GateDeps, p: Project, pr: PullRequest): Promise<void> {
  const state = gateState(d.db, p, pr);
  const off = p.gate ? "🔓 The `gespann` label was removed: the PR is no longer held." : "🔓 The merge gate was switched off: the PR is no longer held.";
  const line = state === "off" ? off : gateLine(state, d.db.hold(p.id, pr.number)?.approved_by);
  const commentId = d.db.prComment(p.id, pr.number);
  const run = commentId ? d.db.runWithComment(p.id, pr.number, commentId) : undefined;
  if (run) {
    await upsertComment(d, p, pr.number, runComment(d.baseUrl, run, run.verdict ? (JSON.parse(run.verdict) as Judged) : null, JSON.parse(run.files) as string[], line)).catch(() => undefined);
  } else if (commentId || state === "approved") {
    await upsertComment(d, p, pr.number, line).catch(() => undefined);
  }
}

/** Switching the gate off releases every PR it holds. */
export async function releaseAll(d: GateDeps, p: Project): Promise<void> {
  for (const n of d.db.heldPrs(p.id)) {
    await withPrLock(p, n, async () => {
      const pr = await d.github().pull(p.installation_id, p.repo, n);
      await applyGate(d, p, pr);
      await refreshComment(d, p, pr);
    }).catch((err: Error) => console.error(JSON.stringify({ level: "error", at: "release", pr: n, message: err.message })));
  }
}

