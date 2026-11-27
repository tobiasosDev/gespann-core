export type Outcome = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export interface Me {
  user: { login: string; avatar: string | null } | null;
  githubReady: boolean;
  installUrl: string | null;
  /** Pages a server module of this instance adds, shown in the sidebar. */
  links?: { label: string; href: string }[];
}

export interface RunRow {
  /** Queued until the PR's other checks (CI) pass; set in a project's run list. */
  waitingForChecks?: boolean;
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
  /** JSON list of the files in conflict with the base: the PR was not tested. */
  conflict: string | null;
}

export type CodexState = "none" | "pending" | "connected" | "failed";

export interface CodexModel {
  id: string;
  name: string;
  description: string;
  /** OpenAI's Codex credits per 1M tokens. */
  rates: { input: number; cached: number; output: number };
  /** Benchmark result (docs/models.md): right verdicts of `of`, mean credits per test PR. */
  bench?: { right: number; of: number; credits: number };
  /** Best tester for its cost in the benchmark. */
  recommended?: boolean;
  /** A warning from the benchmark, shown when the model is selected. */
  note?: string;
}

/** Who runs the tester: Codex on the user's ChatGPT plan or OpenRouter key, or Claude Code, Copilot or Grok on their key. */
export type KeyAgentId = "claude" | "copilot" | "grok";
export type AgentProvider = "codex" | "openrouter" | KeyAgentId;

/** Claude Code, Copilot or Grok in Settings: what to ask for, and the user's connection (never the key). */
export interface KeyAgent {
  id: KeyAgentId;
  name: string;
  keyUrl: string;
  models: string[];
  /** How to get the key, step by step. */
  steps: string[];
  /** The device-code sign-in's button (Copilot, Grok); null: key only. */
  signIn: string | null;
  connected: boolean;
  label: string | null;
  model: string | null;
  login: { state: "pending" | "connected" | "failed" | string; url: string | null; code: string | null; lines: string } | null;
}

/** A model the OpenRouter picker offers; the field takes any other OpenRouter id too. */
export interface OpenRouterModel {
  id: string;
  name: string;
  context: number | null;
  /** US dollars per 1M input, cached input and output tokens. */
  price: { input: number; cached: number; output: number } | null;
  kind: "vision" | "free";
}

export interface Settings {
  agent: AgentProvider;
  openrouter: { connected: boolean; label: string | null; model: string | null };
  keyAgents: KeyAgent[];
  codex: {
    state: CodexState;
    account: string | null;
    model: string | null;
    models: CodexModel[];
    login: { url: string | null; code: string | null; lines: string } | null;
  };
}

/** A server module's card on the Settings page (SettingsSection in src/server/extension.ts). */
export type SettingsRow =
  | { kind: "text"; text: string; tone?: "muted" | "warn" | "bad" }
  | { kind: "meter"; label: string; value: number; max: number }
  | { kind: "button"; label: string; action: string; primary?: boolean; danger?: boolean }
  | { kind: "number"; label: string; name: string; value: number; min?: number; max?: number; step?: number; prefix?: string; button: string; action: string };

export interface SettingsSection {
  id: string;
  title: string;
  description?: string;
  badge?: { text: string; tone?: "ok" | "bad" | "warn" | "info" | "muted" };
  rows: SettingsRow[];
}

export interface RunningBox {
  job_id: number;
  kind: "login" | "setup" | "run" | "suggest";
  project_id: number;
  repo: string;
  pr: number | null;
  sandbox_id: string | null;
  started: string;
}

export interface Boxes {
  /** Jobs your sandbox provider runs at once for everyone on it; null when none runs or serves you. */
  host: number | null;
  /** The job service runs, but no sandbox provider of this instance serves your account. */
  noProvider: boolean;
  /** A cap the server module sets for your jobs (e.g. your plan's), with its reason; null for none. */
  cap: { jobs: number; reason: string } | null;
  /** Jobs of your projects that may run at once. */
  limit: number | null;
  /** Your own limit; null when you take what the host allows. */
  own: number | null;
  running: RunningBox[];
  /** Jobs that wait for a free sandbox. */
  queued: number;
  /** PR runs that wait for their PR's other checks (CI) before they need a sandbox. */
  waitingForChecks: number;
  time: { month: string; days: { day: string; seconds: number }[]; monthSeconds: number; totalSeconds: number; jobs: number };
}

export interface ApiToken {
  id: number;
  name: string;
  hint: string;
  created: string;
  last_used: string | null;
  /** Set for an agent's OAuth sign-in; null for a personal token. */
  client: string | null;
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

export interface Viewport {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface ProjectDetail extends ProjectRow {
  /** Merge gate: a FAIL fails the check, and PRs with the label gespann stay drafts until they pass. */
  gate: number;
  /** Codex sign-in of the project's owner (Settings). */
  codex: CodexState;
  codex_account: string | null;
  codex_model: string | null;
  /** The owner's provider, and whether the agent can run on it (Codex connected, or an OpenRouter key and model). */
  agent: AgentProvider;
  agent_ready: boolean;
  openrouter_model: string | null;
  /** The owner's model for Claude Code, Copilot or Grok; null: the CLI's default. */
  agent_model: string | null;
  own: boolean;
  criteria: string;
  default_checks: string;
  /** Screen sizes the tester checks every PR at (preset ids); empty: the browser's own size. */
  viewports: string[];
  viewport_presets: Viewport[];
  suggestion: string | null;
  model: string | null;
  sandbox_id: string | null;
  setup_error: string | null;
  recipe: string | null;
  notes: string | null;
  proof: boolean;
  runs: RunRow[];
  /** PRs with runs that are merged or closed. */
  closed: { pr: number; merged: boolean }[];
  jobs: JobRow[];
}

export interface Check {
  expect: string;
  observed: string;
  result: "pass" | "fail" | "blocked";
  proof?: string[];
  /** A failed check that fails the same way on the base branch: how the tester confirmed it. */
  pre_existing?: string;
}

export interface Goal {
  issue: string;
  goal: string;
  observed: string;
  result: "met" | "missed" | "blocked";
  proof?: string[];
}

export const STAGES = ["sandbox", "copy", "read", "checks", "verdict"] as const;
export type Stage = (typeof STAGES)[number];

/** Live progress of a running run (src/verify/progress.ts). */
export interface Progress {
  at: Partial<Record<Stage, string>>;
  attempt: number;
  sandboxDone?: string;
  checks: { expect: string; result: Check["result"] | null; active?: true; observed?: string; at?: string }[];
  now: { at: string; text: string }[];
}

export interface RunDetail extends RunRow {
  /** Queued until the PR's other checks (CI) pass; it holds no sandbox meanwhile. */
  waitingForChecks: boolean;
  project: { id: number; repo: string };
  verdict: { verdict: { verdict: Outcome; summary: string; checks: Check[]; goals?: Goal[]; proof: string[] } | null; problems: string[] } | null;
  files: string[];
  token: string;
  progress: Progress | null;
  /** When the screenshots and recording were deleted after the PR closed. */
  media_cleared: string | null;
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

export function ago(iso: string | null): string {
  if (!iso) return "–";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Sandbox time for people: "45 s", "12 min", "3 h 05 min". */
export function hours(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function duration(a: string | null, b: string | null): string {
  if (!a) return "–";
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
