import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { ServerModule, SignInMethod } from "../src/server/extension.ts";
import { type Github, Github as GithubImpl, GithubError, type UserToken } from "../src/server/github.ts";

const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data", BASE_URL: "http://gespann.test" });

/** A provider that signs in whoever `next` names. */
function provider(): SignInMethod & { next: { subject: string; email: string } | Error } {
  const m = {
    id: "sso",
    label: "Continue with Google or SSO",
    next: { subject: "user_1", email: "tobi@acme.test" } as { subject: string; email: string } | Error,
    authorizeUrl: ({ redirectUri, state }: { redirectUri: string; state: string }) => `https://idp.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    identify: async ({ query }: { query: Record<string, string> }) => {
      assert.equal(query.code, "idp-code");
      if (m.next instanceof Error) throw m.next;
      return m.next;
    },
  };
  return m;
}

/** GitHub with one user and one repository; user tokens expire and come with a refresh token. */
function github() {
  const calls: string[] = [];
  let n = 0;
  const gh = {
    who: { id: 7, login: "tobi", name: "Tobi" as string | null, avatar_url: "" },
    /** "refused": GitHub turns the refresh token down; "down": GitHub cannot be reached. */
    refreshFails: null as "refused" | "down" | null,
    /** Holds every refresh until it settles. */
    pause: Promise.resolve() as Promise<unknown>,
    exchangeCode: async (): Promise<UserToken> => ({ access: `access-${++n}`, refresh: `refresh-${n}` }),
    refreshUserToken: async (r: string): Promise<UserToken> => {
      calls.push(`refresh ${r}`);
      await new Promise((r) => setTimeout(r, 5));
      await gh.pause;
      if (gh.refreshFails === "refused") throw new GithubError(400, "bad_refresh_token");
      if (gh.refreshFails === "down") throw new TypeError("fetch failed");
      return { access: `access-${++n}`, refresh: `refresh-${n}` };
    },
    user: async () => gh.who,
    /** No verified GitHub address, so a sign-in's address can fill it. */
    verifiedEmail: async () => null,
    userInstallations: async (t: string) => {
      calls.push(`installations ${t}`);
      return [{ id: 9, account: "acme" }];
    },
    userRepos: async () => [{ id: 1, full_name: "acme/shop", default_branch: "main", private: true }],
    installUrl: () => "https://github.com/apps/x/installations/new",
    authorizeUrl: (_r: string, state: string) => `https://github.com/login/oauth/authorize?state=${state}`,
  };
  return { gh, calls };
}

/** Cookies a response sets, as name → value (empty for a deleted cookie). */
function cookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

function setup() {
  const db = new Db(":memory:");
  const sso = provider();
  const { gh, calls } = github();
  const module: ServerModule = { name: "sso", signIn: [sso] };
  const server = createApp({ config, db, github: () => gh as unknown as Github, githubReady: () => true, module });
  /** The provider's round trip: start, then come back with the code. */
  const viaProvider = async () => {
    const start = await server.request("/auth/with/sso");
    const to = new URL(start.headers.get("location") ?? "");
    assert.equal(to.searchParams.get("redirect_uri"), "http://gespann.test/auth/with/sso/callback");
    const state = to.searchParams.get("state");
    return server.request(`/auth/with/sso/callback?code=idp-code&state=${state}`, { headers: { Cookie: `gs_signin=${cookies(start).gs_signin}` } });
  };
  /** GitHub's round trip; `link`: started from "Connect GitHub" (`/auth/github?link=1`), else a plain sign-in. */
  const viaGithub = async (extra = "", link = true, back = extra) => {
    const start = await server.request(`/auth/github${link ? "?link=1" : ""}`, { headers: { Cookie: extra.replace(/^; /, "") } });
    const oauth = cookies(start).gs_oauth ?? "";
    return server.request(`/auth/github/callback?state=${oauth.split(".")[0]}&code=c`, { headers: { Cookie: `gs_oauth=${oauth}${back}` } });
  };
  return { db, sso, gh, calls, server, viaProvider, viaGithub };
}

