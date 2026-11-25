import { GitPullRequest, Plus } from "lucide-react";
import { ago, type ProjectRow, useResource } from "../api.ts";
import { Button, Card, Empty, Mono } from "../components/ui.tsx";
import { Link, navigate, ProjectStatus, RunStatus } from "../nav.tsx";

export function Projects() {
  const { data, error } = useResource<{ projects: ProjectRow[] }>("/projects", (d) => d.projects.some((p) => p.setup === "running" || p.last?.status === "running"));
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <Button onClick={() => navigate("/projects/new")}>
          <Plus className="size-4" /> Add project
        </Button>
      </div>
      {error && <p className="mb-3 text-bad">{error}</p>}
      <Card>
        {data && data.projects.length === 0 && <Empty>No projects yet. Add a repository to start.</Empty>}
        {data?.projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-0 hover:bg-accent">
            <span className="min-w-0 flex-1 truncate font-medium">{p.repo}</span>
            <ProjectStatus p={p} />
            {p.last ? (
              <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <GitPullRequest className="size-3.5" />
                <Mono>#{p.last.pr}</Mono>
                <RunStatus run={p.last} />
                <span className="w-16 text-right">{ago(p.last.started ?? p.last.created)}</span>
              </span>
            ) : (
              <span className="text-[13px] text-muted-foreground">no runs</span>
            )}
          </Link>
        ))}
      </Card>
    </>
  );
}
