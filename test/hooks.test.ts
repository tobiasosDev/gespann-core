import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { adapters } from "../src/adapters/index.ts";
import { hookCommand } from "../src/adapters/types.ts";
import { parseArgs } from "../src/cli.ts";
import { MAX_CONTINUATIONS } from "../src/gate.ts";
import { handle } from "../src/hook.ts";
import { hooksInstalled, installHooks, uninstallHooks } from "../src/install.ts";

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gespann-test-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

function write(root: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(value));
}

const read = (root: string, path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("install merges with existing hooks, is idempotent and removes hooks of earlier versions", () => {
  const root = makeRepo();
  write(root, ".claude/settings.json", {
    model: "x",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node guard.mjs" }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: hookCommand("claude", "post-tool") }] }],
    },
  });
  installHooks(root, adapters.claude);
  installHooks(root, adapters.claude);
  const cfg = read(root, ".claude/settings.json");
  assert.equal(cfg.model, "x");
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PreToolUse", "Stop"]);
  assert.equal(cfg.hooks.Stop.length, 1);
  assert.match(cfg.hooks.Stop[0].hooks[0].command, /gespann hook claude stop/);
  assert.ok(hooksInstalled(root, "claude"));
  assert.ok(!hooksInstalled(root, "codex"));
  uninstallHooks(root, adapters.claude);
  assert.deepEqual(Object.keys(read(root, ".claude/settings.json").hooks), ["PreToolUse"]);
});

test("stop gate sends the agent back at most MAX_CONTINUATIONS times per session", () => {
  const root = makeRepo();
  const failing = () => "verdict: FAIL";
  const stop = (session: string) => handle({ agent: "codex", event: "stop", session, cwd: root }, [failing]);
  for (let i = 0; i < MAX_CONTINUATIONS; i++) assert.deepEqual(stop("s1"), { decision: "block", reason: "verdict: FAIL" });
  assert.deepEqual(stop("s1"), {});
  assert.equal(stop("s2").decision, "block");
});

test("stop gate stays out of the way without a reason, outside git and for other events", () => {
  const root = makeRepo();
  assert.deepEqual(handle({ agent: "claude", event: "stop", session: "s", cwd: root }, [() => undefined]), {});
  assert.deepEqual(handle({ agent: "claude", event: "other", session: "s", cwd: root }, [() => "x"]), {});
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "gespann-nogit-")));
  assert.deepEqual(handle({ agent: "claude", event: "stop", session: "s", cwd: outside }, [() => "x"]), {});
});

test("adapters parse the stop payload", () => {
  const input = adapters.claude.parse({ session_id: "abc", cwd: "/r", stop_hook_active: true }, "stop");
  assert.deepEqual(input, { agent: "claude", event: "stop", session: "abc", cwd: "/r", transcript: undefined, stopHookActive: true });
  assert.equal(adapters.codex.parse({}, "post-tool").event, "other");
});

test("boolean flags do not swallow positionals", () => {
  const a = parseArgs(["init", "--yes", "x", "--agents", "codex"]);
  assert.deepEqual(a._, ["init", "x"]);
  assert.equal(a.flags.yes, true);
  assert.equal(a.flags.agents, "codex");
});
