import { useState } from "react";
import { api, type MailKind, type MailSettings } from "../api.ts";
import { useResource } from "../live.ts";
import { Block, Rows, SettingsPane } from "../components/settings.tsx";
import { Badge, Button, Input } from "../components/ui.tsx";

const sourceText = (s: string | null) => (s === "github" ? "from GitHub" : s === "user" ? "confirmed" : s ? `from ${s}` : "");

function KindRow({ k, max, busy, save }: { k: MailKind; max: number; busy: boolean; save: (k: MailKind) => void }) {
  const [after, setAfter] = useState(String(k.after));
  const n = Number(after);
  const valid = Number.isInteger(n) && n >= 1 && n <= max;
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-3">
      <label className="flex min-w-0 flex-1 basis-64 cursor-pointer items-start gap-2.5">
        <input type="checkbox" className="mt-1 size-4 cursor-pointer accent-current" checked={k.on} disabled={busy} onChange={(e) => save({ ...k, on: e.target.checked })} />
        <span className="min-w-0">
          <span className="block text-body font-medium">{k.label}</span>
          <span className="block text-small text-muted-foreground">{k.description}</span>
        </span>
      </label>
      <form
        className="flex items-center gap-2 pl-6.5 text-body sm:pl-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save({ ...k, after: n });
        }}
      >
        <span className="text-muted-foreground">after</span>
        <Input className="w-16 text-center tabular-nums" type="number" min={1} max={max} value={after} disabled={busy || !k.on} onChange={(e) => setAfter(e.target.value)} aria-label={`${k.label}: mail after how many in a row`} />
        <span className="text-muted-foreground">in a row</span>
        {valid && n !== k.after && (
          <Button size="sm" type="submit" disabled={busy}>
            Save
          </Button>
        )}
      </form>
    </div>
  );
}

/** Settings → Mail: the address and which trouble is worth a mail. */
export function MailSection() {
  const { data, error, reload } = useResource<MailSettings>("/settings/mail");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const params = new URLSearchParams(location.search);
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Loading…</p>;
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(null);
    try {
      await f();
      return true;
    } catch (err) {
      setFailed((err as Error).message);
      return false;
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const save = (k: MailKind) => void act(() => api("/settings/alerts", { id: k.id, on: k.on, after: k.after }));
  return (
    <SettingsPane
      title="Mail"
      lead="gespann mails you when your projects' tests keep going wrong. One mail per streak: the next comes only after a test went otherwise and the trouble came back."
      action={!data.sends ? <Badge tone="warn">off on this instance</Badge> : undefined}
    >
      {!data.sends && <p className="text-body text-muted-foreground">This instance has no mail server (SMTP_URL), so it sends nothing. Mails go to its log instead.</p>}
      {params.get("email") === "confirmed" && <p className="text-body text-ok">Address confirmed. Mail goes there from now on.</p>}
      {params.get("email") === "stale" && <p className="text-body text-warn">That link is no longer valid: it expired, or you entered another address since. Enter the address again.</p>}
      <Block title="Address">
        {editing || (!data.email && !data.pending) ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => api("/settings/email", { email: draft })).then((ok) => {
                if (ok) {
                  setEditing(false);
                  setDraft("");
                }
              });
            }}
          >
            <Input className="max-w-72" type="email" autoComplete="email" placeholder="you@example.com" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!data.sends} />
            <Button type="submit" disabled={busy || !draft.trim() || !data.sends}>
              Send confirmation link
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-body">
            {data.email ? <span className="font-medium">{data.email}</span> : <span className="text-muted-foreground">none yet</span>}
            {data.email && <Badge tone="ok">{sourceText(data.source)}</Badge>}
            <Button size="sm" variant="outline" disabled={busy || !data.sends} onClick={() => setEditing(true)}>
              Change
            </Button>
          </div>
        )}
        {data.pending && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-body text-warn">
            Waiting for you to open the link we sent to {data.pending}.
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api("/settings/email", { email: data.pending }))}>
              Send again
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api("/settings/email/cancel", {}))}>
              Cancel
            </Button>
          </p>
        )}
      </Block>
      <Block title="What gets a mail">
        <Rows>
          {data.kinds.map((k) => (
            <KindRow key={`${k.id}-${k.after}`} k={k} max={data.maxAfter} busy={busy} save={save} />
          ))}
        </Rows>
      </Block>
      {failed && <p className="text-body text-bad">{failed}</p>}
    </SettingsPane>
  );
}
