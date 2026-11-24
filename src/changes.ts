import { existsSync } from "node:fs";
import { join } from "node:path";
import { matchesAny } from "./glob.ts";
import type { StartEvent } from "./journal.ts";
import { git, gitOk, sha } from "./util.ts";

/**
 * Edits are observed through git, not through tool calls: an agent that writes a file
 * with sed or a Python heredoc changes it just as much as one that uses an Edit tool.
 */
export function headSha(root: string): string | null {
  return gitOk(root, ["rev-parse", "HEAD"])?.trim() ?? null;
}

export function dirtyFiles(root: string): string[] {
  const out = gitOk(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  const files: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    files.push(p.slice(3));
    if (code.startsWith("R") || code.startsWith("C")) i++;
  }
  return files;
}

export function hashNow(root: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const present = files.filter((f) => existsSync(join(root, f)));
  for (const f of files) out[f] = "deleted";
  // --stdin-paths is line based; a name with a newline goes through argv instead.
  const plain = present.filter((f) => !f.includes("\n"));
  if (plain.length) {
    const hashes = git(root, ["hash-object", "--stdin-paths", "--no-filters"], `${plain.join("\n")}\n`).trim().split("\n");
    plain.forEach((f, i) => (out[f] = hashes[i] ?? "?"));
  }
  for (const f of present.filter((x) => x.includes("\n"))) out[f] = git(root, ["hash-object", "--no-filters", "--", f]).trim();
  return out;
}

function hashAt(root: string, rev: string | null, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = "absent";
  if (!rev || files.length === 0) return out;
  const ls = gitOk(root, ["ls-tree", "-r", "-z", rev, "--", ...files]) ?? "";
  for (const entry of ls.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (m) out[m[2] as string] = m[1] as string;
  }
  return out;
}

export function startSnapshot(root: string, globs: string[]): { head: string | null; dirty: Record<string, string> } {
  const head = headSha(root);
  const dirty = dirtyFiles(root).filter((f) => matchesAny(f, globs));
  return { head, dirty: hashNow(root, dirty) };
}

/** Files matching `globs` whose content differs from the session start. */
export function changedSinceStart(root: string, start: Pick<StartEvent, "head" | "dirty">, globs: string[]): string[] {
  const candidates = new Set<string>(Object.keys(start.dirty));
  for (const f of dirtyFiles(root)) candidates.add(f);
  if (start.head) {
    const diff = gitOk(root, ["diff", "--name-only", "-z", start.head, "HEAD"]) ?? "";
    for (const f of diff.split("\0")) if (f) candidates.add(f);
  } else {
    // Unborn HEAD at start: everything tracked since then is new.
    const tracked = gitOk(root, ["ls-files", "-z"]) ?? "";
    for (const f of tracked.split("\0")) if (f) candidates.add(f);
  }
  const relevant = [...candidates].filter((f) => matchesAny(f, globs)).sort();
  if (relevant.length === 0) return [];
  const current = hashNow(root, relevant);
  const atHead = hashAt(root, start.head, relevant.filter((f) => !(f in start.dirty)));
  return relevant.filter((f) => current[f] !== (start.dirty[f] ?? atHead[f]));
}

export function fingerprint(root: string, files: string[]): string {
  if (files.length === 0) return "empty";
  const h = hashNow(root, files);
  return sha(files.map((f) => `${f}:${h[f]}`).join("\n")).slice(0, 16);
}

/** Files changed between a base ref and the working tree, for the CI runner. */
export function changedVsBase(root: string, base: string): string[] {
  const mb = gitOk(root, ["merge-base", base, "HEAD"])?.trim() || base;
  const diff = git(root, ["diff", "--name-only", "-z", mb]).split("\0").filter(Boolean);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  return [...new Set([...diff, ...untracked])].sort();
}
