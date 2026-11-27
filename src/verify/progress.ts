/**
 * Live progress of a run, for the run page while it is still running. The orchestrator records when
 * each stage starts and merges what the tester writes to `progress.json` (orchestrator/src/verify.rs);
 * the UI only reads it.
 */

export const STAGES = ["sandbox", "copy", "read", "checks", "verdict"] as const;
export type Stage = (typeof STAGES)[number];

export interface LiveCheck {
  expect: string;
  /** null while the check is planned or running. */
  result: "pass" | "fail" | "blocked" | null;
  /** The tester said it is on this check now. */
  active?: true;
  observed?: string;
  /** When the server first saw the result. */
  at?: string;
  /** When the server first saw the tester on this check. */
  started?: string;
  /** A check of what the PR changes: the short video of the change covers it. */
  focus?: true;
}

export interface Progress {
  /** When each stage started; a stage is done when the next one has started. */
  at: Partial<Record<Stage, string>>;
  /** 2 when the copy was fixed and the tester runs again. */
  attempt: number;
  /** When the sandbox stage ended, kept when a second attempt starts the copy again. */
  sandboxDone?: string;
  checks: LiveCheck[];
  /** What the tester said it is doing, newest last, at most `TRAIL`. */
  now: { at: string; text: string }[];
  /** When the recording of this attempt started. */
  recordingAt?: string;
}

/** What the tester said it is doing: at most this many lines. */
export const TRAIL = 3;

export function parseProgress(raw: string | null | undefined): Progress | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Progress;
  } catch {
    return null;
  }
}
