import { Check, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { duration, type Progress, type Stage, STAGES } from "../api.ts";
import { cn } from "./ui.tsx";

/** Re-renders every second while `on`, so running times count up between polls. */
export function useTick(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** HH:MM:SS in UTC, like the times in the run's log right below. */
export const clock = (iso: string) => iso.slice(11, 19);

/** The one moving thing on the page: a ring that breathes around what runs right now. */
export function LiveDot({ label = "running" }: { label?: string }) {
  return <span className="live-ring" role="img" aria-label={label} />;
}

export function WaitDot({ label = "waiting" }: { label?: string }) {
  return <span className="inline-block size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground/60" role="img" aria-label={label} />;
}

export const RESULT_ICON = {
  pass: <Check className="size-4 text-ok" aria-label="passed" />,
  fail: <X className="size-4 text-bad" aria-label="failed" />,
  blocked: <Minus className="size-4 text-warn" aria-label="blocked" />,
};

const LABEL: Record<Stage, string> = { sandbox: "Sandbox", copy: "Copy up", read: "Read change", checks: "Checks", verdict: "Verdict" };

/** The stage that runs now: the last one that started. */
export function currentStage(p: Progress | null): Stage | null {
  if (!p) return null;
  for (const s of [...STAGES].reverse()) if (p.at[s]) return s;
  return null;
}

/** Sandbox, copy up, read change, checks, verdict: done ones with their time, the current one counting. */
export function StageStrip({ progress, queued }: { progress: Progress | null; queued: boolean }) {
  const cur = queued ? null : currentStage(progress);
  const curIndex = cur ? STAGES.indexOf(cur) : -1;
  const checks = progress?.checks ?? [];
  const done = checks.filter((c) => c.result).length;
  // A second try starts over from the copy: the first one's time goes in a note below, so the stages add up to the duration.
  const firstTry = (progress?.attempt ?? 1) > 1 && progress?.sandboxDone && progress.at.copy ? duration(progress.sandboxDone, progress.at.copy) : null;
  return (
    <div className="mb-6">
      <div className="grid divide-y divide-border overflow-hidden rounded-lg border border-border bg-card lg:grid-cols-5 lg:divide-x lg:divide-y-0">
        {STAGES.map((s, i) => {
          const ran = (n: number) => !!progress?.at[STAGES[n] as Stage];
          // A stage before the current one that never started was skipped, not done: after a copy that did not come up, or
          // the checks of a tester that shared no plan.
          const state = i < curIndex ? (!ran(i) ? "skipped" : s === "copy" && !ran(i + 1) ? "failed" : "done") : i === curIndex ? "now" : "todo";
          const next = STAGES.slice(i + 1).find((n) => progress?.at[n]);
          const end = s === "sandbox" && progress?.sandboxDone ? progress.sandboxDone : next ? (progress?.at[next] ?? null) : null;
          let detail: string;
          if (state === "done" || state === "failed") detail = duration(progress?.at[s] ?? null, end);
          else if (state === "skipped") detail = s === "checks" && progress?.at.read ? "no plan shared" : "skipped";
          else if (state === "now") {
            const took = duration(progress?.at[s] ?? null, null);
            if (s === "checks" && checks.length) detail = `${done} of ${checks.length} · ${took}`;
            else if (s === "copy" && (progress?.attempt ?? 1) > 1) detail = `second try · ${took}`;
            else detail = took;
          } else detail = queued && i === 0 ? "waiting for a sandbox" : "";
          return (
            <div key={s} className={cn("px-4 py-3", state === "now" && "bg-info/[0.08]")}>
              <div className={cn("flex items-center gap-2 text-[15px] font-medium whitespace-nowrap", (state === "todo" || state === "skipped") && "text-muted-foreground")}>
                {state === "done" ? (
                  <Check className="size-4 shrink-0 text-ok" aria-label="done" />
                ) : state === "failed" ? (
                  <X className="size-4 shrink-0 text-bad" aria-label="failed" />
                ) : state === "now" ? <LiveDot /> : <WaitDot />}
                {LABEL[s]}
              </div>
              <div className={cn("mt-1 pl-6 text-[14px] text-muted-foreground lg:min-h-5", !detail && "hidden lg:block", state === "now" && "text-info")}>{detail}</div>
              {state === "now" && s === "checks" && checks.length > 0 && (
                <div className="mt-2.5 ml-6 h-[3px] overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={checks.length} aria-valuenow={done}>
                  <div className="h-full rounded-full bg-info transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(done / checks.length) * 100}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {firstTry && (
        <p className="mt-2 max-w-3xl text-[13px] text-muted-foreground">
          Second try. The first test took {firstTry} and was blocked by something the copy of the app lacked. Codex adds it, then the change is tested again.
        </p>
      )}
    </div>
  );
}

/** The tester's plan while it works: finished checks with their result, the current one with what it does, the rest waiting. */
export function LiveChecks({ progress }: { progress: Progress }) {
  // The check the tester said it is on; without that, the first one not done yet.
  const marked = progress.checks.findLastIndex((c) => c.active);
  const current = marked !== -1 ? marked : progress.checks.findIndex((c) => !c.result);
  // Only while the tester works: in the verdict stage nothing is "testing now" any more.
  const testing = currentStage(progress) === "checks" ? current : -1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[15px]">
        <thead className="text-left text-[14px] text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-10 px-4 py-2" />
            <th className="px-4 py-2 font-medium">Expected</th>
            <th className="hidden px-4 py-2 font-medium sm:table-cell">Observed</th>
            <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Done</th>
          </tr>
        </thead>
        <tbody>
          {progress.checks.map((c, i) => {
            const now = i === testing;
            const observed = c.result ? (
              (c.observed ?? "")
            ) : now && progress.now.length ? (
              <ol className="flex flex-col gap-1 text-[14px]">
                {progress.now.map((n, j) => {
                  const last = j === progress.now.length - 1;
                  return (
                    <li key={`${n.at}-${j}`} className={cn("flex gap-3", last && "text-foreground")}>
                      <span className={cn("pt-px font-mono text-[13px]", last ? "text-info" : "text-muted-foreground")}>{clock(n.at)}</span>
                      {n.text}
                    </li>
                  );
                })}
              </ol>
            ) : now ? (
              "Testing now"
            ) : testing !== -1 && i === testing + 1 ? (
              "Next"
            ) : (
              "Waiting"
            );
            return (
              <tr key={i} className={cn("border-b border-border align-top last:border-0", now && "bg-info/[0.07]")}>
                <td className="py-3 pr-0 pl-4 sm:pr-4">
                  <span className="flex h-6 items-center">{c.result ? RESULT_ICON[c.result] : now ? <LiveDot label="testing now" /> : <WaitDot />}</span>
                </td>
                <td className={cn("px-4 py-3 sm:w-[40%]", c.result || now ? "font-medium" : "text-muted-foreground")}>
                  {c.expect}
                  {/* Phones: what the tester saw goes under the check, not in a column of its own. */}
                  <div className="mt-1 text-[14px] font-normal text-muted-foreground sm:hidden">
                    {observed}
                    {c.result && c.at && <span className="ml-2 font-mono text-[13px]">{clock(c.at)}</span>}
                  </div>
                </td>
                <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{observed}</td>
                <td className="hidden px-4 py-3 text-right text-[14px] whitespace-nowrap sm:table-cell">
                  {c.result && c.at ? <span className="font-mono text-[13px] text-muted-foreground">{clock(c.at)}</span> : now ? <span className="text-info">testing now</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What to say in the Checks card while there is no plan yet. */
export function waitingText(progress: Progress | null, queued: boolean): string {
  if (queued) return "The run waits for a free sandbox. Checks appear when the tester has a plan.";
  const s = currentStage(progress);
  if (s === "read") return "The tester is reading the change. Its checks appear here as soon as it has a plan.";
  if (s === "verdict" && !progress?.at.read) return "The copy of the app did not come up, so the tester did not start. The log says why.";
  if (s === "verdict") return "The tester is done. Checks appear when the verdict is in.";
  return "The copy of the app is coming up. Checks appear here when the tester has a plan.";
}
