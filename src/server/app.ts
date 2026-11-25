import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { triggered } from "../verify/plan.ts";
import { DEFAULT_CHECKS } from "../verify/prompt.ts";
import { parseRecipe } from "../verify/recipe.ts";
import type { Config, GithubApp } from "./config.ts";
import type { Db, Project, User } from "./db.ts";
import { APPROVE, applyGate, approve, GATE_LABEL, gated, MAY_APPROVE, refreshComment, releaseAll, skipClosedRuns, withPrLock } from "./gate.ts";
import { appManifest, convertManifest, Github, type PullRequest, verifySignature } from "./github.ts";
import { mcpRespond, type Viewer } from "./mcp.ts";
import { afterSignIn, mountOAuth } from "./oauth.ts";

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
  /** Starts the Codex device sign-in for a user (absent when the instance has no sandbox provider). */
  startCodexLogin?: (userId: number) => void;
  /** Throws when the instance has no GitHub App yet. */
  github: () => Github;
  githubReady: () => boolean;
  /** How many jobs the sandbox host runs at once, for all users together; absent without sandboxes. */
  parallel?: number;
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

  // Read-only MCP endpoint for coding agents (Streamable HTTP, stateless). An agent's OAuth sign-in or
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
    const out = mcpRespond(body, viewer, { db, dataDir: config.dataDir, baseUrl: config.baseUrl });
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
    return c.json({ user: u ? { login: u.login, avatar: u.avatar } : null, githubReady: d.githubReady(), installUrl });
  });

  app.post("/api/logout", (c) => {
    const sid = c.get("session");
    if (sid) db.deleteSession(sid);
    deleteCookie(c, "gs", { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/settings", (c) => {
    const codex = db.codex(me(c).id);
    return c.json({ codex: { state: codex?.codex_state ?? "none", account: codex?.codex_account ?? null, login: codex?.codex_login ? JSON.parse(codex.codex_login) : null } });
  });

  app.post("/api/settings/codex/login", (c) => {
    if (!d.startCodexLogin) throw new HttpError(409, "this instance has no sandbox provider configured");
    d.startCodexLogin(me(c).id);
    return c.json({ ok: true });
  });

  app.post("/api/settings/codex/logout", (c) => {
    db.setCodex(me(c).id, { codex_state: "none", codex_login: null, codex_auth: null, codex_account: null });
    return c.json({ ok: true });
  });

  // Sandboxes: what runs now, how many jobs may run at once, and the sandbox time (the billing basis).
  app.get("/api/boxes", (c) => {
    const u = me(c).id;
    const host = d.parallel ?? null;
    const own = db.maxJobs(u);
    return c.json({ host, limit: own === null ? host : host === null ? own : Math.min(own, host), own, running: db.runningBoxes(u), queued: db.queuedJobs(u), time: db.boxTime(u) });
  });

  app.post("/api/boxes/limit", async (c) => {
    const { limit } = await c.req.json<{ limit?: unknown }>();
    const host = d.parallel ?? null;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > (host ?? 999)) throw new HttpError(400, `limit: a whole number from 1 to ${host ?? 999}`);
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
    return c.json({
      ...rest,
      codex: owner?.codex_state ?? "none",
      codex_account: owner?.codex_account ?? null,
      own: p.owner_id === me(c).id,
      default_checks: DEFAULT_CHECKS,
      proof: existsSync(join(config.dataDir, "projects", String(p.id), "setup-proof.png")),
      runs: db.runs(p.id),
      jobs: db.jobs(p.id, 30).map((j) => ({ ...j, log: j.kind === "run" ? "" : j.log })),
    });
  });

  app.get("/api/projects/:id/setup-proof.png", (c) => sendFile(c, join(config.dataDir, "projects", String(project(c).id), "setup-proof.png"), "private, max-age=60"));

  app.post("/api/projects/:id/suggest", (c) => {
    const p = project(c);
    if (db.codex(p.owner_id)?.codex_state !== "connected") throw new HttpError(409, "connect Codex in Settings first");
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
    if (model && !/^[A-Za-z0-9._:-]{1,80}$/.test(model)) throw new HttpError(400, "model: letters, digits, . _ : - only");
    db.updateProject(p.id, { criteria: String(body.criteria ?? "").slice(0, 8000), model: model || null, suggestion: null });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/setup", (c) => {
    const p = project(c);
    if (db.codex(p.owner_id)?.codex_state !== "connected") throw new HttpError(409, "connect Codex in Settings first");
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
    return c.json({ ...run, project: { id: p.id, repo: p.repo }, verdict: run.verdict ? JSON.parse(run.verdict) : null, files: JSON.parse(run.files), log: job?.log ?? "" });
  });

  app.post("/api/runs/:id/rerun", async (c) => {
    const run = db.run_(Number(c.req.param("id")));
    if (!run) throw new HttpError(404, "run not found");
    const p = project(c, String(run.project_id));
    const runId = await queueRun(d, p, await d.github().pull(p.installation_id, p.repo, run.pr));
    return c.json({ runId });
  });

  // GitHub sign-in.
  app.get("/auth/github", (c) => {
    const state = randomBytes(16).toString("hex");
    setCookie(c, "gs_oauth", state, { httpOnly: true, secure, sameSite: "Lax", path: "/auth", maxAge: 600 });
    return c.redirect(d.github().authorizeUrl(`${config.baseUrl}/auth/github/callback`, state));
  });
  app.get("/auth/github/callback", async (c) => {
    const state = getCookie(c, "gs_oauth");
    if (!state || c.req.query("state") !== state) return c.redirect("/auth/github");
    deleteCookie(c, "gs_oauth", { path: "/auth" });
    const gh = d.github();
    const token = await gh.exchangeCode(c.req.query("code") ?? "", `${config.baseUrl}/auth/github/callback`);
    const u = await gh.user(token);
    if (!allowed(u.login)) return c.redirect("/?closed=1");
    const user = db.upsertUser({ github_id: u.id, login: u.login, name: u.name, avatar: u.avatar_url });
    const repos = [];
    for (const i of await gh.userInstallations(token)) {
      for (const r of await gh.userRepos(token, i.id)) repos.push({ repo_id: r.id, installation_id: i.id, account: i.account, full_name: r.full_name, private: r.private, default_branch: r.default_branch });
    }
    db.setRepos(user.id, repos);
    const sid = randomBytes(32).toString("hex");
    db.createSession(sid, user.id, SESSION_DAYS);
    setCookie(c, "gs", sid, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: 7 * 86400 });
    return c.redirect(afterSignIn(c) ?? (db.projects(user.id).length ? "/projects" : "/projects/new"));
  });

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
  const superseded = d.db.cancelQueuedRuns(p.id, pr.number);
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
  if (action === "closed" && event) {
    // Merged or closed: what still waits in the queue for this PR is skipped, not tested.
    const p = d.db.projectByRepoId(repo.id);
    // A late event for a PR reopened since must not cancel its new run: act on the PR as it is now.
    if (p)
      await withPrLock(p, event.number, async () => {
        const pr = await d.github().pull(p.installation_id, p.repo, event.number);
        if (pr.state !== "open") await skipClosedRuns(d, p, pr);
      });
    return;
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
    // Only a PR the gate applies to: labeled, and not a draft its author made.
    if (pr.state !== "open" || !gated(p, pr) || (pr.draft && !d.db.hold(p.id, pr.number)?.held)) return;
    await approve({ db: d.db, github: d.github, baseUrl: d.config.baseUrl }, p, pr, sender.login);
  });
}
