import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeRules, type RuleVersion } from "./rules.ts";
import { dataDir, readJson, sha, writeJson, writeText } from "./util.ts";

/** Skill folders the agents read: Claude Code `.claude/skills`, Codex `.agents/skills`. */
export const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

export interface SyncResult {
  written: string[];
  removed: string[];
  unchanged: string[];
  conflicts: { path: string; rule: string; version: number }[];
}

type Manifest = Record<string, { rule: string; version: number; sha: string }>;

export function skillMarkdown(rule: RuleVersion): string {
  const description = `${rule.title}. Applies when you change ${rule.paths.join(", ")}.`.replace(/\n/g, " ");
  return [
    "---",
    `name: gespann-${rule.id}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `<!-- gespann ${rule.id} v${rule.version}. Managed by gespann: change it with \`gespann propose\`, local edits are kept and reported as a conflict. -->`,
    "",
    (rule.skill ?? "").trim(),
    "",
  ].join("\n");
}

/** Per worktree: each checkout has its own generated files. */
function manifestPath(root: string): string {
  return join(dataDir(root), `sync-${sha(root).slice(0, 12)}.json`);
}

/**
 * Materialise the approved skill versions for both agents. Runs at every session start, so a
 * new session uses the approved version; a file someone edited by hand is left alone and reported.
 */
export function sync(root: string, opts: { force?: boolean } = {}): SyncResult {
  const manifest = readJson<Manifest>(manifestPath(root)) ?? {};
  const result: SyncResult = { written: [], removed: [], unchanged: [], conflicts: [] };
  const wanted = new Map<string, RuleVersion>();
  for (const rule of activeRules(root)) {
    if (!rule.skill || rule.level === "observe") continue;
    for (const base of SKILL_ROOTS) wanted.set(`${base}/gespann-${rule.id}/SKILL.md`, rule);
  }

  for (const [path, rule] of wanted) {
    const abs = join(root, path);
    const text = skillMarkdown(rule);
    const onDisk = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (onDisk === text) {
      manifest[path] = { rule: rule.id, version: rule.version, sha: sha(text) };
      result.unchanged.push(path);
      continue;
    }
    const known = manifest[path];
    const editedByHand = onDisk !== undefined && (!known || sha(onDisk) !== known.sha);
    if (editedByHand && !opts.force) {
      result.conflicts.push({ path, rule: rule.id, version: rule.version });
      continue;
    }
    writeText(abs, text);
    manifest[path] = { rule: rule.id, version: rule.version, sha: sha(text) };
    result.written.push(path);
  }

  for (const [path, entry] of Object.entries(manifest)) {
    if (wanted.has(path)) continue;
    const abs = join(root, path);
    let onDisk: string | undefined;
    try {
      onDisk = readFileSync(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (onDisk !== undefined) {
      if (sha(onDisk) !== entry.sha && !opts.force) {
        result.conflicts.push({ path, rule: entry.rule, version: entry.version });
        continue;
      }
      // Another session may have removed it already; only the folder we created, only when empty.
      try {
        unlinkSync(abs);
        if (readdirSync(dirname(abs)).length === 0) rmdirSync(dirname(abs));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
      }
      result.removed.push(path);
    }
    delete manifest[path];
  }

  writeJson(manifestPath(root), manifest);
  return result;
}
