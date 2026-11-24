import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapters } from "./adapters/index.ts";
import type { Adapter } from "./adapters/types.ts";
import type { Agent } from "./journal.ts";
import { readJson, writeJson, writeText } from "./util.ts";

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

/** Exactly the commands gespann writes; any other hook stays, whatever it mentions. */
const OURS = new Set(Object.values(adapters).flatMap((a) => a.hooks.map((h) => h.command)));
const isOurs = (h: HookEntry) => typeof h.command === "string" && OURS.has(h.command);

function withoutOurs(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
}

/** Merge our hooks into the agent's project config. Idempotent; other hooks stay untouched. */
export function installHooks(root: string, adapter: Adapter): string {
  const path = join(root, adapter.configPath);
  const config = readJson<HookConfig>(path) ?? {};
  const hooks: Record<string, HookGroup[]> = { ...(config.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) hooks[event] = withoutOurs(groups);
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
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    const kept = withoutOurs(groups);
    if (kept.length) hooks[event] = kept;
  }
  writeJson(path, { ...config, hooks });
}

export function hooksInstalled(root: string, agent: Agent): boolean {
  const path = join(root, adapters[agent].configPath);
  const config = existsSync(path) ? readJson<HookConfig>(path) : undefined;
  return Object.values(config?.hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isOurs)));
}

const IGNORES = [".claude/skills/gespann-*/", ".agents/skills/gespann-*/"];

/** Generated skill folders are build output of `.gespann/`; they stay out of git. */
export function ensureGitignore(root: string): void {
  const path = join(root, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = IGNORES.filter((l) => !text.split("\n").includes(l));
  if (missing.length === 0) return;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeText(path, `${text}${sep}# gespann: generated from .gespann/\n${missing.join("\n")}\n`);
}
