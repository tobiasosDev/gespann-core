import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me, type ProjectRow, useResource } from "./api.ts";
import { type Section, Sidebar } from "./components/Sidebar.tsx";
import { LinkButton } from "./components/ui.tsx";
import { Logo, usePath } from "./nav.tsx";
import { NewProject } from "./pages/NewProject.tsx";
import { Project } from "./pages/Project.tsx";
import { Projects } from "./pages/Projects.tsx";
import { Run } from "./pages/Run.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import "./index.css";

/** `wide` lets a page use the width of a wide screen; forms and run reports keep a readable width. */
function Shell({ me, section, projects, wide, children }: { me: Me; section: Section; projects: ProjectRow[] | null; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Sidebar me={me} section={section} projects={projects} />
      <main className="px-4 py-6 md:ml-[60px] md:px-8 sidebar:ml-72">
        <div className={wide ? "mx-auto max-w-[1680px]" : "mx-auto max-w-5xl"}>{children}</div>
      </main>
    </div>
  );
}

function SignIn({ me }: { me: Me }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2 font-semibold">
          <Logo /> gespann
        </div>
        <h1 className="text-title font-semibold">Acceptance tests for every pull request</h1>
        <p className="mt-1 mb-5 text-body text-muted-foreground">An agent on your own Codex plan clicks through each PR in a production-near copy of your app and reports back on GitHub.</p>
        {new URLSearchParams(location.search).has("closed") && <p className="mb-4 text-body text-warn">Sign-in is limited to invited accounts for now. Your GitHub account is not on the list.</p>}
        {me.githubReady ? (
          <LinkButton href="/auth/github" className="w-full">
            Continue with GitHub
          </LinkButton>
        ) : (
          <p className="text-body text-warn">No GitHub App configured on this instance yet.</p>
        )}
      </div>
    </div>
  );
}

/** A bare project URL opens Setup until the project tests PRs, Runs after that. */
function landing(p: Pick<ProjectRow, "setup" | "active">): "runs" | "setup" {
  return p.setup === "ready" && p.active ? "runs" : "setup";
}

function Signed({ me, path }: { me: Me; path: string }) {
  const { data, error, reload } = useResource<{ projects: ProjectRow[] }>("/projects", (d) => d.projects.some((p) => p.setup === "running" || p.setup === "queued" || p.last?.status === "running"));
  const projects = data?.projects ?? null;
  const [runProject, setRunProject] = useState<number | null>(null);
  useEffect(() => void reload(), [path, reload]);
  // A bare project URL gets its tab written into the address bar, so reload and back keep it.
  const bare = path.match(/^\/projects\/(\d+)$/);
  const bareTab = bare ? projects?.find((p) => p.id === Number(bare[1])) : undefined;
  useEffect(() => {
    if (!bare || !bareTab) return;
    history.replaceState(null, "", `/projects/${bare[1]}/${landing(bareTab)}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [bare?.[1], bareTab]);

  let m: RegExpMatchArray | null;
  let section: Section = { kind: "projects" };
  let page: React.ReactNode;
  if (path === "/projects/new") {
    section = { kind: "new" };
    page = <NewProject installUrl={me.installUrl} />;
  } else if ((m = path.match(/^\/projects\/(\d+)(?:\/(runs|setup))?$/))) {
    const id = Number(m[1]);
    const known = projects?.find((p) => p.id === id);
    const tab = (m[2] as "runs" | "setup" | undefined) ?? (known ? landing(known) : null);
    section = { kind: "project", id, tab };
    page = tab ? <Project key={id} id={id} tab={tab} onChange={reload} /> : null;
    if (!tab && projects && !known) page = <p className="text-bad">project not found</p>;
    if (!tab && error) page = <p className="text-bad">{error}</p>;
  } else if ((m = path.match(/^\/runs\/(\d+)$/))) {
    section = runProject ? { kind: "project", id: runProject, tab: "runs" } : { kind: "projects" };
    page = <Run id={Number(m[1])} onProject={setRunProject} />;
  } else if (path === "/settings") {
    section = { kind: "settings" };
    page = <SettingsPage />;
  } else page = <Projects />;
  return (
    <Shell me={me} section={section} projects={projects} wide={path.startsWith("/projects/") && section.kind === "project" && section.tab === "runs"}>
      {page}
    </Shell>
  );
}

function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>("/me").then(setMe, () => setMe({ user: null, githubReady: false, installUrl: null }));
  }, []);
  if (!me) return null;
  if (!me.user) return <SignIn me={me} />;
  return <Signed me={me} path={path} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
