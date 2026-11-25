import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "./config.ts";
import { Docker, type SandboxModule, type Sandboxes, Ssh } from "./sandbox.ts";

const METHODS = ["create", "exists", "home", "ensureRunning", "keepAlive", "stop", "remove", "exec", "start", "status", "kill", "readFile", "writeFile", "download"] as const;

/** The sandbox provider `SANDBOX_PROVIDER` names, or null when the instance has none (jobs stay queued). */
export async function createSandboxes(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<Sandboxes | null> {
  if (config.sandboxProvider.startsWith("module:")) {
    const path = resolve(config.sandboxProvider.slice("module:".length));
    const mod = (await import(pathToFileURL(path).href)) as { default?: SandboxModule };
    if (typeof mod.default !== "function") throw new Error(`SANDBOX_PROVIDER module ${path} has no default export function`);
    const sb = await mod.default(env);
    const missing = METHODS.filter((m) => typeof (sb as unknown as Record<string, unknown>)[m] !== "function");
    if (missing.length) throw new Error(`SANDBOX_PROVIDER module ${path} lacks ${missing.join(", ")}`);
    return sb;
  }
  if (config.sandboxProvider === "docker") return new Docker(config.docker);
  if (config.sandboxProvider === "ssh") {
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
