import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { matchesAny } from "./glob.ts";
import type { Agent, CheckStatus } from "./journal.ts";
import { invocation, type RuleVersion } from "./rules.ts";
import { dataDir, gitOk, now, readJson, writeJson } from "./util.ts";

/**
 * Read past Claude Code and Codex transcripts of this repo and rebuild, per session, whether a
 * rule's check ran after the last relevant edit. This is the baseline before any rule change.
 * Edits are taken from tool calls and recognisable shell writes, so it is an estimate; live hooks
 * observe through git instead.
 */

export interface ScanEvent {
  t: string;
  kind: "edit" | "shell";
  files?: string[];
  command?: string;
  exit?: number | null;
}

export interface ScannedSession {
  agent: Agent;
  session: string;
  t: string;
  cwd: string;
  events: ScanEvent[];
}

export interface ScanResult {
  status: CheckStatus;
  files: string[];
}

export interface ScanFile {
  at: string;
  sessions: { agent: Agent; session: string; t: string; cwd: string; results: Record<string, ScanResult> }[];
}

const INPLACE = /\bsed\s+-i|\bperl\s+-\w*i|\bgit apply\b|\bapply_patch\b/;
const REDIRECT = /(?:>>?|\btee(?:\s+-a)?)\s+['"]?([\w./@~-]+\.\w+)\b/g;
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/g;
const PY_WRITE = /\.write\(|write_text\(|open\([^)]*['"][wa]['"]/;
const PATHLIKE = /[\w./@~-]+\.[A-Za-z]{1,5}\b/g;
const CD = /(?:^|[;&\n]\s*)cd\s+['"]?([^\s;&'"]+)/;

/** Files a shell command visibly writes. Misses writes it cannot see; never invents paths. */
export function shellWrites(command: string): { files: string[]; cd?: string } {
  const files = new Set<string>();
  const outer = command.replace(HEREDOC, " ");
  if (INPLACE.test(outer)) for (const p of outer.match(PATHLIKE) ?? []) files.add(p);
  for (const m of outer.matchAll(REDIRECT)) files.add(m[1] as string);
  for (const m of command.matchAll(HEREDOC)) {
    const body = m[2] as string;
    if (/python|node|bun|ruby|perl/.test(outer) && PY_WRITE.test(body)) for (const p of body.match(PATHLIKE) ?? []) files.add(p);
    if (/apply_patch|git apply/.test(outer)) for (const p of body.match(PATHLIKE) ?? []) files.add(p);
  }
  const cd = CD.exec(command)?.[1];
  return { files: [...files].filter((f) => !/^\d|^https?:/.test(f)), ...(cd ? { cd } : {}) };
}

function* jsonl(path: string): Generator<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // partial line
    }
  }
}

export function parseClaude(path: string): ScannedSession | undefined {
  let cwd = "";
  let first = "";
  const events: ScanEvent[] = [];
  const pending = new Map<string, ScanEvent>();
  for (const d of jsonl(path)) {
    if (!cwd && typeof d.cwd === "string") cwd = d.cwd;
    const t = typeof d.timestamp === "string" ? d.timestamp : "";
    if (!first && t) first = t;
    const content = (d.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (d.type === "assistant" && b.type === "tool_use") {
        const name = String(b.name ?? "").split("_").pop() as string;
        const input = (b.input ?? {}) as Record<string, unknown>;
        if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
          const f = (input.file_path ?? input.notebook_path) as string | undefined;
          if (f) events.push({ t, kind: "edit", files: [f] });
        } else if (name === "Bash" && typeof input.command === "string") {
          const ev: ScanEvent = { t, kind: "shell", command: input.command, exit: null };
          events.push(ev);
          if (typeof b.id === "string") pending.set(b.id, ev);
        }
      } else if (d.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const ev = pending.get(b.tool_use_id);
        if (ev) ev.exit = b.is_error === true ? 1 : 0;
      }
    }
  }
  if (!cwd) return undefined;
  const session = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
  return { agent: "claude", session, t: first, cwd, events };
}

export function parseCodex(path: string): ScannedSession | undefined {
  let cwd = "";
  let session = "";
  let first = "";
  const events: ScanEvent[] = [];
  for (const d of jsonl(path)) {
    const t = typeof d.timestamp === "string" ? d.timestamp : "";
    const p = (d.payload ?? {}) as Record<string, unknown>;
    if (d.type === "session_meta") {
      cwd = String(p.cwd ?? "");
      session = String(p.id ?? p.session_id ?? "");
      first = t;
      continue;
    }
    if (d.type !== "event_msg" || p.type !== "item_completed") continue;
    const item = (p.item ?? {}) as Record<string, unknown>;
    if (item.type === "FileChange" && item.changes && typeof item.changes === "object") {
      events.push({ t, kind: "edit", files: Object.keys(item.changes) });
    } else if (item.type === "CommandExecution") {
      const cmd = Array.isArray(item.command) ? (item.command as string[]) : [String(item.command ?? "")];
      const script = cmd.length >= 3 && /sh$/.test(cmd[0] ?? "") && /^-\w*c$/.test(cmd[1] ?? "") ? cmd.slice(2).join(" ") : cmd.join(" ");
      events.push({ t, kind: "shell", command: script, exit: typeof item.exit_code === "number" ? item.exit_code : null });
    }
  }
  if (!cwd) return undefined;
  return { agent: "codex", session: session || path, t: first, cwd, events };
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth < 0 || !existsSync(dir)) return;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    // Transcript folders are often symlinks to offloaded storage.
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) yield* walk(p, depth - 1);
    else if (d.name.endsWith(".jsonl")) yield p;
  }
}

