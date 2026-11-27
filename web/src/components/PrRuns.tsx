import { ChevronRight, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { ago, duration, type RunRow } from "../api.ts";
import { navigate } from "../live.ts";
import { Link, RunStatus } from "../nav.tsx";
import { type ClosedPr, counts, groupByPr, type PrGroup, type PrState, result, type RunResult, usualSeconds } from "../runs.ts";
import { Button, Card, cn, Empty, LinkButton, Mono } from "./ui.tsx";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const SQUARE: Record<RunResult, string> = {
  pass: "bg-ok",
  fail: "bg-bad",
  blocked: "bg-warn",
  skip: "bg-muted-foreground/50",
  conflict: "bg-muted-foreground/25",
  error: "bg-bad/30",
  running: "border-2 border-info",
  queued: "border-2 border-muted-foreground/60",
  cancelled: "border border-muted-foreground/40",
};
const WORD: Record<RunResult, string> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", skip: "SKIP", conflict: "merge conflict", error: "gespann error", running: "running", queued: "queued", cancelled: "cancelled" };

/** The PR's runs as squares, oldest on the left. Each opens its run. */
function History({ runs }: { runs: RunRow[] }) {
  const shown = [...runs].reverse();
  return (
    // Stops the click here so a square opens its own run, not the row's.
    <span className="flex w-32 flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
  if (run.status === "queued") return <span className="text-small text-muted-foreground sm:text-body">{run.waitingForChecks ? "Waiting for CI." : "Waiting for a sandbox."}</span>;
  const elapsed = run.started ? (Date.now() - Date.parse(run.started)) / 1000 : 0;
  return (
    <div className="min-w-0">
      {usual && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Time used of a usual run" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, (elapsed / usual) * 100))}>
          <div className="h-full rounded-full bg-info" style={{ width: `${Math.min(100, (elapsed / usual) * 100)}%` }} />
        </div>
      )}
      <div className="mt-1.5 flex justify-between gap-3 text-small text-muted-foreground sm:text-body">
        <Mono>{duration(run.started, null)}</Mono>
        {usual && <span>{usual < 60 ? "usually under a minute" : `usually about ${Math.round(usual / 60)} min`}</span>}
      </div>
    </div>
  );
}

const SECTION: Record<PrState, (n: number) => ReactNode> = {
  running: (n) => plural(n, "pull request"),
  attention: (n) => `${plural(n, "pull request")} whose latest run failed or was blocked`,
  error: (n) => `${plural(n, "pull request")} gespann broke off before the tester gave a verdict; open the run for the reason, then test again`,
  conflict: (n) => `${plural(n, "pull request")} not tested: ${n === 1 ? "it does" : "they do"} not merge onto the base until ${n === 1 ? "its" : "their"} agent updates the branch`,
  passing: (n) => plural(n, "pull request"),
  cancelled: (n) => `${plural(n, "pull request")} whose runs were all cancelled`,
  closed: (n) => `${plural(n, "pull request")} no longer open; ${n === 1 ? "its" : "their"} runs stay for reference`,
};
const TITLE: Record<PrState, string> = { running: "Running", attention: "Needs a look", error: "Could not test", conflict: "Merge conflict", passing: "Passing", cancelled: "Cancelled", closed: "Merged or closed" };

function Section({ state, groups }: { state: PrState; groups: PrGroup<RunRow>[] }) {
  if (groups.length === 0) return null;
  return (
    // Running PRs sit in the side panel on wide screens and in a strip above the table below that.
    <tbody className={state === "running" ? "hidden panel:table-row-group" : undefined}>
      <tr className="border-b border-border">
        <th colSpan={7} scope="colgroup" className="px-4 pt-4 pb-2 text-left font-semibold">
          {TITLE[state]} <span className="ml-1.5 font-normal text-muted-foreground">{SECTION[state](groups.length)}</span>
        </th>
      </tr>
      {groups.map((g) => (
        <tr
          key={g.pr}
          className={cn("cursor-pointer border-b border-border last:border-0 hover:bg-accent", state === "closed" && "text-muted-foreground")}
          onClick={(e) => {
            // The title is a link that navigates itself; navigating here too would push the run page twice, so Back would need two steps.
            if ((e.target as HTMLElement).closest("a")) return;
            navigate(`/runs/${g.latest.id}`);
          }}
        >
          <td className="px-4 py-2.5">
            <RunStatus run={g.latest} />
          </td>
          <td className="w-full max-w-0 truncate px-4 py-2.5">
            {/* The title is the row's link, so keyboard users reach every row. */}
            <Link to={`/runs/${g.latest.id}`} className="hover:underline" aria-label={`#${g.pr} ${g.title ?? ""}, open the latest run`}>
              <Mono className="text-muted-foreground">#{g.pr}</Mono> {g.title}
            </Link>
            {state === "closed" && g.closed && <span className="ml-2 text-small">{g.closed}</span>}
          </td>
          <td className="px-4 py-2.5">
            <History runs={g.runs} />
          </td>
          {/* Commit is the first column to go: the run page shows it, and below 1536 px the title needs the room. */}
          <td className="hidden px-4 py-2.5 2xl:table-cell">
            <Mono>{g.latest.head.slice(0, 7)}</Mono>
          </td>
          <td className="hidden px-4 py-2.5 text-right font-mono text-small whitespace-nowrap text-muted-foreground md:table-cell">{duration(g.latest.started, g.latest.finished)}</td>
          <td className="px-4 py-2.5 text-right whitespace-nowrap text-muted-foreground">{ago(g.latest.started ?? g.latest.created)}</td>
          <td className="py-2.5 pr-3 text-right text-muted-foreground" aria-hidden="true">
            <ChevronRight className="inline size-4" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/** The project's runs as one row per pull request, grouped by where each PR stands. */
export function PrRuns({ runs, closed, header }: { runs: RunRow[]; closed: ClosedPr[]; header: ReactNode }) {
  const groups = groupByPr(runs, closed);
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
            <div key={r.id} className="hidden grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:grid panel:hidden md:grid-cols-[auto_minmax(0,1fr)_16rem_auto]">
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
          <PhoneList groups={groups} live={live} usual={usual} />
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-body">
              <thead className="text-left text-small whitespace-nowrap text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="w-28 px-4 py-2 font-medium">Latest</th>
                  <th className="px-4 py-2 font-medium">Pull request</th>
                  <th className="w-36 px-4 py-2 font-medium">Runs, oldest first</th>
                  <th className="hidden w-24 px-4 py-2 font-medium 2xl:table-cell">Commit</th>
                  <th className="hidden w-24 px-4 py-2 text-right font-medium md:table-cell">Took</th>
                  <th className="w-24 px-4 py-2 text-right font-medium">When</th>
                  <th className="w-9" />
                </tr>
              </thead>
              <Section state="running" groups={running} />
              <Section state="attention" groups={of("attention")} />
              <Section state="error" groups={of("error")} />
              <Section state="conflict" groups={of("conflict")} />
              <Section state="passing" groups={of("passing")} />
              <Section state="cancelled" groups={of("cancelled")} />
              <Section state="closed" groups={of("closed")} />
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

/** Phones: what the stripe and the word show per result. Neutral results get a grey that still reads on the card. */
const PHONE: Record<RunResult, { word: string; stripe: string; text: string }> = {
  pass: { word: "Passed", stripe: "bg-ok", text: "text-ok" },
  fail: { word: "Failed", stripe: "bg-bad", text: "text-bad" },
  blocked: { word: "Blocked", stripe: "bg-warn", text: "text-warn" },
  skip: { word: "Skipped", stripe: "bg-muted-foreground/70", text: "text-muted-foreground" },
  conflict: { word: "Merge conflict", stripe: "bg-muted-foreground/70", text: "text-muted-foreground" },
  // gespann broke off: not the PR's fault, but it needs a new test, so the stripe pulls more than grey and less than a FAIL.
  error: { word: "Error", stripe: "bg-bad/50", text: "text-muted-foreground" },
  running: { word: "Running", stripe: "bg-info", text: "text-info" },
  queued: { word: "Queued", stripe: "bg-muted-foreground/70", text: "text-muted-foreground" },
  cancelled: { word: "Cancelled", stripe: "bg-muted-foreground/70", text: "text-muted-foreground" },
};
const DOT: Record<RunResult, string> = { ...SQUARE, running: "bg-info", queued: "bg-muted-foreground/60", cancelled: "bg-muted-foreground/30" };

/** Phones: what needs the developer comes first, what runs next, what is done last. */
const PHONE_ORDER: PrState[] = ["attention", "error", "conflict", "running", "passing", "cancelled", "closed"];

function PhoneRow({ run, group, usual }: { run: RunRow; group: PrGroup<RunRow> | undefined; usual: number | null }) {
  const res = result(run);
  const look = PHONE[res];
  const done = !!group?.closed && res !== "running" && res !== "queued";
  const title = run.title ?? `Pull request #${run.pr}`;
  const live = res === "running" || res === "queued";
  const when = ago(run.started ?? run.created);
  // Running rows skip the squares: the other live run of the PR is the row next to it.
  const runs = !live && group && group.runs.length > 1 ? group.runs : null;
  return (
    <li>
      <Link
        to={`/runs/${run.id}`}
        className="relative flex min-h-14 items-center gap-3 py-3 pr-4 pl-5 focus-visible:-outline-offset-2 active:bg-accent"
        aria-label={[title, look.word, run.title && `#${run.pr}`, runs && plural(runs.length, "run"), group?.closed, !live && when].filter(Boolean).join(", ")}
      >
        <span aria-hidden="true" className={cn("absolute inset-y-3 left-0 w-1 rounded-r-full", look.stripe, done && "opacity-40")} />
        <div className="min-w-0 flex-1">
          <span className={cn("block leading-snug [overflow-wrap:anywhere]", done && "text-muted-foreground")}>{title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-small whitespace-nowrap text-muted-foreground">
            <span className={cn("font-medium", done ? "text-muted-foreground" : look.text)}>{look.word}</span>
            {run.title && <span className="tabular-nums">#{run.pr}</span>}
            {/* Earlier runs as small squares, oldest first, so a fail that later passed stays visible. */}
            {runs && (
              <span className="flex items-center gap-1">
                {[...runs].reverse().map((r) => (
                  <span key={r.id} className={cn("size-2 rounded-[2px]", DOT[result(r)])} />
                ))}
              </span>
            )}
            {group?.closed && <span>{group.closed}</span>}
            {/* A running run shows its elapsed time under the bar instead. */}
            {res !== "running" && <span className="ml-auto">{when}</span>}
          </span>
          {live && (
            <div className="mt-2">
              <Progress run={run} usual={usual} />
            </div>
          )}
        </div>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

/**
 * Phones only: one row per PR, each a single link over its whole width, so a tap opens the run once and
 * Back returns in one step. Running shows one row per running or queued run, like the strip on wider screens,
 * so a run that a newer push queued behind does not hide the one still running.
 */
function PhoneList({ groups, live, usual }: { groups: PrGroup<RunRow>[]; live: RunRow[]; usual: number | null }) {
  return (
    // Clips the last row's press highlight to the card's rounded corners.
    <div className="overflow-hidden rounded-b-lg sm:hidden">
      {PHONE_ORDER.map((state) => {
        const shown = state === "running" ? [...live].sort((a, b) => Number(b.status === "running") - Number(a.status === "running")).map((r) => ({ run: r, group: groups.find((g) => g.pr === r.pr) })) : groups.filter((g) => g.state === state).map((g) => ({ run: g.latest, group: g }));
        if (shown.length === 0) return null;
        return (
          <section key={state} aria-label={TITLE[state]} className="border-t border-border first:border-t-0">
            <h3 className="px-4 pt-3 pb-1 text-small font-medium text-muted-foreground">
              {TITLE[state]} <span className="ml-1 tabular-nums">{shown.length}</span>
            </h3>
            <ul className="divide-y divide-border">
              {shown.map(({ run, group }) => (
                <PhoneRow key={run.id} run={run} group={group} usual={usual} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const LEGEND: { key: RunResult; label: string; bar: string; text: string }[] = [
  { key: "pass", label: "Passed", bar: "bg-ok", text: "text-ok" },
  { key: "fail", label: "Failed", bar: "bg-bad", text: "text-bad" },
  { key: "blocked", label: "Blocked", bar: "bg-warn", text: "text-warn" },
  { key: "skip", label: "Skipped", bar: "bg-muted-foreground/50", text: "text-muted-foreground" },
  { key: "conflict", label: "Merge conflict", bar: "bg-muted-foreground/25", text: "text-muted-foreground" },
  { key: "error", label: "gespann error", bar: "bg-bad/30", text: "text-muted-foreground" },
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
          <h2 className="text-body font-semibold">Running now</h2>
          {live.map((r) => (
            <div key={r.id} className="mt-3 border-t border-border pt-3 first-of-type:border-0 first-of-type:pt-0">
              <p className="text-body leading-snug">
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
        <h2 className="text-body font-semibold">Last {plural(runs.length, "run")}</h2>
        <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={shown.map((l) => `${c[l.key]} ${l.label.toLowerCase()}`).join(", ")}>
          {shown.map((l) => (
            <span key={l.key} className={l.bar} style={{ flex: c[l.key] }} />
          ))}
        </div>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1.5 text-body">
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
        {oldest && <p className="mt-3 text-body text-muted-foreground">The oldest of them started {ago(oldest.started ?? oldest.created)}.</p>}
      </Card>
    </aside>
  );
}
