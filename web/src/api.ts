import { useCallback, useEffect, useState } from "react";

export type Outcome = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export interface Me {
  user: { login: string; avatar: string | null } | null;
  githubReady: boolean;
  installUrl: string | null;
}

export interface RunRow {
  id: number;
  pr: number;
  title: string | null;
  head: string;
  base: string;
  base_ref: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  outcome: Outcome | null;
  created: string;
  started: string | null;
  finished: string | null;
  error: string | null;
}

export type CodexState = "none" | "pending" | "connected" | "failed";

export interface Settings {
  codex: { state: CodexState; account: string | null; login: { url: string | null; code: string | null; lines: string } | null };
}

export interface ApiToken {
  id: number;
  name: string;
  hint: string;
  created: string;
  last_used: string | null;
}

export interface Tokens {
  tokens: ApiToken[];
  mcpUrl: string;
}

export interface ProjectRow {
  id: number;
  repo: string;
  default_branch: string;
  setup: "none" | "queued" | "running" | "ready" | "failed";
  active: number;
  last?: RunRow;
}

export interface JobRow {
  id: number;
  kind: "login" | "setup" | "run" | "suggest";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  run_id: number | null;
  error: string | null;
  log: string;
  created: string;
}

export interface ProjectDetail extends ProjectRow {
  /** Merge gate: PRs with the label gespann stay drafts until they pass. */
  gate: number;
  /** Codex sign-in of the project's owner (Settings). */
  codex: CodexState;
  codex_account: string | null;
  own: boolean;
  criteria: string;
  default_checks: string;
  suggestion: string | null;
  model: string | null;
  sandbox_id: string | null;
  setup_error: string | null;
  recipe: string | null;
  notes: string | null;
  proof: boolean;
  runs: RunRow[];
  jobs: JobRow[];
}

export interface Check {
  expect: string;
  observed: string;
  result: "pass" | "fail" | "blocked";
  proof?: string[];
}

export interface RunDetail extends RunRow {
  project: { id: number; repo: string };
  verdict: { verdict: { verdict: Outcome; summary: string; checks: Check[]; proof: string[] } | null; problems: string[] } | null;
  files: string[];
  token: string;
  log: string;
}

export interface RepoGroup {
  account: string;
  installation: number;
  repos: { id: number; full_name: string; private: boolean; project: number | null }[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "x-gespann": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

/** Loads a resource and reloads it every `pollMs` while `live(data)` says work is running. */
export function useResource<T>(path: string | null, live?: (d: T) => boolean, pollMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  const isLive = data !== null && !!live?.(data);
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [isLive, load, pollMs]);
  return { data, error, reload: load };
}

export function ago(iso: string | null): string {
  if (!iso) return "–";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(a: string | null, b: string | null): string {
  if (!a) return "–";
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
