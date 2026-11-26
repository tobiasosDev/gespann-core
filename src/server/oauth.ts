import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Env } from "./app.ts";
import type { Config } from "./config.ts";
import { ACCESS_SECONDS, type Db, type User } from "./db.ts";

/**
 * OAuth 2.1 sign-in for the MCP endpoint, as the MCP authorization spec describes it: Claude Code and
 * Codex find the server through the protected-resource metadata, register themselves (dynamic client
 * registration), send the user through gespann's GitHub sign-in and a consent page, and get a
 * short-lived access token plus a refresh token. Clients are public (PKCE S256, no secret). A client
 * id carries its own name and redirect URIs, signed with SESSION_SECRET, so registering writes nothing.
 */

export const SCOPE = "read";
const CODE_SECONDS = 300;
const NEXT_COOKIE = "gs_next";

interface Client {
  id: string;
  name: string;
  redirects: string[];
}

interface Grant {
  client: string;
  name: string;
  userId: number;
  redirect: string;
  challenge: string;
  expires: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/** https anywhere, http only on loopback (RFC 8252), or an app's own scheme (cursor://, vscode://). */
function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || BAD_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return true;
}

/** Loopback redirects may use any port (RFC 8252 7.3); everything else matches exactly. */
function redirectMatches(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    if (!redirectAllowed(registered) || !redirectAllowed(asked) || new URL(registered).protocol !== "http:") return false;
  } catch {
    return false;
  }
  const portless = (s: string) => s.replace(/^(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?(?=[/?]|$)/, "$1");
  return portless(registered) === portless(asked);
}

