import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderComment } from "../src/server/comment.ts";
import { closingRefs, Github } from "../src/server/github.ts";
import { issuesText } from "../src/server/worker.ts";
import { testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe } from "../src/verify/recipe.ts";
import { finish, prepare } from "../src/verify/run.ts";
import { judge } from "../src/verify/verdict.ts";

// A throwaway RSA key, only to sign the app JWT for the fake GitHub below.
const TEST_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("closing keywords in the PR text name the issues the PR resolves; bare mentions do not", () => {
  const text = "Fixes #12. Closes: acme/other#3, resolves https://github.com/acme/web/issues/4.\nRefs #9, see #10. Fixes 3 bugs. fixes #12 again.";
  assert.deepEqual(closingRefs(text, "acme/shop"), [
    { repo: "acme/shop", number: 12 },
    { repo: "acme/other", number: 3 },
    { repo: "acme/web", number: 4 },
  ]);
  assert.deepEqual(closingRefs("", "acme/shop"), []);
});

test("linked issues: GitHub's list plus closing keywords it does not count, without PRs or duplicates", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (path.endsWith("/access_tokens")) return json({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path === "/graphql") {
      return json({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 12, title: "Export as CSV", body: "Users need a CSV export.", url: "https://github.com/acme/shop/issues/12", repository: { nameWithOwner: "acme/shop" } }] } } } } });
    }
    if (path === "/repos/acme/other/issues/3") return json({ number: 3, title: "Dark mode", body: null, html_url: "https://github.com/acme/other/issues/3" });
    if (path === "/repos/acme/shop/issues/7") return json({ number: 7, title: "a PR", body: "", html_url: "x", pull_request: {} });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  const gh = new Github({ appId: "1", slug: "s", privateKey: TEST_KEY, webhookSecret: "w", clientId: "c", clientSecret: "s" }, fetchImpl);
  const issues = await gh.linkedIssues(9, "acme/shop", 4, "Fixes #12, closes acme/other#3, fixes #7, fixes #99");
  assert.deepEqual(issues, [
    { ref: "#12", title: "Export as CSV", body: "Users need a CSV export.", url: "https://github.com/acme/shop/issues/12" },
    { ref: "acme/other#3", title: "Dark mode", body: "", url: "https://github.com/acme/other/issues/3" },
  ]);
  assert.ok(!calls.includes("GET /repos/acme/shop/issues/12"), "an issue GitHub already listed is not fetched again");
  assert.match(issuesText(issues), /# #12: Export as CSV[\s\S]*Users need a CSV export[\s\S]*# acme\/other#3: Dark mode[\s\S]*\(no description\)/);
});

const check = { expect: "Export works", observed: "CSV downloaded", result: "pass", proof: ["a.png"] };
const v = (kind: string, goals: object[], checks: object[] = [check]) => JSON.stringify({ verdict: kind, summary: "s", checks, goals, proof: ["a.png"] });

