import { ExternalLink, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ago, api, duration, type Progress, type RunDetail, useResource } from "../api.ts";
import { LiveChecks, RESULT_ICON, StageStrip, useTick, waitingText } from "../components/Live.tsx";
import { ShotList } from "../components/Shots.tsx";
import { Badge, Button, Card, CardHeader, Empty, LinkButton, Log, Mono } from "../components/ui.tsx";
import { Link, navigate, RunStatus } from "../nav.tsx";

const GOAL = { met: RESULT_ICON.pass, missed: RESULT_ICON.fail, blocked: RESULT_ICON.blocked };
const GOAL_TONE = { met: "ok", missed: "bad", blocked: "warn" } as const;

/** `#12` is an issue of the run's repository, `owner/repo#12` one of another. */
function issueUrl(repo: string, ref: string): string {
  const m = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref.trim());
  return m ? `https://github.com/${m[1] ?? repo}/issues/${m[2]}` : `https://github.com/${repo}/issues`;
}

/** "2 passed, 1 failed, 1 is running" for the tester's plan while it works. */
function liveSummary(p: Progress): string {
  const n = (r: string) => p.checks.filter((c) => c.result === r).length;
  const parts = [`${n("pass")} passed`];
  if (n("fail")) parts.push(`${n("fail")} failed`);
  if (n("blocked")) parts.push(`${n("blocked")} blocked`);
  const open = p.checks.filter((c) => !c.result).length;
  if (open) parts.push(`${open} to go`);
  return `The tester planned ${p.checks.length} checks after reading the change. ${parts.join(", ")}.`;
}

