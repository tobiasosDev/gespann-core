import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderComment } from "../src/server/comment.ts";
import { flagChanges } from "../src/verify/flags.ts";
import { promptFor, testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe } from "../src/verify/recipe.ts";
import { judge } from "../src/verify/verdict.ts";

// Cut from a real PR that put attach uploads behind a flag: the registry, the env example and a route.
const ADDS_A_FLAG = `diff --git a/apps/web/.env.example b/apps/web/.env.example
--- a/apps/web/.env.example
+++ b/apps/web/.env.example
@@ -40,0 +41 @@
+# ASYNC_SOURCE_UPLOAD_ENABLED=false
diff --git a/apps/web/lib/feature-flags/registry.ts b/apps/web/lib/feature-flags/registry.ts
--- a/apps/web/lib/feature-flags/registry.ts
+++ b/apps/web/lib/feature-flags/registry.ts
@@ -88,0 +89,5 @@
+  "async-source-upload": {
+    env: "ASYNC_SOURCE_UPLOAD_ENABLED",
+    default: false,
+  },
diff --git a/apps/web/app/api/analysis-runs/[id]/sources/route.ts b/apps/web/app/api/analysis-runs/[id]/sources/route.ts
--- a/apps/web/app/api/analysis-runs/[id]/sources/route.ts
+++ b/apps/web/app/api/analysis-runs/[id]/sources/route.ts
@@ -12,0 +13 @@
+  if (await isFeatureEnabled("async-source-upload")) return accepted(run);
diff --git a/apps/web/tests/sources.test.ts b/apps/web/tests/sources.test.ts
--- a/apps/web/tests/sources.test.ts
+++ b/apps/web/tests/sources.test.ts
@@ -1,0 +2 @@
+  vi.mocked(isFeatureEnabled).mockImplementation((k) => k === "test-only-flag");
`;

test("a flag the PR adds is found once, with its environment variable folded in, and tests do not count", () => {
  assert.deepEqual(flagChanges(ADDS_A_FLAG), [
    {
      key: "async-source-upload",
      aliases: ["ASYNC_SOURCE_UPLOAD_ENABLED"],
      kind: "added",
      files: ["apps/web/.env.example", "apps/web/app/api/analysis-runs/[id]/sources/route.ts", "apps/web/lib/feature-flags/registry.ts"],
    },
  ]);
});

test("the usual flag SDKs are read, a removed flag is marked removed, and a deleted SQL comment is no file header", () => {
  const diff = `diff --git a/app/checkout.tsx b/app/checkout.tsx
--- a/app/checkout.tsx
+++ b/app/checkout.tsx
@@ -1,2 +1,4 @@
-  const on = posthog.isFeatureEnabled('old-cart')
+  const v = useFeatureFlagEnabled("new-cart")
+  if (ldClient.variation("pricing-v2", ctx, false)) show()
+  const g = gb.isOn('wide-header'); const s = checkGate("beta-banner")
diff --git a/app/models/order.rb b/app/models/order.rb
--- a/app/models/order.rb
+++ b/app/models/order.rb
@@ -3,0 +4,2 @@
+    return legacy unless Flipper.enabled?(:split_payments, user)
+    Flipper[:split_payments].enabled?
diff --git a/db/schema.sql b/db/schema.sql
--- a/db/schema.sql
+++ b/db/schema.sql
@@ -1 +1 @@
--- isFeatureEnabled("not-from-sql")
+-- nothing
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,0 +2 @@
+Set FEATURE_DOCS_ONLY=1 to try it.
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,0 +2,2 @@
+const refresh = process.env.FEATURE_FLAG_REFRESH_MS; const all = process.env.FEATURE_FLAGS;
+const isEnabled = (x: boolean) => x;
`;
  const found = flagChanges(diff);
  assert.deepEqual(
    found.map((f) => [f.key, f.kind]),
    [
      ["old-cart", "removed"],
      ["new-cart", "added"],
      ["pricing-v2", "added"],
      ["wide-header", "added"],
      ["beta-banner", "added"],
      ["split_payments", "added"],
      ["not-from-sql", "removed"],
    ],
  );
  // The deleted SQL comment reads "--- isFeatureEnabled(...)" in the diff: content of db/schema.sql, not a file header.
  assert.deepEqual(found.find((f) => f.key === "not-from-sql")?.files, ["db/schema.sql"]);
  assert.deepEqual(found.find((f) => f.key === "split_payments")?.files, ["app/models/order.rb"]);
  assert.deepEqual(flagChanges(""), []);
});

