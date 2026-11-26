import assert from "node:assert/strict";
import { test } from "node:test";
import { renderComment } from "../src/server/comment.ts";
import { judge } from "../src/verify/verdict.ts";

const verdict = (kind: string, checks: object[], goals?: object[]) => JSON.stringify({ verdict: kind, summary: "s", checks, ...(goals ? { goals } : {}), proof: ["a.png"] });
const issues = (goals?: object[]) => (goals ? ["#4"] : []);
const judged = (kind: string, checks: object[], goals?: object[]) => judge(verdict(kind, checks, goals), () => true, issues(goals));

const pass = { expect: "the result opens on the full page", observed: "it does", result: "pass", proof: ["a.png"] };
// The shape of a real run: the tester saw the bug and that the same line is on the base.
const onBase = {
  expect: "the citation expanded in the embed stays expanded",
  observed: "the first reference is expanded instead",
  result: "fail",
  pre_existing: "CartBadge.tsx line 12 reads the old count key on main as well",
};

test("a failed check that fails the same way on the base branch does not fail the PR", () => {
  // The tester wrote FAIL for it: the run takes what the other checks give.
  const asFail = judged("FAIL", [pass, onBase]);
  assert.equal(asFail.outcome, "PASS");
  assert.deepEqual(asFail.problems, []);
  assert.equal(asFail.verdict?.verdict, "FAIL", "what the tester wrote stays as written");
  assert.equal(asFail.verdict?.checks[1]?.pre_existing, onBase.pre_existing);
  // Written as PASS, as the prompt asks, it stands.
  assert.equal(judged("PASS", [pass, onBase]).outcome, "PASS");
  // With a blocked check left it is BLOCKED, not FAIL.
  assert.equal(judged("FAIL", [onBase, { expect: "pay", observed: "no recording", result: "blocked" }]).outcome, "BLOCKED");
});

test("pre_existing never hides a failure of the PR", () => {
  assert.equal(judged("FAIL", [onBase, { ...pass, result: "fail" }]).outcome, "FAIL", "another failed check still fails");
  assert.equal(judged("PASS", [onBase, { ...pass, result: "fail" }]).outcome, "FAIL", "a PASS over a real failure is rejected");
  const missed = [{ issue: "#4", goal: "g", observed: "not done", result: "missed" }];
  assert.equal(judged("FAIL", [pass, onBase], missed).outcome, "FAIL", "a missed issue goal still fails");
  // Only a failed check can be pre-existing, and only with a reason.
  assert.equal(judged("PASS", [pass, { ...onBase, pre_existing: " " }]).outcome, "FAIL");
  assert.equal(judged("BLOCKED", [{ expect: "pay", observed: "no recording", result: "blocked", pre_existing: "x" }]).verdict?.checks[0]?.pre_existing, undefined);
});

test("the PR comment shows a pre-existing failure as a note of its own, not as an open check", () => {
  const j = judged("FAIL", [pass, onBase]);
  const body = renderComment({ outcome: j.outcome, judged: j, files: ["a.png"], fileUrl: (f) => f, runUrl: "u", head: "abcdef123", baseRef: "main" });
  assert.match(body, /### ✅ gespann: PASS · 1\/2 checks passed · 1 already on `main`/);
  assert.match(body, /\*\*Already on `main`\*\*: this check fails on the base branch the same way/);
  assert.match(body, /\| 🔁 \| the citation expanded in the embed stays expanded \| .* \| CartBadge.tsx line 12/);
  assert.doesNotMatch(body, /❌/);
});
