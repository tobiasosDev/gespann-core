import { Check, Circle, ExternalLink, Loader2, Play, Sparkles, Wrench, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ago, api, type ProjectDetail } from "../api.ts";
import { PrRuns, RunsPanel } from "../components/PrRuns.tsx";
import { ScreenSizes } from "../components/ScreenSizes.tsx";
import { ShotList } from "../components/Shots.tsx";
import { Button, Card, CardHeader, Input, Log, Mono, Textarea } from "../components/ui.tsx";
import { navigate, useResource } from "../live.ts";
import { JobStatus, ProjectStatus } from "../nav.tsx";

type StepState = "done" | "running" | "failed" | "todo";

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <Check className="size-4 text-ok" />;
  if (state === "running") return <Loader2 className="size-4 animate-spin text-info motion-reduce:animate-none" />;
  if (state === "failed") return <X className="size-4 text-bad" />;
  return <Circle className="size-4 text-muted-foreground" />;
}

function Step({ n, title, state, summary, action, children }: { n: number; title: string; state: StepState; summary: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-border last:border-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <StepIcon state={state} />
        <span className="w-4 font-mono text-small text-muted-foreground">{n}</span>
        <span className="flex-1 font-medium whitespace-nowrap sm:w-44 sm:flex-none sm:whitespace-normal">{title}</span>
        {/* Phones: the summary takes its own line under the title instead of a narrow column beside it. */}
        <span className="order-last min-w-0 basis-full pl-14 text-body break-words text-muted-foreground sm:order-none sm:basis-0 sm:flex-1 sm:pl-0">{summary}</span>
        {action}
      </div>
      {children && <div className="px-4 pb-4 pl-[3.75rem]">{children}</div>}
    </div>
  );
}

const jobsBusy = (d: ProjectDetail) => d.jobs.some((j) => j.status === "queued" || j.status === "running");

