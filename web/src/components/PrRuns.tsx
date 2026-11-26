import { ChevronRight, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { ago, duration, type RunRow } from "../api.ts";
import { Link, navigate, RunStatus } from "../nav.tsx";
import { counts, groupByPr, type PrGroup, type PrState, result, type RunResult, usualSeconds } from "../runs.ts";
import { Button, Card, cn, Empty, LinkButton, Mono } from "./ui.tsx";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const SQUARE: Record<RunResult, string> = {
  pass: "bg-ok",
  fail: "bg-bad",
  blocked: "bg-warn",
  skip: "bg-muted-foreground/50",
  running: "border-2 border-info",
  queued: "border-2 border-muted-foreground/60",
  cancelled: "border border-muted-foreground/40",
};
const WORD: Record<RunResult, string> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", skip: "SKIP", running: "running", queued: "queued", cancelled: "cancelled" };

/** The PR's runs as squares, oldest on the left. Each opens its run. */
function History({ runs }: { runs: RunRow[] }) {
  const shown = [...runs].reverse();
  return (
    // Stops the click here so a square opens its own run, not the row's.
    <span className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {shown.map((r) => {
        const res = result(r);
        return (
          <Link key={r.id} to={`/runs/${r.id}`} className={cn("size-3 shrink-0 rounded-[3px] hover:opacity-70", SQUARE[res])} title={`${WORD[res]}, ${r.head.slice(0, 7)}, ${ago(r.started ?? r.created)}`} aria-label={`Run ${r.id}: ${WORD[res]}`}>
            {null}
          </Link>
        );
      })}
    </span>
  );
}

function Progress({ run, usual }: { run: RunRow; usual: number | null }) {
  if (run.status === "queued") return <span className="text-[13px] text-muted-foreground">Waiting for a sandbox.</span>;
  const elapsed = run.started ? (Date.now() - Date.parse(run.started)) / 1000 : 0;
  return (
    <div className="min-w-0">
      {usual && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-info" style={{ width: `${Math.min(100, (elapsed / usual) * 100)}%` }} />
        </div>
      )}
      <div className="mt-1.5 flex justify-between gap-3 text-[13px] text-muted-foreground">
        <Mono>{duration(run.started, null)}</Mono>
        {usual && <span>{usual < 60 ? "usually under a minute" : `usually about ${Math.round(usual / 60)} min`}</span>}
      </div>
    </div>
  );
}

const SECTION: Record<PrState, (n: number) => ReactNode> = {
  running: (n) => plural(n, "pull request"),
  attention: (n) => `${plural(n, "pull request")} whose latest run failed or was blocked`,
  passing: (n) => plural(n, "pull request"),
  cancelled: (n) => `${plural(n, "pull request")} whose runs were all cancelled`,
};
const TITLE: Record<PrState, string> = { running: "Running", attention: "Needs a look", passing: "Passing", cancelled: "Cancelled" };

