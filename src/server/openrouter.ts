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
  /** US dollars per 1M input, cached input and output tokens; null when OpenRouter names no fixed price (routers). */
  price: { input: number; cached: number; output: number } | null;
}

/** A model the Settings page offers as a pick; any other OpenRouter id can still be typed. */
export interface OpenRouterSuggestion extends OpenRouterModel {
  kind: "vision" | "free";
}

/**
 * The few paid models the picker suggests: OpenRouter lists them as calling tools and reading images,
 * and they cost cents per test. None is tested through OpenRouter by us; the page says so. Big models
 * such as Sonnet are left out: on a per-token bill they cost too much per PR. A pick OpenRouter no longer
 * lists is left out.
 */
export const OPENROUTER_PICKS: readonly string[] = ["openai/gpt-6.1-terra", "google/gemini-3.5-flash-lite", "anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash"];

/**
 * The free models the picker offers (no cost on the user's key, tight rate limits). OpenRouter changes
 * its free models often: when none of these is listed any more, the picker offers its largest free ones.
 */
export const OPENROUTER_FREE_PICKS: readonly string[] = ["nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free"];

const perMillion = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1000) / 1000 : null;
};

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
  const body = (await res.json()) as {
    data?: { id?: unknown; name?: unknown; context_length?: unknown; supported_parameters?: unknown; architecture?: { input_modalities?: unknown }; pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown } }[];
  };
  return (body.data ?? [])
    .filter((m) => typeof m.id === "string" && OPENROUTER_MODEL_RE.test(m.id))
    .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
    .filter((m) => !Array.isArray(m.architecture?.input_modalities) || m.architecture.input_modalities.includes("image"))
    .map((m) => {
      const input = perMillion(m.pricing?.prompt);
      const output = perMillion(m.pricing?.completion);
      const cached = perMillion(m.pricing?.input_cache_read) ?? input;
      return {
        id: m.id as string,
        name: typeof m.name === "string" ? m.name : (m.id as string),
        context: typeof m.context_length === "number" ? m.context_length : null,
        price: input !== null && output !== null && cached !== null ? { input, cached, output } : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const isFree = (m: OpenRouterModel) => m.id.endsWith(":free") && m.price?.input === 0 && m.price.output === 0;

/**
 * The short list the picker shows instead of all of OpenRouter's ~300 matching models: the paid picks
 * and the free picks that OpenRouter still lists. Routers such as `openrouter/free` are never offered:
 * they may hand a step to a model that cannot call tools or read screenshots.
 */
export function suggestModels(models: OpenRouterModel[]): OpenRouterSuggestion[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const vision = OPENROUTER_PICKS.flatMap((id) => {
    const m = byId.get(id);
    return m ? [{ ...m, kind: "vision" as const }] : [];
  });
  let free = OPENROUTER_FREE_PICKS.flatMap((id) => {
    const m = byId.get(id);
    return m && isFree(m) ? [m] : [];
  });
  if (!free.length) {
    free = models
      .filter((m) => isFree(m) && !m.id.startsWith("openrouter/"))
      .sort((a, b) => (b.context ?? 0) - (a.context ?? 0) || a.id.localeCompare(b.id))
      .slice(0, OPENROUTER_FREE_PICKS.length);
  }
  return [...vision, ...free.map((m) => ({ ...m, kind: "free" as const }))];
}
