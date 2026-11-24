import { type Adapter, hookCommand, parseStop } from "./types.ts";

export const codex: Adapter = {
  agent: "codex",
  configPath: ".codex/hooks.json",
  hooks: [{ event: "Stop", command: hookCommand("codex", "stop"), timeout: 900 }],
  legacy: ["session-start", "post-tool", "session-end"].map((e) => hookCommand("codex", e)),
  parse: (raw, eventArg) => parseStop("codex", raw, eventArg),
};
