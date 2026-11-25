import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseRecipe } from "../src/verify/recipe.ts";
import { expand, finish, prepare, readEnvFile, type RunContext } from "../src/verify/run.ts";
import { judge } from "../src/verify/verdict.ts";
import { testerPrompt } from "../src/verify/prompt.ts";

function ctx(): RunContext {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gespann-run-")));
  writeFileSync(join(dir, "verify.yml"), "");
  return { root: dir, recipeFile: join(dir, "verify.yml"), pr: "7", head: "a".repeat(40), base: "b".repeat(40), run: "0123456789ab", work: join(dir, "work"), out: join(dir, "out") };
}

const RECIPE = `
version: 1
trigger: { paths: ["**"] }
setup:
  - { name: port, run: 'echo "PORT=4321" >> "$GESPANN_ENV"; echo "PR=$GESPANN_PR" >> "$GESPANN_ENV"' }
services:
  - name: svc
    run: 'echo up > "$GESPANN_WORK/svc.txt"; sleep 60'
    ready: 'test -f "$GESPANN_WORK/svc.txt"'
    readyTimeout: 10
flags: { run: 'echo "flag-a: on"' }
env:
  up: 'echo up >> "$GESPANN_WORK/order"'
  down: 'echo down >> "$GESPANN_WORK/order"'
  url: http://127.0.0.1:$PORT/
alongside:
  - { name: golden, run: 'echo "golden ok" > "$GESPANN_WORK/golden.md"', output: golden.md }
cleanup:
  - { name: bye, run: 'echo cleanup >> "$GESPANN_WORK/order"' }
`;

test("prepare brings the copy up, passes values through GESPANN_ENV, finish tears down", async () => {
  const c = ctx();
  const r = parseRecipe(RECIPE);
  const p = await prepare(c, r);
  assert.deepEqual(p, { ok: true, url: "http://127.0.0.1:4321/" });
  assert.equal(readEnvFile(join(c.work, "env")).PR, "7");
  assert.equal(readFileSync(join(c.work, "flags.md"), "utf8").trim(), "flag-a: on");
  writeFileSync(join(c.out, "home.png"), Buffer.from("89504e470d0a1a0a0000000d", "hex"));
  writeFileSync(join(c.out, "verdict.json"), JSON.stringify({ verdict: "PASS", summary: "ok", checks: [{ expect: "e", observed: "o", result: "pass", proof: ["home.png"] }], proof: ["home.png"] }));
  const f = await finish(c, r, 10_000);
  assert.equal(f.outcome, "PASS");
  assert.deepEqual(f.alongside, [{ name: "golden", exit: 0, required: true }]);
  assert.equal(readFileSync(join(c.work, "order"), "utf8"), "up\ndown\ncleanup\n");
  assert.ok(existsSync(join(c.work, "result.json")));
});

test("a failing setup step tears down and reports, without env.down for a copy never started", async () => {
  const c = ctx();
  const r = parseRecipe(RECIPE.replace(`echo "PORT=4321" >> "$GESPANN_ENV"; `, "exit 3; "));
  const p = await prepare(c, r);
  assert.equal(p.ok, false);
  assert.match(p.error ?? "", /setup step "port" failed/);
  assert.equal(readFileSync(join(c.work, "order"), "utf8"), "cleanup\n");
});