test("a module's sign-in methods show on the sign-in page; a bad id stops the server", async () => {
  const { server } = setup();
  assert.deepEqual((await (await server.request("/api/me")).json()).signIn, [{ id: "sso", label: "Continue with Google or SSO" }]);
  const plain = createApp({ config, db: new Db(":memory:"), github: () => github().gh as unknown as Github, githubReady: () => true });
  assert.deepEqual((await (await plain.request("/api/me")).json()).signIn, []);
  const bad = { ...provider(), id: "Bad Id" };
  assert.throws(() => createApp({ config, db: new Db(":memory:"), github: () => { throw new Error("no github"); }, githubReady: () => true, module: { name: "x", signIn: [bad] } }), /sign-in method id "Bad Id"/);
});

test("first sign-in links GitHub once; the next one goes straight in and re-reads the repositories", async () => {
  const { db, calls, viaProvider, viaGithub } = setup();

  const first = await viaProvider();
  assert.equal(first.headers.get("location"), "/?link=sso", "unknown sign-in: connect GitHub first");
  assert.equal(cookies(first).gs, undefined, "no session before GitHub is linked");
  const link = cookies(first).gs_link;
  assert.ok(link);

  const gh = await viaGithub(`; gs_link=${link}`);
  assert.equal(gh.headers.get("location"), "/projects/new");
  assert.match(cookies(gh).gs ?? "", /^[0-9a-f]{64}$/);
  const user = db.identityUser("sso", "user_1");
  assert.equal(user?.login, "tobi", "the sign-in is linked to the GitHub user");
  const kept = db.githubToken(user.id) ?? "";
  assert.ok(kept && !kept.includes("refresh-1"), "the GitHub token is kept, sealed");

  // Two weeks later: the repository list is stale, the provider alone signs in.
  db.sql.prepare("update users set repos_synced = '2000-01-01T00:00:00Z'").run();
  calls.length = 0;
  const again = await viaProvider();
  assert.equal(again.headers.get("location"), "/projects/new");
  assert.match(cookies(again).gs ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(calls, ["refresh refresh-1", "installations access-2"], "GitHub token refreshed, repositories read again");
  assert.ok(Date.parse(db.user(user.id)?.repos_synced ?? "") > Date.now() - 60_000);
  assert.equal(db.user(user.id)?.email, "tobi@acme.test", "the sign-in's address fills the empty one for mail");
});

test("a GitHub token that stopped working sends the user to link GitHub again", async () => {
  const { db, gh, viaProvider, viaGithub } = setup();
  const first = await viaProvider();
  await viaGithub(`; gs_link=${cookies(first).gs_link}`);
  const user = db.identityUser("sso", "user_1")!;

  gh.refreshFails = "refused";
  const again = await viaProvider();
  assert.equal(again.headers.get("location"), "/?link=sso");
  assert.equal(cookies(again).gs, undefined);
  assert.equal(db.githubToken(user.id), null, "the dead token is dropped");

  // The person connects another GitHub account: the sign-in follows it.
  gh.refreshFails = null;
  gh.who = { id: 8, login: "tobi-work", name: null, avatar_url: "" };
  await viaGithub(`; gs_link=${cookies(again).gs_link}`);
  assert.equal(db.identityUser("sso", "user_1")?.login, "tobi-work");
});

test("GitHub out of reach keeps the token; two sign-ins at once refresh it once", async () => {
  const { db, gh, calls, viaProvider, viaGithub } = setup();
  await viaGithub(`; gs_link=${cookies(await viaProvider()).gs_link}`);
  const user = db.identityUser("sso", "user_1")!;
  const kept = db.githubToken(user.id);

  gh.refreshFails = "down";
  const down = await viaProvider();
  assert.equal(down.headers.get("location"), "/?signin=failed");
  assert.equal(db.githubToken(user.id), kept, "the token stays for the next try");

  gh.refreshFails = null;
  calls.length = 0;
  const both = await Promise.all([viaProvider(), viaProvider()]);
  assert.deepEqual(both.map((r) => r.headers.get("location")), ["/projects/new", "/projects/new"]);
  assert.equal(calls.filter((c) => c.startsWith("refresh")).length, 1, "GitHub takes each refresh token once");
});

test("a plain GitHub sign-in never links a pending sign-in", async () => {
  const { db, viaProvider, viaGithub } = setup();
  const pending = cookies(await viaProvider()).gs_link;
  // The "Connect GitHub" page was left open; the person signs in with GitHub in another tab.
  const plain = await viaGithub(`; gs_link=${pending}`, false);
  assert.match(cookies(plain).gs ?? "", /^[0-9a-f]{64}$/);
  assert.equal(db.identityUser("sso", "user_1"), undefined);
});

test("Connect GitHub links only the sign-in it was started for", async () => {
  const { db, sso, viaProvider, viaGithub } = setup();
  const first = cookies(await viaProvider()).gs_link;
  sso.next = { subject: "user_2", email: "eve@acme.test" };
  const second = cookies(await viaProvider()).gs_link;
  // "Connect GitHub" for the first; by the time GitHub returns, the browser holds the second.
  await viaGithub(`; gs_link=${first}`, true, `; gs_link=${second}`);
  assert.equal(db.identityUser("sso", "user_1"), undefined);
  assert.equal(db.identityUser("sso", "user_2"), undefined);
});

test("a refusal that arrives after a newer GitHub sign-in keeps the newer token", async () => {
  const { db, gh, viaProvider, viaGithub } = setup();
  await viaGithub(`; gs_link=${cookies(await viaProvider()).gs_link}`);
  const user = db.identityUser("sso", "user_1")!;
  gh.refreshFails = "refused";
  let release = () => {};
  gh.pause = new Promise<void>((r) => (release = r));
  const late = viaProvider();
  await new Promise((r) => setTimeout(r, 20));
  await viaGithub("", false);
  const newer = db.githubToken(user.id);
  release();
  assert.equal((await late).headers.get("location"), "/?signin=failed", "a retry uses the newer token");
  assert.equal(db.githubToken(user.id), newer, "the token from the GitHub sign-in stays");
});

test("GitHub's token endpoint: a refused token is a 400, an outage keeps its status", async () => {
  let reply = () => new Response(JSON.stringify({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }));
  const app = { appId: "1", slug: "x", privateKey: "k", webhookSecret: "w", clientId: "c", clientSecret: "s" };
  const real = new GithubImpl(app, (async () => reply()) as unknown as typeof fetch);
  await assert.rejects(real.refreshUserToken("r"), (e: GithubError) => e.status === 400);
  reply = () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 });
  await assert.rejects(real.refreshUserToken("r"), (e: GithubError) => e.status === 503);
  reply = () => new Response('{"access_tok');
  await assert.rejects(real.refreshUserToken("r"), (e: GithubError) => e.status === 502, "a cut-off answer is no refusal");
  for (const odd of ["null", '{"access_token":true}', '{"access_token":"a","refresh_token":true}']) {
    reply = () => new Response(odd);
    await assert.rejects(real.refreshUserToken("r"), (e: GithubError) => e.status === 502, odd);
  }
});

