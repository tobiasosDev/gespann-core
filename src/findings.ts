import { type Agent, type CheckEvent, type CheckStatus, type FlagEvent, listSessions, type Session, sinceStart, type StopEvent, startOf } from "./journal.ts";
import { loadScan } from "./scan.ts";

/** One session's outcome for one rule, from live hooks or from a transcript scan. */
export interface Outcome {
  source: "live" | "transcript";
  agent: Agent;
  session: string;
  t: string;
  rule: string;
  /** Rule version active in the session; transcripts predate gespann and have none. */
  version: number | null;
  status: CheckStatus;
  files: string[];
  /** A check failed during the session and passed at the end: a problem caught before review. */
  caught: boolean;
  hookRuns: number;
  hookMs: number;
  falseAlarm: boolean;
}

/** The last stop of the measured interval: a resumed session has no result until it stops again. */
function measuredStop(s: Session): StopEvent | undefined {
  return sinceStart(s.events, startOf(s)).filter((e): e is StopEvent => e.type === "stop").at(-1);
}

function liveOutcomes(s: Session): Outcome[] {
  const start = startOf(s);
  const stop = measuredStop(s);
  const events = sinceStart(s.events, start);
  if (!stop) return [];
  return Object.entries(stop.results)
    .filter(([, r]) => r.status !== "clean")
    .map(([rule, r]) => {
      const checks = events.filter((e): e is CheckEvent => e.type === "check" && e.rule === rule);
      const hook = checks.filter((c) => c.by === "hook");
      return {
        source: "live" as const,
        agent: s.agent,
        session: s.session,
        t: start?.t ?? stop.t,
        rule,
        version: start?.rules[rule] ?? r.version,
        status: r.status,
        files: r.files,
        caught: r.status === "pass" && checks.some((c) => c.exit !== null && c.exit !== 0),
        hookRuns: hook.length,
        hookMs: hook.reduce((sum, c) => sum + (c.durationMs ?? 0), 0),
        falseAlarm: events.some((e): e is FlagEvent => e.type === "flag" && e.rule === rule),
      };
    });
}

export function outcomes(root: string, opts: { rule?: string; transcripts?: boolean } = {}): Outcome[] {
  const out: Outcome[] = [];
  const sessions = listSessions(root);
  for (const s of sessions) out.push(...liveOutcomes(s));
  if (opts.transcripts !== false) {
    // Every session the hooks saw, including clean ones: the transcript must not re-add them.
    const live = new Set(sessions.filter((s) => s.events.some((e) => e.type === "stop")).map((s) => `${s.agent}:${s.session}`));
    for (const s of loadScan(root)?.sessions ?? []) {
      if (live.has(`${s.agent}:${s.session}`)) continue;
      for (const [rule, r] of Object.entries(s.results)) {
        out.push({ source: "transcript", agent: s.agent, session: s.session, t: s.t, rule, version: null, status: r.status, files: r.files, caught: false, hookRuns: 0, hookMs: 0, falseAlarm: false });
      }
    }
  }
  return out.filter((o) => !opts.rule || o.rule === opts.rule).sort((a, b) => a.t.localeCompare(b.t));
}

/** A finding: the check was expected (relevant files changed) and did not end green. */
export function isFinding(o: Outcome): boolean {
  return o.status === "missing" || o.status === "fail";
}

export interface Rate {
  sessions: number;
  ranAfterLastEdit: number;
  passed: number;
  failedAtEnd: number;
  missing: number;
  unknown: number;
  caught: number;
  falseAlarms: number;
  hookMs: number;
}

export function rate(list: Outcome[]): Rate {
  const r: Rate = { sessions: 0, ranAfterLastEdit: 0, passed: 0, failedAtEnd: 0, missing: 0, unknown: 0, caught: 0, falseAlarms: 0, hookMs: 0 };
  for (const o of list) {
    if (o.status === "unknown") {
      r.unknown++;
      continue;
    }
    r.sessions++;
    if (o.status === "pass" || o.status === "fail" || o.status === "ran-unknown") r.ranAfterLastEdit++;
    if (o.status === "pass") r.passed++;
    if (o.status === "fail") r.failedAtEnd++;
    if (o.status === "missing") r.missing++;
    if (o.caught) r.caught++;
    if (o.falseAlarm) r.falseAlarms++;
    r.hookMs += o.hookMs;
  }
  return r;
}
