import type { Agent } from "../journal.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import type { Adapter } from "./types.ts";

export const adapters: Record<Agent, Adapter> = { claude, codex };

export function adapterFor(name: string): Adapter {
  const a = adapters[name as Agent];
  if (!a) throw new Error(`unknown agent "${name}" (claude, codex)`);
  return a;
}