test("a sign-in without its state, a failed provider sign-in or a forged link cookie lets nobody in", async () => {
  const { db, sso, server, viaProvider, viaGithub } = setup();
  const noState = await server.request("/auth/with/sso/callback?code=idp-code&state=x", { headers: { Cookie: "gs_signin=sso.y" } });
  assert.equal(noState.headers.get("location"), "/?signin=failed");

  sso.next = new Error("invalid_grant");
  const failed = await viaProvider();
  assert.equal(failed.headers.get("location"), "/?signin=failed");
  assert.equal(cookies(failed).gs, undefined);

  sso.next = { subject: "user_2", email: "eve@acme.test" };
  const link = cookies(await viaProvider()).gs_link ?? "";
  const forged = Buffer.from(JSON.stringify({ m: "sso", s: "user_3", e: null, t: Date.now() + 60_000 })).toString("base64url");
  await viaGithub(`; gs_link=${forged}.${link.split(".")[1]}`);
  assert.equal(db.identityUser("sso", "user_3"), undefined, "a cookie with another payload is ignored");
  assert.equal((await server.request("/auth/with/nope")).headers.get("location"), "/");
});

test("an instance without other sign-ins keeps no GitHub token", async () => {
  const db = new Db(":memory:");
  const { gh } = github();
  const server = createApp({ config, db, github: () => gh as unknown as Github, githubReady: () => true });
  const res = await server.request("/auth/github/callback?state=st&code=c", { headers: { Cookie: "gs_oauth=st" } });
  assert.match(cookies(res).gs ?? "", /^[0-9a-f]{64}$/);
  assert.equal(db.githubToken(1), null);
});
