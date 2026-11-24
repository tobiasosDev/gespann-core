import type { Agent } from "../journal.ts";

export interface ToolCall {
  id?: string;
  name: string;
  kind: "edit" | "shell" | "other";
  files?: string[];
  command?: string;
  /** null when the agent's hook payload does not carry the exit code. */
  exit: number | null;
}

export interface HookInput {
  agent: Agent;
  event: "start" | "tool" | "stop" | "end" | "other";
  session: string;
  cwd: string;
  transcript?: string;
  source?: string;
  model?: string;
  stopHookActive?: boolean;
  tool?: ToolCall;
}

/** What an adapter can observe. A gap here turns a status into "unknown" instead of a finding. */
export interface Capabilities {
  /** Edits are always observed through git; this says whether tool calls also name the files. */
  editPaths: boolean;
  /** "hook": exit code in the hook payload; "transcript": read back from the agent transcript at stop. */
  shellExit: "hook" | "transcript";
  stopCanContinue: boolean;
}

export interface HookSpec {
  event: string;
  command: string;
  timeout?: number;
}

export interface Adapter {
  agent: Agent;
  capabilities: Capabilities;
  parse(raw: Record<string, unknown>, eventArg: string): HookInput;
  /** Exit code for a tool call id from the agent transcript, if the agent records one. */
  exitFromTranscript?(transcript: string, ids: string[]): Map<string, number>;
  configPath: string;
  hooks: HookSpec[];
}

export function hookCommand(agent: Agent, event: string): string {
  return `command -v gespann >/dev/null 2>&1 && gespann hook ${agent} ${event} || true`;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
