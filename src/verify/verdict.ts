export type VerdictKind = "PASS" | "FAIL" | "BLOCKED" | "SKIP";
export type CheckResult = "pass" | "fail" | "blocked";
export type GoalResult = "met" | "missed" | "blocked";

export interface Check {
  expect: string;
  observed: string;
  result: CheckResult;
  /** Screenshot file names in the out dir that show this check. */
  proof?: string[];
  /** For a blocked check: what the copy lacks that it could have (an app not built, a fake missing). */
  fix?: string;
}

/** Whether the PR reaches what a linked issue asks for, judged against the issue's description. */
export interface Goal {
  /** `#12`, or `owner/repo#12` for an issue in another repository. */
  issue: string;
  /** The issue's goal in one sentence. */
  goal: string;
  observed: string;
  result: GoalResult;
  proof?: string[];
}

export interface Verdict {
  verdict: VerdictKind;
  summary: string;
  checks: Check[];
  /** One per issue the PR resolves; absent when it links none. */
  goals?: Goal[];
  proof: string[];
}

export interface Judged {
  /** The verdict as written, when it was readable at all. */
  verdict: Verdict | null;
  /** What the run counts: the written verdict, or FAIL when the file is missing or rejected. */
  outcome: VerdictKind;
  problems: string[];
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const KINDS = new Set(["PASS", "FAIL", "BLOCKED", "SKIP"]);
const RESULTS = new Set(["pass", "fail", "blocked"]);
const GOALS = new Set(["met", "missed", "blocked"]);
const sameRef = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Validates `verdict.json`. A verdict that breaks its own rules (PASS without proof,
 * BLOCKED with a failed check, proof files that do not exist) counts as FAIL. `issues` are the
 * linked issues the tester was given: each needs a goal, and a missed goal fails the PR.
 */
export function judge(raw: string | null, proofExists: (file: string) => boolean, issues: string[] = []): Judged {
  if (raw === null) return { verdict: null, outcome: "FAIL", problems: ["the tester wrote no verdict.json"] };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { verdict: null, outcome: "FAIL", problems: ["verdict.json is not JSON"] };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { verdict: null, outcome: "FAIL", problems: ["verdict.json is not an object"] };
  const problems: string[] = [];
  const kind = String(v.verdict ?? "");
  if (!KINDS.has(kind)) problems.push(`unknown verdict ${JSON.stringify(kind)}`);
  const entries = Array.isArray(v.checks) ? (v.checks as unknown[]) : [];
  const checks: Check[] = [];
  for (const e of entries) {
    if (typeof e !== "object" || e === null) {
      problems.push("a check entry is not an object");
      continue;
    }
    const c = e as Record<string, unknown>;
    const result = String(c.result ?? "");
    if (!RESULTS.has(result)) problems.push(`check result ${JSON.stringify(result)} is not pass, fail or blocked`);
    const proof = Array.isArray(c.proof) ? c.proof.map(String) : undefined;
    const fix = result === "blocked" && typeof c.fix === "string" && c.fix.trim() ? c.fix.trim() : undefined;
    checks.push({ expect: String(c.expect ?? ""), observed: String(c.observed ?? ""), result: result as CheckResult, ...(proof ? { proof } : {}), ...(fix ? { fix } : {}) });
  }
  const goals: Goal[] = [];
  for (const e of Array.isArray(v.goals) ? (v.goals as unknown[]) : []) {
    if (typeof e !== "object" || e === null) {
      problems.push("a goal entry is not an object");
      continue;
    }
    const g = e as Record<string, unknown>;
    const result = String(g.result ?? "");
    if (!GOALS.has(result)) problems.push(`goal result ${JSON.stringify(result)} is not met, missed or blocked`);
    const proof = Array.isArray(g.proof) ? g.proof.map(String) : undefined;
    goals.push({ issue: String(g.issue ?? ""), goal: String(g.goal ?? ""), observed: String(g.observed ?? ""), result: result as GoalResult, ...(proof ? { proof } : {}) });
  }
  for (const ref of issues) {
    const n = goals.filter((g) => sameRef(g.issue, ref)).length;
    if (n !== 1) problems.push(n ? `issue ${ref} judged ${n} times` : `no goal judged for issue ${ref}`);
  }
  for (const g of goals) if (!issues.some((ref) => sameRef(g.issue, ref))) problems.push(`goal for ${JSON.stringify(g.issue)}, which is no issue this PR resolves`);
  const proof = Array.isArray(v.proof) ? v.proof.map(String) : [];
  const verdict: Verdict = { verdict: kind as VerdictKind, summary: String(v.summary ?? ""), checks, ...(goals.length ? { goals } : {}), proof };

  const missed = goals.some((g) => g.result === "missed");
  const blockedGoal = goals.some((g) => g.result === "blocked");
  if (kind === "PASS") {
    if (!checks.length) problems.push("PASS without checks");
    if (checks.some((c) => c.result !== "pass")) problems.push("PASS with a check that did not pass");
    if (goals.some((g) => g.result !== "met")) problems.push("PASS with an issue goal that was not met");
    if (!proof.some((f) => IMAGE.test(f))) problems.push("PASS without a screenshot in proof");
  } else if (kind === "BLOCKED") {
    if (!checks.some((c) => c.result === "blocked") && !blockedGoal) problems.push("BLOCKED without a blocked check");
    if (checks.some((c) => c.result === "fail")) problems.push("BLOCKED with a failed check");
    if (missed) problems.push("BLOCKED with a missed issue goal");
    if (checks.some((c) => c.result === "blocked" && !c.observed.trim())) problems.push("blocked check without an observation");
  } else if (kind === "FAIL") {
    if (!checks.some((c) => c.result === "fail") && !missed) problems.push("FAIL without a failed check");
  } else if (kind === "SKIP" && issues.length) {
    // An issue asks for a change; "nothing observable changed" cannot meet it.
    if (!goals.length || goals.some((g) => g.result !== "met")) problems.push("SKIP although the PR resolves an issue whose goal was not met");
  }
  if (goals.some((g) => !g.goal.trim())) problems.push("goal without the issue's goal");
  if (goals.some((g) => g.result !== "met" && !g.observed.trim())) problems.push("goal without an observation");
  const all = [...proof, ...checks.flatMap((c) => c.proof ?? []), ...goals.flatMap((g) => g.proof ?? [])];
  const missing = [...new Set(all.filter((f) => f.includes("/") || f.startsWith(".") || !proofExists(f)))];
  if (missing.length) problems.push(`proof files missing: ${missing.join(", ")}`);
  return { verdict, outcome: problems.length ? "FAIL" : (kind as VerdictKind), problems };
}
