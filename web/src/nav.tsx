import type { ReactNode } from "react";
import type { JobRow, Outcome, ProjectRow, RunRow } from "./api.ts";
import { LOCKUP_MARK_TRANSFORM, LOCKUP_VIEWBOX, LOCKUP_WORDMARK_TRANSFORM, MARK_PATH, MARK_VIEWBOX, WORDMARK_PATH } from "./brand.ts";
import { cn } from "./cn.ts";
import { Badge } from "./components/ui.tsx";
import { navigate } from "./live.ts";

/** Projects whose setup or newest run still changes, so their list keeps reloading. */
export function projectsBusy(d: { projects: ProjectRow[] }): boolean {
  return d.projects.some((p) => p.setup === "running" || p.setup === "queued" || p.last?.status === "running" || p.last?.status === "queued");
}

/** A project opens on Setup until it tests PRs, on Runs after that. */
export function landing(p: Pick<ProjectRow, "setup" | "active">): "runs" | "setup" {
  return p.setup === "ready" && p.active ? "runs" : "setup";
}

/** Plain links that stay inside the app. */
export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; "aria-current"?: "page"; "aria-label"?: string; title?: string }) {
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={cn("size-5 shrink-0", className)} aria-hidden="true">
      <path d={MARK_PATH} fill="currentColor" />
    </svg>
  );
}

export function Lockup({ className }: { className?: string }) {
  return (
    <svg viewBox={LOCKUP_VIEWBOX} className={cn("h-5 w-auto shrink-0", className)} role="img" aria-label="gespann">
      <path d={MARK_PATH} transform={LOCKUP_MARK_TRANSFORM} fill="currentColor" />
      <path d={WORDMARK_PATH} transform={LOCKUP_WORDMARK_TRANSFORM} fill="currentColor" />
    </svg>
  );
}

const OUTCOME_TONE: Record<Outcome, "ok" | "bad" | "warn" | "muted"> = { PASS: "ok", FAIL: "bad", BLOCKED: "warn", SKIP: "muted" };

export function RunStatus({ run }: { run: Pick<RunRow, "status" | "outcome" | "conflict"> }) {
  if (run.status === "queued") return <Badge>queued</Badge>;
  if (run.status === "running") return <Badge tone="info" dot>running</Badge>;
  if (run.status === "cancelled") return <Badge>cancelled</Badge>;
  // Not tested: the PR does not merge onto its base. Grey, the PR's agent updates the branch.
  if (run.conflict) return <Badge>conflict</Badge>;
  // gespann broke off the run before a verdict: not the PR's FAIL.
  if (run.status === "failed") return <Badge>error</Badge>;
  const o = run.outcome ?? "FAIL";
  return <Badge tone={OUTCOME_TONE[o]}>{o}</Badge>;
}

export function ProjectStatus({ p }: { p: Pick<ProjectRow, "active" | "setup"> }) {
  if (p.active) return <Badge tone="ok">active</Badge>;
  if (p.setup === "running" || p.setup === "queued") return <Badge tone="info" dot>preparing</Badge>;
  if (p.setup === "failed") return <Badge tone="bad">setup failed</Badge>;
  if (p.setup === "ready") return <Badge tone="warn">paused</Badge>;
  return <Badge>setup</Badge>;
}

export function JobStatus({ job }: { job: Pick<JobRow, "status"> }) {
  const tone = { queued: "muted", running: "info", done: "ok", failed: "bad", cancelled: "muted" } as const;
  return (
    <Badge tone={tone[job.status]} dot={job.status === "running"}>
      {job.status}
    </Badge>
  );
}
