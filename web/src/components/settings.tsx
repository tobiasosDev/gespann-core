import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./ui.tsx";

/** One area of the Settings page: the only one on screen, picked in the list beside it. */
export function SettingsPane({ title, lead, action, children }: { title: ReactNode; lead?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 className="text-title font-semibold">{title}</h2>
        {action}
      </div>
      {lead && <p className="mt-1.5 text-body text-muted-foreground">{lead}</p>}
      <div className="mt-8 space-y-8">{children}</div>
    </section>
  );
}

/** A titled part of a section, e.g. the account or the model. */
export function Block({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-body font-semibold">{title}</h3>
        {aside && <span className="text-small text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/** A bordered list; its rows are separated by lines. Focus rings sit inside it, where its rounded clip leaves them visible. */
export function Rows({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("divide-y divide-border overflow-hidden rounded-lg border border-border bg-card focus-inset", className)}>{children}</div>;
}

export function Radio({ on }: { on: boolean }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]", on ? "border-foreground" : "border-muted-foreground/60")} aria-hidden="true">
      {on && <span className="size-2 rounded-full bg-foreground" />}
    </span>
  );
}

export function Connected() {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ok/15" aria-hidden="true">
      <Check className="size-3.5 text-ok" />
    </span>
  );
}
