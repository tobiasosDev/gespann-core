import { useState } from "react";
import { api, type SettingsRow, type SettingsSection } from "../api.ts";
import { useResource } from "../live.ts";
import { Badge, Button, Card, CardHeader, cn, Input } from "./ui.tsx";

/** What a module action answers: leave for a URL (a checkout, a billing portal), show an error, or reload. */
type ActionResult = { redirect?: string; error?: string };

function Row({ row, busy, run }: { row: SettingsRow; busy: boolean; run: (action: string, body: unknown) => void }) {
  const saved = row.kind === "number" ? String(row.value) : "";
  const [value, setValue] = useState(saved);
  // A new value from the server replaces what is typed; the same value on the next poll leaves it alone.
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setValue(saved);
  }
  if (row.kind === "text")
    return <p className={cn("text-body", row.tone === "muted" ? "text-muted-foreground" : row.tone === "warn" ? "text-warn" : row.tone === "bad" ? "text-bad" : undefined)}>{row.text}</p>;
  if (row.kind === "meter") {
    const pct = row.max > 0 ? Math.min(100, (row.value / row.max) * 100) : 0;
    return (
      <div className="space-y-1.5">
        <p className="text-body tabular-nums">{row.label}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={row.max} aria-valuenow={Math.min(row.value, row.max)}>
          <div className={cn("h-full rounded-full", pct >= 100 ? "bg-warn" : "bg-info")} style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
      </div>
    );
  }
  if (row.kind === "button")
    return (
      <div>
        <Button variant={row.primary ? "default" : row.danger ? "danger" : "outline"} disabled={busy} onClick={() => run(row.action, {})}>
          {row.label}
        </Button>
      </div>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(row.action, { [row.name]: Number(value) });
      }}
    >
      <label className="flex items-center gap-2 text-body">
        <span className="text-muted-foreground">{row.label}</span>
        {row.prefix && <span>{row.prefix}</span>}
        <Input className="w-24 tabular-nums" type="number" inputMode="decimal" min={row.min} max={row.max} step={row.step ?? "any"} value={value} onChange={(e) => setValue(e.target.value)} required />
      </label>
      <Button type="submit" variant="outline" disabled={busy || value === String(row.value)}>
        {row.button}
      </Button>
    </form>
  );
}

/** `/settings#plan` scrolls to that card when it appears; the page loads the cards after the first paint. */
function scrollHere(el: HTMLDivElement | null): void {
  el?.scrollIntoView();
}

function ModuleCard({ s, reload }: { s: SettingsSection; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = async (action: string, body: unknown) => {
    // A module may only point its actions at the API: the same CSRF header and sign-in check guard them.
    if (!action.startsWith("/api/")) return setFailed(`not an API path: ${action}`);
    setBusy(true);
    setFailed(null);
    try {
      const r = await api<ActionResult>(action.slice(4), body);
      if (r.redirect) {
        location.href = r.redirect;
        return;
      }
      // On an error the card stays as it is, so a value typed into a field can be corrected.
      if (r.error) setFailed(r.error);
      else await reload();
      setBusy(false);
    } catch (err) {
      setFailed((err as Error).message);
      setBusy(false);
    }
  };
  return (
    // Raw, not decoded: card ids are plain words, and decoding throws on a link like /settings#%.
    <Card id={s.id} ref={s.id === location.hash.slice(1) ? scrollHere : undefined} className="mb-6 scroll-mt-6">
      <CardHeader title={s.title} description={s.description} action={s.badge && <Badge tone={s.badge.tone}>{s.badge.text}</Badge>} />
      <div className="space-y-3 px-4 py-4">
        {s.rows.map((row, i) => (
          <Row key={`${s.id}-${i}`} row={row} busy={busy} run={(a, b) => void run(a, b)} />
        ))}
        {failed && <p className="text-body text-bad">{failed}</p>}
      </div>
    </Card>
  );
}

/** Cards the instance's server module adds to Settings (a plan and its usage, for example). None without a module. */
export function ModuleSections() {
  const { data, error, reload } = useResource<{ sections: SettingsSection[]; error?: string }>("/settings/sections");
  const problem = error ?? data?.error;
  return (
    <>
      {problem && <p className="mb-6 text-body text-bad">{problem}</p>}
      {data?.sections.map((s) => <ModuleCard key={s.id} s={s} reload={reload} />)}
    </>
  );
}
