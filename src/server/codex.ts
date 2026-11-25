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

/** Codex refreshes its sign-in once it is this old; OpenAI allows each refresh token one use only. */
export const REFRESH_AFTER_MS = 8 * 86_400_000;
/** A sign-in this close to its refresh is due: the longest Codex session (a setup) fits in between. */
export const DUE_MARGIN_MS = 3 * 3_600_000;
/** How often a job's sandbox is checked for a sign-in Codex refreshed, to share it right away. */
export const WATCH_MS = 15_000;

/** When the sign-in was last refreshed, from auth.json's `last_refresh`; 0 when unknown. */
export function refreshedAt(auth: string): number {
  try {
    const t = Date.parse((JSON.parse(auth) as { last_refresh?: string }).last_refresh ?? "");
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function account(auth: string): string {
  try {
    return (JSON.parse(auth) as { tokens?: { account_id?: string } }).tokens?.account_id ?? "";
  } catch {
    return "";
  }
}

/** Codex may refresh this sign-in during a session that starts now. */
export function refreshDue(auth: string, now = Date.now()): boolean {
  return now - refreshedAt(auth) > REFRESH_AFTER_MS - DUE_MARGIN_MS;
}

/** Owners whose sign-in one job may be refreshing right now; the others wait for it. */
const refreshing = new Map<number, Promise<void>>();

/**
 * Stores a sign-in a job's Codex refreshed, unless another job of the owner already stored a newer
 * one. True when it was stored.
 */
function keep(db: Db, config: Config, ownerId: number, auth: string): boolean {
  if (!auth.trim().startsWith("{")) return false;
  const sealed = db.codexAuth(ownerId);
  // Disconnected meanwhile, or connected to another account: the job's sign-in is not theirs anymore.
  if (!sealed) return false;
  const stored = open(config.sessionSecret, sealed);
  if (account(auth) && account(stored) && account(auth) !== account(stored)) return false;
  if (auth === stored || refreshedAt(auth) < refreshedAt(stored)) return false;
  db.setCodex(ownerId, { codex_auth: seal(config.sessionSecret, auth) });
  return true;
}

/**
 * Puts the owner's sign-in into a sandbox for one job and takes the refreshed copy back out. Jobs of
 * one owner run side by side, each with a copy of the same sign-in. A refresh spends the refresh
 * token, so two jobs must never refresh the same copy: while a refresh is due, one job at a time
 * starts Codex, and the others wait until its Codex refreshed (or it ended), then start with the new
 * sign-in. A refreshed sign-in is shared as soon as the job's sandbox has it.
 */
export async function withCodex<T>(db: Db, sb: Sandboxes, config: Config, ownerId: number, sandboxId: string, fn: () => Promise<T>, watchMs = WATCH_MS): Promise<T> {
  const current = () => {
    const sealed = db.codexAuth(ownerId);
    if (!sealed) throw new Error("Connect Codex in Settings first: the tester runs on your ChatGPT plan.");
    return open(config.sessionSecret, sealed);
  };
  let before = current();
  let done: (() => void) | null = null;
  while (refreshDue(before)) {
    const other = refreshing.get(ownerId);
    if (!other) {
      refreshing.set(ownerId, new Promise<void>((ok) => (done = ok)));
      break;
    }
    await other;
    before = current();
  }
  const release = () => {
    if (!done) return;
    refreshing.delete(ownerId);
    done();
    done = null;
  };
  const file = authFile(sb, sandboxId);
  let watching = true;
  let wake = () => {};
  const stopped = new Promise<void>((ok) => (wake = ok));
  let watcher: Promise<void> = Promise.resolve();
  try {
    await sb.exec(sandboxId, "mkdir -p ~/.codex && umask 077 && : > ~/.codex/auth.json", 30);
    await sb.writeFile(sandboxId, file, before);
    // Shares a refresh while the job still runs, so jobs starting meanwhile get the new sign-in.
    watcher = (async () => {
      while (watching) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([new Promise((ok) => (timer = setTimeout(ok, watchMs))), stopped]);
        clearTimeout(timer);
        if (!watching) break;
        const now = await sb.readFile(sandboxId, file).catch(() => null);
        if (now && now !== before && keep(db, config, ownerId, now)) release();
      }
    })();
    return await fn();
  } finally {
    watching = false;
    wake();
    await watcher.catch(() => undefined);
    const after = await sb.readFile(sandboxId, file).catch(() => null);
    if (after && after !== before) keep(db, config, ownerId, after);
    release();
    await sb.exec(sandboxId, "rm -f ~/.codex/auth.json", 30).catch(() => undefined);
  }
}
