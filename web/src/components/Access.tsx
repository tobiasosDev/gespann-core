import { KeyRound } from "lucide-react";
import { useCallback, useState } from "react";
import { api, ApiError, type AccessEntry } from "../api.ts";
import { Badge, Button, Card, CardHeader, Empty, Input, Mono } from "./ui.tsx";

/**
 * The project's outside services (docs/access.md): each one the copy fakes, and the key that lets PRs
 * changing its code test the real one. `focus` is the service a run page link points at.
 */
export function AccessCard({ projectId, entries, own, focus, onChange }: { projectId: number; entries: AccessEntry[]; own: boolean; focus: string | null; onChange: () => Promise<void> }) {
  return (
    <Card id="access" className="mb-6 scroll-mt-6">
      <CardHeader
        title="Outside services"
        description="The copy fakes every service it cannot reach, so PRs are tested without real accounts. Store a key to test the real service on PRs that change its code; every other PR keeps the fake."
      />
      {entries.length === 0 ? (
        <Empty>None yet. When a test needs an outside service, gespann builds a fake for it and lists it here.</Empty>
      ) : (
        entries.map((e) => <AccessRow key={e.name} projectId={projectId} entry={e} own={own} focused={focus === e.name} onChange={onChange} />)
      )}
    </Card>
  );
}

function AccessRow({ projectId, entry, own, focused, onChange }: { projectId: number; entry: AccessEntry; own: boolean; focused: boolean; onChange: () => Promise<void> }) {
  const [open, setOpen] = useState(focused && !entry.key);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A callback ref runs when the row mounts (and again only when `focused` changes): a link from a run page lands on its row.
  const row = useCallback(
    (el: HTMLDivElement | null) => {
      if (focused) el?.scrollIntoView({ block: "center" });
    },
    [focused],
  );

  const call = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${projectId}/access/${entry.name}${path}`, body);
      setKey("");
      setOpen(false);
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={row} className={`border-b border-border px-4 py-3 last:border-0 ${focused ? "bg-info/5" : ""}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* At least 15rem: on a phone the buttons wrap under the text instead of squeezing it. */}
        <div className="min-w-60 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium">{entry.about || entry.name}</span>
            {entry.key ? <Badge tone="ok">key {entry.key.hint}</Badge> : <Badge>fake</Badge>}
            {!entry.listed && <Badge tone="warn">not in the recipe</Badge>}
          </div>
          <p className="mt-1 text-body text-muted-foreground">
            <Mono>{entry.name}</Mono>
            {entry.listed
              ? entry.key
                ? ` · real for PRs that change ${entry.paths.join(", ")}; fake for all others.`
                : ` · every PR runs against the fake. With a key, PRs that change ${entry.paths.join(", ")} test the real service.`
              : " · the recipe no longer lists this service, so no run uses the key."}
          </p>
        </div>
        {own && !open && (
          <div className="flex gap-2">
            {entry.key && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => call("/remove", {})}>
                Remove key
              </Button>
            )}
            {entry.listed && (
              <Button size="sm" variant={entry.key ? "outline" : "default"} disabled={busy} onClick={() => setOpen(true)}>
                <KeyRound className="size-3.5" /> {entry.key ? "Replace key" : "Store key"}
              </Button>
            )}
          </div>
        )}
      </div>
      {own && open && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call("", { key });
          }}
        >
          <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Key for ${entry.name}`} aria-label={`Key for ${entry.name}`} className="min-w-0 flex-1 font-mono" autoFocus />
          <Button size="sm" disabled={busy || !key.trim()}>
            Save
          </Button>
          <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <p className="w-full text-small text-muted-foreground">Kept encrypted and never shown again. Code under test can read it while such a run starts, so use a test account with a small budget.</p>
        </form>
      )}
      {!own && !entry.key && entry.listed && <p className="mt-1 text-small text-muted-foreground">Only the project's owner can store a key.</p>}
      {error && <p className="mt-2 text-body text-bad">{error}</p>}
    </div>
  );
}
