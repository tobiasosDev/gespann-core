import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api.ts";

/**
 * Everything the web app reads from outside React: API resources, the address bar and a clock.
 * Components subscribe through useSyncExternalStore, so this repo needs no useEffect (eslint.config.mjs).
 */

export interface Snapshot<T> {
  data: T | null;
  error: string | null;
  /** When the last answer arrived (ms since epoch), 0 before the first. */
  at: number;
}

interface Subscriber {
  live?: (d: unknown) => boolean;
  pollMs: number;
}

interface Entry {
  path: string;
  snap: Snapshot<unknown>;
  subs: Map<() => void, Subscriber>;
  gen: number;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const EMPTY: Snapshot<never> = { data: null, error: null, at: 0 };
const entries = new Map<string, Entry>();

function schedule(e: Entry): void {
  const data = e.snap.data;
  const waits = data === null ? [] : [...e.subs.values()].filter((s) => s.live?.(data)).map((s) => s.pollMs);
  if (!waits.length) {
    clearTimeout(e.timer);
    e.timer = undefined;
    return;
  }
  e.timer ??= setTimeout(() => {
    e.timer = undefined;
    void load(e);
  }, Math.min(...waits));
}

/** Fetches now; an answer that a newer fetch overtook is dropped. */
function load(e: Entry): Promise<void> {
  const gen = ++e.gen;
  e.pending = true;
  return api<unknown>(e.path).then(
    (data) => settle(e, gen, { data, error: null }),
    (err: Error) => settle(e, gen, { data: e.snap.data, error: err.message }),
  );
}

function settle(e: Entry, gen: number, next: Omit<Snapshot<unknown>, "at">): void {
  if (gen !== e.gen || entries.get(e.path) !== e) return;
  e.pending = false;
  e.snap = { ...next, at: Date.now() };
  for (const notify of e.subs.keys()) notify();
  schedule(e);
}

function subscribe(path: string, sub: Subscriber, notify: () => void): () => void {
  let e = entries.get(path);
  const fresh = !e;
  if (!e) {
    e = { path, snap: EMPTY, subs: new Map(), gen: 0, pending: false, timer: undefined };
    entries.set(path, e);
  }
  e.subs.set(notify, sub);
  if (fresh) void load(e);
  else schedule(e);
  const entry = e;
  return () => {
    entry.subs.delete(notify);
    schedule(entry);
    // React re-subscribes in the same commit when a subscriber's options change; only a real last leave drops the entry.
    queueMicrotask(() => {
      if (entry.subs.size || entries.get(path) !== entry) return;
      clearTimeout(entry.timer);
      entries.delete(path);
    });
  };
}

/** Fetches every resource on screen again, except those already on their way. */
function refreshAll(): void {
  for (const e of entries.values()) if (e.subs.size && !e.pending) void load(e);
}

/**
 * Loads `/api${path}` and reloads it every `pollMs` while `live(data)` says work is running.
 * Components that ask for the same path share one request. Pass `live` as a module-level function:
 * a new function on every render subscribes again on every render.
 */
export function useResource<T>(path: string | null, live?: (d: T) => boolean, pollMs = 4000) {
  const sub = useCallback((notify: () => void) => (path === null ? () => undefined : subscribe(path, { live: live as Subscriber["live"], pollMs }, notify)), [path, live, pollMs]);
  const snap = useSyncExternalStore(sub, () => (path === null ? EMPTY : (entries.get(path)?.snap ?? EMPTY))) as Snapshot<T>;
  const reload = useCallback(async () => {
    const e = path === null ? undefined : entries.get(path);
    if (e) await load(e);
  }, [path]);
  return { ...snap, reload };
}

function onPathChange(notify: () => void): () => void {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
}

export function usePath(): string {
  return useSyncExternalStore(onPathChange, () => location.pathname);
}

function onHashChange(notify: () => void): () => void {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
}

/** The address bar's fragment without `#`, raw: `/settings#plan` gives "plan". */
export function useHash(): string {
  return useSyncExternalStore(onHashChange, () => location.hash.slice(1));
}

/** Sets the fragment as a new history entry, without the browser's jump to an element of that id. */
export function setHash(hash: string): void {
  if (location.hash.slice(1) === hash) return;
  const old = location.href;
  history.pushState(null, "", `#${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: old, newURL: location.href }));
}

/** Every move inside the app (link, back, forward) refreshes what stays on screen, such as the sidebar's projects. */
if (typeof window !== "undefined") window.addEventListener("popstate", () => setTimeout(refreshAll, 0));

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (!replace) window.scrollTo(0, 0);
}

let tick = 0;
const tickers = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | undefined;

function onTick(notify: () => void): () => void {
  tickers.add(notify);
  ticking ??= setInterval(() => {
    tick++;
    for (const n of tickers) n();
  }, 1000);
  return () => {
    tickers.delete(notify);
    if (tickers.size) return;
    clearInterval(ticking);
    ticking = undefined;
  };
}

const still = () => () => undefined;

/** Re-renders once a second while `on`, so running clocks count. */
export function useTick(on: boolean): void {
  useSyncExternalStore(on ? onTick : still, () => tick);
}
