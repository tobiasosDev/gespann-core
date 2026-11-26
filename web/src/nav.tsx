import { useEffect, useState, type ReactNode } from "react";
import type { JobRow, Outcome, ProjectRow, RunRow } from "./api.ts";
import { Badge } from "./components/ui.tsx";

export function navigate(to: string): void {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
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

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
      <path d="M7 6h4v20H7zM21 6h4v20h-4z" className="fill-foreground" />
      <path d="M7 14h18v4H7z" className="fill-info" />
    </svg>
  );
}

const OUTCOME_TONE: Record<Outcome, "ok" | "bad" | "warn" | "muted"> = { PASS: "ok", FAIL: "bad", BLOCKED: "warn", SKIP: "muted" };

export function RunStatus({ run }: { run: Pick<RunRow, "status" | "outcome"> }) {
  if (run.status === "queued") return <Badge>queued</Badge>;
  if (run.status === "running") return <Badge tone="info" dot>running</Badge>;
  if (run.status === "cancelled") return <Badge>cancelled</Badge>;
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
