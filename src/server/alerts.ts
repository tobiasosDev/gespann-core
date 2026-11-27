import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db, Job, Project, Run, User } from "./db.ts";
import type { Mail, Mailer } from "./mail.ts";

/**
 * Mail when a project's jobs keep going wrong. Each kind of trouble counts the project's ended jobs
 * in a row; once the count reaches the owner's number, one mail goes out, and the next only after
 * a job of that group ended otherwise and the trouble came back.
 */

export type AlertCategory = "error" | "setup" | "fail" | "blocked";

export interface AlertKind {
  id: AlertCategory;
  /** In Settings, next to the switch. */
  label: string;
  description: string;
  /** Kinds of the same group break each other's streaks: a FAIL ends a streak of runs that could not test. */
  group: "run" | "setup";
  on: boolean;
  after: number;
}

export const ALERT_KINDS: readonly AlertKind[] = [
  { id: "error", label: "A PR could not be tested", description: "The sandbox, the agent or your plan stopped a run before it had a verdict.", group: "run", on: true, after: 3 },
  { id: "setup", label: "The copy of your app could not be built", description: "A project's setup failed, so its PRs cannot be tested until it is fixed.", group: "setup", on: true, after: 1 },
  { id: "fail", label: "A PR failed its test", description: "The tester found a problem. The PR's check and comment on GitHub say the same.", group: "run", on: false, after: 1 },
  { id: "blocked", label: "A test was blocked", description: "The tester could not check everything, usually because the copy lacks a service or data.", group: "run", on: false, after: 3 },
];

export const ALERT_MAX_AFTER = 20;

/** The user's rule for each kind, with the defaults filled in. */
export function alertRules(db: Db, userId: number): { id: AlertCategory; on: boolean; after: number }[] {
  const own = new Map(db.alertRules(userId).map((r) => [r.category, r]));
  return ALERT_KINDS.map((k) => {
    const r = own.get(k.id);
    return { id: k.id, on: r ? r.on === 1 : k.on, after: r ? r.after : k.after };
  });
}

/** What an ended job says: a kind of trouble, or that its group went fine; null when it says nothing (cancelled, skipped, conflict). */
export function classify(job: Pick<Job, "kind" | "status">, run: Pick<Run, "status" | "outcome" | "conflict"> | null): { hit: AlertCategory | null; group: AlertKind["group"] } | null {
  if (job.status === "cancelled") return null;
  if (job.kind === "setup") return { hit: job.status === "failed" ? "setup" : null, group: "setup" };
  if (job.kind !== "run" || !run) return null;
  if (run.status === "cancelled" || run.conflict) return null;
  // The orchestrator marks a run that threw as failed with outcome FAIL: it was not tested.
  if (job.status === "failed" || run.status === "failed" || !run.outcome) return { hit: "error", group: "run" };
  if (run.outcome === "SKIP") return null;
  if (run.outcome === "FAIL") return { hit: "fail", group: "run" };
  if (run.outcome === "BLOCKED") return { hit: "blocked", group: "run" };
  return { hit: null, group: "run" };
}

export interface AlertDeps {
  db: Db;
  config: Pick<Config, "baseUrl">;
  mailer: Mailer;
}

/**
 * Counts the ended job into its project's streaks and mails the owner when a streak reaches their
 * number. Call once per job. Resolves after the mail went out; a failed send is logged, never thrown.
 */
export async function alertJobEnded(d: AlertDeps, jobId: number): Promise<void> {
  const job = d.db.job(jobId);
  const p = job ? d.db.project(job.project_id) : undefined;
  if (!job || !p) return;
  const run = job.run_id ? (d.db.run_(job.run_id) ?? null) : null;
  const c = classify(job, run);
  if (!c) return;
  const group = ALERT_KINDS.filter((k) => k.group === c.group).map((k) => k.id);
  d.db.endStreaks(p.id, group.filter((g) => g !== c.hit));
  if (!c.hit) return;
  const streak = d.db.bumpStreak(p.id, c.hit);
  const owner = d.db.user(p.owner_id);
  const rule = alertRules(d.db, p.owner_id).find((r) => r.id === c.hit);
  if (!owner?.email || !rule?.on || streak.mailed || streak.count < rule.after) return;
  if (!d.db.markStreakMailed(p.id, c.hit)) return;
  const mail = alertMail(d.config.baseUrl, c.hit, streak.count, p, job, run, owner);
  try {
    await d.mailer.send(mail);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", at: "alert mail", job: job.id, category: c.hit, message: err instanceof Error ? err.message : String(err) }));
  }
}

