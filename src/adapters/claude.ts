import { type Adapter, type HookInput, hookCommand, str, type ToolCall } from "./types.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function tool(raw: Record<string, unknown>, failed: boolean): ToolCall {
  const name = str(raw.tool_name) ?? "?";
  const input = (raw.tool_input ?? {}) as Record<string, unknown>;
  const id = str(raw.tool_use_id);
  if (EDIT_TOOLS.has(name)) {
    const file = str(input.file_path) ?? str(input.notebook_path);
    return { id, name, kind: "edit", files: file ? [file] : [], exit: failed ? 1 : 0 };
  }
  if (name === "Bash") {
    let exit: number | null = 0;
    if (failed) {
      const m = /exit code:?\s*(\d+)/i.exec(str(raw.error) ?? "");
      exit = m ? Number(m[1]) : 1;
    }
    return { id, name, kind: "shell", command: str(input.command) ?? "", exit };
  }
  return { id, name, kind: "other", exit: failed ? 1 : 0 };
}

export const claude: Adapter = {
  agent: "claude",
  capabilities: { editPaths: true, shellExit: "hook", stopCanContinue: true },
  configPath: ".claude/settings.json",
  hooks: [
    { event: "SessionStart", command: hookCommand("claude", "session-start") },
    { event: "PostToolUse", command: hookCommand("claude", "post-tool") },
    { event: "PostToolUseFailure", command: hookCommand("claude", "post-tool-failure") },
    { event: "Stop", command: hookCommand("claude", "stop"), timeout: 900 },
    { event: "SessionEnd", command: hookCommand("claude", "session-end") },
  ],
  parse(raw, eventArg): HookInput {
    const base = {
      agent: "claude" as const,
      session: str(raw.session_id) ?? "unknown",
      cwd: str(raw.cwd) ?? process.cwd(),
      transcript: str(raw.transcript_path),
    };
    switch (eventArg) {
      case "session-start":
        return { ...base, event: "start", source: str(raw.source), model: str(raw.model) };
      case "post-tool":
        return { ...base, event: "tool", tool: tool(raw, false) };
      case "post-tool-failure":
        return { ...base, event: "tool", tool: tool(raw, true) };
      case "stop":
        return { ...base, event: "stop", stopHookActive: raw.stop_hook_active === true };
      case "session-end":
        return { ...base, event: "end" };
      default:
        return { ...base, event: "other" };
    }
  },
};
