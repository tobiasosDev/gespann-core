import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import { api, type Boxes, duration, hours, type RunningBox } from "../api.ts";
import { useResource, useTick } from "../live.ts";
import { Link } from "../nav.tsx";
import { Badge, Button, Card, CardHeader, cn } from "../components/ui.tsx";

/** Up to this many jobs at once the limit is drawn as one tile per sandbox; above it, only the stepper. */
const MAX_TILES = 12;

const what = (b: RunningBox) => (b.kind === "run" && b.pr ? `PR #${b.pr}` : b.kind === "setup" ? "preparing the environment" : b.kind === "suggest" ? "suggesting checks" : b.kind);

function RunningTile({ b, over }: { b: RunningBox; over: boolean }) {
  return (
    <Link
      to={`/projects/${b.project_id}/${b.kind === "setup" ? "setup" : "runs"}`}
      className={cn("flex h-[5.5rem] min-w-0 flex-col justify-between rounded-md border bg-info/10 px-2.5 py-2 hover:bg-info/15", over ? "border-dashed border-warn/70" : "border-info/50")}
    >
      <span className="flex items-center gap-1.5 text-small text-info">
        <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden="true" />
        <span className="tabular-nums">{duration(b.started, null)}</span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-body font-medium">{b.repo.split("/")[1] ?? b.repo}</span>
        <span className="block truncate text-small text-muted-foreground">{what(b)}</span>
      </span>
    </Link>
  );
}

