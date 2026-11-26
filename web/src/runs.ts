// Runs of one project, grouped per pull request. No React or DOM here, so the tests import it directly.

export interface RunLike {
  id: number;
  pr: number;
  title: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  outcome: "PASS" | "FAIL" | "BLOCKED" | "SKIP" | null;
  started: string | null;
  finished: string | null;
  /** Set when the PR does not merge onto its base: nothing was tested. */
  conflict?: string | null;
}

/**
 * Where a pull request stands, by its latest run that was not cancelled. A merged or closed PR is
 * `closed` whatever its last run said, unless a run of it still runs.
 */
export type PrState = "running" | "attention" | "error" | "conflict" | "passing" | "cancelled" | "closed";

/**
 * What one run ended as, for the history squares and the counts. `error`: gespann broke off the run
 * (server restart, the copy did not start, git failed) before the tester gave a verdict.
 */
export type RunResult = "running" | "queued" | "pass" | "fail" | "blocked" | "skip" | "conflict" | "error" | "cancelled";

export function result(r: Pick<RunLike, "status" | "outcome" | "conflict">): RunResult {
  if (r.status === "running") return "running";
  if (r.status === "queued") return "queued";
  if (r.status === "cancelled") return "cancelled";
  if (r.conflict) return "conflict";
  if (r.status === "failed") return "error";
  if (r.outcome === "PASS") return "pass";
  if (r.outcome === "BLOCKED") return "blocked";
  if (r.outcome === "SKIP") return "skip";
  return "fail";
}

export interface PrGroup<R extends RunLike> {
  pr: number;
  title: string | null;
  /** Newest first. */
  runs: R[];
  /** The run the row stands for: the newest one that was not cancelled, else the newest. */
  latest: R;
  state: PrState;
  /** Set when the PR is merged or closed. */
  closed?: "merged" | "closed";
}

/** A merged or closed PR, as the server reports it. */
export interface ClosedPr {
  pr: number;
  merged: boolean;
}

const STATE: Record<RunResult, PrState> = {
  running: "running",
  queued: "running",
  cancelled: "cancelled",
  conflict: "conflict",
  error: "error",
  pass: "passing",
  skip: "passing",
  fail: "attention",
  blocked: "attention",
};

/** One group per PR, in the order of each PR's newest run. `runs` must come newest first. */
export function groupByPr<R extends RunLike>(runs: R[], closed: ClosedPr[] = []): PrGroup<R>[] {
  const ended = new Map(closed.map((c) => [c.pr, c.merged ? ("merged" as const) : ("closed" as const)]));
  const by = new Map<number, R[]>();
  for (const r of runs) {
    const list = by.get(r.pr);
    if (list) list.push(r);
    else by.set(r.pr, [r]);
  }
  return [...by.entries()].map(([pr, list]) => {
    const latest = list.find((r) => r.status !== "cancelled") ?? (list[0] as R);
    const own = STATE[result(latest)];
    const end = ended.get(pr);
    const state: PrState = end && own !== "running" ? "closed" : own;
    return { pr, title: list.find((r) => r.title)?.title ?? null, runs: list, latest, state, ...(end ? { closed: end } : {}) };
  });
}

const seconds = (r: RunLike) => (r.started && r.finished ? (Date.parse(r.finished) - Date.parse(r.started)) / 1000 : null);

/** Median length of the passed runs, the yardstick for a running one. Null with fewer than three. */
export function usualSeconds(runs: RunLike[]): number | null {
  const s = runs
    .filter((r) => result(r) === "pass")
    .map(seconds)
    .filter((x): x is number => x !== null && x > 0)
    .sort((a, b) => a - b);
  if (s.length < 3) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** How many of the runs ended which way; the parts add up to runs.length. */
export function counts(runs: RunLike[]): Record<RunResult, number> {
  const c: Record<RunResult, number> = { running: 0, queued: 0, pass: 0, fail: 0, blocked: 0, skip: 0, conflict: 0, error: 0, cancelled: 0 };
  for (const r of runs) c[result(r)]++;
  return c;
}
