import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Hono } from "hono";

/** A user as a server module sees it: the signed-in user, or the owner of a job's project. */
export interface ModuleUser {
  id: number;
  login: string;
}

export interface ModuleJob {
  jobId: number;
  kind: string;
  projectId: number;
  owner: ModuleUser;
}

export interface ModuleJobEnd extends ModuleJob {
  status: string;
  started: string;
  finished: string;
  /** From the job's start to its end, the same span Settings → Sandboxes counts as sandbox time. */
  seconds: number;
}

/** One line of a module's section on the Settings page. */
export type SettingsRow =
  | { kind: "text"; text: string; tone?: "muted" | "warn" | "bad" }
  /** A bar filled to `value` of `max`, with a line of text above it. */
  | { kind: "meter"; label: string; value: number; max: number }
  /** POSTs to `action` (a path under /api/). */
  | { kind: "button"; label: string; action: string; primary?: boolean; danger?: boolean }
  /** A number field; its button POSTs `{ [name]: number }` to `action` (a path under /api/). */
  | { kind: "number"; label: string; name: string; value: number; min?: number; max?: number; step?: number; prefix?: string; button: string; action: string };

/**
 * A section on the Settings page, listed under Account. The page renders it with its own components; the module only
 * describes it. Its actions answer JSON: `{ redirect }` leaves for that URL, `{ error }` shows the
 * message under the section, anything else reloads it.
 */
export interface SettingsSection {
  /** Anchor on the Settings page: `/settings#<id>` opens this section. */
  id: string;
  title: string;
  description?: string;
  badge?: { text: string; tone?: "ok" | "bad" | "warn" | "info" | "muted" };
  rows: SettingsRow[];
}

/** Who came back from a module's sign-in. */
export interface SignInIdentity {
  /** The person's stable id at the provider. Never an email address: those change hands. */
  subject: string;
  email?: string | null;
}

/**
 * A way to sign in next to GitHub, such as Google, Microsoft or a company's SSO. gespann reads
 * repositories through the person's GitHub account, so the first sign-in links that account once
 * (through GitHub's sign-in); later sign-ins go straight in.
 */
export interface SignInMethod {
  /** In the sign-in URL, `/auth/with/<id>`: lowercase letters, digits and dashes. */
  id: string;
  /** Text of its button on the sign-in page, e.g. "Continue with Google or SSO". */
  label: string;
  /** Where the browser goes to sign in. The provider sends it back to `redirectUri` with `state` unchanged. */
  authorizeUrl(o: { redirectUri: string; state: string }): string | Promise<string>;
  /** Who came back to `redirectUri` with this query (`code`, `state`, …). Throws when the sign-in failed. */
  identify(o: { query: Record<string, string>; redirectUri: string }): Promise<SignInIdentity>;
}

/**
 * What `SERVER_MODULE=<path>` adds to the server. Every part is optional: pages of its own, links to
 * them in the sidebar, sections on the Settings page, ways to sign in, a say in whether a job starts,
 * and a note when a job gave its sandbox back.
 */
export interface ServerModule {
  /** Name for logs. */
  readonly name: string;
  /** Mounts the module's routes. They come before the web app, so they win over its client routes. */
  // The module brings its own route types.
  routes?(app: Hono<any>, helpers: { user(c: Context): ModuleUser | null }): void;
  /** Links in the sidebar, for signed-in users. A link to a page the module serves opens in the same tab. */
  readonly links?: { label: string; href: string }[];
  /** Cards on the Settings page for the signed-in user, above the instance's own. */
  settings?(user: ModuleUser): Promise<SettingsSection[]> | SettingsSection[];
  /** Ways to sign in next to GitHub, as buttons on the sign-in page. */
  readonly signIn?: SignInMethod[];
  /** Before a job takes a sandbox. A string is the reason it does not start; it fails with that reason. */
  admit?(job: ModuleJob): Promise<string | null> | string | null;
  /** After a job ended and gave its sandbox back. Errors are logged, never fail the job. */
  jobEnded?(end: ModuleJobEnd): Promise<void> | void;
  /**
   * At most this many jobs of the owner's projects run at once; null for no cap. Asked while the worker
   * picks the next job, so it must answer right away (no network). A job over the cap waits in the queue.
   */
  jobCap?(owner: ModuleUser): JobCap | null;
}

export interface JobCap {
  jobs: number;
  /** Shown next to the limit in Settings → Sandboxes, e.g. "your plan". */
  reason: string;
}

/** The module's cap for an owner; null when it has none or answers with something unusable. */
export function capFor(module: ServerModule | null | undefined, owner: ModuleUser): JobCap | null {
  if (!module?.jobCap) return null;
  try {
    const c = module.jobCap(owner);
    if (!c || !Number.isInteger(c.jobs) || c.jobs < 0) return null;
    return { jobs: c.jobs, reason: String(c.reason ?? "") };
  } catch (err) {
    console.error(JSON.stringify({ level: "error", at: `${module.name} jobCap`, owner: owner.login, message: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}

/** A module named by `SERVER_MODULE` default-exports this. It gets the server's environment. */
export type ServerModuleFactory = (env: NodeJS.ProcessEnv) => ServerModule | Promise<ServerModule>;

export async function loadServerModule(path: string, env: NodeJS.ProcessEnv = process.env): Promise<ServerModule | null> {
  if (!path) return null;
  const file = resolve(path);
  const mod = (await import(pathToFileURL(file).href)) as { default?: ServerModuleFactory };
  if (typeof mod.default !== "function") throw new Error(`SERVER_MODULE ${file} has no default export function`);
  const m = await mod.default(env);
  if (!m || typeof m.name !== "string") throw new Error(`SERVER_MODULE ${file} returned no module with a name`);
  return m;
}
