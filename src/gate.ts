import { changedSinceStart, fingerprint } from "./changes.ts";
import { runCheck } from "./check.ts";
import { type CheckEvent, type CheckStatus, type JournalEvent, sinceStart, type StartEvent, type StopResult } from "./journal.ts";
import type { RuleVersion } from "./rules.ts";
import { now, tail } from "./util.ts";

/** How often one session may be sent back (by any rule) before it may stop anyway. */
export const MAX_CONTINUATIONS = 2;

/** Evidence counts only for the same rule version: v2 may run a different command than v1. */
export function lastCheck(events: JournalEvent[], rule: string, version: number): CheckEvent | undefined {
  return events.filter((e): e is CheckEvent => e.type === "check" && e.rule === rule && e.version === version).at(-1);
}

/** Status of one rule right now, from git state and the checks recorded in this session. */
export function evaluate(root: string, start: StartEvent | undefined, events: JournalEvent[], rule: RuleVersion): StopResult {
  if (!start) return { status: "unknown", version: rule.version, files: [] };
  const files = changedSinceStart(root, start, rule.paths);
  if (files.length === 0) return { status: "clean", version: rule.version, files };
  if (!rule.check) return { status: "unknown", version: rule.version, files };
  const fp = fingerprint(root, files);
  const last = lastCheck(sinceStart(events, start), rule.id, rule.version);
  let status: CheckStatus = "missing";
  if (last && last.fp === fp) status = last.exit === null ? "ran-unknown" : last.exit === 0 ? "pass" : "fail";
  return { status, version: rule.version, files };
}

export interface GateOutcome {
  result: StopResult;
  check?: CheckEvent;
  /** Set when the agent has to continue: the reason becomes its next prompt. */
  reason?: string;
}

/**
 * Level "hook": at stop, a missing or failing check runs here. A failure sends the agent back
 * with the output, at most MAX_CONTINUATIONS times per session.
 */
export function gate(root: string, start: StartEvent | undefined, events: JournalEvent[], rule: RuleVersion): GateOutcome {
  const result = evaluate(root, start, events, rule);
  if (rule.level !== "hook" || !rule.check) return { result };
  if (result.status === "clean" || result.status === "pass" || result.status === "unknown") return { result };

  const run = runCheck(root, rule);
  const check: CheckEvent = {
    type: "check",
    t: now(),
    rule: rule.id,
    version: rule.version,
    by: "hook",
    exit: run.exit,
    fp: fingerprint(root, result.files),
    files: result.files,
    durationMs: run.durationMs,
    output: tail(run.output, 30),
  };
  const ran: StopResult = { ...result, hookRan: true, status: run.exit === null ? "ran-unknown" : run.exit === 0 ? "pass" : "fail" };
  if (run.exit === 0 || run.exit === null) return { result: ran, check };

  // The limit is per session, across rules: two rules must not send the agent back four times.
  const earlier = sinceStart(events, start).filter((e) => e.type === "stop" && Object.values(e.results).some((r) => r.blocked)).length;
  if (earlier >= MAX_CONTINUATIONS) return { result: ran, check };
  const where = rule.check.cwd ? ` (in ${rule.check.cwd})` : "";
  const reason = [
    `gespann rule "${rule.id}" v${rule.version}: \`${rule.check.command}\`${where} fails after your changes to ${result.files.slice(0, 5).join(", ")}${result.files.length > 5 ? " …" : ""}.`,
    "Fix what it reports, run it again, then finish.",
    "",
    tail(run.output, 40),
  ].join("\n");
  return { result: { ...ran, blocked: true }, check, reason };
}
