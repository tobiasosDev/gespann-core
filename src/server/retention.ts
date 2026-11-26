import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";
import { now } from "./db.ts";
import type { Github } from "./github.ts";

/** Screenshots and recordings; verdict.json and other data files stay. */
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|webm)$/i;
const DAY = 86_400_000;
/** Often enough for a limit counted in days, rare enough to cost one GitHub call per kept PR a few times a day. */
const EVERY = 6 * 3600_000;

export interface MediaSweepDeps {
  db: Db;
  github: () => Github;
  dataDir: string;
  /** Days after a PR closed until its runs' media go. */
  days: number;
  now?: () => number;
}

const logError = (at: string, err: Error) => console.error(JSON.stringify({ level: "error", at, message: err.message }));

/**
 * Deletes the screenshots and recordings of every PR that closed (merged or not) more than `days` ago.
 * The run, its verdict and checks stay. GitHub says whether and when the PR closed, so PRs closed
 * before this ran, or while the server was down, are found too, and a reopened PR keeps its media.
 * Returns the ids of the runs it cleared.
 */
export async function sweepMedia(d: MediaSweepDeps): Promise<number[]> {
  const cutoff = (d.now ?? Date.now)() - d.days * DAY;
  const byPr = new Map<string, (ReturnType<Db["runsWithMedia"]>[number] & { media: string[] })[]>();
  for (const run of d.db.runsWithMedia()) {
    const media = (JSON.parse(run.files) as string[]).filter((f) => MEDIA.test(f));
    if (!media.length) continue;
    const key = `${run.project_id}#${run.pr}`;
    byPr.set(key, [...(byPr.get(key) ?? []), { ...run, media }]);
  }
  const cleared: number[] = [];
  for (const runs of byPr.values()) {
    const first = runs[0]!;
    const pr = await d
      .github()
      .pull(first.installation_id, first.repo, first.pr)
      .catch((err: Error) => (logError(`media sweep ${first.repo}#${first.pr}`, err), null));
    if (!pr || pr.state === "open" || !pr.closed_at || Date.parse(pr.closed_at) > cutoff) continue;
    for (const run of runs) {
      // Files first: a run whose files could not all be removed is tried again by the next sweep.
      try {
        for (const f of run.media) rmSync(join(d.dataDir, "runs", String(run.id), f), { force: true });
      } catch (err) {
        logError(`media sweep run ${run.id}`, err as Error);
        continue;
      }
      d.db.updateRun(run.id, { files: JSON.stringify((JSON.parse(run.files) as string[]).filter((f) => !MEDIA.test(f))), media_cleared: now() });
      cleared.push(run.id);
    }
  }
  return cleared;
}

/** Sweeps a minute after start, then every six hours. */
export function startMediaSweep(d: MediaSweepDeps): void {
  const sweep = () =>
    void sweepMedia(d).then(
      (ids) => ids.length && console.log(JSON.stringify({ level: "info", message: `deleted the screenshots and recordings of ${ids.length} runs whose PR closed more than ${d.days} days ago` })),
      (err: Error) => logError("media sweep", err),
    );
  setTimeout(sweep, 60_000).unref();
  setInterval(sweep, EVERY).unref();
}