test("a fake screenshot does not count as proof", async () => {
  const { proofOk } = await import("../src/verify/run.ts");
  const c = ctx();
  writeFileSync(join(c.root, "empty.png"), "");
  writeFileSync(join(c.root, "real.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  assert.equal(proofOk(join(c.root, "empty.png")), false);
  assert.equal(proofOk(join(c.root, "real.png")), true);
  writeFileSync(join(c.root, "short.png"), Buffer.from("89504e47", "hex"));
  writeFileSync(join(c.root, "g.gif"), "GIF");
  assert.equal(proofOk(join(c.root, "short.png")), false, "truncated PNG signature");
  assert.equal(proofOk(join(c.root, "g.gif")), false);
  assert.equal(proofOk(c.root), false, "a directory is no proof");
});

test("finish after a failed prepare does not tear down twice", async () => {
  const c = ctx();
  const r = parseRecipe(RECIPE.replace(`echo up >> "$GESPANN_WORK/order"`, `echo up >> "$GESPANN_WORK/order"; exit 1`));
  assert.equal((await prepare(c, r)).ok, false);
  await finish(c, r, 1000);
  assert.equal(readFileSync(join(c.work, "order"), "utf8"), "up\ndown\ncleanup\n");
});

test("a failed required alongside check turns PASS into FAIL; a missing verdict is FAIL", async () => {
  const c = ctx();
  const r = parseRecipe(RECIPE.replace(`echo "golden ok" > "$GESPANN_WORK/golden.md"`, "exit 4"));
  assert.ok((await prepare(c, r)).ok);
  const f = await finish(c, r, 10_000);
  assert.equal(f.outcome, "FAIL");
  assert.ok(f.judged.problems.includes("the tester wrote no verdict.json"));
  assert.ok(f.judged.problems.some((x) => /golden" exited 4/.test(x)));
});

test("judge enforces the verdict rules", () => {
  const ok = (v: unknown, exists = true) => judge(JSON.stringify(v), () => exists);
  const pass = { verdict: "PASS", summary: "s", checks: [{ expect: "e", observed: "o", result: "pass" }], proof: ["a.png"] };
  assert.equal(ok(pass).outcome, "PASS");
  assert.equal(ok(pass, false).outcome, "FAIL");
  assert.equal(ok({ ...pass, proof: [] }).outcome, "FAIL");
  assert.equal(ok({ ...pass, proof: ["../x.png"] }).outcome, "FAIL");
  assert.equal(ok({ verdict: "BLOCKED", checks: [{ result: "blocked", observed: "no card" }], proof: [] }).outcome, "BLOCKED");
  assert.equal(ok({ verdict: "BLOCKED", checks: [{ result: "blocked", observed: "" }] }).outcome, "FAIL");
  assert.equal(ok({ verdict: "BLOCKED", checks: [{ result: "blocked", observed: "x" }, { result: "fail" }] }).outcome, "FAIL");
  assert.equal(ok({ verdict: "FAIL", checks: [{ result: "fail" }] }).outcome, "FAIL");
  assert.equal(ok({ verdict: "SKIP", summary: "docs only" }).outcome, "SKIP");
  assert.equal(judge("nope", () => true).outcome, "FAIL");
  assert.equal(judge("null", () => true).outcome, "FAIL");
  assert.equal(ok({ ...pass, proof: ["verdict.json"] }).outcome, "FAIL", "PASS needs a screenshot");
});

test("expand reads $VAR and ${VAR}", () => {
  assert.equal(expand("http://$HOST:${PORT}/x", { HOST: "h", PORT: "1" }), "http://h:1/x");
});

test("the tester prompt carries criteria, login, flags, seeds and the replay rule", () => {
  const r = parseRecipe(`
version: 1
trigger: { paths: ["**"] }
env: { up: x, down: y, url: "http://127.0.0.1:3000" }
flags: { run: z, admin: /admin/flags }
login: { path: /login, user: dev@example.test, password: pw }
seeds: [{ name: paid, run: ./seed paid, about: a paying user }]
replay: { misses: /tmp/misses }
`);
  const text = testerPrompt({ repo: "o/r", pr: 5, head: "h", base: "b", url: "http://127.0.0.1:3000", out: "/o", work: "/w", criteria: "Checkout completes", recipe: r, testerNote: "Open the browser with the drive tool." });
  for (const want of ["Checkout completes", "http://127.0.0.1:3000/login", "dev@example.test / pw", "/w/flags.md", "http://127.0.0.1:3000/admin/flags", "paid: a paying user", "A replay miss is never a failed check", "/w/pr.md", "gespann shot /o/", "   Open the browser with the drive tool."]) {
    assert.ok(text.includes(want), want);
  }
});

test("screenshots of the same screen are kept once and the verdict points at the kept one", async () => {
  const { sameScreens, withAliases, parseThumbs, THUMB } = await import("../src/verify/similar.ts");
  const page = (v: number, dot = 0) => {
    const b = Buffer.alloc(THUMB * THUMB, v);
    for (let i = 0; i < dot; i++) b[i] = 0;
    return b;
  };
  const thumbs = parseThumbs(
    [
      ["01-modal.png", page(200)],
      ["02-modal-other-option.png", page(200, 5)], // 5 of 576 pixels differ: same screen
      ["03-checkout.png", page(120)],
      ["broken.png", Buffer.alloc(3)],
    ]
      .map(([n, b]) => `${n} ${(b as Buffer).toString("base64")}`)
      .join("\n"),
  );
  assert.equal(thumbs.size, 3);
  const alias = sameScreens(thumbs);
  assert.deepEqual([...alias], [["02-modal-other-option.png", "01-modal.png"]]);
  const judged = withAliases(
    {
      outcome: "PASS",
      problems: [],
      verdict: {
        verdict: "PASS",
        summary: "",
        proof: ["01-modal.png", "02-modal-other-option.png", "03-checkout.png"],
        checks: [{ expect: "b", observed: "b", result: "pass", proof: ["02-modal-other-option.png"] }],
      },
    },
    alias,
  );
  assert.deepEqual(judged.verdict?.proof, ["01-modal.png", "03-checkout.png"]);
  assert.deepEqual(judged.verdict?.checks[0]?.proof, ["01-modal.png"]);
});

test("a check blocked by a gap in the copy carries the fix; only a clean BLOCKED verdict asks for a repair", async () => {
  const { copyGaps } = await import("../src/verify/verdict.ts");
  const { repairPrompt } = await import("../src/verify/prompt.ts");
  const verdict = (kind: string, checks: object[]) => judge(JSON.stringify({ verdict: kind, summary: "s", checks, proof: [] }), () => true);
  const blocked = verdict("BLOCKED", [
    { expect: "pricing on the landing page", observed: "landing not built on the copy", result: "blocked", fix: "build and serve apps/landing" },
    { expect: "pay", observed: "needs a real card reader", result: "blocked" },
    { expect: "login", observed: "ok", result: "pass", fix: "ignored on a pass" },
  ]);
  assert.equal(blocked.outcome, "BLOCKED");
  assert.deepEqual(blocked.verdict?.checks.map((c) => c.fix), ["build and serve apps/landing", undefined, undefined]);
  assert.deepEqual(copyGaps(blocked).map((c) => c.expect), ["pricing on the landing page"]);
  // A failed check means the change is broken: no repair, the FAIL is reported.
  const failed = verdict("FAIL", [
    { expect: "a", observed: "landing missing", result: "blocked", fix: "build landing" },
    { expect: "b", observed: "wrong price", result: "fail" },
  ]);
  assert.deepEqual(copyGaps(failed), []);
  assert.deepEqual(copyGaps(null), []);
  const prompt = repairPrompt({ repo: "o/r", repoDir: "/r", projectDir: "/p", gaps: [{ expect: "e", observed: "o", fix: "build landing" }] });
  assert.match(prompt, /The copy lacks: build landing/);
  assert.match(prompt, /Do not change files in the repository/);
});