export function transcriptFiles(agent: Agent, sinceMs: number, home = homedir()): string[] {
  const files =
    agent === "claude"
      ? [...walk(join(home, ".claude", "projects"), 1)]
      : [...walk(join(home, ".codex", "sessions"), 4), ...walk(join(home, ".codex", "archived_sessions"), 4)];
  return files.filter((f) => {
    try {
      return statSync(f).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  });
}

/** Roots a session of this repo can run in: the checkout and its worktrees (also removed ones, via --match). */
export function repoRoots(root: string): string[] {
  const out = gitOk(root, ["worktree", "list", "--porcelain"]) ?? "";
  const roots = out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  return [...new Set([root, ...roots])].sort((a, b) => b.length - a.length);
}

function sessionRoot(cwd: string, roots: string[]): string {
  const found = roots.find((r) => cwd === r || cwd.startsWith(`${r}/`));
  if (found) return found;
  // A removed worktree: assume the session started at its root, cut at a known subfolder.
  const cut = /^(.*?)\/(?:apps|packages|services|src)(?:\/|$)/.exec(cwd);
  return cut ? (cut[1] as string) : cwd;
}

function relTo(root: string, base: string, path: string): string | undefined {
  const abs = isAbsolute(path) ? path : normalize(join(base, path.replace(/^~(?=\/)/, homedir())));
  const r = relative(root, abs);
  return r.startsWith("..") || isAbsolute(r) ? undefined : r.split("\\").join("/");
}

export function evaluateScanned(s: ScannedSession, rule: RuleVersion, roots: string[]): ScanResult {
  const root = sessionRoot(s.cwd, roots);
  let lastEdit = -1;
  const files = new Set<string>();
  let lastCheck: { idx: number; exit: number | null } | undefined;
  s.events.forEach((e, idx) => {
    let base = s.cwd;
    let written = e.files ?? [];
    if (e.kind === "shell" && e.command) {
      const inv = invocation(e.command, rule, root, s.cwd);
      if (inv.ran) lastCheck = { idx, exit: inv.ownExit ? (e.exit ?? null) : null };
      const w = shellWrites(e.command);
      written = w.files;
      if (w.cd) base = isAbsolute(w.cd) ? w.cd : join(s.cwd, w.cd);
    }
    for (const f of written) {
      const r = relTo(root, base, f);
      if (r && matchesAny(r, rule.paths)) {
        files.add(r);
        lastEdit = idx;
      }
    }
  });
  const list = [...files].sort();
  if (lastEdit < 0) return { status: "clean", files: list };
  if (!lastCheck || lastCheck.idx < lastEdit) return { status: "missing", files: list };
  return { status: lastCheck.exit === null ? "ran-unknown" : lastCheck.exit === 0 ? "pass" : "fail", files: list };
}

export interface ScanOptions {
  days: number;
  match?: string;
  agents: Agent[];
  home?: string;
}

export function scan(root: string, rules: RuleVersion[], opts: ScanOptions): ScanFile {
  const since = Date.now() - opts.days * 86_400_000;
  const roots = repoRoots(root);
  const belongs = (cwd: string) => roots.some((r) => cwd === r || cwd.startsWith(`${r}/`)) || (!!opts.match && cwd.includes(opts.match));
  const sessions: ScanFile["sessions"] = [];
  for (const agent of opts.agents) {
    for (const f of transcriptFiles(agent, since, opts.home)) {
      if (agent === "claude" && f.includes("/subagents/")) continue;
      const s = agent === "claude" ? parseClaude(f) : parseCodex(f);
      if (!s || !belongs(s.cwd)) continue;
      const results: Record<string, ScanResult> = {};
      for (const r of rules) {
        const res = evaluateScanned(s, r, roots);
        if (res.status !== "clean") results[r.id] = res;
      }
      sessions.push({ agent: s.agent, session: s.session, t: s.t, cwd: s.cwd, results });
    }
  }
  sessions.sort((a, b) => a.t.localeCompare(b.t));
  return { at: now(), sessions };
}

export function scanPath(root: string): string {
  return join(dataDir(root), "scan.json");
}

export function saveScan(root: string, file: ScanFile): void {
  writeJson(scanPath(root), file);
}

export function loadScan(root: string): ScanFile | undefined {
  return readJson<ScanFile>(scanPath(root));
}
