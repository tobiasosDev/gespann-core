import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * OpenRouter as the agent's model provider: the user brings their own API key, and Codex runs in the
 * sandbox against OpenRouter instead of the user's ChatGPT plan (orchestrator/src/codex.rs).
 */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** OpenRouter model ids: `vendor/model`, optionally `:variant` (`openai/gpt-4o-mini`, `x/y:free`). */
export const OPENROUTER_MODEL_RE = /^[A-Za-z0-9._-]{1,60}\/[A-Za-z0-9._:-]{1,100}$/;

function key(secret: string): Buffer {
  return createHash("sha256").update(`gespann-codex-auth:${secret}`).digest();
}

/** AES-256-GCM as `seal` in orchestrator/src/codex.rs (`base64(iv).base64(tag).base64(body)`), which opens it. */
export function seal(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function open(secret: string, sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv("aes-256-gcm", key(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

export type Fetch = typeof fetch;

export class OpenRouterError extends Error {
  /** 400: OpenRouter refused the key; 502: OpenRouter did not answer. */
  readonly status: 400 | 502;
  constructor(status: 400 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

/** Asks OpenRouter whether the key works; returns its label (OpenRouter shows `sk-or-v1-abc...xyz`). */
export async function checkKey(apiKey: string, f: Fetch = fetch): Promise<{ label: string }> {
  let res: Response;
  try {
    res = await f(`${OPENROUTER_API}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new OpenRouterError(502, `OpenRouter did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) throw new OpenRouterError(400, "OpenRouter does not accept this key");
  if (!res.ok) throw new OpenRouterError(502, `OpenRouter answered ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { data?: { label?: unknown } };
  const label = typeof body.data?.label === "string" && body.data.label ? body.data.label : `${apiKey.slice(0, 12)}…`;
  return { label: label.slice(0, 120) };
}

export interface OpenRouterModel {
  id: string;
  name: string;
  /** Tokens the model reads at most; Codex compacts its context before it reaches it. */
  context: number | null;
}

/**
 * OpenRouter's models the tester can work with: those that call tools (Codex runs shell commands and
 * the browser through tools) and read images (screenshots). Public list, no key needed.
 */
export async function listModels(f: Fetch = fetch): Promise<OpenRouterModel[]> {
  let res: Response;
  try {
    res = await f(`${OPENROUTER_API}/models`, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new OpenRouterError(502, `OpenRouter did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new OpenRouterError(502, `OpenRouter answered ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown; name?: unknown; context_length?: unknown; supported_parameters?: unknown; architecture?: { input_modalities?: unknown } }[] };
  return (body.data ?? [])
    .filter((m) => typeof m.id === "string" && OPENROUTER_MODEL_RE.test(m.id))
    .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
    .filter((m) => !Array.isArray(m.architecture?.input_modalities) || m.architecture.input_modalities.includes("image"))
    .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : (m.id as string), context: typeof m.context_length === "number" ? m.context_length : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
