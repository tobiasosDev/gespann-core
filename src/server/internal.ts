import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Judged } from "../verify/verdict.ts";
import type { AppDeps, Env } from "./app.ts";
import type { Db, Project, Run } from "./db.ts";
import { skipClosedRuns, withPrLock } from "./gate.ts";
import { awaitChecks, ended, issuesText, pendingCheck, prContext, refusal, report } from "./worker.ts";

/**
 * The internal API the orchestrator calls (docs/orchestrator.md): everything a job needs that talks
 * to GitHub or the server module. Harmless with the builtin worker, which nobody calls it for.
 */

/** The orchestrator's bearer token, derived from SESSION_SECRET so both sides know it without another secret. */
export function internalToken(sessionSecret: string): string {
  return createHash("sha256").update(`gespann-internal:${sessionSecret}`).digest("hex");
}

/** What the orchestrator writes to `settings.orchestrator` every 10 s. */
export interface OrchestratorState {
  kind: string;
  parallel: number;
  why: string;
  instance: string;
  /** Its last beat: an ISO time, or milliseconds since 1970. */
  beat: string | number;
}

/** The orchestrator counts as present while its last beat is younger than this. */
export const PRESENT_MS = 60_000;

export function orchestratorState(db: Db): OrchestratorState | null {
  try {
    const s = JSON.parse(db.setting("orchestrator") ?? "null") as OrchestratorState | null;
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

export function orchestratorPresent(db: Db, now = Date.now()): boolean {
  const s = orchestratorState(db);
  const beat = typeof s?.beat === "number" ? s.beat : Date.parse(String(s?.beat ?? ""));
  return Number.isFinite(beat) && now - beat < PRESENT_MS;
}

export function mountInternal(app: Hono<Env>, d: AppDeps): void {
  const { db, config } = d;
  const want = Buffer.from(`Bearer ${internalToken(config.sessionSecret)}`);
  app.use("/internal/*", async (c, next) => {
    const got = Buffer.from(c.req.header("authorization") ?? "");
    if (!config.sessionSecret || got.length !== want.length || !timingSafeEqual(got, want)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  const notFound = (c: Context, what: string) => c.json({ error: `${what} not found` }, 404);
  const runOf = (c: Context): { run: Run; p: Project } | null => {
    const run = db.run_(Number(c.req.param("id")));
    const p = run ? db.project(run.project_id) : undefined;
    return run && p ? { run, p } : null;
  };
  const jobOf = (c: Context) => {
    const job = db.job(Number(c.req.param("id")));
    const p = job ? db.project(job.project_id) : undefined;
    return job && p ? { job, p } : null;
  };
  /** GitHub did not answer: the orchestrator decides what that means for the job. */
  const upstream = (c: Context, err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 502);

  app.post("/internal/jobs/:id/admit", async (c) => {
    const found = jobOf(c);
    if (!found) return notFound(c, "job");
    try {
      return c.json({ refused: await refusal(d, found.job, found.p) });
    } catch (err) {
      return c.json({ refused: (err as Error).message });
    }
  });

  app.post("/internal/jobs/:id/ended", async (c) => {
    const found = jobOf(c);
    if (!found) return notFound(c, "job");
    try {
      await ended(d, found.job, found.p, { retry: true });
    } catch (err) {
      // Not taken: the orchestrator keeps the end in its outbox and sends it again.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
    return c.json({});
  });

  app.get("/internal/runs/:id/pull", async (c) => {
    const found = runOf(c);
    if (!found) return notFound(c, "run");
    const { p, run } = found;
    const pr = await d.github().pull(p.installation_id, p.repo, run.pr).catch(() => null);
    return c.json({ pull: pr ? { state: pr.state, merged: !!pr.merged, head: pr.head.sha } : null });
  });

  app.post("/internal/runs/:id/skip-closed", async (c) => {
    const found = runOf(c);
    if (!found) return notFound(c, "run");
    const { p, run } = found;
    const pr = await d.github().pull(p.installation_id, p.repo, run.pr).catch(() => null);
    // Only this run: an answer that is already stale must not cancel a run queued after a reopen.
    if (!pr || pr.state === "open") return c.json({ skipped: false });
    const skipped = await withPrLock(p, run.pr, () => skipClosedRuns(d, p, pr, run.id));
    return c.json({ skipped: skipped.some((r) => r.id === run.id) });
  });

  // The PR's other checks come first: "later" put the job back into the queue (not_before), "skipped" ended the run as SKIP.
  app.post("/internal/runs/:id/await-checks", async (c) => {
    const found = runOf(c);
    const { jobId } = await c.req.json<{ jobId?: number }>();
    const job = db.job(Number(jobId));
    if (!found || !job) return notFound(c, found ? "job" : "run");
    const log = (s: string) => db.appendLog(job.id, s);
    return c.json({ step: await awaitChecks(d, job, found.p, found.run, log) });
  });

  app.post("/internal/runs/:id/check", async (c) => {
    const found = runOf(c);
    if (!found) return notFound(c, "run");
    const { p, run } = found;
    const { title, summary } = await c.req.json<{ title?: string; summary?: string }>();
    // Progress only: the run goes on when GitHub does not take it. A head a person approved keeps its neutral check.
    await pendingCheck(d, p, run, { status: "in_progress", title: String(title ?? ""), summary: String(summary ?? "") });
    return c.json({});
  });

  app.post("/internal/projects/:id/git-token", async (c) => {
    const p = db.project(Number(c.req.param("id")));
    if (!p) return notFound(c, "project");
    try {
      return c.json({ token: await d.github().installationToken(p.installation_id, true) });
    } catch (err) {
      return upstream(c, err);
    }
  });

  app.get("/internal/runs/:id/context", async (c) => {
    const found = runOf(c);
    if (!found) return notFound(c, "run");
    try {
      const { prText, issues, unread } = await prContext(d.github(), found.p, found.run.pr);
      return c.json({ prText, issues, issuesMd: issuesText(issues), unread });
    } catch (err) {
      return upstream(c, err);
    }
  });

  app.post("/internal/runs/:id/report", async (c) => {
    const found = runOf(c);
    if (!found) return notFound(c, "run");
    const body = await c.req.json<{ jobId?: number; judged?: Judged | null; files?: string[] }>();
    const jobId = Number(body.jobId);
    const log = (s: string) => (Number.isInteger(jobId) && jobId > 0 ? db.appendLog(jobId, s) : undefined);
    await report(d, found.p, found.run, body.judged ?? null, Array.isArray(body.files) ? body.files : [], log);
    return c.json({});
  });
}
