import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Parallel, parallelJobs } from "./capacity.ts";
import type { Config } from "./config.ts";
import { Docker, type SandboxModule, type Sandboxes, Ssh } from "./sandbox.ts";

const METHODS = ["create", "exists", "home", "ensureRunning", "keepAlive", "stop", "remove", "exec", "start", "status", "kill", "readFile", "writeFile", "download"] as const;

/** One sandbox provider of the instance, with how many jobs it runs at once. */
export interface Provider {
  /** What configured it: "docker", "ssh" or "module:<path>". */
  spec: string;
  sandboxes: Sandboxes;
  parallel: Parallel;
}

/**
 * The instance's sandbox providers and which user gets which: `SANDBOX_PROVIDER` for everyone,
 * `SANDBOX_PROVIDER_BY_USER` for the GitHub logins it names. Each provider counts its own jobs at once.
 */
export interface SandboxPool {
  readonly providers: Provider[];
  /** The provider for this user's sandboxes, or null when they have none (their jobs stay queued). */
  forLogin(login: string | null | undefined): Provider | null;
}

/** The sandbox provider one spec names, or null for "" (none). */
export async function createSandboxes(config: Config, env: NodeJS.ProcessEnv = process.env, spec = config.sandboxProvider): Promise<Sandboxes | null> {
  if (spec.startsWith("module:")) {
    const path = resolve(spec.slice("module:".length));
    const mod = (await import(pathToFileURL(path).href)) as { default?: SandboxModule };
    if (typeof mod.default !== "function") throw new Error(`sandbox provider module ${path} has no default export function`);
    const sb = await mod.default(env);
    const missing = METHODS.filter((m) => typeof (sb as unknown as Record<string, unknown>)[m] !== "function");
    if (missing.length) throw new Error(`sandbox provider module ${path} lacks ${missing.join(", ")}`);
    return sb;
  }
  if (spec === "docker") return new Docker(config.docker);
  if (spec === "ssh") {
    const s = config.ssh;
    const dir = join(config.dataDir, "ssh");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let keyFile = s.keyFile;
    if (s.key) {
      keyFile = join(dir, "id");
      writeFileSync(keyFile, s.key.endsWith("\n") ? s.key : `${s.key}\n`, { mode: 0o600 });
    }
    // With SSH_KNOWN_HOSTS the host key is checked strictly; otherwise the first key seen is pinned here.
    const knownHostsFile = join(dir, s.knownHosts ? "known_hosts.pinned" : "known_hosts");
    if (s.knownHosts) writeFileSync(knownHostsFile, s.knownHosts.endsWith("\n") ? s.knownHosts : `${s.knownHosts}\n`, { mode: 0o600 });
    return new Ssh({
      host: s.host,
      port: s.port,
      keyFile,
      knownHostsFile,
      strictHostKeys: !!s.knownHosts,
      root: s.root,
      // Unix socket paths are limited to about 104 bytes (macOS's temp dir alone takes half), so /tmp.
      controlDir: mkdtempSync("/tmp/gsp-"),
    });
  }
  return null;
}

/** Makes every provider the config names once, however many users share it, and reads its size. */
export async function createPool(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<SandboxPool> {
  const bySpec = new Map<string, Provider>();
  for (const spec of new Set([config.sandboxProvider, ...Object.values(config.sandboxProviderByUser)])) {
    const sandboxes = await createSandboxes(config, env, spec);
    if (sandboxes) bySpec.set(spec, { spec, sandboxes, parallel: await parallelJobs(config.maxParallel, sandboxes) });
  }
  return {
    providers: [...bySpec.values()],
    forLogin(login) {
      const own = login && Object.hasOwn(config.sandboxProviderByUser, login.toLowerCase()) ? config.sandboxProviderByUser[login.toLowerCase()] : undefined;
      return bySpec.get(own ?? config.sandboxProvider) ?? null;
    },
  };
}

/** For the log: which provider serves whom, e.g. "ssh (tobi)" and "docker (everyone else)". */
export function describePool(config: Config, pool: SandboxPool): { who: string; provider: Provider }[] {
  const byUser = Object.entries(config.sandboxProviderByUser);
  return pool.providers.map((provider) => {
    const logins = byUser.filter(([, spec]) => spec === provider.spec).map(([login]) => login);
    const rest = provider.spec === config.sandboxProvider ? (byUser.length ? ["everyone else"] : []) : [];
    return { who: [...logins, ...rest].join(", "), provider };
  });
}
