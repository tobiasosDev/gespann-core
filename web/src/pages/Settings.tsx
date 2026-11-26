import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { type AgentProvider, ago, api, type OpenRouterModel, type Settings, type Tokens } from "../api.ts";
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

/** Who runs the model behind the tester, for all the user's projects. */
function AgentChoice({ agent, onChange, busy }: { agent: AgentProvider; onChange: (a: AgentProvider) => void; busy: boolean }) {
  const options: { id: AgentProvider; title: string; text: string }[] = [
    { id: "codex", title: "ChatGPT plan", text: "Codex on your Plus, Pro or Team plan. No extra model bill." },
    { id: "openrouter", title: "OpenRouter", text: "Codex on any OpenRouter model with your own API key. OpenRouter bills you per token." },
  ];
  return (
    <Card>
      <CardHeader title="Agent" description="The tester, the environment setup and the fixes all run in Codex. Choose who runs its model; it applies to all your projects." />
      <div role="radiogroup" aria-label="Agent provider" className="grid gap-3 px-4 py-4 sm:grid-cols-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={agent === o.id}
            disabled={busy}
            onClick={() => agent !== o.id && onChange(o.id)}
            className={`rounded-md border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${agent === o.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
          >
            <span className="flex items-center gap-2 text-body font-medium">
              {agent === o.id && <Check className="size-4 text-primary" />}
              {o.title}
            </span>
            <span className="mt-0.5 block text-small text-muted-foreground">{o.text}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** The user's own OpenRouter key and model. */
function OpenRouterCard({ data, reload }: { data: Settings; reload: () => Promise<void> }) {
  const o = data.openrouter;
  const models = useResource<{ models: OpenRouterModel[]; error?: string }>("/settings/openrouter/models");
  const [key, setKey] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const model = modelDraft ?? o.model ?? "";
  const list = models.data?.models ?? [];
  const run = async (fn: () => Promise<unknown>, setError: (e: string | null) => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <Card className="mt-6">
      <CardHeader
        title="OpenRouter"
        description="Codex runs on OpenRouter with your own API key, for all your projects. gespann keeps the key encrypted, puts it into a project's sandbox only while a job runs, and keeps it out of the commands the agent runs."
        action={o.connected && o.model ? <Badge tone="ok">ready</Badge> : o.connected ? <Badge tone="warn">pick a model</Badge> : <Badge>not connected</Badge>}
      />
      <div className="space-y-3 px-4 py-4">
        {o.connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <Check className="size-4 text-ok" />
            <Mono>{o.label ?? "OpenRouter key"}</Mono>
            <Button size="sm" variant="danger" className="ml-auto" disabled={busy} onClick={() => void run(() => api("/settings/openrouter/logout", {}), setKeyError)}>
              Remove key
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api("/settings/openrouter/key", { key: key.trim() }), setKeyError)) setKey("");
            }}
          >
            <Input type="password" aria-label="OpenRouter API key" autoComplete="off" className="max-w-sm font-mono" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} />
            <Button type="submit" size="sm" disabled={busy || !key.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : null} Connect
            </Button>
            <LinkButton href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" size="sm" variant="ghost">
              Create a key <ExternalLink className="size-3.5" />
            </LinkButton>
          </form>
        )}
        {keyError && <p className="text-body text-bad">{keyError}</p>}
      </div>
      <div className="space-y-2 border-t border-border px-4 py-4">
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/settings/openrouter/model", { model: model.trim() }), setModelError)) setModelDraft(null);
          }}
        >
          <label htmlFor="openrouter-model" className="text-body font-medium">
            Model
          </label>
          <Input id="openrouter-model" list="openrouter-models" className="max-w-sm font-mono" placeholder="vendor/model, e.g. anthropic/…" value={model} onChange={(e) => setModelDraft(e.target.value)} maxLength={160} />
          <datalist id="openrouter-models">
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.context ? ` · ${Math.round(m.context / 1000)}k context` : ""}
              </option>
            ))}
          </datalist>
          <Button type="submit" size="sm" disabled={busy || model.trim() === (o.model ?? "")}>
            Save
          </Button>
        </form>
        {modelError && <p className="text-body text-bad">{modelError}</p>}
        {models.data?.error && <p className="text-small text-warn">Could not load OpenRouter's models: {models.data.error}. You can still type a model id.</p>}
        <p className="text-small text-muted-foreground">
          Required. The list shows the {list.length || ""} models that call tools and read screenshots, which the tester needs. Used for all your projects unless a project sets its own model in Setup.
        </p>
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
      <AgentChoice agent={data.agent} busy={busy} onChange={(agent) => void act("/settings/agent", { agent })} />
      {data.agent === "openrouter" ? (
        <OpenRouterCard data={data} reload={reload} />
      ) : (
      <Card className="mt-6">
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
      )}
      <Sandboxes />
      <AgentAccess />
    </>
  );
}
