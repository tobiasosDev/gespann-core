import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { ago, api, type Settings, type Tokens, useResource } from "../api.ts";
import { Badge, Button, Card, CardHeader, Input, LinkButton, Log, Mono } from "../components/ui.tsx";
import { Sandboxes } from "./Sandboxes.tsx";

/** Personal tokens for the read-only MCP endpoint, and how to give one to Claude Code or Codex. */
function AgentAccess() {
  const { data, error, reload } = useResource<Tokens>("/tokens");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return null;
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setFailed(null);
    try {
      await f();
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const token = fresh ?? "<token>";
  const claude = `claude mcp add --transport http gespann ${data.mcpUrl} --header "Authorization: Bearer ${token}"`;
  const codex = `export GESPANN_TOKEN=${token}\n\n# ~/.codex/config.toml\n[mcp_servers.gespann]\nurl = "${data.mcpUrl}"\nbearer_token_env_var = "GESPANN_TOKEN"`;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Agent access"
        description="Lets Claude Code or Codex read your runs over MCP: status, issues, the review text, screenshots and recordings. Read-only: a token cannot start, cancel or approve anything, and sees only the projects you see."
      />
      <div className="space-y-3 px-4 py-4">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ token: string }>("/tokens", { name });
              setFresh(r.token);
              setName("");
            });
          }}
        >
          <Input className="max-w-64" placeholder="Name, e.g. laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <Button type="submit" disabled={busy}>
            Create token
          </Button>
          {failed && <span className="self-center text-[13px] text-bad">{failed}</span>}
        </form>
        {fresh && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-info/60 bg-info/10 px-3 py-2">
            <span className="w-full text-[12px] text-info">Copy it now; it is shown only once.</span>
            <Mono className="break-all">{fresh}</Mono>
            <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(fresh)}>
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
        )}
        <div className="space-y-1">
          <span className="text-[12px] text-muted-foreground">Claude Code</span>
          <Log text={claude} />
          <span className="text-[12px] text-muted-foreground">Codex</span>
          <Log text={codex} />
        </div>
        {data.tokens.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]">
                <span className="font-medium">{t.name}</span>
                <Mono className="text-muted-foreground">gsp_…{t.hint}</Mono>
                <span className="text-muted-foreground">created {ago(t.created)} · {t.last_used ? `used ${ago(t.last_used)}` : "never used"}</span>
                <Button
                  size="sm"
                  variant="danger"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void act(async () => void (await api(`/tokens/${t.id}/revoke`, {})))}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { data, error, reload } = useResource<Settings>("/settings", (d) => d.codex.state === "pending", 3000);
  const [busy, setBusy] = useState(false);
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Loading…</p>;
  const c = data.codex;
  const act = async (path: string) => {
    setBusy(true);
    try {
      await api(path, {});
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <Card>
        <CardHeader
          title="Codex"
          description="The tester runs on your own ChatGPT plan (Plus, Pro or Team), for all your projects. gespann keeps the sign-in encrypted and puts it into a project's sandbox only while a job runs."
          action={
            c.state === "connected" ? (
              <Badge tone="ok">connected</Badge>
            ) : c.state === "pending" ? (
              <Badge tone="info" dot>
                waiting
              </Badge>
            ) : c.state === "failed" ? (
              <Badge tone="bad">failed</Badge>
            ) : (
              <Badge>not connected</Badge>
            )
          }
        />
        <div className="space-y-3 px-4 py-4">
          {c.state === "connected" && (
            <div className="flex flex-wrap items-center gap-3">
              <Check className="size-4 text-ok" />
              <Mono>{c.account ?? "ChatGPT"}</Mono>
              <Button size="sm" variant="danger" className="ml-auto" disabled={busy} onClick={() => act("/settings/codex/logout")}>
                Disconnect
              </Button>
            </div>
          )}
          {c.state === "pending" &&
            (c.login?.code ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-full text-[13px] text-muted-foreground">Open the link, sign in with your ChatGPT account and enter this code:</span>
                <Mono className="rounded-md border border-dashed border-info/60 bg-info/10 px-3 py-1.5 text-lg tracking-widest text-info">{c.login.code}</Mono>
                <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(c.login?.code ?? "")}>
                  <Copy className="size-3.5" /> Copy
                </Button>
                <LinkButton href={c.login.url ?? "https://auth.openai.com/codex/device"} target="_blank" rel="noreferrer" size="sm" variant="outline">
                  Open auth.openai.com <ExternalLink className="size-3.5" />
                </LinkButton>
                <span className="w-full text-[12px] text-muted-foreground">Code refused? Enable device code login in ChatGPT → Settings → Security. The code expires after 15 minutes.</span>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Starting a sign-in sandbox and asking OpenAI for a code (about a minute)…
              </p>
            ))}
          {c.state === "failed" && c.login?.lines && <Log text={c.login.lines} className="border-bad/40 text-bad" />}
          {c.state !== "connected" && c.state !== "pending" && (
            <Button disabled={busy} onClick={() => act("/settings/codex/login")}>
              Connect ChatGPT plan
            </Button>
          )}
        </div>
      </Card>
      <Sandboxes />
      <AgentAccess />
    </>
  );
}
