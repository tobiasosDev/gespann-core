import { GitPullRequest, Plus } from "lucide-react";
import { ago, type ProjectRow } from "../api.ts";
import { Button, Card, Empty, Mono } from "../components/ui.tsx";
import { navigate, useResource } from "../live.ts";
import { landing, Link, projectsBusy, ProjectStatus, RunStatus } from "../nav.tsx";

// One grid for the whole list: every row is a subgrid, so status, PR, verdict
// and time line up in the same column from the first row to the last.
// Phones: the repo takes its own line, status, PR and verdict sit below it, still aligned, and the time below them.
const row = "col-span-full grid grid-cols-subgrid items-center gap-y-1.5 px-4";

export function Projects() {
  const { data, error } = useResource<{ projects: ProjectRow[] }>("/projects", projectsBusy);
  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-title font-semibold">Projects</h1>
        <Button onClick={() => navigate("/projects/new")}>
          <Plus className="size-4" /> Add project
        </Button>
      </div>
      {error && <p className="mb-3 text-bad">{error}</p>}
      <Card>
        {data && data.projects.length === 0 && <Empty>No projects yet. Add a repository to start.</Empty>}
        {data && data.projects.length > 0 && (
          <div className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)] gap-x-4 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] sm:gap-x-6">
            <div className={`${row} hidden border-b border-border py-2 text-small font-medium text-muted-foreground sm:grid`}>
              <span>Repository</span>
              <span>Status</span>
              <span>Last PR</span>
              <span>Verdict</span>
              <span className="text-right">Tested</span>
            </div>
            {data.projects.map((p) => (
              <Link key={p.id} to={`/projects/${p.id}/${landing(p)}`} className={`${row} border-b border-border py-3 last:border-0 hover:bg-accent`}>
                <span className="col-span-full truncate font-medium sm:col-span-1">{p.repo}</span>
                <span className="flex">
                  <ProjectStatus p={p} />
                </span>
                {p.last ? (
                  <>
                    <span className="flex items-center gap-1.5 text-body text-muted-foreground">
                      <GitPullRequest className="size-3.5" />
                      <Mono className="tabular-nums">#{p.last.pr}</Mono>
                    </span>
                    <span className="flex">
                      <RunStatus run={p.last} />
                    </span>
                    <span className="col-span-full text-body whitespace-nowrap text-muted-foreground sm:col-span-1 sm:text-right">{ago(p.last.started ?? p.last.created)}</span>
                  </>
                ) : (
                  <span className="col-span-3 text-body text-muted-foreground">no runs</span>
                )}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
