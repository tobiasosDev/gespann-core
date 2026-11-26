import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { GithubApp } from "./config.ts";

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gespann" };

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`GitHub ${status}: ${message}`);
    this.status = status;
  }
}

async function request<T>(token: string, method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: { ...HEADERS, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new GithubError(res.status, `${method} ${path}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** RS256 JWT that authenticates as the app itself (10 minutes). */
export function appJwt(appId: string, privateKey: string, at = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: at - 60, exp: at + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** GitHub signs webhook bodies with HMAC-SHA256 of the webhook secret. */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface PullRequest {
  number: number;
  /** GraphQL id, for draft changes. */
  node_id: string;
  title: string;
  body: string | null;
  draft: boolean;
  state: string;
  merged?: boolean;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
  labels: { name: string }[];
  html_url: string;
}

export interface LinkedIssue {
  /** `#12`: always an issue of the PR's own repository. */
  ref: string;
  title: string;
  body: string;
  url: string;
}

const MAX_ISSUES = 5;

/**
 * Issues the PR text closes with GitHub's keywords: `Fixes #12`, `closes owner/repo#3`,
 * `Resolves https://github.com/owner/repo/issues/4`. A bare mention (`#12`, `Refs #12`) is no goal of this PR.
 */
export function closingRefs(text: string, repo: string): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+))?#?(\d+)\b/gi;
  for (const m of text.matchAll(re)) {
    // A number only counts with `#` or as an issue URL: "fixes 3 bugs" is no reference.
    if (!m[1] && !m[0].includes("#")) continue;
    const r = { repo: m[1] ?? m[2] ?? repo, number: Number(m[3]) };
    if (!out.some((o) => o.repo.toLowerCase() === r.repo.toLowerCase() && o.number === r.number)) out.push(r);
  }
  return out;
}

export class Github {
  private readonly app: GithubApp;
  private readonly fetchImpl: typeof fetch;
  private readonly tokens = new Map<string, { token: string; expires: number }>();

  constructor(app: GithubApp, fetchImpl: typeof fetch = fetch) {
    this.app = app;
    this.fetchImpl = fetchImpl;
  }

  get slug(): string {
    return this.app.slug;
  }

  installUrl(): string {
    return `https://github.com/apps/${this.app.slug}/installations/new`;
  }

