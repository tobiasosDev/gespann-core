export type Agent = "claude" | "codex";

export interface HookInput {
  agent: Agent;
  event: "stop" | "other";
  session: string;
  cwd: string;
  transcript?: string;
  /** True when this stop follows a continuation a stop hook asked for. */
  stopHookActive?: boolean;
}

export interface HookSpec {
  event: string;
  command: string;
  timeout?: number;
}

export interface Adapter {
  agent: Agent;
  parse(raw: Record<string, unknown>, eventArg: string): HookInput;
  configPath: string;
  hooks: HookSpec[];
  /** Commands earlier versions installed. `init` and `uninstall` remove them. */
  legacy: string[];
}

export function hookCommand(agent: Agent, event: string): string {
  return `command -v gespann >/dev/null 2>&1 && gespann hook ${agent} ${event} || true`;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseStop(agent: Agent, raw: Record<string, unknown>, eventArg: string): HookInput {
  return {
    agent,
    event: eventArg === "stop" ? "stop" : "other",
    session: str(raw.session_id) ?? "unknown",
    cwd: str(raw.cwd) ?? process.cwd(),
    transcript: str(raw.transcript_path),
    stopHookActive: raw.stop_hook_active === true,
  };
}
