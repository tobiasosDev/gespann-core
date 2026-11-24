import { outcomes, type Outcome, type Rate, rate } from "./findings.ts";
import { activeRules, loadState, loadVersion, type RuleVersion, record, saveState, saveVersion, versions } from "./rules.ts";
import { now, pct, readJson } from "./util.ts";

export const MIN_SESSIONS = 3;

export interface TrialReport {
  rule: string;
  status: string;
  version: number;
  previous: number | null;
  started?: string;
  ends?: string;
  trial: Rate;
  before: Rate;
  beforeSource: string;
  verdict: string;
}

function inTrial(o: Outcome, version: number, started: string): boolean {
  return o.source === "live" && o.version === version && o.t >= started;
}

export function trialReport(root: string, ruleId: string): TrialReport {
  const state = loadState(root);
  const rs = state.rules[ruleId];
  if (!rs) throw new Error(`unknown rule ${ruleId}`);
  const all = outcomes(root, { rule: ruleId });
  const started = rs.trial?.started ?? "9999";
  const version = rs.trial?.version ?? rs.active;
  const trialList = all.filter((o) => inTrial(o, version, started));
  const liveBefore = all.filter((o) => o.source === "live" && o.t < started);
  const before = liveBefore.length >= MIN_SESSIONS ? liveBefore : all.filter((o) => o.t < started);
  const beforeSource = before === liveBefore ? "live sessions before the trial" : "live sessions and transcripts before the trial";
  const t = rate(trialList);
  const b = rate(before);
  let verdict: string;
  if (!rs.trial) verdict = "No trial running.";
  else if (t.sessions < MIN_SESSIONS) verdict = `Effect open: ${t.sessions} relevant session(s) in the trial, need ${MIN_SESSIONS}.`;
  else {
    const tr = t.ranAfterLastEdit / t.sessions;
    const br = b.sessions ? b.ranAfterLastEdit / b.sessions : 0;
    verdict =
      tr > br
        ? `Check ran after the last edit in ${pct(t.ranAfterLastEdit, t.sessions)} of trial sessions vs ${pct(b.ranAfterLastEdit, b.sessions)} before.`
        : `No improvement: ${pct(t.ranAfterLastEdit, t.sessions)} in the trial vs ${pct(b.ranAfterLastEdit, b.sessions)} before.`;
  }
  const ends = rs.trial ? new Date(Date.parse(rs.trial.started) + rs.trial.days * 86_400_000).toISOString() : undefined;
  return {
    rule: ruleId,
    status: rs.status,
    version,
    previous: rs.trial?.previous ?? null,
    ...(rs.trial ? { started: rs.trial.started } : {}),
    ...(ends ? { ends } : {}),
    trial: t,
    before: b,
    beforeSource,
    verdict,
  };
}

export function renderRate(r: Rate): string {
  return [
    `${r.sessions} sessions with relevant changes`,
    `check after last edit ${pct(r.ranAfterLastEdit, r.sessions)}`,
    `green at end ${pct(r.passed, r.sessions)}`,
    `caught before review ${r.caught}`,
    `false alarms ${r.falseAlarms}`,
    `hook time ${r.sessions ? (r.hookMs / r.sessions / 1000).toFixed(1) : "0.0"} s/session`,
    `unknown ${r.unknown}`,
  ].join(", ");
}

function requireTrial(root: string, ruleId: string) {
  const state = loadState(root);
  const rs = state.rules[ruleId];
  if (!rs) throw new Error(`unknown rule ${ruleId}`);
  return { state, rs };
}

export function adopt(root: string, ruleId: string, note?: string): void {
  const { state, rs } = requireTrial(root, ruleId);
  if (rs.status !== "trial") throw new Error(`${ruleId} is not in a trial (${rs.status})`);
  rs.status = "adopted";
  delete rs.trial;
  record(root, state, ruleId, "adopt", rs.active, note);
  saveState(root, state);
}

export function extend(root: string, ruleId: string, days: number, note?: string): void {
  const { state, rs } = requireTrial(root, ruleId);
  if (rs.status !== "trial" || !rs.trial) throw new Error(`${ruleId} is not in a trial (${rs.status})`);
  rs.trial.days += days;
  record(root, state, ruleId, `extend +${days}d`, rs.active, note);
  saveState(root, state);
}

/**
 * Go back to the version before the current one; the next session start syncs it. A rule that
 * did not exist before is deactivated (its version files stay).
 */
export function rollback(root: string, ruleId: string, note?: string): number | null {
  const { state, rs } = requireTrial(root, ruleId);
  // undefined: nothing recorded (e.g. a rule from init); null: approval recorded that the rule was new.
  const previous = rs.trial ? rs.trial.previous : rs.previous;
  const from = rs.active;
  if (previous === undefined) throw new Error(`${ruleId} v${from} has no recorded earlier version to return to`);
  if (previous === null) {
    delete state.rules[ruleId];
    saveState(root, state);
    return null;
  }
  delete rs.previous;
  rs.active = previous;
  rs.status = "rolled_back";
  delete rs.trial;
  record(root, state, ruleId, `rollback from v${from}`, previous, note);
  saveState(root, state);
  return previous;
}

/** Merge blocking is a separate human decision, never part of a proposal. */
export function ciBlock(root: string, ruleId: string, note?: string): RuleVersion {
  const { state, rs } = requireTrial(root, ruleId);
  if (rs.status === "trial") throw new Error(`${ruleId} is in a trial; adopt or roll it back first`);
  // Through activeRules: a version edited after approval must not be copied into a new one.
  const current = activeRules(root, state).find((r) => r.id === ruleId) as RuleVersion;
  if (!current.check) throw new Error(`${ruleId} has no check command`);
  const version = (versions(root, ruleId).at(-1) ?? current.version) + 1;
  const next: RuleVersion = { ...current, version, ci: "block", origin: { ...current.origin, proposal: undefined } };
  saveVersion(root, next);
  rs.previous = rs.active;
  rs.active = next.version;
  record(root, state, ruleId, "ci-block", next.version, note);
  saveState(root, state);
  return next;
}

export interface Portable {
  gespann: 1;
  rule: Omit<RuleVersion, "version" | "origin">;
  exportedFrom: { version: number; at: string };
}

export function exportRule(root: string, ruleId: string): Portable {
  const { rs } = requireTrial(root, ruleId);
  const v = loadVersion(root, ruleId, rs.active);
  const { version, origin: _origin, ...rule } = v;
  return { gespann: 1, rule, exportedFrom: { version, at: now() } };
}

export function readPortable(path: string): Portable {
  const p = readJson<Portable>(path);
  if (!p || p.gespann !== 1 || !p.rule?.id) throw new Error(`${path} is not a gespann rule export`);
  return p;
}
