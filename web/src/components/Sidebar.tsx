import { BookOpen, Check, ChevronRight, FolderGit2, History, Link2, LogOut, Menu, Plus, Settings, Wrench, X } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api, type Me, type ProjectRow } from "../api.ts";
import { Link, Logo, usePath } from "../nav.tsx";
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

function rowClass(active?: boolean, indent?: boolean) {
  return cn(
    "relative flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-body transition-colors",
    indent && "ml-3.5 w-[calc(100%-0.875rem)] pl-3",
    active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
}

/** One row in the sidebar. The active row carries the blue bar from the logo on its left edge. */
function Item({ to, active, icon, children, trailing, external, server, indent }: { to: string; active?: boolean; icon?: ReactNode; children: ReactNode; trailing?: ReactNode; external?: boolean; server?: boolean; indent?: boolean }) {
  const cls = rowClass(active, indent);
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
  // A page the server serves itself (a server module's), so a full page load, not a client route.
  if (server)
    return (
      <a href={to} className={cls}>
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
  // A project row only folds its pages in and out; it never navigates, so the mobile drawer stays open.
  // The project of the open page is unfolded on every arrival, also on another page of the same project.
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set(current === null ? [] : [current]));
  const path = usePath();
  useEffect(() => {
    if (current !== null) setUnfolded((s) => (s.has(current) ? s : new Set(s).add(current)));
  }, [path, current]);
  const toggle = (id: number) =>
    setUnfolded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const nav = (
    <nav className="flex h-full flex-col gap-5 px-3 py-4" aria-label="Main">
      <Link to="/projects" className="flex items-center gap-2 px-2 font-semibold tracking-tight">
        <Logo />
        gespann
      </Link>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-1 flex items-center justify-between px-2">
          <Link to="/projects" className={cn("text-small font-medium", section.kind === "projects" ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            Projects
          </Link>
          <Link to="/projects/new" className={cn("rounded p-0.5 hover:bg-accent", section.kind === "new" ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <Plus className="size-3.5" aria-label="Add project" />
          </Link>
        </div>
        {projects?.length === 0 && (
          <Link to="/projects/new" className="block px-2 py-1.5 text-body text-muted-foreground hover:text-foreground">
            Add your first repository
          </Link>
        )}
        <ul className="space-y-0.5">
          {projects?.map((p) => {
            const here = p.id === current;
            const open = unfolded.has(p.id);
            const [owner, name] = p.repo.split("/");
            const tab = section.kind === "project" && here ? section.tab : null;
            return (
              <li key={p.id}>
                <button type="button" className={cn(rowClass(), "cursor-pointer")} aria-expanded={open} onClick={() => toggle(p.id)}>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <FolderGit2 className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-small text-muted-foreground">{owner}/</span>
                    <span className={here ? "text-foreground" : undefined}>{name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <StatusDot tone={projectDot(p)} label={DOT_LABEL[projectDot(p)]} />
                    <ChevronRight className={cn("size-3.5 opacity-60 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
                  </span>
                </button>
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
        {me.links?.map((l) => (
          <Item key={l.href} to={l.href} server icon={<Link2 className="size-4" />}>
            {l.label}
          </Item>
        ))}
        <Item to="https://github.com/tobiasosDev/gespann-core" external icon={<BookOpen className="size-4" />}>
          Docs
        </Item>
        {me.user && (
          <div className="flex items-center gap-2.5 px-2 pt-2">
            {me.user.avatar ? <img src={me.user.avatar} alt="" className="size-5 rounded-full" /> : <span className="size-5 rounded-full bg-muted" />}
            <span className="min-w-0 flex-1 truncate font-mono text-small text-muted-foreground">{me.user.login}</span>
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
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-border bg-card sidebar:block">{nav}</aside>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[60px] border-r border-border bg-card md:block sidebar:hidden">
        <Rail me={me} section={section} projects={projects} />
      </aside>
      <MobileBar section={section}>{nav}</MobileBar>
    </>
  );
}

/** Two letters for a repository in the rail: "gespann-core" gives "gc", "acurio" gives "ac". */
function initials(repo: string): string {
  const name = repo.split("/").pop() ?? repo;
  const parts = name.split(/[-_.]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2)).toLowerCase();
}

function railClass(active?: boolean) {
  return cn(
    "relative flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
    active && "bg-accent text-foreground",
  );
}

/** Between md and the sidebar breakpoint the sidebar folds into a rail of icons, so the page keeps the width. */
function Rail({ me, section, projects }: { me: Me; section: Section; projects: ProjectRow[] | null }) {
  const current = section.kind === "project" ? section.id : null;
  const tab = section.kind === "project" ? section.tab : null;
  return (
    <nav className="flex h-full flex-col items-center gap-1 py-4" aria-label="Main">
      <Link to="/projects" className="mb-3 flex size-10 items-center justify-center" aria-label="gespann, all projects" title="All projects">
        <Logo />
      </Link>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {projects?.map((p) => {
          const here = p.id === current;
          return (
            <Fragment key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className={cn(railClass(here), "border font-mono text-small", here ? "border-foreground/25" : "border-border")}
                title={`${p.repo}, ${DOT_LABEL[projectDot(p)]}`}
                aria-label={p.repo}
                aria-current={here && tab === null ? "page" : undefined}
              >
                {initials(p.repo)}
                <span className="absolute top-1 right-1 flex">
                  <StatusDot tone={projectDot(p)} label={DOT_LABEL[projectDot(p)]} />
                </span>
              </Link>
              {here && (
                <>
                  <Link to={`/projects/${p.id}/runs`} className={railClass(tab === "runs")} title="Runs" aria-label="Runs" aria-current={tab === "runs" ? "page" : undefined}>
                    <History className="size-4" />
                  </Link>
                  <Link to={`/projects/${p.id}/setup`} className={railClass(tab === "setup")} title="Setup" aria-label="Setup" aria-current={tab === "setup" ? "page" : undefined}>
                    <Wrench className="size-4" />
                  </Link>
                  <span className="my-1 h-px w-7 bg-border" aria-hidden="true" />
                </>
              )}
            </Fragment>
          );
        })}
        <Link to="/projects/new" className={railClass(section.kind === "new")} title="Add project" aria-label="Add project">
          <Plus className="size-4" />
        </Link>
      </div>
      <div className="flex flex-col items-center gap-1 border-t border-border pt-3">
        <Link to="/settings" className={railClass(section.kind === "settings")} title="Settings" aria-label="Settings" aria-current={section.kind === "settings" ? "page" : undefined}>
          <Settings className="size-4" />
        </Link>
        {me.links?.map((l) => (
          <a key={l.href} href={l.href} className={railClass()} title={l.label} aria-label={l.label}>
            <Link2 className="size-4" />
          </a>
        ))}
        <a href="https://github.com/tobiasosDev/gespann-core" target="_blank" rel="noreferrer" className={railClass()} title="Docs" aria-label="Docs">
          <BookOpen className="size-4" />
        </a>
        {me.user && (
          <button
            className={cn(railClass(), "cursor-pointer")}
            title={`Sign out ${me.user.login}`}
            aria-label={`Sign out ${me.user.login}`}
            onClick={async () => {
              await api("/logout", {});
              location.href = "/";
            }}
          >
            <LogOut className="size-4" />
          </button>
        )}
      </div>
    </nav>
  );
}

/** Below md the sidebar becomes a drawer behind a menu button. It closes on every navigation, not when a project folds open. */
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
          {/* Every link closes the drawer, also one to the page already open. This runs after the link's own
              handler (bubble, not capture): unmounting first would drop that handler and reload the whole page. */}
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-card shadow-xl" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
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
