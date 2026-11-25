import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { runLong, type Sandboxes } from "./sandbox.ts";

/**
 * One Codex sign-in per user, made once in Settings and used by all their projects.
 * The sign-in happens in a short-lived sandbox with `codex login --device-auth`; its auth.json
 * is kept encrypted here, written into a project sandbox only for the length of a job, and
 * read back afterwards because Codex refreshes it in place (OpenAI's guidance for CI use).
 */
const authFile = (sb: Sandboxes, id: string) => `${sb.home(id)}/.codex/auth.json`;

function key(secret: string): Buffer {
  return createHash("sha256").update(`gespann-codex-auth:${secret}`).digest();
}

export function seal(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function open(secret: string, sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv("aes-256-gcm", key(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

const running = new Set<number>();

/** Starts the device-code sign-in for a user in the background; the UI polls the user's state. */
export function startLogin(db: Db, sb: Sandboxes, config: Config, userId: number): void {
  if (running.has(userId)) return;
  running.add(userId);
  db.setCodex(userId, { codex_state: "pending", codex_login: null });
  void (async () => {
    let id: string | null = null;
    try {
      const s = await sb.create({ name: `gespann-login-${userId}`, purpose: "login", ttlSeconds: 1800, labels: { gespann_login: String(userId) } });
      id = s.id;
      await sb.ensureRunning(id, 1800);
      const result = await runLong(sb, id, "codex login --device-auth 2>&1", {
        timeoutMs: 15 * 60_000,
        onTick: (tail) => {
          const clean = tail.replace(/\u001b\[[0-9;]*m/g, "");
          const url = /https:\/\/\S*(?:auth\.openai\.com|chatgpt\.com)\S*/.exec(clean)?.[0] ?? null;
          const code = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(clean)?.[1] ?? null;
          db.setCodex(userId, { codex_login: JSON.stringify({ url, code, lines: clean.split("\n").slice(-12).join("\n") }) });
        },
      });
      const auth = result.exitCode === 0 ? await sb.readFile(id, authFile(sb, id)) : null;
      if (!auth) throw new Error(result.timedOut ? "The code was not confirmed within 15 minutes." : `codex login ended without a sign-in: ${result.tail.slice(-600)}`);
      const status = await sb.exec(id, "codex login status 2>&1", 60);
      db.setCodex(userId, { codex_state: "connected", codex_login: null, codex_auth: seal(config.sessionSecret, auth), codex_account: status.stdout.trim().slice(0, 200) || "ChatGPT" });
      db.autoSetup(userId);
    } catch (err) {
      db.setCodex(userId, { codex_state: "failed", codex_login: JSON.stringify({ url: null, code: null, lines: (err as Error).message }) });
    } finally {
      running.delete(userId);
      // The sign-in sandbox never outlives the sign-in.
      if (id) await sb.remove(id).catch(() => undefined);
    }
  })();
}

/** Puts the owner's sign-in into a sandbox for one job and takes the refreshed copy back out. */
export async function withCodex<T>(db: Db, sb: Sandboxes, config: Config, ownerId: number, sandboxId: string, fn: () => Promise<T>): Promise<T> {
  const sealed = db.codexAuth(ownerId);
  if (!sealed) throw new Error("Connect Codex in Settings first: the tester runs on your ChatGPT plan.");
  const before = open(config.sessionSecret, sealed);
  await sb.exec(sandboxId, "mkdir -p ~/.codex && umask 077 && : > ~/.codex/auth.json", 30);
  await sb.writeFile(sandboxId, authFile(sb, sandboxId), before);
  try {
    return await fn();
  } finally {
    const after = await sb.readFile(sandboxId, authFile(sb, sandboxId)).catch(() => null);
    if (after && after !== before && after.trim().startsWith("{")) db.setCodex(ownerId, { codex_auth: seal(config.sessionSecret, after) });
    await sb.exec(sandboxId, "rm -f ~/.codex/auth.json", 30).catch(() => undefined);
  }
}
