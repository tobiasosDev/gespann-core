import type { Sandboxes } from "./sandbox.ts";

/**
 * What one job takes on the sandbox host at its peak: a Docker build of the app, the running copy,
 * Codex and a browser. A host gets as many jobs at once as it has room for both.
 */
export const PER_JOB = { cpus: 4, memoryGb: 8 } as const;
/** Without a reading of the host (a provider that cannot tell, or the host did not answer). */
export const DEFAULT_PARALLEL = 2;

export interface Parallel {
  jobs: number;
  /** For the log: where the number came from. */
  why: string;
}

/** Jobs that fit a host of this size; at least one. */
export function jobsFor(cpus: number, memoryGb: number): number {
  return Math.max(1, Math.min(Math.floor(cpus / PER_JOB.cpus), Math.floor(memoryGb / PER_JOB.memoryGb)));
}

/** `MAX_PARALLEL_JOBS` when set; otherwise from the sandbox host's CPUs and memory. */
export async function parallelJobs(max: number | null, sb: Pick<Sandboxes, "capacity">): Promise<Parallel> {
  if (max) return { jobs: max, why: "MAX_PARALLEL_JOBS" };
  if (!sb.capacity) return { jobs: DEFAULT_PARALLEL, why: "default: the sandbox provider does not report its size" };
  try {
    const c = await sb.capacity();
    if (!(c.cpus > 0) || !(c.memoryGb > 0)) throw new Error(`it reported ${c.cpus} CPUs and ${c.memoryGb} GB`);
    return { jobs: jobsFor(c.cpus, c.memoryGb), why: `${c.cpus} CPUs and ${Math.round(c.memoryGb)} GB on the sandbox host, ${PER_JOB.cpus} CPUs and ${PER_JOB.memoryGb} GB per job` };
  } catch (err) {
    return { jobs: DEFAULT_PARALLEL, why: `default: could not read the sandbox host's size (${(err as Error).message.slice(0, 200)})` };
  }
}
