import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "./adapters/index.ts";
import type { HookInput } from "./adapters/types.ts";
import { gate, type HookReply, type StopCheck } from "./gate.ts";
import { dataDir, gitOk, now } from "./util.ts";

/** Checks the stop hook runs. Empty until the verdict back channel lands. */
export const stopChecks: StopCheck[] = [];

export function handle(input: HookInput, checks: StopCheck[] = stopChecks): HookReply {
  if (input.event !== "stop") return {};
  const root = gitOk(input.cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return {};
  return gate(root, input, checks);
}

/** Entry for `gespann hook <agent> <event>`. Never breaks the agent: errors go to a log. */
export function runHook(agentName: string, eventArg: string): void {
  let reply: HookReply = {};
  let cwd = process.cwd();
  try {
    const rawText = readFileSync(0, "utf8");
    const raw = (rawText.trim() ? JSON.parse(rawText) : {}) as Record<string, unknown>;
    const input = adapterFor(agentName).parse(raw, eventArg);
    cwd = input.cwd;
    reply = handle(input);
  } catch (err) {
    try {
      const root = gitOk(cwd, ["rev-parse", "--show-toplevel"])?.trim();
      if (root) {
        const dir = dataDir(root);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "errors.log"), `${now()} ${agentName} ${eventArg}: ${(err as Error).stack ?? err}\n`);
      }
    } catch {
      // nothing left to report to
    }
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
