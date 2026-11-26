import type { Db } from "./db.ts";
import { now } from "./db.ts";
import type { Github, PullRequest } from "./github.ts";

/** Often enough to catch a missed webhook the same day, rare enough to cost one GitHub call per open PR. */
const EVERY = 6 * 3600_000;

const logError = (at: string, err: Error) => console.error(JSON.stringify({ level: "error", at, message: err.message }));

/** Records whether the PR is merged, closed or open, as GitHub has it now. */
export function recordPrState(db: Db, projectId: number, pr: Pick<PullRequest, "number" | "state" | "merged" | "closed_at">): void {
  db.setPrClosed(projectId, pr.number, pr.state === "open" ? null : { at: pr.closed_at ?? now(), merged: !!pr.merged });
}

/**
 * Asks GitHub about every PR with runs that gespann still counts as open, and marks the merged and
 * closed ones. The webhook marks them as they close; this finds the ones closed before gespann
 * stored that, or while the server was down. Returns how many it marked.
 */
export async function syncClosedPrs(d: { db: Db; github: () => Github }): Promise<number> {
  let marked = 0;
  for (const p of d.db.openPrsWithRuns()) {
    const pr = await d
      .github()
      .pull(p.installation_id, p.repo, p.pr)
      .catch((err: Error) => (logError(`pr sync ${p.repo}#${p.pr}`, err), null));
    if (!pr || pr.state === "open") continue;
    recordPrState(d.db, p.project_id, pr);
    marked++;
  }
  return marked;
}

/** Syncs half a minute after start, then every six hours. */
export function startPrSync(d: { db: Db; github: () => Github }): void {
  const sync = () => void syncClosedPrs(d).catch((err: Error) => logError("pr sync", err));
  setTimeout(sync, 30_000).unref();
  setInterval(sync, EVERY).unref();
}
