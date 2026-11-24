import { join } from "node:path";
import { adapters } from "./adapters/index.ts";
import type { Adapter, Agent } from "./adapters/types.ts";
import { readJson, writeJson } from "./util.ts";

interface HookEntry {
  type: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type HookConfig = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

/** Exactly the commands gespann writes or wrote; any other hook stays, whatever it mentions. */
const OURS = new Set(Object.values(adapters).flatMap((a) => [...a.hooks.map((h) => h.command), ...a.legacy]));
const isOurs = (h: HookEntry) => typeof h.command === "string" && OURS.has(h.command);

function withoutOurs(hooks: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

/** Merge our hooks into the agent's project config. Idempotent; other hooks stay untouched. */
export function installHooks(root: string, adapter: Adapter): string {
  const path = join(root, adapter.configPath);
  const config = readJson<HookConfig>(path) ?? {};
  const hooks = withoutOurs(config.hooks ?? {});
  for (const spec of adapter.hooks) {
    const entry: HookEntry = { type: "command", command: spec.command, ...(spec.timeout ? { timeout: spec.timeout } : {}) };
    hooks[spec.event] = [...(hooks[spec.event] ?? []), { hooks: [entry] }];
  }
  writeJson(path, { ...config, hooks });
  return adapter.configPath;
}

export function uninstallHooks(root: string, adapter: Adapter): void {
  const path = join(root, adapter.configPath);
  const config = readJson<HookConfig>(path);
  if (!config?.hooks) return;
  writeJson(path, { ...config, hooks: withoutOurs(config.hooks) });
}

export function hooksInstalled(root: string, agent: Agent): boolean {
  const config = readJson<HookConfig>(join(root, adapters[agent].configPath));
  return Object.values(config?.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isOurs)));
}