  /**
   * An installation token, cached until shortly before it expires. `readOnly` narrows it to reading
   * code: that is the one handed into sandboxes, where pull request code runs.
   */
  async installationToken(installationId: number, readOnly = false): Promise<string> {
    const key = `${installationId}:${readOnly ? "read" : "full"}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 5 * 60_000) return cached.token;
    const body = readOnly ? { permissions: { contents: "read", metadata: "read" } } : {};
    const r = await request<{ token: string; expires_at: string }>(appJwt(this.app.appId, this.app.privateKey), "POST", `/app/installations/${installationId}/access_tokens`, body, this.fetchImpl);
    this.tokens.set(key, { token: r.token, expires: Date.parse(r.expires_at) });
    return r.token;
  }

  async asInstallation<T>(installationId: number, method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(await this.installationToken(installationId), method, path, body, this.fetchImpl);
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", this.app.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gespann" },
      body: JSON.stringify({ client_id: this.app.clientId, client_secret: this.app.clientSecret, code, redirect_uri: redirectUri }),
    });
    const r = (await res.json()) as { access_token?: string; error_description?: string };
    if (!r.access_token) throw new GithubError(400, r.error_description ?? "no access token");
    return r.access_token;
  }

  async user(userToken: string): Promise<{ id: number; login: string; name: string | null; avatar_url: string }> {
    return request(userToken, "GET", "/user", undefined, this.fetchImpl);
  }

  /** Installations of this app the user can access. */
  async userInstallations(userToken: string): Promise<{ id: number; account: string }[]> {
    const r = await request<{ installations: { id: number; account: { login: string } }[] }>(userToken, "GET", "/user/installations?per_page=100", undefined, this.fetchImpl);
    return r.installations.map((i) => ({ id: i.id, account: i.account.login }));
  }

  /** Repositories of one installation that this user can access (user token). */
  async userRepos(userToken: string, installationId: number): Promise<{ id: number; full_name: string; default_branch: string; private: boolean }[]> {
    const out: { id: number; full_name: string; default_branch: string; private: boolean }[] = [];
    for (let page = 1; ; page++) {
      const r = await request<{ repositories: typeof out }>(userToken, "GET", `/user/installations/${installationId}/repositories?per_page=100&page=${page}`, undefined, this.fetchImpl);
      out.push(...r.repositories);
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  async installationRepos(installationId: number): Promise<{ id: number; full_name: string; default_branch: string; private: boolean }[]> {
    const out: { id: number; full_name: string; default_branch: string; private: boolean }[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.asInstallation<{ repositories: typeof out }>(installationId, "GET", `/installation/repositories?per_page=100&page=${page}`);
      out.push(...r.repositories);
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  async pull(installationId: number, repo: string, pr: number): Promise<PullRequest> {
    return this.asInstallation(installationId, "GET", `/repos/${repo}/pulls/${pr}`);
  }

  /**
   * The issues of this repository that this PR says it resolves: GitHub's own list (closing keywords
   * and issues linked in the sidebar) plus closing keywords in the PR text that GitHub does not count,
   * e.g. on a PR into a branch other than the default. Issues of other repositories are left out: their
   * text would reach this repository's sandbox and PR comment, which may be public while they are not.
   * Throws when GitHub does not answer, so the run can say it judged without them.
   */
  async linkedIssues(installationId: number, repo: string, pr: number, body: string | null): Promise<LinkedIssue[]> {
    const [owner, name] = repo.split("/");
    const found = new Map<number, LinkedIssue>();
    const q = await this.asInstallation<{ errors?: { message: string }[]; data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes: { number: number; title: string; body: string; url: string; repository: { nameWithOwner: string } }[] } } } } }>(
      installationId,
      "POST",
      "/graphql",
      {
        query: "query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { closingIssuesReferences(first: 10) { nodes { number title body url repository { nameWithOwner } } } } } }",
        variables: { owner, name, pr },
      },
    );
    if (q.errors?.length) throw new GithubError(422, `closingIssuesReferences: ${q.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
    for (const n of q.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []) {
      if (n.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()) found.set(n.number, { ref: `#${n.number}`, title: n.title, body: n.body ?? "", url: n.url });
    }
    for (const r of closingRefs(body ?? "", repo)) {
      if (found.size >= MAX_ISSUES) break;
      if (r.repo.toLowerCase() !== repo.toLowerCase() || found.has(r.number)) continue;
      // A number that is no issue (a typo, a PR) is no goal; any other GitHub failure stops the lookup.
      const i = await this.asInstallation<{ number: number; title: string; body: string | null; html_url: string; pull_request?: unknown }>(installationId, "GET", `/repos/${repo}/issues/${r.number}`).catch((err: unknown) => {
        if (err instanceof GithubError && (err.status === 404 || err.status === 410)) return null;
        throw err;
      });
      if (i && !i.pull_request) found.set(r.number, { ref: `#${r.number}`, title: i.title, body: i.body ?? "", url: i.html_url });
    }
    return [...found.values()].slice(0, MAX_ISSUES);
  }

  async changedFiles(installationId: number, repo: string, pr: number): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const r = await this.asInstallation<{ filename: string; previous_filename?: string }[]>(installationId, "GET", `/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
      for (const f of r) out.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
      if (r.length < 100) break;
    }
    return out;
  }

  async createCheck(installationId: number, repo: string, headSha: string, detailsUrl: string): Promise<number> {
    const r = await this.asInstallation<{ id: number }>(installationId, "POST", `/repos/${repo}/check-runs`, {
      name: "gespann/verify",
      head_sha: headSha,
      status: "queued",
      details_url: detailsUrl,
    });
    return r.id;
  }

  async updateCheck(
    installationId: number,
    repo: string,
    checkId: number,
    fields: { status?: "queued" | "in_progress" | "completed"; conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped"; title?: string; summary?: string; text?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (fields.status) body.status = fields.status;
    if (fields.conclusion) {
      body.conclusion = fields.conclusion;
      body.completed_at = new Date().toISOString();
    }
    if (fields.title) body.output = { title: fields.title, summary: fields.summary ?? "", ...(fields.text ? { text: fields.text } : {}) };
    await this.asInstallation(installationId, "PATCH", `/repos/${repo}/check-runs/${checkId}`, body);
  }

  async comment(installationId: number, repo: string, pr: number, body: string): Promise<number> {
    return (await this.asInstallation<{ id: number }>(installationId, "POST", `/repos/${repo}/issues/${pr}/comments`, { body })).id;
  }

  async updateComment(installationId: number, repo: string, commentId: number, body: string): Promise<void> {
    await this.asInstallation(installationId, "PATCH", `/repos/${repo}/issues/comments/${commentId}`, { body });
  }

  /** Turns a PR into a draft (which GitHub never merges) or back into ready for review. */
  async setDraft(installationId: number, nodeId: string, draft: boolean): Promise<void> {
    const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
    const r = await this.asInstallation<{ errors?: { message: string }[] }>(installationId, "POST", "/graphql", {
      query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      variables: { id: nodeId },
    });
    if (r.errors?.length) throw new GithubError(422, `${mutation}: ${r.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
  }
}

/** Manifest for the one-click GitHub App creation (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
export function appManifest(baseUrl: string, name: string): Record<string, unknown> {
  return {
    name,
    url: baseUrl,
    hook_attributes: { url: `${baseUrl}/github/webhook`, active: true },
    redirect_url: `${baseUrl}/setup/github/created`,
    callback_urls: [`${baseUrl}/auth/github/callback`],
    setup_url: `${baseUrl}/auth/github`,
    setup_on_update: true,
    public: true,
    // contents: write only because GitHub requires it to switch a PR to draft and back (the merge
    // gate); the token handed into sandboxes is narrowed to contents: read.
    default_permissions: { checks: "write", contents: "write", metadata: "read", pull_requests: "write", issues: "write" },
    // issue_comment: "/gespann approve" releases a PR the merge gate holds.
    default_events: ["pull_request", "issue_comment"],
  };
}

export async function convertManifest(code: string, fetchImpl: typeof fetch = fetch): Promise<{ id: number; slug: string; pem: string; webhook_secret: string; client_id: string; client_secret: string }> {
  const res = await fetchImpl(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", headers: HEADERS });
  if (!res.ok) throw new GithubError(res.status, (await res.text()).slice(0, 300));
  return (await res.json()) as { id: number; slug: string; pem: string; webhook_secret: string; client_id: string; client_secret: string };
}
