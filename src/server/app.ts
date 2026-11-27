import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { triggered } from "../verify/plan.ts";
import { parseProgress } from "../verify/progress.ts";
import { DEFAULT_CHECKS } from "../verify/prompt.ts";
import { parseRecipe } from "../verify/recipe.ts";
import { viewportsOf, VIEWPORTS } from "../verify/viewports.ts";
import type { Config, GithubApp } from "./config.ts";
import { ALERT_KINDS, ALERT_MAX_AFTER, alertRules, confirmMail, readConfirmToken } from "./alerts.ts";
import { AGENT_PROVIDERS, type Db, type Project, SIGN_IN_AGENTS, type User } from "./db.ts";
import { APPROVE, applyGate, approve, approvedCheck, GATE_LABEL, gated, MAY_APPROVE, refreshComment, releaseAll, skipClosedRuns, withPrLock } from "./gate.ts";
import { appManifest, convertManifest, Github, type PullRequest, verifySignature } from "./github.ts";
import { capFor, type ServerModule } from "./extension.ts";
import { hostSizeFor, mountInternal, orchestratorPresent, orchestratorState, servesMacos, unservedBy } from "./internal.ts";
import { mcpRespond, type Viewer } from "./mcp.ts";
import { mountOAuth } from "./oauth.ts";
import { AGENT_MODEL_RE, AgentKeyError, checkAgentKey, isKeyAgent, KEY_AGENT_INFO, KEY_AGENTS } from "./agentkeys.ts";
import { checkKey, type Fetch, listModels, OPENROUTER_MODEL_RE, OpenRouterError, type OpenRouterModel, seal, suggestModels } from "./openrouter.ts";
import { type Mailer, validEmail } from "./mail.ts";
import { recordPrState } from "./pulls.ts";
import { afterGithub, landingAfterSignIn, linkTag, mountSignIn, signInMethods, syncRepos } from "./signin.ts";

/**
 * Codex models offered in Settings; users may also keep Codex's default or enter a custom model slug.
 * `rates`: OpenAI's Codex credits per 1M tokens (input / cached input / output). `bench`, `recommended`
 * and `note` come from the tester benchmark in docs/models.md: right verdicts of `of`, and the mean
 * credits one test PR used.
 */
const CODEX_MODELS: {
  id: string;
  name: string;
  description: string;
  rates: { input: number; cached: number; output: number };
  bench?: { right: number; of: number; credits: number };
  recommended?: true;
  note?: string;
}[] = [
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", description: "Strong at visual understanding and computer use", rates: { input: 25, cached: 1.25, output: 125 }, bench: { right: 14, of: 14, credits: 1.5 }, recommended: true },
  { id: "gpt-6.2-sol", name: "GPT-6.2-Sol", description: "Fast, go-to model for coding and everyday work", rates: { input: 50, cached: 2.5, output: 250 }, bench: { right: 14, of: 14, credits: 3.6 } },
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", description: "Previous generation coding model", rates: { input: 50, cached: 2.5, output: 250 }, bench: { right: 14, of: 14, credits: 3.4 } },
  { id: "gpt-6-luna", name: "GPT-6-Luna", description: "Fast and affordable for easier tasks", rates: { input: 2.5, cached: 0.25, output: 12.5 }, bench: { right: 13, of: 14, credits: 0.25 }, note: "The cheapest, but in our benchmark it passed a PR that broke a total. Not recommended for testing." },
  { id: "gpt-6.2-astra", name: "GPT-6.2-Astra", description: "Most capable model for complex coding", rates: { input: 200, cached: 10, output: 1000 } },
  { id: "gpt-6-astra", name: "GPT-6-Astra", description: "Previous generation complex coding model", rates: { input: 250, cached: 25, output: 1250 } },
];

/** A model slug: Codex's own (`gpt-6.2-sol`) or OpenRouter's (`anthropic/claude-x`). */
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,160}$/;
const MODEL_HINT = "model: letters, digits, . _ : / - only";

/** The built React app: dist/web, next to dist/server when built, or ../../dist/web from src. */
const WEB = [new URL("../web/", import.meta.url), new URL("../../dist/web/", import.meta.url)].map((u) => fileURLToPath(u)).find((p) => existsSync(join(p, "index.html")));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
const CSP =
  "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self' https://github.com; base-uri 'none'";

export type Env = { Variables: { user: User | null; session: string | null } };

export interface AppDeps {
  config: Config;
  db: Db;
  /** Throws when the instance has no GitHub App yet. */
  github: () => Github;
  githubReady: () => boolean;
  /** `SERVER_MODULE`: its routes, sidebar links and Settings cards. */
  module?: ServerModule | null;
  /** For calls to OpenRouter (tests pass a fake); default the global fetch. */
  fetch?: Fetch;
  /** gespann's mail (mail.ts); without one, nobody is asked for an address and nothing is mailed. */
  mailer?: Mailer | null;
}

export function githubApp(config: Config, db: Db): GithubApp | null {
  const stored = db.setting("github_app");
  const merged = { ...(stored ? (JSON.parse(stored) as Partial<GithubApp>) : {}), ...config.github };
  return merged.appId && merged.privateKey && merged.webhookSecret && merged.clientId && merged.clientSecret && merged.slug ? (merged as GithubApp) : null;
}

/**
 * Serves a file from disk, streamed. Answers byte ranges (206), which Safari on iOS needs before it
 * plays a video at all.
 */
export function sendFile(c: Context, path: string, cache: string): Response {
  if (!existsSync(path)) return c.text("Not found", 404);
  const size = statSync(path).size;
  const headers: Record<string, string> = { "Content-Type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream", "Cache-Control": cache, "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range")?.trim() ?? "");
  if (range && (range[1] || range[2])) {
    // "bytes=a-b", "bytes=a-" or the last n bytes "bytes=-n".
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    const body = c.req.method === "HEAD" ? null : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream);
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const body = c.req.method === "HEAD" ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream);
  return new Response(body, { headers: { ...headers, "Content-Length": String(size) } });
}

