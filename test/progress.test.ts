import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProgress, mergeTester, startStage } from "../src/verify/progress.ts";

const T1 = "2026-11-26T06:34:00.000Z";
const T2 = "2026-11-26T06:35:00.000Z";

test("progress: the tester's plan starts the checks stage; a result keeps the time it was first seen", () => {
  let p = startStage(startStage(emptyProgress(), "sandbox", T1), "read", T1);
  p = mergeTester(p, JSON.stringify({ checks: [{ expect: "A", result: null }, "B"], now: "Reading the diff" }), T1);
  assert.equal(p.at.checks, T1);
  assert.deepEqual(p.checks, [
    { expect: "A", result: null },
    { expect: "B", result: null },
  ]);
  p = mergeTester(p, JSON.stringify({ checks: [{ expect: "A", result: "pass", observed: "fine" }, { expect: "B" }], now: "Opening B" }), T1);
  p = mergeTester(p, JSON.stringify({ checks: [{ expect: "A", result: "pass", observed: "fine" }, { expect: "B", result: "weird" }], now: "Opening B" }), T2);
  assert.deepEqual(p.checks[0], { expect: "A", result: "pass", observed: "fine", at: T1 });
  assert.deepEqual(p.checks[1], { expect: "B", result: null }, "an unknown result counts as not done");
  assert.deepEqual(
    p.now.map((n) => n.text),
    ["Reading the diff", "Opening B"],
    "the same sentence twice is one entry",
  );
});

test("progress: a broken or half-written file leaves the progress as it was; the trail keeps the last three", () => {
  let p = emptyProgress();
  for (const raw of [null, "", "{", "[]", '"x"', JSON.stringify({ checks: "no" })]) assert.deepEqual(mergeTester(p, raw, T1), p);
  for (const n of ["a", "b", "c", "d"]) p = mergeTester(p, JSON.stringify({ now: n }), T1);
  assert.deepEqual(
    p.now.map((n) => n.text),
    ["b", "c", "d"],
  );
});

test("progress: a second attempt starts over from the copy and keeps when the sandbox started", () => {
  let p = startStage(emptyProgress(), "sandbox", T1);
  p = startStage(p, "copy", T1);
  p = mergeTester(startStage(p, "read", T1), JSON.stringify({ checks: ["A"], now: "x" }), T1);
  p = startStage(p, "verdict", T1);
  p = startStage(p, "copy", T2, 2);
  assert.deepEqual(p, { at: { sandbox: T1, copy: T2 }, attempt: 2, sandboxDone: T1, checks: [], now: [] }, "the sandbox keeps its own end");
  assert.equal(startStage(p, "copy", "2026-11-26T06:40:00.000Z", 2), p, "the copy of the second attempt keeps the start of its fix");
});

test("progress: the check the tester marks running is the active one, wherever it is in the plan", () => {
  const p = mergeTester(emptyProgress(), JSON.stringify({ checks: [{ expect: "A", result: null }, { expect: "B", result: "running" }] }), T1);
  assert.deepEqual(p.checks, [
    { expect: "A", result: null },
    { expect: "B", result: null, active: true },
  ]);
});