test("a flag only in a flag folder's registry is found, and a renamed key stays two flags", () => {
  const registryOnly = `diff --git a/apps/web/lib/feature-flags/registry.ts b/apps/web/lib/feature-flags/registry.ts
--- a/apps/web/lib/feature-flags/registry.ts
+++ b/apps/web/lib/feature-flags/registry.ts
@@ -88,0 +89 @@
+  "quiet-mode": { default: false },
`;
  assert.deepEqual(flagChanges(registryOnly), [{ key: "quiet-mode", kind: "added", files: ["apps/web/lib/feature-flags/registry.ts"] }]);
  const renamed = `diff --git a/app/cart.ts b/app/cart.ts
--- a/app/cart.ts
+++ b/app/cart.ts
@@ -1 +1 @@
-if (isFeatureEnabled("new_checkout")) go();
+if (isFeatureEnabled("new-checkout") && process.env.NEW_CHECKOUT_ENABLED) go();
`;
  assert.deepEqual(
    flagChanges(renamed).map((f) => [f.key, f.kind, f.aliases ?? []]),
    [
      ["new_checkout", "removed", []],
      ["new-checkout", "added", ["NEW_CHECKOUT_ENABLED"]],
    ],
  );
  const upper = `diff --git a/app/cart.ts b/app/cart.ts
--- a/app/cart.ts
+++ b/app/cart.ts
@@ -1 +1 @@
-if (isFeatureEnabled("NEW_CART")) go();
+if (isFeatureEnabled("new-cart")) go();
`;
  assert.deepEqual(flagChanges(upper).map((f) => [f.key, f.kind]), [["NEW_CART", "removed"], ["new-cart", "added"]], "an upper-case key the code asks for is a key, not an environment variable");
  // No cap: a tenth flag reaches the tester like the first.
  const many = Array.from({ length: 10 }, (_, i) => `+isFeatureEnabled("flag-${i}")`).join("\n");
  assert.equal(flagChanges(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,10 @@\n${many}\n`).length, 10);
});

const recipe = parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nflags:\n  run: node flags.js\n  admin: /admin/flags\n  switch: ./flag.sh\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1\n');
const input = { repo: "acme/shop", pr: 4, head: "h", base: "b", url: "http://localhost:1", out: "/o", work: "/w", criteria: "", recipe };

test("the tester tests a found flag off first, against the base, then on, and names how to switch it", () => {
  assert.equal(recipe.flags?.switch, "./flag.sh");
  const p = testerPrompt({ ...input, flags: flagChanges(ADDS_A_FLAG) });
  assert.match(p, /- async-source-upload: on new lines, in apps\/web\/\.env\.example/);
  assert.match(p, /twice, off first/);
  assert.match(p, /Off, before you switch it on for the first time.*behave exactly as on b\./);
  assert.match(p, /with the flag off the PR must not affect any user/);
  assert.match(p, /Switch the flag with `gespann verify flag <key> off --work \/w` \(`on` to switch it on\), which returns once the copy runs in that state, or on the page http:\/\/localhost:1\/admin\/flags\./);
  assert.match(p, /"flags" has one entry per feature flag the PR touches \(at least async-source-upload\)/);
  const none = testerPrompt({ ...input, recipe: parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1\n') });
  assert.match(none, /gespann found none in the diff/);
  assert.match(none, /the way the app does it/);
});

test("the prompt tool reads the flags from the merged checkout and leaves them for the verdict", () => {
  const repo = mkdtempSync(join(tmpdir(), "gespann-flags-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "app.ts"), 'export const a = isFeatureEnabled("new-cart") ? 2 : 1;\n');
  git("commit", "-qam", "flag");
  const head = git("rev-parse", "HEAD");
  const work = join(repo, ".work");
  const recipeFile = join(repo, "verify.yml");
  writeFileSync(recipeFile, 'version: 1\ntrigger: { paths: ["**"] }\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1\n');
  const p = promptFor("tester", { ...input, recipe: undefined, recipeFile, repoDir: repo, base, head, work });
  assert.match(p, /- new-cart: on new lines, in app\.ts/);
  assert.deepEqual(JSON.parse(readFileSync(join(work, "flag-changes.json"), "utf8")), [{ key: "new-cart", kind: "added", files: ["app.ts"] }]);
});

const offCheck = { expect: "[new-cart off] the cart looks as on main", observed: "same cart", result: "pass", proof: ["off.png"], flag: "new-cart", state: "off" };
const onCheck = { expect: "[new-cart on] the new cart opens", observed: "it opens", result: "pass", proof: ["on.png"], flag: "new-cart", state: "on" };
const verdict = (kind: string, checks: object[], flags?: object[]) => JSON.stringify({ verdict: kind, summary: "s", checks, ...(flags ? { flags } : {}), proof: ["off.png", "on.png"] });
const judged = (kind: string, checks: object[], flags?: object[], found = ["new-cart"]) => judge(verdict(kind, checks, flags), () => true, [], found);

test("a found flag passes only when it was tested off and on, or the tester says why not", () => {
  const tested = [{ flag: "new-cart", tested: true, how: "admin page" }];
  const ok = judged("PASS", [offCheck, onCheck], tested);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.outcome, "PASS");
  assert.deepEqual(ok.verdict?.flags, tested);
  assert.equal(ok.verdict?.checks[0]?.state, "off");

  assert.match(judged("PASS", [offCheck, onCheck]).problems.join(), /no entry for the feature flag new-cart found in the diff/);
  assert.match(judged("PASS", [onCheck], tested).problems.join(), /flag new-cart tested without a check with it off/);
  assert.match(judged("PASS", [{ ...onCheck, flag: undefined, state: undefined }], [{ flag: "new-cart", tested: false }]).problems.join(), /not tested without saying why/);
  assert.equal(judged("PASS", [{ ...onCheck, flag: undefined, state: undefined }], [{ flag: "new-cart", tested: false, why: "the PR removes it" }]).outcome, "PASS");
  assert.match(judged("PASS", [offCheck, { ...onCheck, state: "half" }], tested).problems.join(), /check state "half" is not off or on/);
  assert.match(judged("PASS", [offCheck, onCheck], [], []).problems.join(), /checks for the flag new-cart, which the verdict does not list as tested/);
  // A flag the tester found on its own is judged the same way.
  assert.equal(judged("PASS", [offCheck, onCheck], tested, []).outcome, "PASS");
});

test("a difference with the flag off fails the PR, and the comment shows both states", () => {
  const tested = [{ flag: "new-cart", tested: true, how: "admin page" }];
  const off = { ...offCheck, observed: "the old cart button is gone", result: "fail" };
  const j = judged("FAIL", [off, onCheck], tested);
  assert.equal(j.outcome, "FAIL");
  const body = renderComment({ outcome: j.outcome, judged: j, files: ["off.png", "on.png"], fileUrl: (f) => f, runUrl: "u", head: "abcdef123", baseRef: "main" });
  assert.match(body, /- Feature flag `new-cart`: off ❌ behaves as before the PR · on ✅ the change works/);
  const skipped = judged("PASS", [{ ...onCheck, flag: undefined, state: undefined }], [{ flag: "new-cart", tested: false, why: "the PR removes it" }]);
  assert.match(renderComment({ outcome: skipped.outcome, judged: skipped, files: [], fileUrl: (f) => f, runUrl: "u", head: "abcdef123", baseRef: "main" }), /Feature flag `new-cart`: not tested, the PR removes it/);
});