test("judge: every linked issue needs a goal, and a missed goal fails the PR", () => {
  const met = { issue: "#12", goal: "CSV export", observed: "works", result: "met" };
  const missed = { issue: "#12", goal: "CSV export", observed: "only the first page is exported", result: "missed" };
  assert.equal(judge(v("PASS", [met]), () => true, ["#12"]).outcome, "PASS");
  assert.equal(judge(v("PASS", [{ ...met, issue: " #12 " }]), () => true, ["#12"]).outcome, "PASS", "refs compare loosely");

  const passMissed = judge(v("PASS", [missed]), () => true, ["#12"]);
  assert.equal(passMissed.outcome, "FAIL");
  assert.ok(passMissed.problems.includes("PASS with an issue goal that was not met"));

  const fail = judge(v("FAIL", [missed]), () => true, ["#12"]);
  assert.equal(fail.outcome, "FAIL");
  assert.deepEqual(fail.problems, [], "a missed goal alone is a valid FAIL");

  const none = judge(v("PASS", []), () => true, ["#12", "acme/other#3"]);
  assert.deepEqual(none.problems, ["no goal judged for issue #12", "no goal judged for issue acme/other#3"]);

  const blocked = judge(v("BLOCKED", [{ ...missed, result: "blocked", observed: "no mail fake" }]), () => true, ["#12"]);
  assert.equal(blocked.outcome, "BLOCKED", "a blocked goal is enough for BLOCKED");
  assert.ok(judge(v("BLOCKED", [missed], [{ ...check, result: "blocked" }]), () => true, ["#12"]).problems.includes("BLOCKED with a missed issue goal"));

  assert.ok(judge(v("SKIP", [missed], []), () => true, ["#12"]).problems.some((p) => /SKIP although/.test(p)));
  assert.equal(judge(v("SKIP", [met], []), () => true, ["#12"]).outcome, "SKIP", "a CI-only issue can be met from the diff");
  assert.ok(judge(v("FAIL", [{ ...missed, proof: ["gone.png"] }]), (f) => f !== "gone.png", ["#12"]).problems.some((p) => /gone\.png/.test(p)));
  assert.equal(judge(v("PASS", []), () => true).outcome, "PASS", "without linked issues nothing changes");
});

test("finish requires a goal for each issue in issues.json", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gespann-issues-")));
  writeFileSync(join(dir, "verify.yml"), "");
  const c = { root: dir, recipeFile: join(dir, "verify.yml"), pr: "7", head: "a".repeat(40), base: "b".repeat(40), run: "0123456789ab", work: join(dir, "work"), out: join(dir, "out") };
  const r = parseRecipe("version: 1\ntrigger: { paths: [\"**\"] }\nenv:\n  up: \"true\"\n  down: \"true\"\n  url: http://localhost:1\n");
  assert.ok((await prepare(c, r)).ok);
  mkdirSync(c.out, { recursive: true });
  writeFileSync(join(c.work, "issues.json"), JSON.stringify([{ ref: "#12", url: "u" }]));
  writeFileSync(join(c.out, "a.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(c.out, "verdict.json"), v("PASS", []));
  const f = await finish(c, r, 1000);
  assert.equal(f.outcome, "FAIL");
  assert.ok(f.judged.problems.includes("no goal judged for issue #12"));
});

test("the tester prompt sends the tester to the issue text only when issues are linked", () => {
  const recipe = parseRecipe("version: 1\ntrigger: { paths: [\"**\"] }\nenv:\n  up: \"true\"\n  down: \"true\"\n  url: http://localhost:1\n");
  const base = { repo: "acme/shop", pr: 4, head: "h", base: "b", url: "http://localhost:1", out: "/o", work: "/w", criteria: "", recipe };
  const withIssues = testerPrompt({ ...base, issues: ["#12"] });
  assert.match(withIssues, /resolves the issue #12\. Read \/w\/issues\.md/);
  assert.match(withIssues, /"goals":\[/);
  assert.match(withIssues, /A missed goal is a FAIL/);
  const without = testerPrompt(base);
  assert.doesNotMatch(without, /issues\.md|"goals"/);
});

test("the PR comment shows each issue goal in the open", () => {
  const judged = judge(v("FAIL", [{ issue: "#12", goal: "Export all orders as CSV", observed: "Only the first page", result: "missed", proof: ["b.png"] }]), () => true, ["#12"]);
  const body = renderComment({ outcome: judged.outcome, judged, files: ["a.png", "b.png"], fileUrl: (f) => `https://x/${f}`, runUrl: "u", head: "abcdef1", baseRef: "main" });
  const open = body.slice(0, body.indexOf("<details>"));
  assert.match(open, /\| #12 \| Export all orders as CSV \| ❌ missed \| Only the first page \|/);
  assert.match(body, /📸 2 screenshots/);
  assert.match(body, /alt="Export all orders as CSV"/);
});
