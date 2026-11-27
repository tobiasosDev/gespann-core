import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "./app.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { SignInMethod } from "./extension.ts";
import { type Github, GithubError, type UserToken } from "./github.ts";
import { afterSignIn } from "./oauth.ts";
import { open, seal } from "./openrouter.ts";

/**
 * Sign-in through a server module's methods (`ServerModule.signIn`), next to GitHub. gespann reads
 * repositories with the person's GitHub token, so a sign-in it does not know yet ends on the sign-in
 * page with "connect GitHub once": the GitHub sign-in then links the two. On instances with such
 * methods gespann keeps each user's GitHub token (sealed with SESSION_SECRET), so later sign-ins
 * re-read the repositories without a trip to GitHub.
 */

const ID = /^[a-z0-9-]{1,40}$/;
const STATE_COOKIE = "gs_signin";
const LINK_COOKIE = "gs_link";

export interface SignInDeps {
  config: Config;
  db: Db;
  github: () => Github;
  githubReady: () => boolean;
  methods: SignInMethod[];
  allowed: (login: string) => boolean;
  /** Starts a web session for the user and answers where to go next. */
  signedIn: (c: Context<Env>, userId: number) => Response;
}

/** The module's sign-in methods, checked once at startup. */
export function signInMethods(methods: SignInMethod[] | undefined): SignInMethod[] {
  const seen = new Set<string>();
  for (const m of methods ?? []) {
    if (!ID.test(m.id) || seen.has(m.id)) throw new Error(`sign-in method id ${JSON.stringify(m.id)}: lowercase letters, digits and dashes, each id once`);
    if (typeof m.authorizeUrl !== "function" || typeof m.identify !== "function" || !m.label) throw new Error(`sign-in method ${m.id} needs a label, authorizeUrl and identify`);
    seen.add(m.id);
  }
  return methods ?? [];
}

/** Reads the repositories this GitHub user can access through the app, as at every sign-in. */
export async function syncRepos(db: Db, gh: Github, token: string, userId: number): Promise<void> {
  const repos = [];
  for (const i of await gh.userInstallations(token)) {
    for (const r of await gh.userRepos(token, i.id)) repos.push({ repo_id: r.id, installation_id: i.id, account: i.account, full_name: r.full_name, private: r.private, default_branch: r.default_branch });
  }
  db.setRepos(userId, repos);
}

const mac = (config: Config, s: string) => createHmac("sha256", config.sessionSecret).update(`signin:${s}`).digest("base64url");

/**
 * "Connect GitHub" binds the GitHub sign-in to the pending sign-in it was started for: this tag of
 * the link cookie goes into GitHub's state cookie. Null when nothing is pending.
 */
export function linkTag(c: Context, config: Config): string | null {
  const raw = getCookie(c, LINK_COOKIE);
  return raw ? mac(config, `tag:${raw}`).slice(0, 22) : null;
}

/**
 * After the GitHub sign-in: keeps the GitHub token if the instance has methods, and, when the user
 * came from "Connect GitHub" for the pending sign-in (`tag`), links that sign-in to this user.
 */
export function afterGithub(c: Context<Env>, d: Pick<SignInDeps, "config" | "db" | "methods">, userId: number, token: UserToken, tag: string | undefined): void {
  if (!d.methods.length) return;
  d.db.setGithubToken(userId, seal(d.config.sessionSecret, JSON.stringify(token)));
  if (!tag || linkTag(c, d.config) !== tag) return;
  const raw = getCookie(c, LINK_COOKIE);
  if (!raw) return;
  deleteCookie(c, LINK_COOKIE, { path: "/auth" });
  const [payload = "", sig = ""] = raw.split(".");
  const want = Buffer.from(mac(d.config, payload));
  if (want.length !== Buffer.from(sig).length || !timingSafeEqual(want, Buffer.from(sig))) return;
  const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as { m: string; s: string; e: string | null; t: number };
  if (p.t < Date.now() || !d.methods.some((m) => m.id === p.m)) return;
  d.db.linkIdentity(p.m, p.s, userId, p.e);
  // A verified address from the sign-in fills an empty one for mail; GitHub's or a confirmed one stays.
  if (p.e) d.db.offerEmail(userId, p.e, p.m);
}