function firstLines(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function summaryOf(run: Run | null): string {
  try {
    const v = JSON.parse(run?.verdict ?? "null") as { verdict?: { summary?: string } } | null;
    return v?.verdict?.summary ?? "";
  } catch {
    return "";
  }
}

export function alertMail(baseUrl: string, category: AlertCategory, count: number, p: Project, job: Job, run: Run | null, owner: User): Mail {
  const repo = p.repo;
  const times = count > 1 ? ` ${count} times in a row` : "";
  const ref = run ? `PR #${run.pr}` : "a PR";
  const pr = run ? `${ref}${run.title ? `, "${run.title}"` : ""}` : ref;
  let subject: string;
  let lead: string;
  let reason: string;
  let link: string;
  switch (category) {
    case "setup":
      subject = count > 1 ? `The copy of ${repo} could not be built${times}` : `The copy of ${repo} could not be built`;
      lead = `gespann could not build the copy of ${repo}${times}. Its PRs are not tested until the setup works.`;
      reason = job.error ?? p.setup_error ?? "";
      link = `${baseUrl}/projects/${p.id}/setup`;
      break;
    case "error":
      subject = count > 1 ? `gespann could not test ${repo}${times}` : `gespann could not test ${ref} of ${repo}`;
      lead = count > 1 ? `gespann could not test the last ${count} PR runs of ${repo}.` : `gespann could not test ${pr} of ${repo}.`;
      reason = run?.error ?? job.error ?? "";
      link = run ? `${baseUrl}/runs/${run.id}` : `${baseUrl}/projects/${p.id}/runs`;
      break;
    case "fail":
      subject = count > 1 ? `${count} PR tests of ${repo} failed in a row` : `${ref} of ${repo} failed its test`;
      lead = count > 1 ? `The last ${count} PR tests of ${repo} failed.` : `${pr} of ${repo} failed its test.`;
      reason = summaryOf(run);
      link = `${baseUrl}/runs/${run?.id}`;
      break;
    case "blocked":
      subject = count > 1 ? `${count} PR tests of ${repo} were blocked in a row` : `The test of ${ref} of ${repo} was blocked`;
      lead = count > 1 ? `The tester could not check everything in the last ${count} PR tests of ${repo}. Often the copy lacks a service or data.` : `The tester could not check everything in ${pr} of ${repo}.`;
      reason = summaryOf(run) || (run?.error ?? "");
      link = `${baseUrl}/runs/${run?.id}`;
      break;
  }
  const lines = [`Hi ${owner.name || owner.login},`, "", lead, ""];
  if (count > 1 && run && category !== "setup") lines.push(`Last: ${pr}`);
  if (reason) lines.push(`Reason: ${firstLines(reason)}`);
  lines.push(`Details: ${link}`, "");
  lines.push("No further mail about this until it stops and starts again.");
  lines.push(`Change these mails or turn them off: ${baseUrl}/settings#mail`);
  return { to: owner.email as string, subject, text: `${lines.join("\n")}\n` };
}

// ---- confirming an address the user typed

const CONFIRM_HOURS = 24;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", `gespann-email:${secret}`).update(payload).digest("base64url");
}

/** The link that confirms `email` for this user; valid for 24 hours. */
export function confirmLink(baseUrl: string, secret: string, userId: number, email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: email, x: now + CONFIRM_HOURS * 3_600_000 })).toString("base64url");
  return `${baseUrl}/email/confirm?t=${payload}.${sign(secret, payload)}`;
}

/** The user and address a confirmation token names; null when it is forged or expired. */
export function readConfirmToken(secret: string, token: string, now = Date.now()): { userId: number; email: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(secret, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u?: unknown; e?: unknown; x?: unknown };
    if (typeof v.u !== "number" || typeof v.e !== "string" || typeof v.x !== "number" || v.x < now) return null;
    return { userId: v.u, email: v.e };
  } catch {
    return null;
  }
}

export function confirmMail(baseUrl: string, secret: string, user: User, email: string): Mail {
  return {
    to: email,
    subject: "Confirm your address for gespann",
    text: [
      `Hi ${user.name || user.login},`,
      "",
      "Open this link to get gespann's mail at this address:",
      confirmLink(baseUrl, secret, user.id, email),
      "",
      `The link works for ${CONFIRM_HOURS} hours. If you did not ask for this, ignore this mail.`,
      "",
    ].join("\n"),
  };
}
