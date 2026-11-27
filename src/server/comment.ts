import { preExisting, type Check, type Goal, type Judged, type Verdict, type VerdictKind } from "../verify/verdict.ts";

export interface CommentInput {
  outcome: VerdictKind;
  judged: Judged | null;
  /** Why there is no verdict, when gespann itself failed. */
  error?: string | null;
  /** Files of the run that were kept; proof outside this list is not shown. */
  files: string[];
  fileUrl: (file: string) => string;
  runUrl: string;
  head: string;
  baseRef: string;
  /** The merge gate's line, empty when the PR is not gated. */
  gate?: string;
  /** Files in conflict when the head does not merge onto the base: the PR was not tested. */
  conflict?: string[] | null;
}

const ICON: Record<VerdictKind, string> = { PASS: "✅", FAIL: "❌", BLOCKED: "⛔", SKIP: "⏭️" };
const MARK: Record<Check["result"], string> = { pass: "✅", fail: "❌", blocked: "⛔" };
const GOAL: Record<Goal["result"], string> = { met: "✅ met", missed: "❌ missed", blocked: "⛔ blocked" };
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** The conflicting files for one line of text, at most five by name. */
function fileList(files: string[]): string {
  const named = files.slice(0, 5).map((f) => `\`${f}\``).join(", ");
  return files.length > 5 ? `${named} and ${files.length - 5} more` : named;
}

/**
 * A PR whose head does not merge onto its base is not tested. Resolving the conflict is the job of
 * the PR's author or coding agent, not gespann's: this says what to do, for the check, the comment
 * and the MCP issue.
 */
export function conflictNote(baseRef: string, files: string[]): { title: string; fix: string } {
  return {
    title: `Not tested: the PR has merge conflicts with ${baseRef} in ${fileList(files)}`,
    fix: `Merge ${baseRef} into the PR branch (or rebase onto it), resolve the conflicts in ${fileList(files)} and push. gespann tests the new head when the push starts a run; if none starts (a draft, or a PR outside the recipe's triggers), use Rerun on the run page.`,
  };
}

/** One line of table text: no pipes or line breaks, cut at a word. */
export function cell(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max * 0.6 ? cut.lastIndexOf(" ") : cut.length)}…`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The first sentences of a text, up to `max` characters. */
export function sentences(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let out = "";
  for (const s of flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? []) {
    if ((out + s).length > max) break;
    out += s;
  }
  return out.trim() || cell(flat, max);
}

function table(checks: Check[]): string[] {
  return ["| | Check | What the tester saw |", "|:-:|---|---|", ...checks.map((x) => `| ${MARK[x.result] ?? "❔"} | ${cell(x.expect, 80)} | ${cell(x.observed, 130)} |`)];
}

/** Whether the PR reaches what each linked issue asks for; always in the open, it is the PR's purpose. */
function goalTable(goals: Goal[]): string[] {
  return ["| Issue | Goal | Result | What the tester saw |", "|---|---|---|---|", ...goals.map((g) => `| ${cell(g.issue, 40)} | ${cell(g.goal, 80)} | ${GOAL[g.result] ?? "❔"} | ${cell(g.observed, 130)} |`)];
}

/** The state of a flag's checks in one state: passed, failed (the PR's fault), or blocked. */
function stateMark(checks: Check[], flag: string, state: "off" | "on"): string {
  const own = checks.filter((x) => x.flag === flag && x.state === state);
  if (own.some((x) => x.result === "fail" && !preExisting(x))) return "❌";
  if (own.some((x) => x.result === "blocked")) return "⛔";
  return own.length ? "✅" : "❔";
}

/** One line per feature flag the PR touches: off (no user notices the PR) and on (the change works). */
function flagLines(v: Verdict): string[] {
  return (v.flags ?? []).map((f) =>
    f.tested
      ? `- Feature flag \`${cell(f.flag, 60)}\`: off ${stateMark(v.checks, f.flag, "off")} behaves as before the PR · on ${stateMark(v.checks, f.flag, "on")} the change works`
      : `- Feature flag \`${cell(f.flag, 60)}\`: not tested, ${cell(f.why ?? "", 160)}`,
  );
}

/**
 * The PR comment, short on purpose: outcome and count in the title, the summary, the merge gate,
 * the checks that need a person in the open, and passed checks and screenshots folded away.
 * gespann edits this one comment per PR.
 */