/** Web sessions last this long; MCP tokens trust a user's repository list for as long. */
const SESSION_DAYS = 7;

/** A 401 that points agents at the OAuth sign-in (MCP authorization, RFC 9728). */
function mcpDenied(c: Context, baseUrl: string, message: string, tokenSent: boolean): Response {
  c.header("WWW-Authenticate", `Bearer realm="gespann", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"${tokenSent ? ', error="invalid_token"' : ""}`);
  return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, 401);
}

class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409;
  constructor(status: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(d: AppDeps): Hono<Env> {
  const { config, db } = d;
  const app = new Hono<Env>();
  const secure = config.baseUrl.startsWith("https://");
  // ALLOWED_USERS closes the instance to everyone else, including users who signed in before.
  const allowed = (login: string) => !config.allowedUsers.length || config.allowedUsers.includes(login.toLowerCase());
  // Read per request: the orchestrator publishes each sandbox provider's size while it runs; a user's
  // number is the one of the provider that serves them.
  const hostSize = (login: string): number | null => hostSizeFor(orchestratorState(db), login);
  const f = d.fetch ?? fetch;
  const methods = signInMethods(d.module?.signIn);
  // OpenRouter's model list changes rarely; asked at most once an hour. Losing it on a restart is harmless.
  let models: { at: number; list: OpenRouterModel[] } | null = null;
  const openRouterModels = async (): Promise<OpenRouterModel[]> => {
    if (!models || Date.now() - models.at > 3_600_000) models = { at: Date.now(), list: await listModels(f) };
    return models.list;
  };

  // The orchestrator's API comes first: it has its own token and needs no session.
  mountInternal(app, d);

  app.use("*", async (c, next) => {
    const sid = getCookie(c, "gs") ?? null;
    const found = sid ? db.sessionUser(sid) : undefined;
    const user = found && allowed(found.login) ? found : null;
    c.set("user", user);
    c.set("session", user ? sid : null);
    await next();
    // Pages that set their own policy (the OAuth consent page) keep it.
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
  });

  // Every API call needs the custom header: a cross-site form cannot set it, so it guards against CSRF.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/me") return next();
    if (c.req.method !== "GET" && c.req.header("x-gespann") !== "1") throw new HttpError(403, "missing x-gespann header");
    if (!c.get("user")) throw new HttpError(401, "sign in first");
    return next();
  });
  const me = (c: Context<Env>) => c.get("user") as User;
  const project = (c: Context<Env>, id = c.req.param("id")): Project => {
    const p = db.project(Number(id));
    if (!p || !db.canSee(me(c).id, p)) throw new HttpError(404, "project not found");
    return p;
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  // MCP endpoint for coding agents (Streamable HTTP, stateless): reads runs, and reruns a PR. An agent's OAuth sign-in or
  // a personal token from Settings sees the projects its user sees; the ADMIN_TOKEN sees every project.
  app.post("/mcp", async (c) => {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(config.baseUrl).origin) return c.json({ error: "origin not allowed" }, 403);
    const raw = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    let viewer: Viewer | null = null;
    if (raw && config.adminToken && raw.length === config.adminToken.length && timingSafeEqual(Buffer.from(raw), Buffer.from(config.adminToken))) viewer = { operator: true };
    else {
      const found = raw ? db.tokenUser(raw) : undefined;
      const user = found && allowed(found.login) ? found : undefined;
      // Repository access is what GitHub reported at the last sign-in. Like a web session, a token
      // relies on it for at most 7 days, so someone removed from a repository loses it there too.
      if (user && Date.parse(user.repos_synced ?? "") > Date.now() - SESSION_DAYS * 86_400_000) viewer = { userId: user.id };
      else if (user) return mcpDenied(c, config.baseUrl, `sign in to gespann again (${config.baseUrl}): repository access is re-checked with GitHub every ${SESSION_DAYS} days`, true);
    }
    if (!viewer) return mcpDenied(c, config.baseUrl, "sign in with OAuth (your agent opens the browser) or send a token from Settings → Agent access", !!raw);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const out = await mcpRespond(body, viewer, {
      db,
      dataDir: config.dataDir,
      baseUrl: config.baseUrl,
      ...(d.githubReady() ? { pull: (p: Project, pr: number) => d.github().pull(p.installation_id, p.repo, pr), queueRun: (p: Project, pr: PullRequest) => queueRun(d, p, pr) } : {}),
    });
    return out === null ? c.body(null, 202) : c.json(out);
  });
  // No server-to-client stream and no sessions: GET and DELETE are not offered.
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "POST JSON-RPC messages to this endpoint" }, 405);
  });
  mountOAuth(app, { config, db, sessionDays: SESSION_DAYS });
  // Other discovery documents: 404, not the web app.
  app.get("/.well-known/*", (c) => c.json({ error: "not found" }, 404));

  // Operator API for the instance owner (Bearer ADMIN_TOKEN): start and inspect runs without a browser session.
  app.use("/ops/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const want = Buffer.from(`Bearer ${config.adminToken}`);
    const got = Buffer.from(auth);
    if (!config.adminToken || want.length !== got.length || !timingSafeEqual(want, got)) return c.json({ error: "not found" }, 404);
    return next();
  });
  app.get("/ops/projects", (c) =>
    c.json(db.allProjects().map((p) => ({ id: p.id, repo: p.repo, setup: p.setup, active: p.active, sandboxes: db.slots(p.id).map((s) => ({ id: s.sandbox_id, job: s.job_id })), criteria: p.criteria, runs: db.runs(p.id, 5).map((r) => ({ id: r.id, pr: r.pr, status: r.status, outcome: r.outcome })) }))),
  );
  app.post("/ops/projects/:id/runs", async (c) => {
    const p = db.project(Number(c.req.param("id")));
    if (!p) throw new HttpError(404, "project not found");
    const { pr } = await c.req.json<{ pr: number }>();
    return c.json({ runId: await queueRun(d, p, await d.github().pull(p.installation_id, p.repo, pr)) });
  });
  app.post("/ops/projects/:id/suggest", (c) => {
    const p = db.project(Number(c.req.param("id")));
    if (!p) throw new HttpError(404, "project not found");
    db.enqueue(p.id, "suggest");
    return c.json({ ok: true });
  });
  app.get("/ops/runs/:id", (c) => {
    const run = db.run_(Number(c.req.param("id")));
    if (!run) throw new HttpError(404, "run not found");
    const job = db.jobs(run.project_id, 500).find((j) => j.run_id === run.id);
    return c.json({ ...run, verdict: run.verdict ? JSON.parse(run.verdict) : null, files: JSON.parse(run.files), job: job ? { status: job.status, error: job.error, log: job.log } : null });
  });
  app.get("/ops/projects/:id/jobs", (c) => c.json(db.jobs(Number(c.req.param("id")), 20)));

  app.get("/api/me", (c) => {
    const u = c.get("user");
    let installUrl: string | null = null;
    if (d.githubReady()) installUrl = d.github().installUrl();
    // An instance that sends mail asks a user without an address for one, once, right after sign-in.
    const askEmail = !!u && !!d.mailer?.sends && !u.email && !u.email_pending;
    const signIn = d.githubReady() ? methods.map((m) => ({ id: m.id, label: m.label })) : [];
    return c.json({ user: u ? { login: u.login, avatar: u.avatar } : null, githubReady: d.githubReady(), installUrl, links: u ? (d.module?.links ?? []) : [], askEmail, signIn });
  });

  app.post("/api/logout", (c) => {
    const sid = c.get("session");
    if (sid) db.deleteSession(sid);
    deleteCookie(c, "gs", { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => {
    const codex = db.codex(me(c).id);
    const agent = db.agent(me(c).id);
    return c.json({
      agent: agent?.agent ?? "codex",
      openrouter: { connected: !!agent?.openrouter, label: agent?.openrouter_label ?? null, model: agent?.openrouter_model ?? null },
      keyAgents: KEY_AGENTS.map((a) => ({ ...KEY_AGENT_INFO[a], ...(agent?.[a] ?? { connected: false, label: null, model: null, login: null }) })),
      codex: {
        state: codex?.codex_state ?? "none",
        account: codex?.codex_account ?? null,
        model: codex?.codex_model ?? null,
        models: CODEX_MODELS,
        login: codex?.codex_login ? JSON.parse(codex.codex_login) : null,
      },
    });
  });

  app.get("/api/settings/mail", (c) => {
    const u = db.user(me(c).id) as User;
    const rules = alertRules(db, u.id);
    return c.json({
      sends: !!d.mailer?.sends,
      email: u.email ?? null,
      source: u.email_source ?? null,
      pending: u.email_pending ?? null,
      maxAfter: ALERT_MAX_AFTER,
      kinds: ALERT_KINDS.map((k) => ({ id: k.id, label: k.label, description: k.description, defaultAfter: k.after, ...rules.find((r) => r.id === k.id) })),
    });
  });

  // An address the user types counts only once they open the link mailed to it.
  app.post("/api/settings/email", async (c) => {
    if (!d.mailer?.sends) throw new HttpError(409, "this instance sends no mail");
    const { email } = await c.req.json<{ email?: unknown }>();
    const address = String(email ?? "").trim();
    if (!validEmail(address)) throw new HttpError(400, "that is not an email address");
    const u = db.user(me(c).id) as User;
    if (u.email?.toLowerCase() === address.toLowerCase()) {
      db.setPendingEmail(u.id, null);
      return c.json({ ok: true, confirmed: true });
    }
    db.setPendingEmail(u.id, address);
    await d.mailer.send(confirmMail(config.baseUrl, config.sessionSecret, u, address)).catch((err: Error) => {
      throw new HttpError(409, `the confirmation mail could not be sent: ${err.message.slice(0, 200)}`);
    });
    return c.json({ ok: true, confirmed: false });
  });

  app.post("/api/settings/email/cancel", (c) => {
    db.setPendingEmail(me(c).id, null);
    return c.json({ ok: true });
  });

  app.post("/api/settings/alerts", async (c) => {
    const { id, on, after } = await c.req.json<{ id?: unknown; on?: unknown; after?: unknown }>();
    if (!ALERT_KINDS.some((k) => k.id === id)) throw new HttpError(400, "unknown kind of mail");
    if (typeof on !== "boolean") throw new HttpError(400, "on: true or false");
    if (typeof after !== "number" || !Number.isInteger(after) || after < 1 || after > ALERT_MAX_AFTER) throw new HttpError(400, `after: a whole number from 1 to ${ALERT_MAX_AFTER}`);
    db.setAlertRule(me(c).id, { category: String(id), on: on ? 1 : 0, after });
    return c.json({ ok: true });
  });

  // The link in the confirmation mail. It carries its own proof, so it works in another browser too.
  app.get("/email/confirm", (c) => {
    const t = readConfirmToken(config.sessionSecret, c.req.query("t") ?? "");
    if (!t || !db.confirmEmail(t.userId, t.email)) return c.redirect("/settings?email=stale#mail");
    return c.redirect("/settings?email=confirmed#mail");
  });

  // The server module's cards. A module that fails costs only its own cards, not the page.
  app.get("/api/settings/sections", async (c) => {
    // Per-user plan and usage: never from a cache.
    c.header("Cache-Control", "no-store");
    const m = d.module;
    if (!m?.settings) return c.json({ sections: [] });
    try {
      return c.json({ sections: await m.settings({ id: me(c).id, login: me(c).login }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: "error", at: `${m.name} settings`, message }));
      return c.json({ sections: [], error: `${m.name} could not load: ${message}` });
    }
  });

  app.post("/api/settings/codex/login", (c) => {
    if (!orchestratorPresent(db)) throw new HttpError(409, "the orchestrator is not running, and Codex sign-in needs it; try again in a minute");
    // The orchestrator runs the sign-in for every pending user; one already waiting keeps its sign-in.
    if (db.codex(me(c).id)?.codex_state !== "pending") db.setCodex(me(c).id, { codex_state: "pending", codex_login: null });
    return c.json({ ok: true });
  });

  app.post("/api/settings/codex/logout", (c) => {
    db.setCodex(me(c).id, { codex_state: "none", codex_login: null, codex_auth: null, codex_account: null });
    return c.json({ ok: true });
  });

  app.post("/api/settings/codex/model", async (c) => {
    const body = await c.req.json<{ model?: unknown }>();
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (model && !MODEL_RE.test(model)) throw new HttpError(400, MODEL_HINT);
    db.setCodex(me(c).id, { codex_model: model || null });
    return c.json({ ok: true, model: model || null });
  });

  // Which provider runs the agent of the user's projects. Both stay connected; switching back is one click.
  app.post("/api/settings/agent", async (c) => {
    const body = await c.req.json<{ agent?: unknown }>();
    const agent = AGENT_PROVIDERS.find((p) => p === body.agent);
    if (!agent) throw new HttpError(400, `agent: ${AGENT_PROVIDERS.join(", ")}`);
    db.setAgent(me(c).id, { agent });
    db.autoSetup(me(c).id);
    return c.json({ ok: true });
  });

  // The user's own OpenRouter key: checked with OpenRouter once, then kept sealed like a Codex sign-in.
  app.post("/api/settings/openrouter/key", async (c) => {
    const body = await c.req.json<{ key?: unknown }>();
    const apiKey = typeof body.key === "string" ? body.key.trim() : "";
    if (!/^sk-or-[A-Za-z0-9_-]{10,200}$/.test(apiKey)) throw new HttpError(400, "key: an OpenRouter API key starts with sk-or-");
    let label: string;
    try {
      ({ label } = await checkKey(apiKey, f));
    } catch (err) {
      if (err instanceof OpenRouterError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    db.setAgent(me(c).id, { openrouter_key: seal(config.sessionSecret, apiKey), openrouter_label: label });
    db.autoSetup(me(c).id);
    return c.json({ ok: true, label });
  });

  app.post("/api/settings/openrouter/logout", (c) => {
    db.setAgent(me(c).id, { openrouter_key: null, openrouter_label: null });
    return c.json({ ok: true });
  });

  app.get("/api/settings/openrouter/models", async (c) => {
    try {
      // A short list to pick from; the field takes any other OpenRouter id.
      return c.json({ models: suggestModels(await openRouterModels()) });
    } catch (err) {
      if (err instanceof OpenRouterError) return c.json({ error: err.message, models: [] }, err.status);
      throw err;
    }
  });

  app.post("/api/settings/openrouter/model", async (c) => {
    const body = await c.req.json<{ model?: unknown }>();
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (model && !OPENROUTER_MODEL_RE.test(model)) throw new HttpError(400, "model: an OpenRouter model id like vendor/model");
    // The context size lets Codex compact before the model's limit; unknown when OpenRouter does not answer.
    const context = model ? ((await openRouterModels().catch(() => [])).find((m) => m.id === model)?.context ?? null) : null;
    db.setAgent(me(c).id, { openrouter_model: model || null, openrouter_context: context });
    db.autoSetup(me(c).id);
    return c.json({ ok: true, model: model || null });
  });

  // Claude Code, Copilot and Grok: the user's own key, checked with its provider once, then kept sealed.
  app.post("/api/settings/agents/:agent/key", async (c) => {
    const agent = c.req.param("agent");
    if (!isKeyAgent(agent)) throw new HttpError(404, "no such agent");
    const body = await c.req.json<{ key?: unknown }>();
    let checked: { key: string; label: string };
    try {
      checked = await checkAgentKey(agent, typeof body.key === "string" ? body.key : "", f);
    } catch (err) {
      if (err instanceof AgentKeyError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    // A pasted key ends a sign-in still waiting for its code, so that sign-in cannot replace it later.
    const signIn = (SIGN_IN_AGENTS as readonly string[]).includes(agent) ? { login_state: null, login: null } : {};
    db.setKeyAgent(me(c).id, agent, { key: seal(config.sessionSecret, checked.key), label: checked.label, ...signIn });
    db.autoSetup(me(c).id);
    return c.json({ ok: true, label: checked.label });
  });

  app.post("/api/settings/agents/:agent/logout", (c) => {
    const agent = c.req.param("agent");
    if (!isKeyAgent(agent)) throw new HttpError(404, "no such agent");
    // Only Copilot and Grok have sign-in columns; Grok's sign-in itself goes too.
    const signIn = (SIGN_IN_AGENTS as readonly string[]).includes(agent) ? { login_state: null, login: null } : {};
    db.setKeyAgent(me(c).id, agent, { key: null, label: null, ...signIn, ...(agent === "grok" ? { auth: null } : {}) });
    return c.json({ ok: true });
  });

  // Copilot and Grok sign in with a device code: the orchestrator runs `copilot login` or `grok login` in a
  // short-lived sandbox for every pending user and shows the code here, as for Codex.
  app.post("/api/settings/agents/:agent/login", (c) => {
    const agent = c.req.param("agent");
    if (!isKeyAgent(agent) || !KEY_AGENT_INFO[agent].signIn) throw new HttpError(404, "no sign-in for this agent");
    if (!orchestratorPresent(db)) throw new HttpError(409, "the orchestrator is not running, and the sign-in needs it; try again in a minute");
    if (db.agent(me(c).id)?.[agent].login?.state !== "pending") db.setKeyAgent(me(c).id, agent, { login_state: "pending", login: null });
    return c.json({ ok: true });
  });

  app.post("/api/settings/agents/:agent/model", async (c) => {
    const agent = c.req.param("agent");
    if (!isKeyAgent(agent)) throw new HttpError(404, "no such agent");
    const body = await c.req.json<{ model?: unknown }>();
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (model && !AGENT_MODEL_RE.test(model)) throw new HttpError(400, "model: a model id such as claude-sonnet-5-5");
    db.setKeyAgent(me(c).id, agent, { model: model || null });
    return c.json({ ok: true, model: model || null });
  });

  // Sandboxes: what runs now, how many jobs may run at once, and the sandbox time (the billing basis).
  // The most a user may choose: the host's number, lowered by the server module's cap (e.g. a plan's).
  const ceiling = (u: User) => {
    const host = hostSize(u.login);
    const cap = capFor(d.module, { id: u.id, login: u.login });
    const most = [host, cap?.jobs].filter((n): n is number => typeof n === "number");
    return { host, cap, most: most.length ? Math.min(...most) : null };
  };

  app.get("/api/boxes", (c) => {
    const u = me(c);
    const { host, cap, most } = ceiling(u);
    const own = db.maxJobs(u.id);
    const limit = own === null ? most : most === null ? own : Math.min(own, most);
    const waiting = db.queuedJobs(u.id);
    const noProvider = orchestratorPresent(db) && unservedBy(orchestratorState(db), u.login);
    return c.json({ host, cap, limit, own, noProvider, running: db.runningBoxes(u.id), queued: waiting.sandbox, waitingForChecks: waiting.checks, time: db.boxTime(u.id) });
  });

  app.post("/api/boxes/limit", async (c) => {
    const { limit } = await c.req.json<{ limit?: unknown }>();
    const top = ceiling(me(c)).most ?? 999;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > top) throw new HttpError(400, `limit: a whole number from 1 to ${top}`);
    db.setMaxJobs(me(c).id, limit);
    return c.json({ ok: true });
  });

  app.get("/api/tokens", (c) => c.json({ tokens: db.tokens(me(c).id), mcpUrl: `${config.baseUrl}/mcp` }));

  app.post("/api/tokens", async (c) => {
    const { name } = await c.req.json<{ name?: string }>();
    const label = String(name ?? "").trim().slice(0, 60) || "agent";
    if (db.personalTokens(me(c).id) >= 20) throw new HttpError(409, "at most 20 tokens; revoke one first");
    return c.json(db.createToken(me(c).id, label));
  });

  app.post("/api/tokens/:tid/revoke", (c) => {
    db.deleteToken(me(c).id, Number(c.req.param("tid")));
    return c.json({ ok: true });
  });

  app.get("/api/projects", (c) => {
    const projects = db.projects(me(c).id).map((p) => {
      const last = db.runs(p.id, 1)[0];
      return { id: p.id, repo: p.repo, default_branch: p.default_branch, setup: p.setup, active: p.active, ...(last ? { last } : {}) };
    });
    return c.json({ projects });
  });

  // Repositories come from what GitHub reported for this user at sign-in; installing the app on more
  // repositories sends the user through sign-in again (the app's setup URL), which refreshes the list.
  app.get("/api/repos", (c) => {
    const groups = new Map<number, { account: string; installation: number; repos: { id: number; full_name: string; private: boolean; project: number | null }[] }>();
    for (const r of db.repos(me(c).id)) {
      const g = groups.get(r.installation_id) ?? { account: r.account, installation: r.installation_id, repos: [] };
      g.repos.push({ id: r.repo_id, full_name: r.full_name, private: !!r.private, project: db.projectByRepoId(r.repo_id)?.id ?? null });
      groups.set(r.installation_id, g);
    }
    return c.json({ groups: [...groups.values()] });
  });

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<{ installation: number; repo: number }>();
    const repo = db.repos(me(c).id).find((r) => r.repo_id === body.repo && r.installation_id === body.installation);
    if (!repo) throw new HttpError(404, "you have no access to that repository through the app");
    const existing = db.projectByRepoId(repo.repo_id);
    const id = existing?.id ?? db.createProject({ owner_id: me(c).id, installation_id: repo.installation_id, repo: repo.full_name, repo_id: repo.repo_id, default_branch: repo.default_branch });
    if (!existing) db.autoSetup(me(c).id);
    return c.json({ id });
  });

  app.get("/api/projects/:id", (c) => {
    const p = project(c);
    const { codex_login: _unused, codex: _old, ...rest } = p;
    const owner = db.codex(p.owner_id);
    const agent = db.agent(p.owner_id);
    const ciWait = db.runsWaitingForChecks(p.id);
    return c.json({
      ...rest,
      codex: owner?.codex_state ?? "none",
      codex_account: owner?.codex_account ?? null,
      codex_model: owner?.codex_model ?? null,
      agent: agent?.agent ?? "codex",
      agent_ready: agent?.ready ?? false,
      openrouter_model: agent?.openrouter_model ?? null,
      /** The model of Claude Code, Copilot or Grok when the owner runs one of them; null: the CLI's default. */
      agent_model: agent && isKeyAgent(agent.agent) ? agent[agent.agent].model : null,
      own: p.owner_id === me(c).id,
      default_checks: DEFAULT_CHECKS,
      viewports: viewportsOf(p.viewports).map((v) => v.id),
      viewport_presets: VIEWPORTS,
      platform: p.platform === "macos" ? "macos" : "linux",
      /** The instance runs macOS sandboxes (the orchestrator says so); without them a macOS project's jobs wait. */
      macos_available: servesMacos(orchestratorState(db)),
      proof: existsSync(join(config.dataDir, "projects", String(p.id), "setup-proof.png")),
      runs: db.runs(p.id).map((r) => ({ ...r, waitingForChecks: ciWait.has(r.id) })),
      closed: db.closedPrs(p.id),
      jobs: db.jobs(p.id, 30).map((j) => ({ ...j, log: j.kind === "run" ? "" : j.log })),
    });
  });

  app.get("/api/projects/:id/setup-proof.png", (c) => sendFile(c, join(config.dataDir, "projects", String(project(c).id), "setup-proof.png"), "private, max-age=60"));

  app.post("/api/projects/:id/suggest", (c) => {
    const p = project(c);
    if (!db.agentReady(p.owner_id)) throw new HttpError(409, "connect Codex or OpenRouter in Settings first");
    if (!db.jobs(p.id).some((j) => j.kind === "suggest" && (j.status === "queued" || j.status === "running"))) db.enqueue(p.id, "suggest");
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/suggestion/dismiss", (c) => {
    db.updateProject(project(c).id, { suggestion: null });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/criteria", async (c) => {
    const p = project(c);
    const body = await c.req.json<{ criteria?: string; model?: string }>();
    const model = String(body.model ?? "").trim();
    if (model && !MODEL_RE.test(model)) throw new HttpError(400, MODEL_HINT);
    db.updateProject(p.id, { criteria: String(body.criteria ?? "").slice(0, 8000), model: model || null, suggestion: null });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/viewports", async (c) => {
    const p = project(c);
    const body = await c.req.json<{ viewports?: unknown }>();
    if (!Array.isArray(body.viewports)) throw new HttpError(400, "viewports: a list of screen sizes");
    const unknown = body.viewports.filter((id) => !VIEWPORTS.some((v) => v.id === id));
    if (unknown.length) throw new HttpError(400, `viewports: unknown size ${unknown.map(String).join(", ")}`);
    db.updateProject(p.id, { viewports: viewportsOf(body.viewports.join(",")).map((v) => v.id).join(",") });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/platform", async (c) => {
    const p = project(c);
    const body = await c.req.json<{ platform?: unknown }>();
    const platform = body.platform;
    if (platform !== "linux" && platform !== "macos") throw new HttpError(400, "platform: linux or macos");
    if (platform === p.platform) return c.json({ ok: true });
    // The recipe was written for the other platform: the next setup starts over in a sandbox of the new one.
    if (!db.switchPlatform(p.id, platform)) throw new HttpError(409, "wait until the project's jobs have ended, then switch");
    rmSync(join(config.dataDir, "projects", String(p.id), "setup-proof.png"), { force: true });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/setup", (c) => {
    const p = project(c);
    if (!db.agentReady(p.owner_id)) throw new HttpError(409, "connect Codex or OpenRouter in Settings first");
    if (p.setup !== "running" && p.setup !== "queued") {
      db.updateProject(p.id, { setup: "queued", setup_error: null });
      db.enqueue(p.id, "setup");
    }
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/active", async (c) => {
    const p = project(c);
    const { active } = await c.req.json<{ active: boolean }>();
    if (active && p.setup !== "ready") throw new HttpError(409, "prepare the environment first");
    db.updateProject(p.id, { active: active ? 1 : 0 });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/gate", async (c) => {
    const p = project(c);
    const { gate } = await c.req.json<{ gate: boolean }>();
    db.updateProject(p.id, { gate: gate ? 1 : 0 });
    if (!gate) void releaseAll({ db, github: d.github, baseUrl: config.baseUrl }, { ...p, gate: 0 });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/runs", async (c) => {
    const p = project(c);
    if (p.setup !== "ready") throw new HttpError(409, "prepare the environment first");
    const { pr } = await c.req.json<{ pr: number }>();
    if (!Number.isInteger(pr) || pr < 1) throw new HttpError(400, "pr must be a pull request number");
    const runId = await queueRun(d, p, await d.github().pull(p.installation_id, p.repo, pr));
    return c.json({ runId });
  });

  app.get("/api/runs/:id", (c) => {
    const run = db.run_(Number(c.req.param("id")));
    if (!run) throw new HttpError(404, "run not found");
    const p = project(c, String(run.project_id));
    const job = db.jobs(p.id, 500).find((j) => j.run_id === run.id);
    return c.json({ ...run, project: { id: p.id, repo: p.repo }, verdict: run.verdict ? JSON.parse(run.verdict) : null, files: JSON.parse(run.files), progress: parseProgress(run.progress), log: job?.log ?? "", waitingForChecks: run.status === "queued" && !!job?.not_before });
  });

  app.post("/api/runs/:id/rerun", async (c) => {
    const run = db.run_(Number(c.req.param("id")));
    if (!run) throw new HttpError(404, "run not found");
    const p = project(c, String(run.project_id));
    const runId = await queueRun(d, p, await d.github().pull(p.installation_id, p.repo, run.pr));
    return c.json({ runId });
  });

  const signedIn = (c: Context<Env>, userId: number) => {
    const sid = randomBytes(32).toString("hex");
    db.createSession(sid, userId, SESSION_DAYS);
    setCookie(c, "gs", sid, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.redirect(landingAfterSignIn(c, db, userId));
  };

  // GitHub sign-in.
  // `?link=1`: the "Connect GitHub" step after another sign-in; only such a sign-in links it, and only
  // the pending sign-in it started for.
  app.get("/auth/github", (c) => {
    const state = randomBytes(16).toString("hex");
    const tag = c.req.query("link") ? linkTag(c, config) : null;
    setCookie(c, "gs_oauth", tag ? `${state}.${tag}` : state, { httpOnly: true, secure, sameSite: "Lax", path: "/auth", maxAge: 600 });
    return c.redirect(d.github().authorizeUrl(`${config.baseUrl}/auth/github/callback`, state));
  });
  app.get("/auth/github/callback", async (c) => {
    const [state, tag] = (getCookie(c, "gs_oauth") ?? "").split(".");
    if (!state || c.req.query("state") !== state) return c.redirect("/auth/github");
    deleteCookie(c, "gs_oauth", { path: "/auth" });
    const gh = d.github();
    const token = await gh.exchangeCode(c.req.query("code") ?? "", `${config.baseUrl}/auth/github/callback`);
    const u = await gh.user(token.access);
    if (!allowed(u.login)) return c.redirect("/?closed=1");
    const user = db.upsertUser({ github_id: u.id, login: u.login, name: u.name, avatar: u.avatar_url });
    const email = await gh.verifiedEmail(token.access, u.email);
    if (email) db.offerEmail(user.id, email, "github");
    await syncRepos(db, gh, token.access, user.id);
    afterGithub(c, { config, db, methods }, user.id, token, tag);
    return signedIn(c, user.id);
  });
  // Other ways to sign in, from the server module.
  mountSignIn(app, { config, db, github: d.github, githubReady: d.githubReady, methods, allowed, signedIn });

  // GitHub App creation for this instance (manifest flow), guarded by ADMIN_TOKEN.
  app.get("/setup", (c) => {
    if (!config.adminToken || c.req.query("token") !== config.adminToken) return c.text("Not found", 404);
    const ready = githubApp(config, db);
    if (ready) return c.html(html`<!doctype html><meta charset="utf-8"><title>gespann setup</title><p>GitHub App <a href="https://github.com/apps/${ready.slug}">${ready.slug}</a> is connected. <a href="/">Open gespann</a></p>`);
    const state = randomBytes(16).toString("hex");
    db.setSetting("setup_state", JSON.stringify({ state, expires: Date.now() + 3600_000 }));
    const org = c.req.query("org");
    const action = `https://github.com/${org ? `organizations/${encodeURIComponent(org)}/settings/apps/new` : "settings/apps/new"}?state=${state}`;
    const manifest = JSON.stringify(appManifest(config.baseUrl, c.req.query("name") ?? "gespann"));
    return c.html(
      html`<!doctype html><meta charset="utf-8"><title>gespann setup</title><body style="font:14px system-ui;background:#0a0a0a;color:#ededed;padding:40px"><h1>Create the GitHub App</h1><p>GitHub asks you to confirm, then sends you back here.</p><form method="post" action="${action}"><input type="hidden" name="manifest" value="${manifest}"><button type="submit">Create GitHub App</button></form></body>`,
    );
  });
  app.get("/setup/github/created", async (c) => {
    if (githubApp(config, db)) return c.text("This instance already has a GitHub App.", 409);
    const saved = JSON.parse(db.setting("setup_state") ?? "null") as { state: string; expires: number } | null;
    if (!saved || saved.expires < Date.now() || c.req.query("state") !== saved.state) return c.text("This link expired. Start again at /setup.", 400);
    db.setSetting("setup_state", "null");
    const r = await convertManifest(c.req.query("code") ?? "");
    db.setSetting("github_app", JSON.stringify({ appId: String(r.id), slug: r.slug, privateKey: r.pem, webhookSecret: r.webhook_secret, clientId: r.client_id, clientSecret: r.client_secret }));
    return c.redirect(`https://github.com/apps/${r.slug}/installations/new`);
  });

  // Screenshots and recordings: public behind an unguessable token, so PR comments can embed them.
  app.get("/proof/:token{[0-9a-f]{32}}/:file{[A-Za-z0-9._-]+}", (c) => {
    const run = db.runByToken(c.req.param("token"));
    const file = c.req.param("file");
    if (!run || !(JSON.parse(run.files) as string[]).includes(file)) return c.text("Not found", 404);
    return sendFile(c, join(config.dataDir, "runs", String(run.id), file), "private, max-age=3600");
  });

  app.post("/github/webhook", async (c) => {
    const gapp = githubApp(config, db);
    if (!gapp) return c.text("not configured", 503);
    const body = await c.req.text();
    if (!verifySignature(gapp.webhookSecret, body, c.req.header("x-hub-signature-256"))) return c.text("bad signature", 401);
    const event = c.req.header("x-github-event");
    const handler = event === "pull_request" ? onPullRequest : event === "issue_comment" ? onIssueComment : null;
    if (handler) void handler(d, JSON.parse(body) as Record<string, unknown>).catch((err: Error) => console.error(JSON.stringify({ level: "error", at: `webhook ${event}`, message: err.message })));
    return c.json({ ok: true }, 202);
  });

  // The server module's pages come before the React app, so its paths are not client routes.
  d.module?.routes?.(app, {
    user: (c) => {
      const u = (c as Context<Env>).get("user");
      return u ? { id: u.id, login: u.login } : null;
    },
  });

  // The React app: static assets, and index.html for every other GET so client routes work on reload.
  app.get("*", (c) => {
    if (!WEB) return c.text("The web app is not built. Run npm run build.", 503);
    const rel = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "");
    const file = join(WEB, rel);
    if (rel !== "/" && file.startsWith(WEB) && existsSync(file) && extname(file)) return sendFile(c, file, rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
    return sendFile(c, join(WEB, "index.html"), "no-cache");
  });

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(JSON.stringify({ level: "error", path: c.req.path, message: err.message }));
    return c.json({ error: err.message }, status);
  });
  return app;
}

const logError = (at: string, err: Error) => console.error(JSON.stringify({ level: "error", at, message: err.message }));

async function queueRun(d: AppDeps, p: Project, pr: PullRequest): Promise<number> {
  // PR code runs in the project's sandbox next to the Codex sign-in: only branches of the repo itself, never forks.
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) throw new HttpError(409, "pull requests from forks are not tested");
  // All database changes happen before the first await, so a newer push cannot interleave.
  // A start for the head that is already queued or running joins that run: one test per head.
  const live = d.db.liveRunForHead(p.id, pr.number, pr.head.sha);
  if (live) return live.id;
  const superseded = d.db.supersedeRuns(p.id, pr.number);
  const token = randomBytes(16).toString("hex");
  const runId = d.db.createRun({ project_id: p.id, pr: pr.number, title: pr.title.slice(0, 300), head: pr.head.sha, base: pr.base.sha, base_ref: pr.base.ref, token });
  for (const old of superseded) {
    if (old.check_run_id) await d.github().updateCheck(p.installation_id, p.repo, old.check_run_id, { status: "completed", conclusion: "cancelled", title: "Superseded by a newer push", summary: "A newer commit is tested instead." }).catch((err: Error) => logError("cancel-check", err));
  }
  const check = await d.github().createCheck(p.installation_id, p.repo, pr.head.sha, `${d.config.baseUrl}/runs/${runId}`).catch((err: Error) => {
    logError("create-check", err);
    return null;
  });
  if (check) d.db.updateRun(runId, { check_run_id: check });
  // A head a person already approved keeps a neutral check; the test still runs and may turn it green.
  const approvedBy = d.db.hold(p.id, pr.number)?.approved_head === pr.head.sha ? d.db.hold(p.id, pr.number)?.approved_by : null;
  if (check && approvedBy) await d.github().updateCheck(p.installation_id, p.repo, check, approvedCheck(approvedBy)).catch((err: Error) => logError("approved-check", err));
  if (d.db.run_(runId)?.status === "cancelled") {
    // A newer push arrived while the check was created.
    if (check) await d.github().updateCheck(p.installation_id, p.repo, check, { status: "completed", conclusion: "cancelled", title: "Superseded by a newer push", summary: "A newer commit is tested instead." }).catch((err: Error) => logError("cancel-check", err));
    return runId;
  }
  d.db.enqueue(p.id, "run", runId);
  return runId;
}

const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"]);

interface Sender {
  login: string;
  type: string;
}

async function onPullRequest(d: AppDeps, payload: Record<string, unknown>): Promise<void> {
  const action = String(payload.action);
  const event = payload.pull_request as PullRequest;
  const repo = payload.repository as { id: number };
  const sender = payload.sender as Sender | undefined;
  if ((action === "closed" || action === "reopened") && event) {
    // Merged or closed: what still waits in the queue for this PR is skipped, not tested, and the
    // PR leaves the open sections of the Runs page. Reopened: it comes back.
    const p = d.db.projectByRepoId(repo.id);
    // A late event for a PR reopened since must not cancel its new run: act on the PR as it is now.
    if (p)
      await withPrLock(p, event.number, async () => {
        const pr = await d.github().pull(p.installation_id, p.repo, event.number);
        recordPrState(d.db, p.id, pr);
        if (pr.state !== "open") await skipClosedRuns(d, p, pr);
      });
    if (action === "closed") return;
  }
  if (!ACTIONS.has(action) || !event || event.state !== "open") return;
  if (event.head.repo?.full_name !== event.base.repo.full_name) return;
  const p = d.db.projectByRepoId(repo.id);
  if (!p || !p.active || p.setup !== "ready" || !p.recipe) return;
  const trigger = parseRecipe(p.recipe).trigger;
  const label = (payload.label as { name?: string } | undefined)?.name;
  if ((action === "labeled" || action === "unlabeled") && label !== trigger.label && label !== GATE_LABEL) return;
  const deps = { db: d.db, github: d.github, baseUrl: d.config.baseUrl };
  await withPrLock(p, event.number, async () => {
    // Events arrive out of order: act on the PR as it is now, not on the event's snapshot.
    const pr = await d.github().pull(p.installation_id, p.repo, event.number);
    if (pr.state !== "open") return;
    const hold = d.db.hold(p.id, pr.number);
    // A person clicking "Ready for review" on a PR the gate holds releases that head. A late click
    // for an older head releases nothing: the event's head must still be the PR's head.
    if (action === "ready_for_review" && hold?.held && gated(p, pr) && sender && sender.type !== "Bot" && !pr.draft && event.head.sha === pr.head.sha) {
      await approve(deps, p, pr, sender.login);
      return;
    }
    // The label came off: release a held PR and say so, before any trigger logic can fail.
    if (action === "unlabeled" && label === GATE_LABEL && !gated(p, pr)) {
      if (hold?.held) {
        await applyGate(deps, p, pr);
        await refreshComment(deps, p, pr);
      }
      return;
    }
    // Drafts are not tested, except the ones the gate holds: those wait for exactly this test.
    if (pr.draft && !hold?.held) return;
    // A hold GitHub refuses (e.g. the app lacks a permission) must not stop the test itself.
    const holdPr = () => applyGate(deps, p, pr).catch((err: Error) => logError("gate", err));
    if (gated(p, pr)) {
      // Held first, before anything else can take time; the label alone starts a run.
      await holdPr();
    } else {
      const changed = await d.github().changedFiles(p.installation_id, p.repo, pr.number);
      if (!triggered(trigger, { base: pr.base.ref, labels: pr.labels.map((l) => l.name), changed }).run) {
        return;
      }
    }
    const known = d.db.runForHead(p.id, pr.number, pr.head.sha);
    if (!known || known.status === "failed") await queueRun(d, p, pr);
    await holdPr();
  });
}

async function onIssueComment(d: AppDeps, payload: Record<string, unknown>): Promise<void> {
  const issue = payload.issue as { number: number; pull_request?: unknown } | undefined;
  const comment = payload.comment as { body?: string; author_association?: string } | undefined;
  const sender = payload.sender as Sender | undefined;
  const repo = payload.repository as { id: number };
  if (payload.action !== "created" || !issue?.pull_request || !comment || !sender || sender.type === "Bot") return;
  if (!APPROVE.test(comment.body ?? "") || !MAY_APPROVE.has(comment.author_association ?? "")) return;
  const p = d.db.projectByRepoId(repo.id);
  if (!p) return;
  await withPrLock(p, issue.number, async () => {
    const pr = await d.github().pull(p.installation_id, p.repo, issue.number);
    // Any open PR: the approval ends its gespann check, so a required check lets it merge.
    if (pr.state !== "open") return;
    await approve({ db: d.db, github: d.github, baseUrl: d.config.baseUrl }, p, pr, sender.login);
  });
}