export function Run({ id, onProject }: { id: number; onProject?: (project: number) => void }) {
  const { data: r, error } = useResource<RunDetail>(`/runs/${id}`, (d) => d.status === "queued" || d.status === "running");
  const [busy, setBusy] = useState(false);
  const [fullLog, setFullLog] = useState(false);
  const projectId = r?.project.id;
  useEffect(() => {
    if (projectId) onProject?.(projectId);
  }, [projectId, onProject]);
  useTick(r?.status === "running");
  if (error) return <p className="text-bad">{error}</p>;
  if (!r) return <p className="text-muted-foreground">Loading…</p>;
  const v = r.verdict?.verdict ?? null;
  const src = (f: string) => `/proof/${r.token}/${encodeURIComponent(f)}`;
  const images = r.files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
  const video = r.files.find((f) => /\.(mp4|webm)$/i.test(f));
  const live = r.status === "queued" || r.status === "running";
  const livePlan = r.status === "running" && r.progress?.checks.length ? r.progress : null;
  const logLines = r.log.split("\n").filter(Boolean);
  const conflict = r.conflict ? (JSON.parse(r.conflict) as string[]) : null;
  const shots = images.map((f) => {
    const check = v?.checks.find((c) => c.proof?.includes(f));
    const goal = check ? undefined : v?.goals?.find((g) => g.proof?.includes(f));
    return { src: src(f), caption: check?.expect ?? goal?.goal ?? f, result: check?.result ?? (goal ? ({ met: "pass", missed: "fail", blocked: "blocked" } as const)[goal.result] : undefined) };
  });

  const recordingCard = (
    <Card className="mb-6">
      <CardHeader title="Recording" description={video ? "The tester's screen during the whole test." : undefined} />
      {video ? (
        <div className="p-4">
          <video controls playsInline preload="metadata" src={src(video)} poster={shots[0]?.src} className="max-h-[70vh] w-full rounded-md border border-border bg-black object-contain" />
        </div>
      ) : (
        <Empty>{live ? "The recording appears when the tester is done." : r.media_cleared ? `The recording and screenshots were deleted ${ago(r.media_cleared)}, after the pull request closed.` : "This run has no recording. The log below says why."}</Empty>
      )}
    </Card>
  );

  return (
    <>
      <div className="mb-1 text-body text-muted-foreground">
        <Link to={`/projects/${r.project.id}/runs`} className="hover:text-foreground">
          {r.project.repo}
        </Link>{" "}
        / runs / {r.id}
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-title font-semibold">
          <Mono className="text-title text-muted-foreground">#{r.pr}</Mono> {r.title}
        </h1>
        <RunStatus run={r} />
        <div className="ml-auto flex gap-2">
          <LinkButton href={`https://github.com/${r.project.repo}/pull/${r.pr}`} target="_blank" rel="noreferrer" variant="outline" size="sm">
            Pull request <ExternalLink className="size-3.5" />
          </LinkButton>
          {!live && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const n = await api<{ runId: number }>(`/runs/${r.id}/rerun`, {}).finally(() => setBusy(false));
                navigate(`/runs/${n.runId}`);
              }}
            >
              <RotateCw className="size-3.5" /> Rerun
            </Button>
          )}
        </div>
      </div>

      <Card className="mb-6 grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-4">
        {[
          ["Head", <Mono key="h">{r.head.slice(0, 12)}</Mono>],
          ["Base", <Mono key="b">{`${r.base_ref} @ ${r.base.slice(0, 7)}`}</Mono>],
          ["Duration", <Mono key="d">{duration(r.started, r.finished)}</Mono>],
          ["Started", <Mono key="s">{ago(r.started ?? r.created)}</Mono>],
        ].map(([k, val]) => (
          <div key={k as string} className="bg-card px-4 py-3">
            <div className="text-small text-muted-foreground">{k}</div>
            <div className="mt-0.5">{val}</div>
          </div>
        ))}
      </Card>

      {live && <StageStrip progress={r.status === "running" ? r.progress : null} queued={r.status === "queued"} />}

      {v?.summary && <p className="mb-4 max-w-3xl text-body">{v.summary}</p>}
      {conflict && (
        <Card className="mb-4 max-w-3xl px-4 py-3 text-body">
          <p className="font-medium">Not tested: this PR has merge conflicts with {r.base_ref}.</p>
          <p className="mt-1 text-muted-foreground">
            Conflicts in{" "}
            {conflict.map((f, i) => (
              <span key={f}>
                {i > 0 && ", "}
                <Mono>{f}</Mono>
              </span>
            ))}
            . Resolving them is up to the PR's author or coding agent; gespann says so on the pull request and over MCP. Once the branch is updated and pushed, gespann tests the new head; if no run starts (a draft, or a PR outside the recipe's triggers), use Rerun.
          </p>
        </Card>
      )}
      {r.error && <Log text={r.error} className="mb-4 border-bad/40 text-bad" />}
      {r.verdict?.problems.length ? (
        <Card className="mb-4 border-bad/40">
          <CardHeader title="Verdict rejected" description="The tester's verdict broke the rules, so the run counts as FAIL." />
          <ul className="list-disc px-8 py-3 text-body text-bad">
            {r.verdict.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {v?.goals && v.goals.length > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="Issue goals"
            description={`${v.goals.filter((g) => g.result === "met").length} of ${v.goals.length} met, judged against what each linked issue asks for`}
          />
          <ul className="divide-y divide-border">
            {v.goals.map((g, i) => (
              <li key={i} className="flex gap-3 px-4 py-3">
                <span className="mt-0.5 shrink-0" aria-hidden>
                  {GOAL[g.result]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a href={issueUrl(r.project.repo, g.issue)} target="_blank" rel="noreferrer" className="truncate font-mono text-small text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      {g.issue}
                    </a>
                    <span className="ml-auto">
                      <Badge tone={GOAL_TONE[g.result]}>{g.result}</Badge>
                    </span>
                  </div>
                  <p className="mt-0.5 text-body font-medium">{g.goal}</p>
                  {g.observed && <p className="mt-1 max-w-3xl text-body text-muted-foreground">{g.observed}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* While the run runs, its live checks come first; the recording joins them when the tester is done. */}
      {/* A run with merge conflicts tested nothing: no recording or checks to show. */}
      {!live && !conflict && recordingCard}

      {!conflict && (
        <Card className="mb-6">
          <CardHeader
            title="Checks"
            description={v ? `${v.checks.filter((c) => c.result === "pass").length}/${v.checks.length} passed` : livePlan ? liveSummary(livePlan) : undefined}
          />
          {(!v || v.checks.length === 0) && livePlan ? (
            <LiveChecks progress={livePlan} />
          ) : !v || v.checks.length === 0 ? (
            <Empty>{live ? waitingText(r.status === "running" ? r.progress : null, r.status === "queued") : "No checks."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <thead className="text-left text-small text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="w-10 px-4 py-2" />
                    <th className="px-4 py-2 font-medium">Expected</th>
                    <th className="hidden px-4 py-2 font-medium sm:table-cell">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {v.checks.map((c, i) => (
                    <tr key={i} className="border-b border-border align-top last:border-0">
                      <td className="py-3 pr-0 pl-4 sm:pr-4">
                        <span className="flex h-6 items-center">{RESULT_ICON[c.result]}</span>
                      </td>
                      <td className="px-4 py-3 font-medium sm:w-[40%]">
                        {c.expect}
                        <div className="mt-1 text-small font-normal text-muted-foreground sm:hidden">{c.observed}</div>
                      </td>
                      <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{c.observed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {live && recordingCard}

      {images.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Screenshots" description={`${shots.length} from the tester. Select one to see it full screen.`} />
          <ShotList shots={shots} className="p-4" />
        </Card>
      )}

      <Card>
        <CardHeader title="Log" />
        {live && !fullLog && logLines.length > 1 ? (
          <div className="flex items-center gap-4 p-4">
            <span className="min-w-0 flex-1 truncate font-mono text-small text-muted-foreground">{logLines.at(-1)}</span>
            <Button size="sm" variant="outline" onClick={() => setFullLog(true)}>
              Show all {logLines.length} lines
            </Button>
          </div>
        ) : (
          <div className="p-4">{r.log ? <Log text={r.log} /> : <span className="text-body text-muted-foreground">No log yet.</span>}</div>
        )}
      </Card>
    </>
  );
}
