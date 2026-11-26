import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Me, ProjectRow, RunDetail } from "./api.ts";
import { type Section, Sidebar } from "./components/Sidebar.tsx";
import { LinkButton } from "./components/ui.tsx";
import { usePath, useResource } from "./live.ts";
import { landing, Lockup, projectsBusy } from "./nav.tsx";
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
        <div className="mb-4 flex items-center">
          <Lockup />
        </div>
        <h1 className="text-title font-semibold">Acceptance tests for every pull request</h1>
        <p className="mt-1 mb-5 text-body text-muted-foreground">An agent on your own ChatGPT plan or OpenRouter key clicks through each PR in a production-near copy of your app and reports back on GitHub.</p>
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

function Signed({ me, path }: { me: Me; path: string }) {
  const { data, error, reload } = useResource<{ projects: ProjectRow[] }>("/projects", projectsBusy);
  const projects = data?.projects ?? null;
  // The run page and the sidebar share this request; the sidebar only needs the run's project.
  const runId = path.match(/^\/runs\/(\d+)$/)?.[1];
  const runProject = useResource<RunDetail>(runId ? `/runs/${runId}` : null).data?.project.id ?? null;

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
    page = <Run id={Number(m[1])} />;
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

const SIGNED_OUT: Me = { user: null, githubReady: false, installUrl: null };

function App() {
  const path = usePath();
  const { data, error } = useResource<Me>("/me");
  const me = data ?? (error ? SIGNED_OUT : null);
  if (!me) return null;
  if (!me.user) return <SignIn me={me} />;
  return <Signed me={me} path={path} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
