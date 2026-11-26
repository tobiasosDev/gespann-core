import { Check, ExternalLink, Minus, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ago, api, duration, type RunDetail, useResource } from "../api.ts";
import { ShotList } from "../components/Shots.tsx";
import { Badge, Button, Card, CardHeader, Empty, LinkButton, Log, Mono } from "../components/ui.tsx";
import { Link, navigate, RunStatus } from "../nav.tsx";

const ICON = {
  pass: <Check className="size-4 text-ok" />,
  fail: <X className="size-4 text-bad" />,
  blocked: <Minus className="size-4 text-warn" />,
};
const GOAL = { met: ICON.pass, missed: ICON.fail, blocked: ICON.blocked };
const GOAL_TONE = { met: "ok", missed: "bad", blocked: "warn" } as const;

/** `#12` is an issue of the run's repository, `owner/repo#12` one of another. */
function issueUrl(repo: string, ref: string): string {
  const m = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref.trim());
  return m ? `https://github.com/${m[1] ?? repo}/issues/${m[2]}` : `https://github.com/${repo}/issues`;
}

export function Run({ id, onProject }: { id: number; onProject?: (project: number) => void }) {
  const { data: r, error } = useResource<RunDetail>(`/runs/${id}`, (d) => d.status === "queued" || d.status === "running");
  const [busy, setBusy] = useState(false);
  const projectId = r?.project.id;
  useEffect(() => {
    if (projectId) onProject?.(projectId);
  }, [projectId, onProject]);
  if (error) return <p className="text-bad">{error}</p>;
  if (!r) return <p className="text-muted-foreground">Loading…</p>;
  const v = r.verdict?.verdict ?? null;
  const src = (f: string) => `/proof/${r.token}/${encodeURIComponent(f)}`;
  const images = r.files.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
  const video = r.files.find((f) => /\.(mp4|webm)$/i.test(f));
  const live = r.status === "queued" || r.status === "running";
  const shots = images.map((f) => {
    const check = v?.checks.find((c) => c.proof?.includes(f));
    const goal = check ? undefined : v?.goals?.find((g) => g.proof?.includes(f));
    return { src: src(f), caption: check?.expect ?? goal?.goal ?? f, result: check?.result ?? (goal ? ({ met: "pass", missed: "fail", blocked: "blocked" } as const)[goal.result] : undefined) };
  });

  return (
    <>
      <div className="mb-1 text-[13px] text-muted-foreground">
        <Link to={`/projects/${r.project.id}/runs`} className="hover:text-foreground">
          {r.project.repo}
        </Link>{" "}
        / runs / {r.id}
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">
          <Mono className="text-xl text-muted-foreground">#{r.pr}</Mono> {r.title}
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
          ["Started", <span key="s">{ago(r.started ?? r.created)}</span>],
        ].map(([k, val]) => (
          <div key={k as string} className="bg-card px-4 py-3">
            <div className="text-[12px] text-muted-foreground">{k}</div>
            <div className="mt-0.5">{val}</div>
          </div>
        ))}
      </Card>

      {v?.summary && <p className="mb-4 max-w-3xl text-[15px]">{v.summary}</p>}
      {r.error && <Log text={r.error} className="mb-4 border-bad/40 text-bad" />}
      {r.verdict?.problems.length ? (
        <Card className="mb-4 border-bad/40">
          <CardHeader title="Verdict rejected" description="The tester's verdict broke the rules, so the run counts as FAIL." />
          <ul className="list-disc px-8 py-3 text-[13px] text-bad">
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
                    <a href={issueUrl(r.project.repo, g.issue)} target="_blank" rel="noreferrer" className="truncate font-mono text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      {g.issue}
                    </a>
                    <span className="ml-auto">
                      <Badge tone={GOAL_TONE[g.result]}>{g.result}</Badge>
                    </span>
                  </div>
                  <p className="mt-0.5 text-[13px] font-medium">{g.goal}</p>
                  {g.observed && <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">{g.observed}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader title="Recording" description={video ? "The tester's screen during the whole test." : undefined} />
        {video ? (
          <div className="p-4">
            <video controls playsInline preload="metadata" src={src(video)} poster={shots[0]?.src} className="max-h-[70vh] w-full rounded-md border border-border bg-black object-contain" />
          </div>
        ) : (
          <Empty>{live ? "The recording appears when the tester is done." : "This run has no recording. The log below says why."}</Empty>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader title="Checks" description={v ? `${v.checks.filter((c) => c.result === "pass").length}/${v.checks.length} passed` : undefined} />
        {!v || v.checks.length === 0 ? (
          <Empty>{live ? "The tester is working. Checks appear when it is done." : "No checks."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="w-8 px-4 py-2" />
                  <th className="px-4 py-2 font-medium">Expected</th>
                  <th className="px-4 py-2 font-medium">Observed</th>
                </tr>
              </thead>
              <tbody>
                {v.checks.map((c, i) => (
                  <tr key={i} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-2.5">{ICON[c.result]}</td>
                    <td className="px-4 py-2.5 font-medium">{c.expect}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.observed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {images.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Screenshots" description={`${shots.length} from the tester. Select one to see it full screen.`} />
          <ShotList shots={shots} className="p-4" />
        </Card>
      )}

      <Card>
        <CardHeader title="Log" />
        <div className="p-4">{r.log ? <Log text={r.log} /> : <span className="text-[13px] text-muted-foreground">No log yet.</span>}</div>
      </Card>
    </>
  );
}
