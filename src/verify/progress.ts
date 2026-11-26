/**
 * Live progress of a run, for the run page while it is still running. The server records when each
 * stage starts; the tester writes its plan and each finished check to `progress.json` in its work dir,
 * which the server reads while the tester works.
 */

export const STAGES = ["sandbox", "copy", "read", "checks", "verdict"] as const;
export type Stage = (typeof STAGES)[number];

export interface LiveCheck {
  expect: string;
  /** null while the check is planned or running. */
  result: "pass" | "fail" | "blocked" | null;
  /** The tester said it is on this check now. */
  active?: true;
  observed?: string;
  /** When the server first saw the result. */
  at?: string;
}

export interface Progress {
  /** When each stage started; a stage is done when the next one has started. */
  at: Partial<Record<Stage, string>>;
  /** 2 when the copy was fixed and the tester runs again. */
  attempt: number;
  /** When the sandbox stage ended, kept when a second attempt starts the copy again. */
  sandboxDone?: string;
  checks: LiveCheck[];
  /** What the tester said it is doing, newest last, at most `TRAIL`. */
  now: { at: string; text: string }[];
}

export const TRAIL = 3;
const MAX_CHECKS = 20;
const MAX_TEXT = 300;

export const emptyProgress = (): Progress => ({ at: {}, attempt: 1, checks: [], now: [] });

/** Starts `stage` now. A later attempt starts over from the copy, with no checks from the attempt before. */
export function startStage(p: Progress, stage: Stage, at: string, attempt = p.attempt): Progress {
  // Already running (the copy of a second attempt, after its fix): the stage keeps its start.
  if (attempt === p.attempt && current(p) === stage) return p;
  const sandboxDone = p.sandboxDone ?? p.at.copy;
  const next: Progress =
    attempt === p.attempt ? { ...p, at: { ...p.at } } : { at: { sandbox: p.at.sandbox }, attempt, ...(sandboxDone ? { sandboxDone } : {}), checks: [], now: [] };
  // A stage that starts again (a second attempt) drops the stages after it.
  for (const s of STAGES.slice(STAGES.indexOf(stage))) delete next.at[s];
  next.at[stage] = at;
  return next;
}

const current = (p: Progress): Stage | undefined => [...STAGES].reverse().find((s) => p.at[s]);

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : undefined);
const RESULTS = new Set(["pass", "fail", "blocked"]);

/**
 * Merges what the tester wrote into `progress.json` (`{"checks":[{"expect","result","observed"}],"now":"..."}`).
 * Anything unreadable leaves the progress as it was: the file is the tester's, written mid-run.
 */
export function mergeTester(p: Progress, raw: string | null, at: string): Progress {
  if (!raw) return p;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return p;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return p;
  const o = v as { checks?: unknown; now?: unknown };
  const checks: LiveCheck[] = [];
  for (const c of Array.isArray(o.checks) ? o.checks.slice(0, MAX_CHECKS) : []) {
    const e = c as { expect?: unknown; result?: unknown; observed?: unknown };
    const expect = text(typeof c === "string" ? c : e?.expect);
    if (!expect) continue;
    const result = typeof e?.result === "string" && RESULTS.has(e.result) ? (e.result as LiveCheck["result"]) : null;
    const before = p.checks.find((b) => b.expect === expect);
    const observed = result ? text(e?.observed) : undefined;
    const active = !result && e?.result === "running";
    checks.push({ expect, result, ...(active ? { active: true as const } : {}), ...(observed ? { observed } : {}), ...(result ? { at: before?.result === result && before.at ? before.at : at } : {}) });
  }
  let next = p;
  if (checks.length && JSON.stringify(checks) !== JSON.stringify(p.checks)) {
    next = { ...next, checks };
    if (!next.at.checks) next = startStage(next, "checks", at);
  }
  const now = text(o.now);
  if (now && next.now.at(-1)?.text !== now) next = { ...next, now: [...next.now, { at, text: now }].slice(-TRAIL) };
  return next;
}

export function parseProgress(raw: string | null | undefined): Progress | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Progress;
  } catch {
    return null;
  }
}