export function Project({ id, tab, onChange }: { id: number; tab: "runs" | "setup"; onChange?: () => void }) {
  const { data: p, error, reload } = useResource<ProjectDetail>(`/projects/${id}`, jobsBusy);
  const [criteria, setCriteria] = useState("");
  const [model, setModel] = useState("");
  const [editing, setEditing] = useState(false);
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  /** Shown at once on a click; the server's list takes over again after the save. */
  const [sizes, setSizes] = useState<string[] | null>(null);

  if (error) return <p className="text-bad">{error}</p>;
  if (!p) return <p className="text-muted-foreground">Loading…</p>;

  const post = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      return await api<{ runId?: number }>(`/projects/${p.id}${path}`, body);
    } finally {
      setBusy(false);
      await reload();
      onChange?.();
    }
  };
  const edit = (text: string) => {
    setCriteria(text);
    setModel(p.model ?? "");
    setEditing(true);
  };
  const setupJob = p.jobs.find((j) => j.kind === "setup");
  const suggestJob = p.jobs.find((j) => j.kind === "suggest");
  const suggesting = suggestJob?.status === "queued" || suggestJob?.status === "running";
  const openrouter = p.agent === "openrouter";
  const keyAgent = p.agent === "claude" ? "Claude Code" : p.agent === "copilot" ? "GitHub Copilot" : p.agent === "grok" ? "Grok" : null;
  const codex: StepState = p.agent_ready ? "done" : !openrouter && p.codex === "pending" ? "running" : "todo";
  const ownerModel = openrouter ? p.openrouter_model : p.codex_model;
  const crit: StepState = "done";
  const setup: StepState = p.setup === "ready" ? "done" : p.setup === "running" || p.setup === "queued" ? "running" : p.setup === "failed" ? "failed" : "todo";
  const start: StepState = p.active ? "done" : "todo";
  const chosen = sizes ?? p.viewports;
  /** The last numbered step before Environment: Screen sizes is only there for web apps. */
  const step = p.platform === "linux" ? 4 : 3;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-title font-semibold">{p.repo}</h1>
        <ProjectStatus p={p} />
        <a className="text-muted-foreground hover:text-foreground" href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer" aria-label="Open on GitHub">
          <ExternalLink className="size-4" />
        </a>
        <span className="ml-auto flex items-center gap-3 font-mono text-small text-muted-foreground">
          <span>branch {p.default_branch}</span>
          {p.sandbox_id && <span>sandbox {p.sandbox_id}</span>}
        </span>
      </div>

      {tab === "setup" ? (
        <>
      <Card className="mb-6">
        <CardHeader title="Setup" description="Once per repository. After that every pull request is tested automatically." />

        <Step
          n={1}
          title="Agent"
          state={codex}
          summary={
            codex === "done" && keyAgent
              ? `Runs in ${keyAgent} on ${p.own ? "your" : "the project owner's"} key${p.agent_model ? ` · model ${p.agent_model}` : ""}.`
              : codex === "done"
              ? openrouter
                ? `Runs on ${p.own ? "your" : "the project owner's"} OpenRouter key · model ${p.openrouter_model ?? "?"}.`
                : `Runs on ${p.own ? "your" : "the project owner's"} ChatGPT plan${p.codex_account ? ` (${p.codex_account})` : ""}${p.codex_model ? ` · model ${p.codex_model}` : ""}.`
              : p.own
                ? keyAgent
                  ? `Add your ${keyAgent} key once in Settings. It is used for all your projects.`
                  : openrouter
                  ? "Add your OpenRouter key and pick a model once in Settings. They are used for all your projects."
                  : "Connect your ChatGPT plan or an OpenRouter key once in Settings. It is used for all your projects."
                : "The project owner has not connected an agent yet."
          }
          action={
            p.own && (
              <Button size="sm" variant={codex === "done" ? "ghost" : "default"} onClick={() => navigate("/settings")}>
                {codex === "done" ? "Settings" : "Connect in Settings"}
              </Button>
            )
          }
        />

        <Step
          n={2}
          title="What to check"
          state={crit}
          summary={
            suggesting
              ? suggestJob?.status === "queued"
                ? "Suggestion queued: Codex starts when the sandbox is free."
                : "Codex reads the repository and proposes checks…"
              : p.criteria.trim()
                ? `${p.criteria.trim().split("\n").length} check(s)${p.model ? ` · model ${p.model}` : ""}`
                : "Default checks. Let Codex suggest concrete ones for this repo, or write your own."
          }
          action={
            !editing && (
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || suggesting || codex !== "done"} onClick={() => post("/suggest")} title={codex !== "done" ? "Connect an agent in Settings first" : undefined}>
                  {suggesting ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Sparkles className="size-3.5" />} Suggest checks
                </Button>
                <Button size="sm" variant="outline" onClick={() => edit(p.criteria)}>
                  Edit
                </Button>
              </div>
            )
          }
        >
          {p.suggestion && !editing && (
            <div className="mb-3 rounded-md border border-info/40 bg-info/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-body font-medium text-info">
                <Sparkles className="size-3.5" /> Suggested by Codex
              </div>
              <Log text={p.suggestion} className="max-h-52" />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => edit(p.suggestion ?? "")}
                >
                  Review and use
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => post("/suggestion/dismiss")}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          {suggestJob?.status === "failed" && !p.suggestion && !editing && <Log text={suggestJob.error ?? "The suggestion failed."} className="mb-3 border-bad/40 text-bad" />}
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                await post("/criteria", { criteria, model });
                setEditing(false);
              }}
            >
              <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder={p.default_checks} />
              <div className="flex items-center gap-2">
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={ownerModel ? `Model (empty = ${ownerModel})` : "Model (empty = Codex default)"} className="max-w-64 font-mono" />
                <Button type="submit" size="sm" disabled={busy}>
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Log text={p.criteria.trim() || p.default_checks} className="max-h-40" />
          )}
        </Step>

        <Step
          n={3}
          title="Platform"
          state="done"
          summary={
            p.platform === "macos"
              ? p.macos_available
                ? "macOS with Xcode and the iOS Simulator: the tester drives your app in the simulator."
                : "macOS, but this instance has no macOS sandboxes yet: jobs wait until it has."
              : "Linux: web apps, APIs and servers, tested in Chrome."
          }
          action={
            <div className="flex gap-1" role="group" aria-label="Platform">
              {(["linux", "macos"] as const).map((pl) => (
                <Button
                  key={pl}
                  size="sm"
                  variant={p.platform === pl ? "default" : "outline"}
                  aria-pressed={p.platform === pl}
                  disabled={busy || (pl !== p.platform && pl === "macos" && !p.macos_available)}
                  title={pl === "macos" && !p.macos_available ? "This instance has no macOS sandboxes" : undefined}
                  onClick={async () => {
                    if (pl === p.platform) return;
                    if (setup !== "todo" && !window.confirm("Switching the platform resets the environment: Prepare runs again in a sandbox of the new platform.")) return;
                    await post("/platform", { platform: pl });
                  }}
                >
                  {pl === "linux" ? "Web app" : "iOS app"}
                </Button>
              ))}
            </div>
          }
        />

        {p.platform === "linux" && (
        <Step
          n={4}
          title="Screen sizes"
          state="done"
          summary={
            chosen.length === 0
              ? "The browser's own size, 1440 × 900. Pick the sizes your users have."
              : `Every check runs at ${chosen.length === 1 ? "one size" : `${chosen.length} sizes at once, side by side`}: ${p.viewport_presets
                  .filter((v) => chosen.includes(v.id))
                  .map((v) => v.name)
                  .join(", ")}.`
          }
        >
          <ScreenSizes
            presets={p.viewport_presets}
            selected={chosen}
            disabled={sizes !== null}
            onChange={async (next) => {
              setSizes(next);
              try {
                await post("/viewports", { viewports: next });
              } finally {
                setSizes(null);
              }
            }}
          />
          {chosen.length > 1 && <p className="mt-2 text-body text-muted-foreground">The tester sees every size at once; each size beyond the first adds about a quarter of the run time.</p>}
        </Step>
        )}

        <Step
          n={step + 1}
          title="Environment"
          state={setup}
          summary={
            setup === "done"
              ? "Recipe ready: the copy starts and stops cleanly."
              : setup === "running"
                ? "Codex writes the scripts and builds the copy. The first build can take an hour."
                : setup === "failed"
                  ? "The copy did not come up."
                  : "Codex writes scripts that start a production-near copy: prod build, DB with a test user, fakes for payment, mail, AI."
          }
          action={
            setup !== "running" && (
              <Button size="sm" variant={setup === "done" ? "outline" : "default"} disabled={busy || codex !== "done"} onClick={() => post("/setup")}>
                {setup === "todo" ? "Prepare" : "Prepare again"}
              </Button>
            )
          }
        >
          {(setup !== "todo" || setupJob) && (
            <div className="space-y-2">
              {p.setup_error && <Log text={p.setup_error} className="border-bad/40 text-bad" />}
              {setupJob?.log && (
                <details open={setup === "running"}>
                  <summary className="cursor-pointer text-body text-muted-foreground">Setup log</summary>
                  <Log text={setupJob.log} className="mt-2" />
                </details>
              )}
              {p.proof && (
                <details>
                  <summary className="cursor-pointer text-body text-muted-foreground">Screenshot after setup</summary>
                  <ShotList shots={[{ src: `/api/projects/${p.id}/setup-proof.png`, caption: "The app on the copy after setup" }]} className="mt-2 max-w-xl" />
                </details>
              )}
              {p.notes && (
                <details>
                  <summary className="cursor-pointer text-body text-muted-foreground">NOTES.md</summary>
                  <Log text={p.notes} className="mt-2" />
                </details>
              )}
              {p.recipe && (
                <details>
                  <summary className="cursor-pointer text-body text-muted-foreground">verify.yml</summary>
                  <Log text={p.recipe} className="mt-2" />
                </details>
              )}
            </div>
          )}
        </Step>

        <Step
          n={step + 2}
          title="Test pull requests"
          state={start}
          summary={p.active ? "On: every matching PR gets the check gespann/verify and a comment." : "Off."}
          action={
            <Button size="sm" variant={p.active ? "outline" : "default"} disabled={busy || setup !== "done"} onClick={() => post("/active", { active: !p.active })}>
              {p.active ? "Pause" : "Start"}
            </Button>
          }
        />

        <Step
          n={step + 3}
          title="Merge gate"
          state={p.gate ? "done" : "todo"}
          summary={p.gate ? "On: a FAIL fails the check gespann/verify, and PRs with the label gespann stay drafts until they pass." : "Off: results are reported, the check never fails, merging stays free."}
          action={
            <Button size="sm" variant={p.gate ? "outline" : "default"} disabled={busy} onClick={() => post("/gate", { gate: !p.gate })}>
              {p.gate ? "Turn off" : "Turn on"}
            </Button>
          }
        >
          <p className="mt-2 text-body text-muted-foreground">
            A PR with the label <Mono>gespann</Mono> stays a draft, which GitHub cannot merge, until its current commit passes. To merge anyway, comment <Mono>/gespann approve</Mono>, click Ready for review, or remove the label. Turning the gate off releases every PR it holds.
          </p>
        </Step>
      </Card>

      {p.jobs.some((j) => j.kind !== "run") && (
        <details className="mt-6">
          <summary className="cursor-pointer text-body text-muted-foreground">Jobs</summary>
          <Card className="mt-2">
            {p.jobs
              .filter((j) => j.kind !== "run")
              .map((j) => (
                <div key={j.id} className="flex items-center gap-3 border-b border-border px-4 py-2 text-body last:border-0">
                  <Mono className="w-10 text-muted-foreground">#{j.id}</Mono>
                  <span className="w-14">{j.kind}</span>
                  <JobStatus job={j} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{j.error ?? ""}</span>
                  <span className="text-muted-foreground">{ago(j.created)}</span>
                </div>
              ))}
          </Card>
        </details>
      )}
        </>
      ) : (
        <>
          {setup !== "done" ? (
            <Card className="mb-6 border-info/40">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Wrench className="size-4 text-info" />
                <span className="min-w-0 flex-1 text-body">Pull requests can be tested once the setup is done. It runs once per repository.</span>
                <Button size="sm" onClick={() => navigate(`/projects/${p.id}/setup`)}>
                  Go to setup
                </Button>
              </div>
            </Card>
          ) : (
            !p.active && (
              <Card className="mb-6 border-warn/40">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1 text-body">New pull requests are not tested automatically while testing is paused.</span>
                  <Button size="sm" disabled={busy} onClick={() => post("/active", { active: true })}>
                    Start testing
                  </Button>
                </div>
              </Card>
            )
          )}
          <div className="flex items-start gap-6">
            <div className="min-w-0 flex-1">
              <PrRuns
                runs={p.runs}
                closed={p.closed}
                header={
                  <CardHeader
                    // Never broken over two lines: on a narrow phone the form wraps under the title instead.
                    title={<span className="whitespace-nowrap">Pull requests</span>}
                    description="Each pull request once, with all its runs. Select a row to open its latest run."
                    // Phones: every row carries a chevron, so the line would only push the list down.
                    descriptionClassName="hidden sm:block"
                    // Phones show the title alone, so it centres on the taller form beside it.
                    className="items-center sm:items-start"
                    action={
                      <form
                        className="flex items-center gap-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const r = await post("/runs", { pr: Number(pr) });
                          if (r.runId) navigate(`/runs/${r.runId}`);
                        }}
                      >
                        <Input value={pr} onChange={(e) => setPr(e.target.value.replace(/\D/g, ""))} placeholder="PR #" inputMode="numeric" aria-label="Pull request number" className="h-11 w-20 font-mono sm:h-9" disabled={setup !== "done"} />
                        <Button size="sm" variant="outline" className="h-11 sm:h-8" disabled={busy || setup !== "done" || !pr}>
                          <Play className="size-3.5" /> Test PR
                        </Button>
                      </form>
                    }
                  />
                }
              />
            </div>
            <RunsPanel runs={p.runs} repo={p.repo} />
          </div>

        </>
      )}
    </>
  );
}
