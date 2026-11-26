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

/**
 * What `SERVER_MODULE=<path>` adds to the server. Every part is optional: pages of its own, links to
 * them in the sidebar, a say in whether a job starts, and a note when a job gave its sandbox back.
 */
export interface ServerModule {
  /** Name for logs. */
  readonly name: string;
  /** Mounts the module's routes. They come before the web app, so they win over its client routes. */
  // The module brings its own route types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes?(app: Hono<any>, helpers: { user(c: Context): ModuleUser | null }): void;
  /** Links in the sidebar, for signed-in users. A link to a page the module serves opens in the same tab. */
  readonly links?: { label: string; href: string }[];
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