export function renderComment(c: CommentInput): string {
  const v = c.judged?.verdict ?? null;
  const checks = v?.checks ?? [];
  const passed = checks.filter((x) => x.result === "pass");
  const onBase = checks.filter(preExisting);
  const open = checks.filter((x) => x.result !== "pass" && !preExisting(x));
  const lines: string[] = [];
  if (c.conflict?.length) {
    const n = conflictNote(c.baseRef, c.conflict);
    lines.push("### 🔀 gespann: not tested, merge conflict", "", `> ${n.title}.`, "", n.fix);
  } else if (!v) {
    lines.push("### ⚠️ gespann could not test this PR", "", `> ${cell(c.error ?? "The run produced no verdict.", 300)}`);
  } else {
    const count = checks.length ? ` · ${passed.length}/${checks.length} checks passed${onBase.length ? ` · ${onBase.length} already on \`${c.baseRef}\`` : ""}` : "";
    lines.push(`### ${ICON[c.outcome]} gespann: ${c.outcome}${count}`);
    if (v.summary.trim()) lines.push("", `> ${sentences(v.summary, 260)}`);
  }
  if (c.gate) lines.push("", c.gate);
  for (const p of c.judged?.problems ?? []) if (v) lines.push("", `⚠️ Verdict rejected: ${cell(p, 200)}`);
  if (v?.goals?.length) lines.push("", ...goalTable(v.goals));
  if (v?.flags?.length) lines.push("", ...flagLines(v));
  if (open.length) lines.push("", ...table(open));
  if (onBase.length)
    lines.push(
      "",
      `**Already on \`${c.baseRef}\`**: ${onBase.length === 1 ? "this check fails" : "these checks fail"} on the base branch the same way, so ${onBase.length === 1 ? "it does" : "they do"} not count against this PR.`,
      "",
      "| | Check | What the tester saw | Same on the base |",
      "|:-:|---|---|---|",
      ...onBase.map((x) => `| 🔁 | ${cell(x.expect, 80)} | ${cell(x.observed, 130)} | ${cell(x.pre_existing ?? "", 130)} |`),
    );
  if (passed.length) lines.push("", `<details><summary>✅ ${passed.length} passed ${passed.length === 1 ? "check" : "checks"}</summary>`, "", ...table(passed), "", "</details>");

  // GitHub plays no video from another site, so the recording is a link, above the screenshots.
  // change.mp4 is the part of the recording that shows what the PR changes; it leads when there is one.
  const videos = c.files.filter((f) => /\.(mp4|webm)$/i.test(f));
  const clip = videos.find((f) => f === "change.mp4");
  const whole = videos.find((f) => f !== "change.mp4");
  if (clip) lines.push("", `🎬 **[Watch the change](${c.fileUrl(clip)})** in the tester's recording${whole ? ` · [whole test](${c.fileUrl(whole)})` : ""}`);
  else if (whole) lines.push("", `🎬 **[Watch the recording](${c.fileUrl(whole)})** of the tester's screen`);

  const shown = [...new Set([...checks.flatMap((x) => x.proof ?? []), ...(v?.goals ?? []).flatMap((g) => g.proof ?? []), ...(v?.proof ?? [])])].filter((f) => IMAGE.test(f) && c.files.includes(f));
  if (shown.length) {
    const caption = (f: string) => esc(cell(checks.find((x) => x.proof?.includes(f))?.expect ?? v?.goals?.find((g) => g.proof?.includes(f))?.goal ?? f, 48).replace(/\\\|/g, "|"));
    lines.push("", `<details><summary>📸 ${shown.length} ${shown.length === 1 ? "screenshot" : "screenshots"}</summary>`, "", "<table>");
    for (let i = 0; i < shown.length; i += 3) {
      const row = shown.slice(i, i + 3).map((f) => `<td width="33%" valign="top"><a href="${esc(c.fileUrl(f))}"><img src="${esc(c.fileUrl(f))}" width="100%" alt="${caption(f)}"></a><br><sub>${caption(f)}</sub></td>`);
      lines.push(`<tr>${row.join("")}</tr>`);
    }
    lines.push("</table>", "", "</details>");
  }
  const merged = c.conflict?.length ? "does not merge onto" : "merged onto";
  lines.push("", `<sub>\`${c.head.slice(0, 7)}\` ${merged} \`${c.baseRef}\` · [Full run](${c.runUrl}) · gespann</sub>`);
  return lines.join("\n");
}