/** RFC 7636: 43 to 128 unreserved characters; an S256 challenge is 43 base64url characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function mountOAuth(app: Hono<Env>, d: { config: Config; db: Db; sessionDays: number }): void {
  const { config, db } = d;
  const base = config.baseUrl;
  const resource = `${base}/mcp`;
  const sign = (s: string) => createHmac("sha256", config.sessionSecret).update(`oauth:${s}`).digest("base64url").slice(0, 22);
  const codes = new Map<string, Grant>();
  const fresh = (u: User | null | undefined): u is User => !!u && Date.parse(u.repos_synced ?? "") > Date.now() - d.sessionDays * 86_400_000;

  const clientOf = (id: string): Client | null => {
    const m = /^gsc_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(id);
    if (!m) return null;
    const want = Buffer.from(sign(m[1]!));
    if (!timingSafeEqual(want, Buffer.from(m[2]!))) return null;
    try {
      const { n, r } = JSON.parse(Buffer.from(m[1]!, "base64url").toString()) as { n: string; r: string[] };
      return { id, name: n, redirects: r };
    } catch {
      return null;
    }
  };

  /** RFC 8707: the resource, when given, has to be this MCP endpoint. */
  const resourceOk = (r: string | undefined) => !r || [resource, `${resource}/`, base, `${base}/`].includes(r);
  const cors = (c: Context) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  };
  const oauthError = (c: Context, status: 400 | 401, error: string, description: string) => {
    cors(c);
    c.header("Cache-Control", "no-store");
    return c.json({ error, error_description: description }, status);
  };

  const protectedResource = (c: Context) => {
    cors(c);
    return c.json({ resource, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "gespann" });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-authorization-server", (c) => {
    cors(c);
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  });
  app.on("OPTIONS", ["/.well-known/*", "/oauth/register", "/oauth/token"], (c) => {
    cors(c);
    return c.body(null, 204);
  });

  // RFC 7591 dynamic client registration. Public clients only.
  app.post("/oauth/register", async (c) => {
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, 400, "invalid_client_metadata", "send the client metadata as JSON");
    }
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5 || !redirects.every((r) => typeof r === "string" && r.length <= 500 && redirectAllowed(r)))
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris: 1 to 5 https, loopback http or app-scheme URIs without a fragment");
    const name = (typeof body.client_name === "string" ? body.client_name.trim() : "").slice(0, 60) || "MCP client";
    const payload = b64(JSON.stringify({ n: name, r: redirects }));
    const id = `gsc_${payload}.${sign(payload)}`;
    cors(c);
    return c.json(
      { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE },
      201,
    );
  });

  type Ask = { client: Client; redirect: string; state: string | undefined; challenge: string };
  /**
   * Checks an authorization request. Problems are shown to the user, never redirected: anyone can
   * register a client, so an error redirect would make gespann an open redirector (RFC 9700 4.11.2).
   */
  const parseAsk = (q: Record<string, string | undefined>): { page: string } | Ask => {
    const client = clientOf(q.client_id ?? "");
    if (!client) return { page: "This sign-in link comes from an unknown app. Add gespann to your agent again and retry." };
    const redirect = q.redirect_uri ?? (client.redirects.length === 1 ? client.redirects[0]! : "");
    if (!client.redirects.some((r) => redirectMatches(r, redirect))) return { page: "This sign-in link has a return address the app did not register." };
    if (q.response_type !== "code") return { page: `${client.name} asked for an unsupported response type (only response_type=code).` };
    if (!q.code_challenge || !CHALLENGE.test(q.code_challenge) || q.code_challenge_method !== "S256") return { page: `${client.name} did not send a PKCE S256 challenge, which gespann requires.` };
    if (!resourceOk(q.resource)) return { page: `${client.name} asked for access to ${q.resource ?? ""}; gespann can only grant ${resource}.` };
    return { client, redirect, state: q.state, challenge: q.code_challenge };
  };

  const page = (c: Context, status: 200 | 400, body: ReturnType<typeof html>, formTarget?: string) => {
    // A form's redirect counts against form-action: allow the client's return address too.
    let target = "";
    if (formTarget) {
      const u = new URL(formTarget);
      target = u.protocol === "http:" || u.protocol === "https:" ? ` ${u.origin}` : ` ${u.protocol}`;
    }
    c.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; img-src https://avatars.githubusercontent.com; form-action 'self'${target}; frame-ancestors 'none'; base-uri 'none'`);
    c.header("Cache-Control", "no-store");
    return c.html(
      html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gespann · Agent access</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#ededed;font:15px/1.5 system-ui,-apple-system,sans-serif;padding:16px;box-sizing:border-box}
main{width:100%;max-width:420px;border:1px solid #262626;border-radius:12px;background:#111;padding:24px}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px;color:#a3a3a3}b{color:#ededed;font-weight:600}
ul{margin:0 0 16px;padding-left:18px;color:#a3a3a3}code{font:13px ui-monospace,monospace;color:#ededed;word-break:break-all}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;font:inherit;font-weight:600;border-radius:8px;padding:10px 12px;cursor:pointer;border:1px solid #333;background:transparent;color:#ededed}
button.go{background:#ededed;color:#0a0a0a;border-color:#ededed}.who{display:flex;align-items:center;gap:8px;margin-bottom:16px;color:#a3a3a3;font-size:13px}.who img{width:20px;height:20px;border-radius:50%}
</style></head><body><main>${body}</main></body></html>`,
      status,
    );
  };

  app.get("/oauth/authorize", (c) => {
    const ask = parseAsk(c.req.query());
    if ("page" in ask) return page(c, 400, html`<h1>Sign-in link not valid</h1><p>${ask.page}</p>`);
    const user = c.get("user");
    if (!fresh(user)) {
      // Back here after the GitHub sign-in, which also refreshes the repository list.
      setCookie(c, NEXT_COOKIE, c.req.url.slice(c.req.url.indexOf("/oauth/authorize")), { httpOnly: true, secure: base.startsWith("https://"), sameSite: "Lax", path: "/auth", maxAge: 600 });
      return c.redirect("/auth/github");
    }
    const q = c.req.query();
    const to = new URL(ask.redirect);
    const where = to.protocol === "http:" && LOOPBACK.has(to.hostname) ? "an app on this computer" : to.protocol === "https:" ? to.host : `the app behind ${to.protocol}//`;
    const hidden = (["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource"] as const).map((k) => (q[k] === undefined ? "" : html`<input type="hidden" name="${k}" value="${q[k]}">`));
    return page(
      c,
      200,
      html`<div class="who">${user.avatar ? html`<img src="${user.avatar}" alt="">` : ""}Signed in to gespann as <b>${user.login}</b></div>
<h1>Allow <b>${ask.client.name}</b> to read your gespann runs?</h1>
<ul><li>Status, issues, review text, screenshots and recordings of runs</li><li>Rerun a pull request, at most 3 times per commit</li><li>Only the projects you can see</li><li>It cannot cancel or approve anything</li></ul>
<p>After you allow it, your browser goes back to ${where}. You can revoke it under Settings → Agent access.</p>
<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${sign(`csrf:${c.get("session")}`)}">
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="go" type="submit" name="decision" value="allow">Allow</button></div></form>`,
      ask.redirect,
    );
  });

  app.post("/oauth/authorize", async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
    const ask = parseAsk(form);
    if ("page" in ask) return page(c, 400, html`<h1>Sign-in link not valid</h1><p>${ask.page}</p>`);
    const user = c.get("user");
    const sid = c.get("session");
    if (!fresh(user) || !sid || form.csrf !== sign(`csrf:${sid}`)) return page(c, 400, html`<h1>Please try again</h1><p>Your gespann sign-in changed. Start the connection from your agent again.</p>`);
    const u = new URL(ask.redirect);
    if (ask.state) u.searchParams.set("state", ask.state);
    u.searchParams.set("iss", base);
    if (form.decision !== "allow") {
      // Not sent anywhere on its own: the return address belongs to an app nobody vouched for.
      u.searchParams.set("error", "access_denied");
      return page(c, 200, html`<h1>Cancelled</h1><p><b>${ask.client.name}</b> did not get access.</p><p><a style="color:#ededed" href="${u.toString()}">Tell ${ask.client.name}</a> so it stops waiting.</p>`);
    }
    for (const [k, g] of codes) if (g.expires < Date.now()) codes.delete(k);
    const code = randomBytes(32).toString("base64url");
    codes.set(b64(sha256(code)), { client: ask.client.id, name: ask.client.name, userId: user.id, redirect: ask.redirect, challenge: ask.challenge, expires: Date.now() + CODE_SECONDS * 1000 });
    u.searchParams.set("code", code);
    return c.redirect(u.toString());
  });

  app.post("/oauth/token", async (c) => {
    const type = c.req.header("content-type") ?? "";
    const raw = type.includes("application/json") ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : await c.req.parseBody();
    const f = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
    const client = clientOf(f("client_id"));
    if (!client) return oauthError(c, 401, "invalid_client", "unknown client_id; register again");
    if (!resourceOk(f("resource") || undefined)) return oauthError(c, 400, "invalid_target", `the resource has to be ${resource}`);
    let issued: { access: string; refresh: string };
    if (f("grant_type") === "authorization_code") {
      const key = b64(sha256(f("code")));
      const g = codes.get(key);
      codes.delete(key);
      if (!g || g.expires < Date.now() || g.client !== client.id) return oauthError(c, 400, "invalid_grant", "the code is unknown, used or expired");
      if (f("redirect_uri") && f("redirect_uri") !== g.redirect) return oauthError(c, 400, "invalid_grant", "redirect_uri differs from the authorization request");
      if (!VERIFIER.test(f("code_verifier")) || b64(sha256(f("code_verifier"))) !== g.challenge) return oauthError(c, 400, "invalid_grant", "code_verifier does not match the code_challenge");
      issued = db.createOAuthToken(g.userId, client.id, g.name);
    } else if (f("grant_type") === "refresh_token") {
      // Repository access is re-checked with GitHub at sign-in; a stale list sends the user there.
      const r = db.refreshOAuthToken(f("refresh_token"), client.id, fresh);
      if (r === "unknown") return oauthError(c, 400, "invalid_grant", "the refresh token is unknown, revoked or expired; sign in again");
      if (r === "denied") return oauthError(c, 400, "invalid_grant", `sign in to gespann again: repository access is re-checked with GitHub every ${d.sessionDays} days`);
      issued = r;
    } else {
      return oauthError(c, 400, "unsupported_grant_type", "authorization_code or refresh_token");
    }
    cors(c);
    c.header("Cache-Control", "no-store");
    return c.json({ access_token: issued.access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: issued.refresh, scope: SCOPE });
  });
}

/** Where to go after the GitHub sign-in: back to a pending agent sign-in, if there is one. */
export function afterSignIn(c: Context): string | null {
  const next = getCookie(c, NEXT_COOKIE);
  if (!next) return null;
  deleteCookie(c, NEXT_COOKIE, { path: "/auth" });
  return next.startsWith("/oauth/authorize?") ? next : null;
}
