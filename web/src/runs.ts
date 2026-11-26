// Runs of one project, grouped per pull request. No React or DOM here, so the tests import it directly.

export interface RunLike {
  id: number;
  pr: number;
  title: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  outcome: "PASS" | "FAIL" | "BLOCKED" | "SKIP" | null;
  started: string | null;
  finished: string | null;
}

/** Where a pull request stands, by its latest run that was not cancelled. */
export type PrState = "running" | "attention" | "passing" | "cancelled";

/** What one run ended as, for the history squares and the counts. */
export type RunResult = "running" | "queued" | "pass" | "fail" | "blocked" | "skip" | "cancelled";

export function result(r: Pick<RunLike, "status" | "outcome">): RunResult {
  if (r.status === "running") return "running";
  if (r.status === "queued") return "queued";
  if (r.status === "cancelled") return "cancelled";
  if (r.status === "failed") return "fail";
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
}

/** One group per PR, in the order of each PR's newest run. `runs` must come newest first. */
export function groupByPr<R extends RunLike>(runs: R[]): PrGroup<R>[] {
  const by = new Map<number, R[]>();
  for (const r of runs) {
    const list = by.get(r.pr);
    if (list) list.push(r);
    else by.set(r.pr, [r]);
  }
  return [...by.entries()].map(([pr, list]) => {
    const latest = list.find((r) => r.status !== "cancelled") ?? (list[0] as R);
    const res = result(latest);
    const state: PrState =
      res === "running" || res === "queued" ? "running" : res === "cancelled" ? "cancelled" : res === "pass" || res === "skip" ? "passing" : "attention";
    return { pr, title: list.find((r) => r.title)?.title ?? null, runs: list, latest, state };
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
  const c: Record<RunResult, number> = { running: 0, queued: 0, pass: 0, fail: 0, blocked: 0, skip: 0, cancelled: 0 };
  for (const r of runs) c[result(r)]++;
  return c;
}
