import { BookOpen, Check, FolderGit2, History, LogOut, Menu, Plus, Settings, Wrench, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type Me, type ProjectRow } from "../api.ts";
import { Link, Logo } from "../nav.tsx";
import { cn } from "./ui.tsx";

type Dot = "ok" | "info" | "bad" | "warn" | "muted";

function projectDot(p: Pick<ProjectRow, "active" | "setup">): Dot {
  if (p.active) return "ok";
  if (p.setup === "running" || p.setup === "queued") return "info";
  if (p.setup === "failed") return "bad";
  if (p.setup === "ready") return "warn";
  return "muted";
}

const DOT: Record<Dot, string> = { ok: "bg-ok", info: "bg-info animate-pulse motion-reduce:animate-none", bad: "bg-bad", warn: "bg-warn", muted: "bg-muted-foreground/40" };

function StatusDot({ tone, label }: { tone: Dot; label: string }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} role="img" aria-label={label} />;
}

const DOT_LABEL: Record<Dot, string> = { ok: "active", info: "preparing", bad: "setup failed", warn: "paused", muted: "setup not done" };

/** One row in the sidebar. The active row carries the blue bar from the logo on its left edge. */
function Item({ to, active, icon, children, trailing, external, indent }: { to: string; active?: boolean; icon?: ReactNode; children: ReactNode; trailing?: ReactNode; external?: boolean; indent?: boolean }) {
  const cls = cn(
    "relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
    indent && "ml-3.5 pl-3",
    active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
  const inner = (
    <>
      {active && <span className={cn("absolute top-1.5 bottom-1.5 w-[3px] rounded-full bg-info", indent ? "-left-[1px]" : "-left-2.5")} aria-hidden="true" />}
      {icon && <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  );
  if (external)
    return (
      <a href={to} target="_blank" rel="noreferrer" className={cls}>
        {inner}
      </a>
    );
  return (
    <Link to={to} className={cls} aria-current={active ? "page" : undefined}>
      {inner}
    </Link>
  );
}

function SetupMark({ p }: { p: Pick<ProjectRow, "active" | "setup"> }) {
  if (p.setup === "ready" && p.active) return <Check className="size-3.5 text-ok" aria-label="done" />;
  const tone = projectDot(p);
  return <StatusDot tone={tone === "ok" ? "warn" : tone} label="needs attention" />;
}

export type Section = { kind: "projects" } | { kind: "new" } | { kind: "settings" } | { kind: "project"; id: number; tab: "runs" | "setup" | null };

export function Sidebar({ me, section, projects }: { me: Me; section: Section; projects: ProjectRow[] | null }) {
  const current = section.kind === "project" ? section.id : null;
  const nav = (
    <nav className="flex h-full flex-col gap-5 px-3 py-4" aria-label="Main">
      <Link to="/projects" className="flex items-center gap-2 px-2 font-semibold tracking-tight">
        <Logo />
        gespann
      </Link>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-1 flex items-center justify-between px-2">
          <Link to="/projects" className={cn("text-[12px] font-medium", section.kind === "projects" ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            Projects
          </Link>
          <Link to="/projects/new" className={cn("rounded p-0.5 hover:bg-accent", section.kind === "new" ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <Plus className="size-3.5" aria-label="Add project" />
          </Link>
        </div>
        {projects?.length === 0 && (
          <Link to="/projects/new" className="block px-2 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            Add your first repository
          </Link>
        )}
        <ul className="space-y-0.5">
          {projects?.map((p) => {
            const open = p.id === current;
            const [owner, name] = p.repo.split("/");
            const tab = section.kind === "project" && open ? section.tab : null;
            return (
              <li key={p.id}>
                <Item to={`/projects/${p.id}`} active={open && tab === null} icon={<FolderGit2 className="size-4" />} trailing={<StatusDot tone={projectDot(p)} label={DOT_LABEL[projectDot(p)]} />}>
                  <span className="text-muted-foreground">{owner}/</span>
                  <span className={open ? "text-foreground" : undefined}>{name}</span>
                </Item>
                {open && (
                  <div className="relative mt-0.5 mb-1.5 space-y-0.5 before:absolute before:top-0 before:bottom-0 before:left-[1.125rem] before:w-px before:bg-border">
                    <Item indent to={`/projects/${p.id}/runs`} active={tab === "runs"} icon={<History className="size-3.5" />}>
                      Runs
                    </Item>
                    <Item indent to={`/projects/${p.id}/setup`} active={tab === "setup"} icon={<Wrench className="size-3.5" />} trailing={<SetupMark p={p} />}>
                      Setup
                    </Item>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-0.5 border-t border-border pt-3">
        <Item to="/settings" active={section.kind === "settings"} icon={<Settings className="size-4" />}>
          Settings
        </Item>
        <Item to="https://github.com/tobiasosDev/gespann-core" external icon={<BookOpen className="size-4" />}>
          Docs
        </Item>
        {me.user && (
          <div className="flex items-center gap-2.5 px-2 pt-2">
            {me.user.avatar ? <img src={me.user.avatar} alt="" className="size-5 rounded-full" /> : <span className="size-5 rounded-full bg-muted" />}
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{me.user.login}</span>
            <button
              className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Sign out"
              aria-label="Sign out"
              onClick={async () => {
                await api("/logout", {});
                location.href = "/";
              }}
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        )}
      </div>
    </nav>
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 border-r border-border bg-card md:block">{nav}</aside>
      <MobileBar section={section}>{nav}</MobileBar>
    </>
  );
}

/** Below md the sidebar becomes a drawer behind a menu button. It closes on every navigation. */
function MobileBar({ section, children }: { section: Section; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const key = JSON.stringify(section);
  useEffect(() => setOpen(false), [key]);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);
  return (
    <div className="md:hidden">
      <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur">
        <button className="-ml-1 cursor-pointer rounded p-1 hover:bg-accent" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}>
          <Menu className="size-5" />
        </button>
        <Link to="/projects" className="flex items-center gap-2 font-semibold">
          <Logo /> gespann
        </Link>
      </header>
      {open && (
        <div className="fixed inset-0 z-30">
          <button className="absolute inset-0 cursor-default bg-black/40" aria-label="Close navigation" onClick={() => setOpen(false)} />
          {/* Every link closes the drawer, also one to the page already open. */}
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-card shadow-xl" onClickCapture={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
            <button className="absolute top-3.5 right-3 cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close navigation" onClick={() => setOpen(false)}>
              <X className="size-4" />
            </button>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
