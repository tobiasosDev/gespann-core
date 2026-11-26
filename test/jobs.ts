import type { Db, JobStatus } from "../src/server/db.ts";

/** The orchestrator took the job: it runs now. */
export function startJob(db: Db, id: number): void {
  db.sql.prepare("update jobs set status = 'running', started = ? where id = ? and status = 'queued'").run(new Date().toISOString(), id);
}

/** The orchestrator ended the job. */
export function endJob(db: Db, id: number, status: JobStatus): void {
  db.sql.prepare("update jobs set status = ?, finished = ? where id = ?").run(status, new Date().toISOString(), id);
}

/** A running orchestrator that runs this many jobs at once (what it writes every 10 s). */
export function orchestrator(db: Db, parallel: number): void {
  db.setSetting("orchestrator", JSON.stringify({ kind: "ssh", parallel, why: "test", instance: "test", beat: new Date().toISOString() }));
}
