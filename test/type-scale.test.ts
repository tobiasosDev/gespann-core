import assert from "node:assert/strict";
import { test } from "node:test";
import { cn } from "../web/src/cn.ts";

test("a type-scale size survives next to a text colour, and a later size replaces an earlier one", () => {
  assert.equal(cn("text-body", "text-muted-foreground"), "text-body text-muted-foreground");
  assert.equal(cn("font-mono text-small", "text-title text-muted-foreground"), "font-mono text-title text-muted-foreground");
});
