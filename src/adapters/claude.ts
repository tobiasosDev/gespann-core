import { type Adapter, hookCommand, parseStop } from "./types.ts";

export const claude: Adapter = {
  agent: "claude",
  configPath: ".claude/settings.json",
  hooks: [{ event: "Stop", command: hookCommand("claude", "stop"), timeout: 900 }],
  legacy: ["session-start", "post-tool", "post-tool-failure", "session-end"].map((e) => hookCommand("claude", e)),
  parse: (raw, eventArg) => parseStop("claude", raw, eventArg),
};
