import type { Fetch } from "./openrouter.ts";

/**
 * Tester agents with the user's own key: Claude Code (Anthropic API key or Claude subscription token),
 * the GitHub Copilot CLI (a GitHub token that may use Copilot) and the Grok CLI (xAI API key). The key is
 * checked once here, kept sealed like a Codex sign-in, and lies in the sandbox only while a step starts
 * (`gespann agent`, src/verify/agents.ts).
 */
export const KEY_AGENTS = ["claude", "copilot", "grok"] as const;
export type KeyAgent = (typeof KEY_AGENTS)[number];

export function isKeyAgent(s: unknown): s is KeyAgent {
  return typeof s === "string" && (KEY_AGENTS as readonly string[]).includes(s);
}

export interface KeyAgentInfo {
  id: KeyAgent;
  name: string;
  /** What the key field asks for. */
  keyHint: string;
  /** Where the user gets a key. */
  keyUrl: string;
  /** Models to suggest; the CLI's default when none is chosen. */
  models: string[];
}

export const KEY_AGENT_INFO: Record<KeyAgent, KeyAgentInfo> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    keyHint: "an Anthropic API key (sk-ant-api…) or the token that claude setup-token prints for your Claude Pro or Max plan (sk-ant-oat…)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    keyHint: "a GitHub token of an account with Copilot (fine-grained, with the permission Copilot Requests)",
    keyUrl: "https://github.com/settings/personal-access-tokens/new",
    models: ["auto", "claude-sonnet-5-5", "gpt-6.1-terra"],
  },
  grok: {
    id: "grok",
    name: "Grok",
    keyHint: "an xAI API key (xai-…)",
    keyUrl: "https://console.x.ai",
    models: ["grok-4.7", "grok-4.20-0309-reasoning", "grok-4.6"],
  },
};

/** Model ids of the three CLIs: letters, digits, `.`, `-`, `_`, `:` and `/`. */
export const AGENT_MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

export class AgentKeyError extends Error {
  /** 400: the key is malformed or refused; 502: the provider did not answer. */
  readonly status: 400 | 502;
  constructor(status: 400 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

/** The key's start and end, never the middle: enough to recognise it in Settings. */
export function shortKey(key: string): string {
  return key.length > 20 ? `${key.slice(0, 12)}…${key.slice(-4)}` : `${key.slice(0, 6)}…`;
}

async function ask(f: Fetch, who: string, url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await f(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new AgentKeyError(502, `${who} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Checks the key with its provider and returns the label Settings shows. A Claude subscription token
 * is checked by its form only: Anthropic's API does not take it outside Claude Code.
 */
export async function checkAgentKey(agent: KeyAgent, raw: string, f: Fetch = fetch): Promise<{ key: string; label: string }> {
  const key = raw.trim();
  if (agent === "claude") {
    if (/^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,300}$/.test(key)) return { key, label: `Claude subscription token ${shortKey(key)}` };
    if (!/^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,300}$/.test(key)) throw new AgentKeyError(400, "key: an Anthropic API key starts with sk-ant-api, the token of claude setup-token with sk-ant-oat");
    const res = await ask(f, "Anthropic", "https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" });
    if (res.status === 401 || res.status === 403) throw new AgentKeyError(400, "Anthropic does not accept this key");
    if (!res.ok) throw new AgentKeyError(502, `Anthropic answered ${res.status}`);
    return { key, label: `Anthropic API key ${shortKey(key)}` };
  }
  if (agent === "copilot") {
    if (!/^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/.test(key)) throw new AgentKeyError(400, "key: a GitHub token starts with github_pat_, ghp_ or gho_");
    const res = await ask(f, "GitHub", "https://api.github.com/user", { Authorization: `Bearer ${key}`, Accept: "application/vnd.github+json", "User-Agent": "gespann" });
    if (res.status === 401 || res.status === 403) throw new AgentKeyError(400, "GitHub does not accept this token");
    if (!res.ok) throw new AgentKeyError(502, `GitHub answered ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { login?: unknown };
    const login = typeof body.login === "string" ? body.login : "";
    return { key, label: login ? `GitHub @${login} · ${shortKey(key)}` : `GitHub token ${shortKey(key)}` };
  }
  if (!/^xai-[A-Za-z0-9_-]{20,300}$/.test(key)) throw new AgentKeyError(400, "key: an xAI API key starts with xai-");
  const res = await ask(f, "xAI", "https://api.x.ai/v1/api-key", { Authorization: `Bearer ${key}` });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new AgentKeyError(400, "xAI does not accept this key");
  if (!res.ok) throw new AgentKeyError(502, `xAI answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { name?: unknown; api_key_blocked?: unknown; api_key_disabled?: unknown };
  if (body.api_key_blocked === true || body.api_key_disabled === true) throw new AgentKeyError(400, "xAI has blocked or disabled this key");
  const name = typeof body.name === "string" && body.name ? body.name.slice(0, 60) : "";
  return { key, label: name ? `xAI key "${name}" · ${shortKey(key)}` : `xAI key ${shortKey(key)}` };
}
