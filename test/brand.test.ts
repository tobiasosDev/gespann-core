import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { faviconSvg, lockupSvg, MARK_PATH, markSvg, WORDMARK_PATH } from "../web/src/brand.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("brand assets stay in sync with web/src/brand.ts and contain no legacy mark paths", () => {
  const favicon = readFileSync("web/public/favicon.svg", "utf8");
  assert.equal(favicon, faviconSvg(), "web/public/favicon.svg drifted; run node scripts/render-brand.ts");
  assert.ok(favicon.includes(MARK_PATH));

  assert.ok(markSvg().includes('fill="currentColor"'));
  assert.ok(markSvg().includes(MARK_PATH));
  assert.ok(lockupSvg().includes(MARK_PATH));
  assert.ok(lockupSvg().includes(WORDMARK_PATH));

  const legacySnippets = ["M7 6h4v20H7z", "M8 7h3.5v18H8z"];
  for (const file of walk("web")) {
    const text = readFileSync(file, "utf8");
    for (const legacy of legacySnippets) {
      assert.ok(!text.includes(legacy), `legacy mark path found in ${file}`);
    }
  }
});
