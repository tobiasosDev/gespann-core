import type { Check, Goal, Judged, VerdictKind } from "../verify/verdict.ts";

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
}

const ICON: Record<VerdictKind, string> = { PASS: "✅", FAIL: "❌", BLOCKED: "⛔", SKIP: "⏭️" };
const MARK: Record<Check["result"], string> = { pass: "✅", fail: "❌", blocked: "⛔" };
const GOAL: Record<Goal["result"], string> = { met: "✅ met", missed: "❌ missed", blocked: "⛔ blocked" };
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

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

/**
 * The PR comment, short on purpose: outcome and count in the title, the summary, the merge gate,
 * the checks that need a person in the open, and passed checks and screenshots folded away.
 * gespann edits this one comment per PR.
 */
export function renderComment(c: CommentInput): string {
  const v = c.judged?.verdict ?? null;
  const checks = v?.checks ?? [];
  const passed = checks.filter((x) => x.result === "pass");
  const open = checks.filter((x) => x.result !== "pass");
  const lines: string[] = [];
  if (!v) {
    lines.push("### ⚠️ gespann could not test this PR", "", `> ${cell(c.error ?? "The run produced no verdict.", 300)}`);
  } else {
    const count = checks.length ? ` · ${passed.length}/${checks.length} checks passed` : "";
    lines.push(`### ${ICON[c.outcome]} gespann: ${c.outcome}${count}`);
    if (v.summary.trim()) lines.push("", `> ${sentences(v.summary, 260)}`);
  }
  if (c.gate) lines.push("", c.gate);
  for (const p of c.judged?.problems ?? []) if (v) lines.push("", `⚠️ Verdict rejected: ${cell(p, 200)}`);
  if (v?.goals?.length) lines.push("", ...goalTable(v.goals));
  if (open.length) lines.push("", ...table(open));
  if (passed.length) lines.push("", `<details><summary>✅ ${passed.length} passed ${passed.length === 1 ? "check" : "checks"}</summary>`, "", ...table(passed), "", "</details>");

  // GitHub plays no video from another site, so the recording is a link, above the screenshots.
  const video = c.files.find((f) => /\.(mp4|webm)$/i.test(f));
  if (video) lines.push("", `🎬 **[Watch the recording](${c.fileUrl(video)})** of the tester's screen`);

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
  lines.push("", `<sub>\`${c.head.slice(0, 7)}\` merged onto \`${c.baseRef}\` · [Full run](${c.runUrl}) · gespann</sub>`);
  return lines.join("\n");
}
