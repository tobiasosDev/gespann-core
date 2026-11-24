import { join } from "node:path";
import type { HookInput } from "./adapters/types.ts";
import { dataDir, readJson, writeJson } from "./util.ts";

/** How often one session may be sent back before it may stop anyway. */
export const MAX_CONTINUATIONS = 2;

export interface StopContext {
  root: string;
  input: HookInput;
}

/** Returns a reason when the agent has to continue; the reason becomes its next prompt. */
export type StopCheck = (ctx: StopContext) => string | undefined;

export interface HookReply {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

function counterFile(root: string, input: HookInput): string {
  const id = `${input.agent}-${input.session}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dataDir(root), "sessions", `${id}.json`);
}

/**
 * Runs the stop checks. The first reason sends the agent back, at most MAX_CONTINUATIONS
 * times per session across all checks, so a check that cannot pass never traps the agent.
 */
export function gate(root: string, input: HookInput, checks: StopCheck[]): HookReply {
  const reasons = checks.map((c) => c({ root, input })).filter((r): r is string => !!r);
  if (reasons.length === 0) return {};
  const file = counterFile(root, input);
  const done = readJson<{ continuations: number }>(file)?.continuations ?? 0;
  if (done >= MAX_CONTINUATIONS) return {};
  writeJson(file, { continuations: done + 1 });
  return { decision: "block", reason: reasons.join("\n\n") };
}
