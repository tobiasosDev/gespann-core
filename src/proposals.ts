import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lineDiff } from "./diff.ts";
import { isFinding, outcomes } from "./findings.ts";
import { loadState, loadVersion, type RuleState, type RuleVersion, record, saveState, saveVersion, validate, versions } from "./rules.ts";
import { skillMarkdown } from "./sync.ts";
import { configDir, now, readJson, shortId, userName, writeJson } from "./util.ts";

export interface Evidence {
  sessions: number;
  findings: number;
  missing: number;
  failed: number;
  samples: { source: string; agent: string; session: string; t: string; status: string; files: string[] }[];
}

export interface Proposal {
  id: string;
  rule: string;
  from: number | null;
  to: RuleVersion;
  reason: string;
  evidence: Evidence;
  status: "open" | "approved" | "rejected";
  created: string;
  createdBy: string;
  decided?: { at: string; by: string; note?: string };
}

export function proposalPath(root: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new Error(`invalid proposal id "${id}"`);
  return join(configDir(root), "proposals", `${id}.json`);
}

export function loadProposal(root: string, id: string): Proposal {
  const p = readJson<Proposal>(proposalPath(root, id));
  if (!p || p.id !== id) throw new Error(`no proposal ${id}`);
  return p;
}

export function listProposals(root: string): Proposal[] {
  const dir = join(configDir(root), "proposals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Proposal>(join(dir, f)) as Proposal)
    .sort((a, b) => a.created.localeCompare(b.created));
}

export function defaultSkill(rule: RuleVersion): string {
  const c = rule.check;
  if (!c) return `${rule.title}.\n\nWhy: ${rule.why}`;
  const where = c.cwd ? ` in \`${c.cwd}\`` : "";
  return [
    `Before you report a change to ${rule.paths.map((p) => `\`${p}\``).join(", ")} as done, run \`${c.command}\`${where} and fix everything it reports.`,
    "Run it after your last edit, not before: a pass from before an edit does not count.",
    `If it cannot run (missing service, data or tool), say so in your final message instead of skipping it silently.`,
    "",
    `Why: ${rule.why}`,
  ].join("\n");
}

/**
 * The next level for a rule, highest that works first (as in pstack /correct): an instruction
 * can be skipped, a check at stop cannot; CI catches what the local loop missed.
 */
export function nextVersion(current: RuleVersion): { to: RuleVersion; reason: string } {
  const base: RuleVersion = { ...current, version: current.version + 1, skill: current.skill ?? defaultSkill(current) };
  if (current.check && current.level !== "hook") {
    return {
      to: { ...base, level: "hook" },
      reason: `The check exists as a command, so a stop hook runs \`${current.check.command}\` when relevant files changed and sends the agent back on failure. The skill tells the agent to run it itself first.`,
    };
  }
  if (!current.check && current.level === "observe") {
    return { to: { ...base, level: "skill" }, reason: "There is no command to run, so the rule becomes an instruction the agent receives as a skill." };
  }
  if (current.check && current.ci === "off") {
    return { to: { ...base, ci: "report" }, reason: "The stop hook is in place; CI now reports the same check per PR in trial mode." };
  }
  return { to: { ...base, skill: current.skill ?? defaultSkill(current) }, reason: "No higher level is available; revise the skill text." };
}

export function evidenceFor(root: string, rule: string): Evidence {
  const list = outcomes(root, { rule });
  const f = list.filter(isFinding);
  return {
    sessions: list.filter((o) => o.status !== "unknown").length,
    findings: f.length,
    missing: f.filter((o) => o.status === "missing").length,
    failed: f.filter((o) => o.status === "fail").length,
    samples: f
      .slice(-5)
      .reverse()
      .map((o) => ({ source: o.source, agent: o.agent, session: o.session, t: o.t, status: o.status, files: o.files.slice(0, 5) })),
  };
}

