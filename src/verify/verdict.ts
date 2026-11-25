export type VerdictKind = "PASS" | "FAIL" | "BLOCKED" | "SKIP";
export type CheckResult = "pass" | "fail" | "blocked";

export interface Check {
  expect: string;
  observed: string;
  result: CheckResult;
  /** Screenshot file names in the out dir that show this check. */
  proof?: string[];
  /** For a blocked check: what the copy lacks that it could have (an app not built, a fake missing). */
  fix?: string;
}

export interface Verdict {
  verdict: VerdictKind;
  summary: string;
  checks: Check[];
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

/**
 * Validates `verdict.json`. A verdict that breaks its own rules (PASS without proof,
 * BLOCKED with a failed check, proof files that do not exist) counts as FAIL.
 */
export function judge(raw: string | null, proofExists: (file: string) => boolean): Judged {
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
  const proof = Array.isArray(v.proof) ? v.proof.map(String) : [];
  const verdict: Verdict = { verdict: kind as VerdictKind, summary: String(v.summary ?? ""), checks, proof };

  if (kind === "PASS") {
    if (!checks.length) problems.push("PASS without checks");
    if (checks.some((c) => c.result !== "pass")) problems.push("PASS with a check that did not pass");
    if (!proof.some((f) => IMAGE.test(f))) problems.push("PASS without a screenshot in proof");
  } else if (kind === "BLOCKED") {
    if (!checks.some((c) => c.result === "blocked")) problems.push("BLOCKED without a blocked check");
    if (checks.some((c) => c.result === "fail")) problems.push("BLOCKED with a failed check");
    if (checks.some((c) => c.result === "blocked" && !c.observed.trim())) problems.push("blocked check without an observation");
  } else if (kind === "FAIL") {
    if (!checks.some((c) => c.result === "fail")) problems.push("FAIL without a failed check");
  }
  const all = [...proof, ...checks.flatMap((c) => c.proof ?? [])];
  const missing = [...new Set(all.filter((f) => f.includes("/") || f.startsWith(".") || !proofExists(f)))];
  if (missing.length) problems.push(`proof files missing: ${missing.join(", ")}`);
  return { verdict, outcome: problems.length ? "FAIL" : (kind as VerdictKind), problems };
}

/** Blocked checks the copy could be changed to support: the run fixes the copy and tests again. */
export function copyGaps(j: Judged | null): Check[] {
  if (!j?.verdict || j.problems.length || j.outcome !== "BLOCKED") return [];
  return j.verdict.checks.filter((c) => c.result === "blocked" && c.fix);
}
