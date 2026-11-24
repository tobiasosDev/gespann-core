import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

export function gitOk(cwd: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** Local, uncommitted data shared by all worktrees of a repo: <git-common-dir>/gespann. */
export function dataDir(root: string): string {
  const common = git(root, ["rev-parse", "--git-common-dir"]).trim();
  return join(isAbsolute(common) ? common : resolve(root, common), "gespann");
}

export function configDir(root: string): string {
  return join(root, ".gespann");
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function now(): string {
  return new Date().toISOString();
}

export function rel(root: string, path: string): string {
  const r = isAbsolute(path) ? relative(root, path) : path;
  return r.split(sep).join("/");
}

export function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function userName(root: string): string {
  return gitOk(root, ["config", "user.name"])?.trim() || process.env.USER || "unknown";
}

export function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((100 * n) / d)} %`;
}