export function propose(root: string, ruleId: string, opts: { force?: boolean; to?: RuleVersion; reason?: string } = {}): Proposal {
  const state = loadState(root);
  const rs = state.rules[ruleId];
  const current = rs ? loadVersion(root, ruleId, rs.active) : undefined;
  const evidence = current ? evidenceFor(root, ruleId) : { sessions: 0, findings: 0, missing: 0, failed: 0, samples: [] };
  if (current && evidence.findings === 0 && !opts.force && !opts.to) {
    throw new Error(`no findings for ${ruleId}: nothing to propose (use --force to propose anyway)`);
  }
  const next = opts.to ? { to: opts.to, reason: opts.reason ?? "Imported rule." } : nextVersion(current as RuleVersion);
  const latest = versions(root, ruleId).at(-1) ?? 0;
  next.to.version = latest + 1;
  validate(next.to);
  const open = listProposals(root).find((p) => p.rule === ruleId && p.status === "open");
  if (open) throw new Error(`proposal ${open.id} for ${ruleId} is still open; approve or reject it first`);
  const p: Proposal = {
    id: `${ruleId}-v${next.to.version}-${shortId()}`,
    rule: ruleId,
    from: current?.version ?? null,
    to: { ...next.to, origin: { ...next.to.origin } },
    reason: next.reason,
    evidence,
    status: "open",
    created: now(),
    createdBy: userName(root),
  };
  p.to.origin = { ...p.to.origin, proposal: p.id };
  writeJson(proposalPath(root, p.id), p);
  return p;
}

export function render(root: string, p: Proposal): string {
  const from = p.from ? loadVersion(root, p.rule, p.from) : undefined;
  const strip = (v?: RuleVersion) => (v ? JSON.stringify({ ...v, skill: undefined, origin: undefined }, null, 2) : "");
  const lines = [
    `Proposal ${p.id} (${p.status})`,
    `Rule ${p.rule}: ${p.from ? `v${p.from}` : "new"} → v${p.to.version}, level ${from?.level ?? "-"} → ${p.to.level}, ci ${from?.ci ?? "-"} → ${p.to.ci}`,
    "",
    `Why: ${p.reason}`,
    "",
    `Evidence: ${p.evidence.findings} of ${p.evidence.sessions} sessions with relevant changes ended without a passing check after the last edit (${p.evidence.missing} not run, ${p.evidence.failed} failing).`,
    ...p.evidence.samples.map((s) => `  ${s.t.slice(0, 16)} ${s.agent} ${s.session.slice(0, 12)} ${s.status} (${s.source}): ${s.files.join(", ")}`),
    "",
    "Rule diff:",
    lineDiff(strip(from), strip(p.to)),
  ];
  if (p.to.skill && p.to.level !== "observe") {
    lines.push("", "Skill (.claude/skills and .agents/skills):", lineDiff(from?.skill && from.level !== "observe" ? skillMarkdown(from) : "", skillMarkdown(p.to)));
  }
  return lines.join("\n");
}

export function approve(root: string, id: string, opts: { edited?: RuleVersion; note?: string; trialDays?: number } = {}): RuleVersion {
  const p = loadProposal(root, id);
  if (p.status !== "open") throw new Error(`proposal ${id} is ${p.status}`);
  const to = opts.edited ? { ...opts.edited, id: p.rule, version: p.to.version, origin: p.to.origin } : p.to;
  if (opts.edited && opts.edited.ci === "block" && p.to.ci !== "block") {
    throw new Error("blocking merges needs its own approval: use `gespann ci-block <rule>`");
  }
  const state = loadState(root);
  const applied = state.rules[p.rule];
  // A retry after the state was written (also after --edit): finish the proposal only.
  if (applied?.active === to.version && applied.trial?.version === to.version && loadVersion(root, p.rule, to.version).origin?.proposal === p.id) {
    // A retry after the state was written: finish the proposal only.
    p.status = "approved";
    p.decided = { at: now(), by: userName(root), ...(opts.note ? { note: opts.note } : {}) };
    writeJson(proposalPath(root, id), p);
    return loadVersion(root, p.rule, to.version);
  }
  saveVersion(root, to);
  const prev: RuleState | undefined = state.rules[p.rule];
  state.rules[p.rule] = {
    active: to.version,
    status: "trial",
    trial: { version: to.version, previous: prev?.active ?? null, started: now(), days: opts.trialDays ?? 14 },
    previous: prev?.active ?? null,
    ...(prev?.digests ? { digests: prev.digests } : {}),
    history: prev?.history ?? [],
  };
  record(root, state, p.rule, "approve", to.version, opts.note ?? `proposal ${id}`);
  saveState(root, state);
  p.status = "approved";
  p.decided = { at: now(), by: userName(root), ...(opts.note ? { note: opts.note } : {}) };
  writeJson(proposalPath(root, id), p);
  return to;
}

export function reject(root: string, id: string, note?: string): void {
  const p = loadProposal(root, id);
  if (p.status !== "open") throw new Error(`proposal ${id} is ${p.status}`);
  p.status = "rejected";
  p.decided = { at: now(), by: userName(root), ...(note ? { note } : {}) };
  writeJson(proposalPath(root, id), p);
}
