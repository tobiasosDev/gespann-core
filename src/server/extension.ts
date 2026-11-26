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

/** One line of a module's card on the Settings page. */
export type SettingsRow =
  | { kind: "text"; text: string; tone?: "muted" | "warn" | "bad" }
  /** A bar filled to `value` of `max`, with a line of text above it. */
  | { kind: "meter"; label: string; value: number; max: number }
  /** POSTs to `action` (a path under /api/). */
  | { kind: "button"; label: string; action: string; primary?: boolean; danger?: boolean }
  /** A number field; its button POSTs `{ [name]: number }` to `action` (a path under /api/). */
  | { kind: "number"; label: string; name: string; value: number; min?: number; max?: number; step?: number; prefix?: string; button: string; action: string };

/**
 * A card on the Settings page. The page renders it with its own components; the module only
 * describes it. Its actions answer JSON: `{ redirect }` leaves for that URL, `{ error }` shows the
 * message under the card, anything else reloads the card.
 */
export interface SettingsSection {
  /** Anchor on the Settings page: `/settings#<id>` scrolls to the card. */
  id: string;
  title: string;
  description?: string;
  badge?: { text: string; tone?: "ok" | "bad" | "warn" | "info" | "muted" };
  rows: SettingsRow[];
}

/**
 * What `SERVER_MODULE=<path>` adds to the server. Every part is optional: pages of its own, links to
 * them in the sidebar, cards on the Settings page, a say in whether a job starts, and a note when a
 * job gave its sandbox back.
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
  /** Before a job takes a sandbox. A string is the reason it does not start; it fails with that reason. */
  admit?(job: ModuleJob): Promise<string | null> | string | null;
  /** After a job ended and gave its sandbox back. Errors are logged, never fail the job. */
  jobEnded?(end: ModuleJobEnd): Promise<void> | void;
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
