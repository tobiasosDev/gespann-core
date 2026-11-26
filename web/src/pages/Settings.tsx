import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { ago, api, type Settings, type Tokens } from "../api.ts";
import { ModuleSections } from "../components/ModuleSections.tsx";
import { useResource } from "../live.ts";
import { Badge, Button, Card, CardHeader, Input, LinkButton, Log, Mono, Select } from "../components/ui.tsx";
import { Sandboxes } from "./Sandboxes.tsx";

const codexPending = (d: Settings) => d.codex.state === "pending";

/** Agent sign-ins and personal tokens for the MCP endpoint, and how to connect Claude Code or Codex. */
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
  const claude = `claude mcp add --transport http gespann ${data.mcpUrl}\n\n# then in Claude Code: /mcp → gespann → Authenticate`;
  const codex = `codex mcp add gespann --url ${data.mcpUrl}\ncodex mcp login gespann`;
  const claudeToken = `claude mcp add --transport http gespann ${data.mcpUrl} --header "Authorization: Bearer ${token}"`;
  const codexToken = `export GESPANN_TOKEN=${token}\n\n# ~/.codex/config.toml\n[mcp_servers.gespann]\nurl = "${data.mcpUrl}"\nbearer_token_env_var = "GESPANN_TOKEN"`;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Agent access"
        description="Lets Claude Code or Codex read your runs over MCP: status, issues, the review text, screenshots and recordings. An agent can also rerun a pull request (at most 3 times per commit), but cannot cancel or approve anything, and sees only the projects you see."
      />
      <div className="space-y-3 px-4 py-4">
        <p className="text-body text-muted-foreground">Add gespann to your agent. It opens this site in your browser; you allow it once and are connected, no token to copy.</p>
        <div className="space-y-1">
          <span className="text-small text-muted-foreground">Claude Code</span>
          <Log text={claude} />
          <span className="text-small text-muted-foreground">Codex</span>
          <Log text={codex} />
        </div>
        {data.tokens.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.tokens.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-body">
                <span className="font-medium">{t.name}</span>
                {t.client ? <Badge tone="info">signed in</Badge> : <Mono className="text-muted-foreground">gsp_…{t.hint}</Mono>}
                <span className="text-muted-foreground">
                  {t.client ? "connected" : "created"} {ago(t.created)} · {t.last_used ? `used ${ago(t.last_used)}` : "never used"}
                </span>
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
        {failed && <p className="text-body text-bad">{failed}</p>}
        <details className="group rounded-md border border-border" open={!!fresh}>
          <summary className="cursor-pointer px-3 py-2 text-body text-muted-foreground select-none">Use a token instead (CI, scripts, agents without OAuth)</summary>
          <div className="space-y-3 border-t border-border px-3 py-3">
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
              <Input className="max-w-64" placeholder="Name, e.g. CI" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <Button type="submit" disabled={busy}>
                Create token
              </Button>
            </form>
            {fresh && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-info/60 bg-info/10 px-3 py-2">
                <span className="w-full text-small text-info">Copy it now; it is shown only once.</span>
                <Mono className="break-all">{fresh}</Mono>
                <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(fresh)}>
                  <Copy className="size-3.5" /> Copy
                </Button>
              </div>
            )}
            <div className="space-y-1">
              <span className="text-small text-muted-foreground">Claude Code</span>
              <Log text={claudeToken} />
              <span className="text-small text-muted-foreground">Codex</span>
              <Log text={codexToken} />
            </div>
          </div>
        </details>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { data, error, reload } = useResource<Settings>("/settings", codexPending, 3000);
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Loading…</p>;
  const c = data.codex;
  const known = c.models.some((m) => m.id === c.model);
  const isCustom = customOpen || (!!c.model && !known);
  const selectValue = isCustom ? "__custom__" : (c.model ?? "");
  const customValue = customDraft ?? (c.model && !known ? c.model : "");
  const selected = isCustom ? undefined : c.models.find((m) => m.id === c.model);
  const recommended = c.models.find((m) => m.recommended);
  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      await api(path, body);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const saveModel = async (next: string) => {
    setBusy(true);
    setModelError(null);
    try {
      await api("/settings/codex/model", { model: next });
      if (!next || c.models.some((m) => m.id === next)) setCustomOpen(false);
      setCustomDraft(null);
    } catch (err) {
      setModelError((err as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <>
      <h1 className="mb-4 text-title font-semibold">Settings</h1>
      <ModuleSections />
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
                <span className="w-full text-body text-muted-foreground">Open the link, sign in with your ChatGPT account and enter this code:</span>
                <Mono className="rounded-md border border-dashed border-info/60 bg-info/10 px-3 py-1.5 text-title tracking-widest text-info">{c.login.code}</Mono>
                <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(c.login?.code ?? "")}>
                  <Copy className="size-3.5" /> Copy
                </Button>
                <LinkButton href={c.login.url ?? "https://auth.openai.com/codex/device"} target="_blank" rel="noreferrer" size="sm" variant="outline">
                  Open auth.openai.com <ExternalLink className="size-3.5" />
                </LinkButton>
                <span className="w-full text-small text-muted-foreground">Code refused? Enable device code login in ChatGPT → Settings → Security. The code expires after 15 minutes.</span>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-body text-muted-foreground">
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
        <div className="space-y-2 border-t border-border px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="codex-model" className="text-body font-medium">
              Model
            </label>
            <Select
              id="codex-model"
              className="max-w-sm"
              disabled={busy}
              value={selectValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom__") {
                  setCustomOpen(true);
                  setCustomDraft(c.model ?? "");
                  setModelError(null);
                  return;
                }
                setCustomOpen(false);
                setCustomDraft(null);
                void saveModel(v);
              }}
            >
              <option value="">Codex default</option>
              {c.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.recommended ? " (recommended)" : ""} — {m.description}
                </option>
              ))}
              <option value="__custom__">Custom…</option>
            </Select>
          </div>
          {isCustom && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveModel(customValue.trim());
              }}
            >
              <Input
                aria-label="Custom Codex model"
                className="max-w-64 font-mono"
                placeholder="e.g. gpt-6.2-sol"
                value={customValue}
                onChange={(e) => setCustomDraft(e.target.value)}
                maxLength={80}
              />
              <Button type="submit" size="sm" disabled={busy}>
                Save
              </Button>
              {c.model && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCustomOpen(false);
                    setCustomDraft(null);
                    void saveModel("");
                  }}
                >
                  Use default
                </Button>
              )}
            </form>
          )}
          {modelError && <p className="text-body text-bad">{modelError}</p>}
          {selected?.note && <p className="text-body text-warn">{selected.note}</p>}
          {recommended && !isCustom && selected?.id !== recommended.id && (
            <p className="text-body">
              Recommended: {recommended.name}. In our benchmark it judged every test PR right.{" "}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void saveModel(recommended.id)}>
                Use {recommended.name}
              </Button>
            </p>
          )}
          <p className="text-small text-muted-foreground">
            Used for all your projects unless a project sets its own model in Setup.{" "}
            <a className="underline" href="https://github.com/tobiasosDev/gespann-core/blob/main/docs/models.md" target="_blank" rel="noreferrer">
              How we compared the models
            </a>
          </p>
        </div>
      </Card>
      <Sandboxes />
      <AgentAccess />
    </>
  );
}