/** The limit as a row of sandboxes: running ones, free ones, and the host's others you switched off. */
function Tiles({ data, busy, setLimit }: { data: Boxes & { host: number; limit: number }; busy: boolean; setLimit: (n: number) => void }) {
  const cells = Array.from({ length: Math.max(data.host, data.running.length) }, (_, i) => i);
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label="Sandboxes">
      {cells.map((i) => {
        const b = data.running[i];
        const on = i < data.limit;
        return (
          <li key={i} className="min-w-0">
            {b ? (
              <RunningTile b={b} over={!on} />
            ) : (
              <button
                type="button"
                disabled={busy || (on && i === 0)}
                onClick={() => setLimit(on ? i : i + 1)}
                aria-label={on ? (i === 0 ? "Free sandbox" : `Allow ${i} at once`) : `Allow ${i + 1} at once`}
                className={cn(
                  "group flex h-[5.5rem] w-full cursor-pointer flex-col justify-end rounded-md border px-2.5 py-2 text-left text-small transition-colors disabled:cursor-default",
                  on ? "border-dashed border-border bg-card text-muted-foreground enabled:hover:border-bad/50" : "border-transparent bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,transparent_6px_12px)] text-muted-foreground/70 hover:border-border",
                )}
              >
                {on ? (
                  <>
                    <span className="group-enabled:group-hover:hidden">free</span>
                    <span className="hidden text-bad group-enabled:group-hover:inline">switch off</span>
                  </>
                ) : (
                  <>
                    <span className="group-hover:hidden">off</span>
                    <span className="hidden text-foreground group-hover:inline">switch on</span>
                  </>
                )}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Sandbox time per day of the month; hover or focus a day for its number. */
function Days({ days }: { days: Boxes["time"]["days"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(...days.map((d) => d.seconds), 1);
  const today = new Date().toISOString().slice(0, 10);
  const shown = hover !== null ? days[hover] : undefined;
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div>
      <div className="mb-1 h-4 text-small text-muted-foreground" aria-live="polite">
        {shown ? `${label(shown.day)}: ${shown.seconds ? hours(shown.seconds) : "no sandbox time"}` : ""}
      </div>
      <div className="flex h-20 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => {
          const future = d.day > today;
          const h = d.seconds ? Math.max(3, Math.round((d.seconds / top) * 80)) : 0;
          return (
            <button
              key={d.day}
              type="button"
              className="flex h-full min-w-0 flex-1 cursor-default items-end focus-visible:outline-offset-0"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${label(d.day)}: ${d.seconds ? hours(d.seconds) : "none"}`}
            >
              <span
                className={cn("block w-full rounded-t-[4px]", d.seconds ? (hover === i ? "bg-foreground" : "bg-info") : future ? "h-px bg-border/60" : "h-px bg-border", d.day === today && !d.seconds && "h-0.5 bg-info/60")}
                style={d.seconds ? { height: `${h}px` } : undefined}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-label text-muted-foreground tabular-nums">
        <span>{label(days[0]?.day ?? today)}</span>
        <span>{label(days.at(-1)?.day ?? today)}</span>
      </div>
    </div>
  );
}

const always = () => true;

export function Sandboxes() {
  const { data, error, at: loadedAt, reload } = useResource<Boxes>("/boxes", always, 5000);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useTick(!!data?.running.length);
  if (error) return <p className="mt-6 text-bad">{error}</p>;
  if (!data) return null;
  const setLimit = async (limit: number) => {
    setBusy(true);
    setFailed(null);
    try {
      await api("/boxes/limit", { limit });
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const { host: hostRoom, cap, limit, running, queued, waitingForChecks, time } = data;
  // The most you can choose: the host's room, or less when the server module caps your jobs.
  const host = cap !== null && hostRoom !== null ? Math.min(cap.jobs, hostRoom) : hostRoom;
  const capText = cap ? `${cap.reason ? `${cap.reason[0]?.toUpperCase()}${cap.reason.slice(1)}` : "This instance"} allows ${cap.jobs} at once.` : "";
  const monthName = new Date(`${time.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  // The server counts running jobs up to its answer; the seconds since then are added here.
  const live = (running.length * Math.max(0, Date.now() - loadedAt)) / 1000;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Sandboxes"
        description="Each job (a pull request test, preparing the environment) runs in a sandbox of its own. Choose how many of your jobs run at the same time; the others wait in line."
        action={
          running.length ? (
            <Badge tone="info" dot>
              {running.length} running
            </Badge>
          ) : (
            <Badge>idle</Badge>
          )
        }
      />
      <div className="space-y-4 px-4 py-4">
        {data.noProvider ? (
          <p className="text-body text-warn">No sandboxes are set up for your account on this instance, so your jobs wait. They start once its operator gives your account sandboxes.</p>
        ) : host === null || limit === null ? (
          <p className="text-body text-warn">The service that runs jobs is not running right now, so your jobs wait. They start once it is back.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-body font-medium">At the same time</span>
              <div className="flex items-center rounded-md border border-border">
                <Button variant="ghost" size="sm" className="rounded-r-none" disabled={busy || limit <= 1} onClick={() => void setLimit(limit - 1)} aria-label="One fewer at once">
                  <Minus className="size-3.5" />
                </Button>
                <output className="min-w-16 px-2 text-center text-body tabular-nums" aria-live="polite">
                  <span className="font-semibold">{limit}</span>
                  <span className="text-muted-foreground"> of {host}</span>
                </output>
                <Button variant="ghost" size="sm" className="rounded-l-none" disabled={busy || limit >= host} onClick={() => void setLimit(limit + 1)} aria-label="One more at once">
                  <Plus className="size-3.5" />
                </Button>
              </div>
              <span className="text-small text-muted-foreground">{cap && cap.jobs <= (hostRoom ?? 0) ? capText : `${capText} The sandbox host has room for ${hostRoom}.`.trim()}</span>
              {queued > 0 && (
                <span className="text-small text-foreground">
                  {queued === 1 ? "One job waits" : `${queued} jobs wait`} for a free sandbox.
                </span>
              )}
              {waitingForChecks > 0 && (
                <span className="text-small text-muted-foreground">
                  {waitingForChecks === 1 ? "One PR waits" : `${waitingForChecks} PRs wait`} for its other checks to pass first.
                </span>
              )}
              {failed && <span className="text-body text-bad">{failed}</span>}
            </div>
            {host <= MAX_TILES ? (
              <Tiles data={{ ...data, host, limit }} busy={busy} setLimit={(n) => void setLimit(n)} />
            ) : (
              running.length > 0 && (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {running.map((b, i) => (
                    <li key={b.job_id} className="min-w-0">
                      <RunningTile b={b} over={i >= limit} />
                    </li>
                  ))}
                </ul>
              )
            )}
            {running.length > limit && <p className="text-small text-warn">{running.length - limit} more than your limit still run; they finish, and no new job starts until fewer than {limit} run.</p>}
          </>
        )}
      </div>
      <div className="grid gap-6 border-t border-border px-4 py-4 md:grid-cols-[minmax(0,18rem)_1fr]">
        <div>
          <h3 className="text-body font-medium">Sandbox time in {monthName}</h3>
          <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{hours(time.monthSeconds + live)}</p>
          <p className="mt-1 text-small text-muted-foreground">
            {time.jobs} {time.jobs === 1 ? "job" : "jobs"} this month, {hours(time.totalSeconds + live)} in total. Counted from the start to the end of each job, by calendar month in UTC.
          </p>
        </div>
        <Days days={time.days} />
      </div>
    </Card>
  );
}