function Section({ state, groups }: { state: PrState; groups: PrGroup<RunRow>[] }) {
  if (groups.length === 0) return null;
  return (
    // Running PRs sit in the side panel on wide screens and in a strip above the table below that.
    <tbody className={state === "running" ? "hidden panel:table-row-group" : undefined}>
      <tr className="border-b border-border">
        <th colSpan={7} scope="colgroup" className="px-3 pt-4 pb-2 text-left font-semibold sm:px-4">
          {TITLE[state]} <span className="ml-1.5 font-normal text-muted-foreground">{SECTION[state](groups.length)}</span>
        </th>
      </tr>
      {groups.map((g) => (
        <tr key={g.pr} className="cursor-pointer border-b border-border last:border-0 hover:bg-accent" onClick={() => navigate(`/runs/${g.latest.id}`)}>
          <td className="px-3 py-2.5 align-top sm:px-4 sm:align-middle">
            <RunStatus run={g.latest} />
          </td>
          <td className="px-3 py-2.5 break-words sm:max-w-0 sm:truncate sm:px-4">
            {/* The title is the row's link, so keyboard users reach every row at every width. */}
            <Link to={`/runs/${g.latest.id}`} className="hover:underline" aria-label={`#${g.pr} ${g.title ?? ""}, open the latest run`}>
              <Mono className="text-muted-foreground">#{g.pr}</Mono> {g.title}
            </Link>
          </td>
          <td className="hidden px-4 py-2.5 sm:table-cell">
            <History runs={g.runs} />
          </td>
          <td className="hidden px-4 py-2.5 md:table-cell">
            <Mono>{g.latest.head.slice(0, 7)}</Mono>
          </td>
          <td className="hidden px-4 py-2.5 text-right font-mono text-[12px] whitespace-nowrap text-muted-foreground md:table-cell">{duration(g.latest.started, g.latest.finished)}</td>
          <td className="px-3 py-2.5 text-right align-top whitespace-nowrap text-muted-foreground sm:px-4 sm:align-middle">{ago(g.latest.started ?? g.latest.created)}</td>
          <td className="hidden py-2.5 pr-3 text-right text-muted-foreground sm:table-cell" aria-hidden="true">
            <ChevronRight className="inline size-4" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/** The project's runs as one row per pull request, grouped by where each PR stands. */
export function PrRuns({ runs, header }: { runs: RunRow[]; header: ReactNode }) {
  const groups = groupByPr(runs);
  const usual = usualSeconds(runs);
  const of = (s: PrState) => groups.filter((g) => g.state === s);
  const running = of("running");
  // One strip per running or queued run, not per PR: a new push can queue a run while the last one still runs.
  const live = runs.filter((r) => r.status === "running" || r.status === "queued");
  return (
    <Card>
      {header}
      {runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <>
          {live.map((r) => (
            <div key={r.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 panel:hidden md:grid-cols-[auto_minmax(0,1fr)_16rem_auto]">
              <RunStatus run={r} />
              <Link to={`/runs/${r.id}`} className="truncate hover:underline">
                <Mono className="text-muted-foreground">#{r.pr}</Mono> {r.title}
              </Link>
              <div className="order-last col-span-3 md:order-none md:col-span-1">
                <Progress run={r} usual={usual} />
              </div>
              <Button size="sm" variant="outline" className="md:order-last" onClick={() => navigate(`/runs/${r.id}`)}>
                Open run
              </Button>
            </div>
          ))}
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] sm:table-fixed">
              <thead className="text-left text-[12px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="w-[6.5rem] px-3 py-2 font-medium sm:w-28 sm:px-4">Latest</th>
                  <th className="px-3 py-2 font-medium sm:px-4">Pull request</th>
                  <th className="hidden w-44 px-4 py-2 font-medium sm:table-cell">Runs, oldest first</th>
                  <th className="hidden w-24 px-4 py-2 font-medium md:table-cell">Commit</th>
                  <th className="hidden w-24 px-4 py-2 text-right font-medium md:table-cell">Took</th>
                  <th className="w-[5.5rem] px-3 py-2 text-right font-medium sm:w-24 sm:px-4">When</th>
                  <th className="hidden w-9 sm:table-cell" />
                </tr>
              </thead>
              <Section state="running" groups={running} />
              <Section state="attention" groups={of("attention")} />
              <Section state="passing" groups={of("passing")} />
              <Section state="cancelled" groups={of("cancelled")} />
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

const LEGEND: { key: RunResult; label: string; bar: string; text: string }[] = [
  { key: "pass", label: "Passed", bar: "bg-ok", text: "text-ok" },
  { key: "fail", label: "Failed", bar: "bg-bad", text: "text-bad" },
  { key: "blocked", label: "Blocked", bar: "bg-warn", text: "text-warn" },
  { key: "skip", label: "Skipped", bar: "bg-muted-foreground/50", text: "text-muted-foreground" },
  { key: "running", label: "Running", bar: "bg-info", text: "text-info" },
  { key: "queued", label: "Queued", bar: "bg-muted-foreground/30", text: "text-muted-foreground" },
  { key: "cancelled", label: "Cancelled", bar: "bg-muted-foreground/20", text: "text-muted-foreground" },
];

/** Wide screens only: what runs right now and how the recent runs ended. */
export function RunsPanel({ runs, repo }: { runs: RunRow[]; repo: string }) {
  if (runs.length === 0) return null;
  const usual = usualSeconds(runs);
  const live = runs.filter((r) => r.status === "running" || r.status === "queued");
  const c = counts(runs);
  const shown = LEGEND.filter((l) => c[l.key] > 0);
  const oldest = runs[runs.length - 1];
  return (
    <aside className="hidden w-[380px] shrink-0 flex-col gap-5 panel:flex">
      {live.length > 0 && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Running now</h2>
          {live.map((r) => (
            <div key={r.id} className="mt-3 border-t border-border pt-3 first-of-type:border-0 first-of-type:pt-0">
              <p className="text-[14px] leading-snug">
                <Mono className="text-muted-foreground">#{r.pr}</Mono> {r.title}
              </p>
              <div className="mt-3">
                <Progress run={r} usual={usual} />
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => navigate(`/runs/${r.id}`)}>
                  Open run
                </Button>
                <LinkButton size="sm" variant="outline" href={`https://github.com/${repo}/pull/${r.pr}`} target="_blank" rel="noreferrer">
                  Pull request <ExternalLink className="size-3.5" />
                </LinkButton>
              </div>
            </div>
          ))}
        </Card>
      )}
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Last {plural(runs.length, "run")}</h2>
        <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={shown.map((l) => `${c[l.key]} ${l.label.toLowerCase()}`).join(", ")}>
          {shown.map((l) => (
            <span key={l.key} className={l.bar} style={{ flex: c[l.key] }} />
          ))}
        </div>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1.5 text-[13px]">
          {shown.map((l) => (
            <div key={l.key} className="contents">
              <dt className={cn("flex items-center gap-2", l.text)}>
                <span className={cn("size-2 rounded-full", l.bar)} />
                {l.label}
              </dt>
              <dd className="text-right font-mono">{c[l.key]}</dd>
            </div>
          ))}
        </dl>
        {oldest && <p className="mt-3 text-[13px] text-muted-foreground">The oldest of them started {ago(oldest.started ?? oldest.created)}.</p>}
      </Card>
    </aside>
  );
}
