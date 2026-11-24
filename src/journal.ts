import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./util.ts";

export type Agent = "claude" | "codex";

/** Final status of a rule at a stop. "unknown" means the adapter could not observe enough to tell. */
export type CheckStatus = "clean" | "pass" | "fail" | "ran-unknown" | "missing" | "unknown";

export interface StartEvent {
  type: "start";
  t: string;
  agent: Agent;
  session: string;
  cwd: string;
  head: string | null;
  /** Hashes of dirty files at start, so pre-existing edits are not blamed on this session. */
  dirty: Record<string, string>;
  rules: Record<string, number>;
  source?: string;
  model?: string;
}

export interface ToolEvent {
  type: "tool";
  t: string;
  id?: string;
  kind: "edit" | "shell" | "other";
  tool: string;
  files?: string[];
  command?: string;
  exit: number | null;
}

export interface CheckEvent {
  type: "check";
  t: string;
  rule: string;
  version: number;
  by: "agent" | "hook";
  /** Tool call id, to resolve an exit code the hook did not get. */
  id?: string;
  exit: number | null;
  fp: string;
  files: string[];
  durationMs?: number;
  output?: string;
}

export interface ExitEvent {
  type: "exit";
  t: string;
  id: string;
  exit: number;
}

export interface StopResult {
  status: CheckStatus;
  version: number;
  files: string[];
  hookRan?: boolean;
  blocked?: boolean;
}

export interface StopEvent {
  type: "stop";
  t: string;
  results: Record<string, StopResult>;
}

export interface FlagEvent {
  type: "flag";
  t: string;
  rule: string;
  kind: "false-alarm";
  note?: string;
}

export interface EndEvent {
  type: "end";
  t: string;
}

export type JournalEvent = StartEvent | ToolEvent | CheckEvent | ExitEvent | StopEvent | FlagEvent | EndEvent;

export interface Session {
  agent: Agent;
  session: string;
  file: string;
  events: JournalEvent[];
}

function sessionsDir(root: string): string {
  return join(dataDir(root), "sessions");
}

export function sessionFile(root: string, agent: Agent, session: string): string {
  const safe = session.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(sessionsDir(root), `${agent}-${safe}.jsonl`);
}

export function append(root: string, agent: Agent, session: string, event: JournalEvent): void {
  mkdirSync(sessionsDir(root), { recursive: true });
  appendFileSync(sessionFile(root, agent, session), `${JSON.stringify(event)}\n`);
}

export function readEvents(file: string): JournalEvent[] {
  if (!existsSync(file)) return [];
  const out: JournalEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JournalEvent);
    } catch {
      // a torn last line from a killed hook; skip it
    }
  }
  return resolveExits(out);
}

/** Apply late exit codes (from the agent transcript) to the check and tool events they belong to. */
function resolveExits(events: JournalEvent[]): JournalEvent[] {
  const exits = new Map<string, number>();
  for (const e of events) if (e.type === "exit") exits.set(e.id, e.exit);
  if (exits.size === 0) return events;
  return events.map((e) => {
    if ((e.type === "check" || e.type === "tool") && e.exit === null && e.id && exits.has(e.id)) {
      return { ...e, exit: exits.get(e.id) as number };
    }
    return e;
  });
}

export function listSessions(root: string): Session[] {
  const dir = sessionsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const file = join(dir, f);
      const agent = (f.startsWith("codex-") ? "codex" : "claude") as Agent;
      const session = f.slice(agent.length + 1, -".jsonl".length);
      return { agent, session, file, events: readEvents(file) };
    })
    .sort((a, b) => (a.events[0]?.t ?? "").localeCompare(b.events[0]?.t ?? ""));
}

export function findSession(root: string, idPrefix: string): Session | undefined {
  const all = listSessions(root).filter((s) => s.session.startsWith(idPrefix));
  if (all.length > 1) throw new Error(`session prefix ${idPrefix} is ambiguous`);
  return all[0];
}

/**
 * The snapshot a session is measured against: the latest real start. A start after compaction
 * is the same conversation and must not forgive edits made before it.
 */
export function startOf(s: Session): StartEvent | undefined {
  return s.events.filter((e): e is StartEvent => e.type === "start" && e.source !== "compact").at(-1) ?? s.events.find((e): e is StartEvent => e.type === "start");
}

/** Events since the measured start: evidence from before a resume does not count. */
export function sinceStart(events: JournalEvent[], start: StartEvent | undefined): JournalEvent[] {
  if (!start) return events;
  const i = events.indexOf(start);
  return i < 0 ? events : events.slice(i);
}

export function lastStop(s: Session): StopEvent | undefined {
  return s.events.filter((e): e is StopEvent => e.type === "stop").at(-1);
}
