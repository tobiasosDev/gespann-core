import { existsSync, readFileSync } from "node:fs";
import { type Adapter, type HookInput, hookCommand, str, type ToolCall } from "./types.ts";

export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push((m[1] as string).trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) files.push((m[1] as string).trim());
  return files;
}

function tool(raw: Record<string, unknown>): ToolCall {
  const name = str(raw.tool_name) ?? "?";
  const input = (raw.tool_input ?? {}) as Record<string, unknown>;
  const id = str(raw.tool_use_id);
  const command = str(input.command) ?? "";
  if (name === "apply_patch") {
    const m = /Exit code: (\d+)/.exec(str(raw.tool_response) ?? "");
    return { id, name, kind: "edit", files: patchFiles(command), exit: m ? Number(m[1]) : null };
  }
  if (name === "Bash") return { id, name, kind: "shell", command, exit: null };
  return { id, name, kind: "other", exit: null };
}

export const codex: Adapter = {
  agent: "codex",
  // Codex's PostToolUse for shell commands carries only the output, not the exit code.
  capabilities: { editPaths: true, shellExit: "transcript", stopCanContinue: true },
  configPath: ".codex/hooks.json",
  hooks: [
    { event: "SessionStart", command: hookCommand("codex", "session-start") },
    { event: "PostToolUse", command: hookCommand("codex", "post-tool") },
    { event: "Stop", command: hookCommand("codex", "stop"), timeout: 900 },
    { event: "SessionEnd", command: hookCommand("codex", "session-end"), timeout: 3 },
  ],
  parse(raw, eventArg): HookInput {
    const base = {
      agent: "codex" as const,
      session: str(raw.session_id) ?? "unknown",
      cwd: str(raw.cwd) ?? process.cwd(),
      transcript: str(raw.transcript_path),
      model: str(raw.model),
    };
    switch (eventArg) {
      case "session-start":
        return { ...base, event: "start", source: str(raw.source) };
      case "post-tool":
        return { ...base, event: "tool", tool: tool(raw) };
      case "stop":
        return { ...base, event: "stop", stopHookActive: raw.stop_hook_active === true };
      case "session-end":
        return { ...base, event: "end" };
      default:
        return { ...base, event: "other" };
    }
  },
  exitFromTranscript(transcript, ids) {
    const found = new Map<string, number>();
    if (!existsSync(transcript) || ids.length === 0) return found;
    const wanted = new Set(ids);
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.includes("CommandExecution")) continue;
      try {
        const item = JSON.parse(line)?.payload?.item;
        if (item?.type === "CommandExecution" && wanted.has(item.id) && typeof item.exit_code === "number") {
          found.set(item.id, item.exit_code);
        }
      } catch {
        // not a JSON line we understand
      }
    }
    return found;
  },
};