export function mountSignIn(app: Hono<Env>, d: SignInDeps): void {
  const { config, db } = d;
  const secure = config.baseUrl.startsWith("https://");
  const cookie = { httpOnly: true, secure, sameSite: "Lax" as const, path: "/auth", maxAge: 600 };
  const method = (c: Context) => (d.githubReady() ? d.methods.find((m) => m.id === c.req.param("id")) : undefined);
  const redirectUri = (m: SignInMethod) => `${config.baseUrl}/auth/with/${m.id}/callback`;
  const log = (m: SignInMethod, message: string) => console.error(JSON.stringify({ level: "error", at: `sign-in ${m.id}`, message }));

  /**
   * Re-reads a linked user's repositories with the kept GitHub token: "ok", "relink" when GitHub no
   * longer takes the token, "failed" when GitHub could not be asked (the token stays). One at a time
   * per user: GitHub accepts each refresh token once.
   */
  const inflight = new Map<number, Promise<"ok" | "relink" | "failed">>();
  const refresh = (userId: number, githubId: number) => {
    let p = inflight.get(userId);
    if (!p) {
      p = refreshOnce(userId, githubId).finally(() => inflight.delete(userId));
      inflight.set(userId, p);
    }
    return p;
  };
  const refreshOnce = async (userId: number, githubId: number): Promise<"ok" | "relink" | "failed"> => {
    let sealed = db.githubToken(userId);
    if (!sealed) return "relink";
    try {
      const gh = d.github();
      let token = JSON.parse(open(config.sessionSecret, sealed)) as UserToken;
      if (token.refresh) {
        token = await gh.refreshUserToken(token.refresh);
        // A GitHub sign-in meanwhile stored a newer token: keep that one.
        if (!db.swapGithubToken(userId, sealed, seal(config.sessionSecret, JSON.stringify(token)))) return "failed";
        sealed = db.githubToken(userId) ?? "";
      }
      const u = await gh.user(token.access);
      if (u.id !== githubId) return "relink";
      db.upsertUser({ github_id: u.id, login: u.login, name: u.name, avatar: u.avatar_url });
      await syncRepos(db, gh, token.access, userId);
      return "ok";
    } catch (err) {
      // GitHub refused the token (a bad refresh token answers 400): link again. Anything else, e.g. a
      // rate limit or a network error, keeps the token for the next try.
      const refused = err instanceof GithubError && (err.status === 400 || err.status === 401);
      console.error(JSON.stringify({ level: "warn", at: "sign-in github token", userId, refused, message: err instanceof Error ? err.message : String(err) }));
      // A refusal of a token a GitHub sign-in has since replaced: the newer one may work, try again.
      return refused && db.swapGithubToken(userId, sealed, null) ? "relink" : "failed";
    }
  };

  app.get("/auth/with/:id", async (c) => {
    const m = method(c);
    if (!m) return c.redirect("/");
    const state = randomBytes(16).toString("hex");
    setCookie(c, STATE_COOKIE, `${m.id}.${state}`, cookie);
    try {
      return c.redirect(await m.authorizeUrl({ redirectUri: redirectUri(m), state }));
    } catch (err) {
      log(m, err instanceof Error ? err.message : String(err));
      return c.redirect("/?signin=failed");
    }
  });

  app.get("/auth/with/:id/callback", async (c) => {
    const m = method(c);
    if (!m) return c.redirect("/");
    const query = c.req.query();
    const want = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth" });
    if (!want || !query.state || want !== `${m.id}.${query.state}`) return c.redirect("/?signin=failed");
    let who;
    try {
      who = await m.identify({ query, redirectUri: redirectUri(m) });
      if (!who || typeof who.subject !== "string" || !who.subject) throw new Error("identify returned no subject");
    } catch (err) {
      log(m, err instanceof Error ? err.message : String(err));
      return c.redirect("/?signin=failed");
    }
    const user = db.identityUser(m.id, who.subject);
    const refreshed = user ? await refresh(user.id, user.github_id) : "relink";
    if (refreshed === "failed") return c.redirect("/?signin=failed");
    if (user && refreshed === "ok") {
      const fresh = db.user(user.id);
      if (!fresh || !d.allowed(fresh.login)) return c.redirect("/?closed=1");
      if (who.email) db.offerEmail(user.id, who.email, m.id);
      return d.signedIn(c, user.id);
    }
    // Not linked yet, or gespann can no longer read the repositories: link GitHub (again).
    const payload = Buffer.from(JSON.stringify({ m: m.id, s: who.subject, e: who.email ?? null, t: Date.now() + 600_000 })).toString("base64url");
    setCookie(c, LINK_COOKIE, `${payload}.${mac(config, payload)}`, cookie);
    return c.redirect(`/?link=${m.id}`);
  });
}

/** Where a fresh session starts: a pending agent sign-in, else the projects. */
export function landingAfterSignIn(c: Context, db: Db, userId: number): string {
  return afterSignIn(c) ?? (db.projects(userId).length ? "/projects" : "/projects/new");
}
