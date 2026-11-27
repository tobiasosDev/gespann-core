import { Copy, ExternalLink, Loader2, Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { type AgentProvider, ago, api, type Boxes, type CodexModel, type KeyAgent, type OpenRouterModel, type Settings, type SettingsSection, type Tokens } from "../api.ts";
import { ModuleSection } from "../components/ModuleSection.tsx";
import { Block, Connected, Radio, Rows, SettingsPane } from "../components/settings.tsx";
import { setHash, useHash, useResource } from "../live.ts";
import { Badge, Button, cn, Input, LinkButton, Log, Mono } from "../components/ui.tsx";
import { boxesLive, Sandboxes } from "./Sandboxes.tsx";

const codexPending = (d: Settings) => d.codex.state === "pending" || d.keyAgents.some((a) => a.login?.state === "pending");

/** Who can run the tester; `short` names the choice in the list of sections. */
const AGENTS: { id: AgentProvider; title: string; short: string; text: string }[] = [
  { id: "codex", title: "ChatGPT plan", short: "Codex", text: "Codex on your Plus, Pro or Team plan. No extra model bill." },
  { id: "openrouter", title: "OpenRouter", short: "OpenRouter", text: "Codex on any OpenRouter model with your own API key. OpenRouter bills you per token." },
  { id: "claude", title: "Claude Code", short: "Claude Code", text: "Claude Code on your Anthropic API key or your Claude Pro or Max plan." },
  { id: "copilot", title: "GitHub Copilot", short: "Copilot", text: "The Copilot CLI on your GitHub account's Copilot plan (sign in with GitHub)." },
  { id: "grok", title: "Grok", short: "Grok", text: "The Grok CLI on your Grok plan (sign in with xAI) or an xAI API key." },
];

/** The chosen agent's state, as its badge says it. */
function agentBadge(d: Settings): ReactNode {
  if (d.agent === "codex") {
    const s = d.codex.state;
    if (s === "connected") return <Badge tone="ok">connected</Badge>;
    if (s === "pending")
      return (
        <Badge tone="info" dot>
          waiting
        </Badge>
      );
    if (s === "failed") return <Badge tone="bad">failed</Badge>;
    return <Badge>not connected</Badge>;
  }
  if (d.agent === "openrouter") return d.openrouter.connected ? d.openrouter.model ? <Badge tone="ok">connected</Badge> : <Badge tone="warn">pick a model</Badge> : <Badge>not connected</Badge>;
  return d.keyAgents.find((a) => a.id === d.agent)?.connected ? <Badge tone="ok">connected</Badge> : <Badge>not connected</Badge>;
}

const agentReady = (d: Settings) =>
  d.agent === "codex" ? d.codex.state === "connected" : d.agent === "openrouter" ? d.openrouter.connected && !!d.openrouter.model : !!d.keyAgents.find((a) => a.id === d.agent)?.connected;

/** Runs a request with a busy flag and an error line, then reloads; true when it worked. */
function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
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
  return { busy, run };
}

/** A device code to type on the provider's page, with copy and open buttons. */
function DeviceCode({ code, url, urlLabel, note, intro }: { code: string; url: string | null; urlLabel: string; note: string; intro: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-full text-body text-muted-foreground">{intro}</span>
      <Mono className="rounded-md border border-dashed border-info/60 bg-info/10 px-3 py-1.5 text-title tracking-widest text-info">{code}</Mono>
      <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(code)}>
        <Copy className="size-3.5" /> Copy
      </Button>
      {url && (
        <LinkButton href={url} target="_blank" rel="noreferrer" size="sm" variant="outline">
          {urlLabel} <ExternalLink className="size-3.5" />
        </LinkButton>
      )}
      <span className="w-full text-small text-muted-foreground">{note}</span>
    </div>
  );
}

/** The account row once connected: what is connected and the button to remove it. */
function AccountRow({ label, note, button, busy, onRemove }: { label: string; note: string; button: string; busy: boolean; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <Connected />
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">{label}</p>
        <p className="text-small text-muted-foreground">{note}</p>
      </div>
      <Button size="sm" variant="danger" disabled={busy} onClick={onRemove}>
        {button}
      </Button>
    </div>
  );
}

const KEPT = "Kept encrypted and put into a sandbox only while a job runs.";

/* ---------------------------------------------------------------- Codex */

/** A model's benchmark facts for the table: judged right, and credits per PR or its price next to the recommended model. */
function modelFacts(m: CodexModel, recommended: CodexModel | undefined): { right: string; cost: string; tested: boolean } {
  if (m.bench) return { right: `${m.bench.right} of ${m.bench.of}`, cost: m.bench.credits < 1 ? m.bench.credits.toFixed(2) : m.bench.credits.toFixed(1), tested: true };
  if (!recommended) return { right: "not tested", cost: "", tested: false };
  const r = recommended.rates;
  const ratios = [m.rates.input / r.input, m.rates.cached / r.cached, m.rates.output / r.output].map((x) => Math.round(x));
  const lo = Math.min(...ratios);
  const hi = Math.max(...ratios);
  return { right: "not tested", cost: `${lo === hi ? lo : `${lo}–${hi}`}× ${recommended.name}`, tested: false };
}

const MODEL_GRID = "grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[1rem_minmax(0,1fr)_8.5rem_10rem]";

function ModelRow({ on, onPick, name, tag, facts, note }: { on: boolean; onPick: () => void; name: string; tag?: string; facts?: { right: string; cost: string; tested: boolean }; note?: string }) {
  return (
    // A native radio keeps the arrow keys moving through the models, as the select before it did.
    <label
      className={cn(
        MODEL_GRID,
        "cursor-pointer gap-y-1 px-4 py-3 transition-colors",
        on ? "bg-foreground/[0.04]" : "hover:bg-muted/50",
      )}
    >
      {/* Not disabled while a pick saves: that would drop the focus between two arrow presses. */}
      <input type="radio" name="codex-model" className="sr-only" checked={on} onChange={onPick} />
      <Radio on={on} />
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 font-medium">
        {name}
        {tag && <span className="text-small font-normal text-ok">{tag}</span>}
      </span>
      {facts && (
        <>
          <span className={cn("col-start-2 text-small tabular-nums sm:col-start-auto sm:text-right sm:text-body", facts.tested ? "text-foreground" : "text-muted-foreground")}>
            <span className="sm:hidden">Judged right: </span>
            {facts.right}
            {facts.cost && <span className="sm:hidden">, {facts.tested ? `${facts.cost} credits per PR` : `token price ${facts.cost}`}</span>}
          </span>
          <span className={cn("hidden text-right tabular-nums sm:block", facts.tested ? "text-foreground" : "text-small text-muted-foreground")}>{facts.cost}</span>
        </>
      )}
      {note && <span className="col-start-2 text-small text-warn sm:col-end-5">{note}</span>}
    </label>
  );
}

function CodexSettings({ d, reload }: { d: Settings; reload: () => Promise<void> }) {
  const c = d.codex;
  const { busy, run } = useAction(reload);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  // A row pick shows at once and saves in order, so quick arrow presses end on the last pick.
  const [picked, setPicked] = useState<string | null>(null);
  const known = c.models.some((m) => m.id === c.model);
  const isCustom = customOpen || (picked === null && !!c.model && !known);
  const customValue = customDraft ?? (c.model && !known ? c.model : "");
  const recommended = c.models.find((m) => m.recommended);
  const saves = useRef({ tail: Promise.resolve() as Promise<unknown>, n: 0 });
  const selected = picked ?? c.model ?? "";
  const pick = (id: string) => {
    setCustomOpen(false);
    setCustomDraft(null);
    setModelError(null);
    setPicked(id);
    const n = ++saves.current.n;
    const last = () => n === saves.current.n;
    saves.current.tail = saves.current.tail
      .then(() => api("/settings/codex/model", { model: id }))
      .then(
        () => undefined,
        (err: Error) => last() && setModelError(err.message),
      )
      .then(async () => {
        if (!last()) return;
        await reload();
        if (last()) setPicked(null);
      });
  };
  /** A typed model id: saved after the row picks still on their way, and it has the last word over them. */
  const saveCustom = async (next: string) => {
    saves.current.n++;
    const saved = saves.current.tail.then(() => api("/settings/codex/model", { model: next }));
    saves.current.tail = saved.catch(() => undefined);
    // On an error the typed id stays in the field.
    if (await run(() => saved, setModelError)) {
      setPicked(null);
      if (!next || c.models.some((m) => m.id === next)) setCustomOpen(false);
      setCustomDraft(null);
    }
  };
  return (
    <>
      <Block title="ChatGPT account">
        <Rows>
          {c.state === "connected" ? (
            <AccountRow label={c.account ?? "ChatGPT"} note={KEPT} button="Disconnect" busy={busy} onRemove={() => void run(() => api("/settings/codex/logout", {}), setAccountError)} />
          ) : (
            <div className="space-y-3 px-4 py-4">
              {c.state === "pending" &&
                (c.login?.code ? (
                  <DeviceCode
                    intro="Open the link, sign in with your ChatGPT account and enter this code:"
                    code={c.login.code}
                    url={c.login.url ?? "https://auth.openai.com/codex/device"}
                    urlLabel="Open auth.openai.com"
                    note="Code refused? Enable device code login in ChatGPT → Settings → Security. The code expires after 15 minutes."
                  />
                ) : (
                  <p className="flex items-center gap-2 text-body text-muted-foreground">
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Starting a sign-in sandbox and asking OpenAI for a code (about a minute)…
                  </p>
                ))}
              {c.state === "failed" && c.login?.lines && <Log text={c.login.lines} className="border-bad/40 text-bad" />}
              {c.state !== "pending" && (
                <>
                  <p className="text-body text-muted-foreground">Sign in once with your ChatGPT account. {KEPT}</p>
                  <Button disabled={busy} onClick={() => void run(() => api("/settings/codex/login", {}), setAccountError)}>
                    Connect ChatGPT plan
                  </Button>
                </>
              )}
            </div>
          )}
        </Rows>
        {accountError && <p className="mt-2 text-body text-bad">{accountError}</p>}
      </Block>
      <Block title="Model" aside="For all projects, unless a project sets its own in Setup">
        <Rows>
          <div role="radiogroup" aria-label="Codex model" className="divide-y divide-border">
            <div className={cn(MODEL_GRID, "hidden px-4 py-2.5 text-small text-muted-foreground sm:grid")} aria-hidden="true">
              <span />
              <span>Model</span>
              <span className="text-right">Judged right</span>
              <span className="text-right">Credits per PR</span>
            </div>
            {c.models.map((m) => (
              <ModelRow
                key={m.id}
                on={!isCustom && selected === m.id}
                onPick={() => pick(m.id)}
                name={m.name}
                tag={m.recommended ? "recommended" : undefined}
                facts={modelFacts(m, recommended)}
                note={m.note}
              />
            ))}
            <ModelRow
              on={!isCustom && !selected}
              onPick={() => pick("")}
              name="Codex default"
            />
            {isCustom ? (
              <form
                className="flex flex-wrap items-center gap-2 bg-foreground/[0.04] px-4 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveCustom(customValue.trim());
                }}
              >
                <Radio on />
                <Input aria-label="Custom Codex model" className="ml-1 max-w-64 font-mono" placeholder="e.g. gpt-6.2-sol" value={customValue} onChange={(e) => setCustomDraft(e.target.value)} maxLength={80} autoFocus={customOpen} />
                <Button type="submit" size="sm" disabled={busy || !customValue.trim() || customValue.trim() === c.model}>
                  Save
                </Button>
                {(customOpen || customDraft !== null) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      // Drops only the draft; a saved custom model stays until another row is picked.
                      setCustomOpen(false);
                      setCustomDraft(null);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </form>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCustomOpen(true);
                  setCustomDraft(c.model ?? "");
                  setModelError(null);
                }}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left text-body text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                <Plus className="size-4" /> Use another model id
              </button>
            )}
          </div>
        </Rows>
        {modelError && <p className="mt-2 text-body text-bad">{modelError}</p>}
        <p className="mt-2.5 text-small text-muted-foreground">
          Credits: what one test PR of a small app cost in our benchmark, at OpenAI's Codex rates; bigger apps use more. A cheaper model leaves more of your plan's usage limits for other work. For a model we have not tested, the table shows its token price as a multiple of the recommended model's.{" "}
          <a className="text-foreground underline underline-offset-2" href="https://github.com/tobiasosDev/gespann-core/blob/main/docs/models.md" target="_blank" rel="noreferrer">
            How we compared the models
          </a>
        </p>
      </Block>
    </>
  );
}

/* ----------------------------------------------------------- OpenRouter */

/**
 * A test PR in our benchmark (docs/models.md): about 406k input tokens, 90 % of them cached, and 3k
 * output tokens. Real apps with longer flows use more; the ratio between models roughly holds.
 */
const TEST_TOKENS = { input: 40_600, cached: 365_400, output: 3_000 };

/** "≈ $0.07 per test · $1 / $5 per 1M tokens", or "free". */
function priceLabel(m: OpenRouterModel): string {
  if (!m.price) return "price set by OpenRouter";
  if (m.price.input === 0 && m.price.output === 0) return "free";
  const perTest = (TEST_TOKENS.input * m.price.input + TEST_TOKENS.cached * m.price.cached + TEST_TOKENS.output * m.price.output) / 1_000_000;
  const usd = (n: number) => `$${Math.round(n * 100) / 100}`;
  return `${perTest < 0.01 ? "< $0.01" : `≈ $${perTest.toFixed(2)}`} per test · ${usd(m.price.input)} in / ${usd(m.price.output)} out per 1M tokens`;
}

/** "200k" or "1M" tokens of context. */
const contextLabel = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`);

/** One group of OpenRouter models to pick from; a click fills the model field. */
function ModelPicks({ title, note, models, current, onPick }: { title: string; note?: string; models: OpenRouterModel[]; current: string; onPick: (id: string) => void }) {
  if (!models.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-small font-medium">{title}</p>
      {note && <p className="text-small text-muted-foreground">{note}</p>}
      <Rows>
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={current === m.id}
            onClick={() => onPick(m.id)}
            className={cn("grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 px-4 py-2.5 text-left transition-colors", current === m.id ? "bg-foreground/[0.04]" : "hover:bg-muted/50")}
          >
            <span className="mt-1">
              <Radio on={current === m.id} />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{m.name.replace(/^[^:]+:\s*/, "")}</span>
              <span className="block font-mono text-small break-all text-muted-foreground">{m.id}</span>
              <span className="block text-small text-muted-foreground">
                {priceLabel(m)}
                {m.context ? ` · ${contextLabel(m.context)} context` : ""}
              </span>
            </span>
          </button>
        ))}
      </Rows>
    </div>
  );
}

function OpenRouterSettings({ d, reload }: { d: Settings; reload: () => Promise<void> }) {
  const o = d.openrouter;
  const models = useResource<{ models: OpenRouterModel[] }>("/settings/openrouter/models");
  const { busy, run } = useAction(reload);
  const [key, setKey] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const model = modelDraft ?? o.model ?? "";
  const list = models.data?.models ?? [];
  return (
    <>
      <Block title="OpenRouter key">
        <Rows>
          {o.connected ? (
            <AccountRow label={o.label ?? "OpenRouter key"} note={`${KEPT} Handed to the agent outside the commands it runs.`} button="Remove key" busy={busy} onRemove={() => void run(() => api("/settings/openrouter/logout", {}), setKeyError)} />
          ) : (
            <form
              className="flex flex-wrap items-center gap-2 px-4 py-4"
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
        </Rows>
        {keyError && <p className="mt-2 text-body text-bad">{keyError}</p>}
      </Block>
      <Block title="Model" aside="Required. For all projects, unless a project sets its own in Setup">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api("/settings/openrouter/model", { model: model.trim() }), setModelError)) setModelDraft(null);
          }}
        >
          <Input aria-label="OpenRouter model" className="max-w-sm font-mono" placeholder="vendor/model" value={model} onChange={(e) => setModelDraft(e.target.value)} maxLength={160} spellCheck={false} autoComplete="off" />
          <Button type="submit" size="sm" disabled={busy || model.trim() === (o.model ?? "")}>
            Save
          </Button>
        </form>
        {modelError && <p className="mt-2 text-body text-bad">{modelError}</p>}
        <p className="mt-2.5 text-small text-muted-foreground">
          Type any OpenRouter model id that calls tools and reads images (the tester runs commands and looks at screenshots), or pick one below.{" "}
          <a className="text-foreground underline underline-offset-2" href="https://openrouter.ai/models?fmt=table&input_modalities=image&supported_parameters=tools" target="_blank" rel="noreferrer">
            All matching models
          </a>
        </p>
        {models.error && <p className="mt-2 text-small text-warn">Could not load OpenRouter's models: {models.error}. You can still type a model id.</p>}
        {list.length > 0 && (
          <div className="mt-5 space-y-5">
            <p className="text-small text-muted-foreground">Suggestions only: we have not tested any of these models through OpenRouter ourselves. Per test is an estimate for a small PR; a real app with longer flows costs more.</p>
            <ModelPicks title="Vision models" models={list.filter((m) => m.kind === "vision")} current={model.trim()} onPick={setModelDraft} />
            <ModelPicks
              title="Free models"
              note="No cost on your key, but OpenRouter allows free models only a few requests per minute and per day, and a test makes many. Runs may stop halfway: fine for trying gespann, not for every PR."
              models={list.filter((m) => m.kind === "free")}
              current={model.trim()}
              onPick={setModelDraft}
            />
          </div>
        )}
      </Block>
    </>
  );
}

/* ------------------------------------------------- Claude Code, Copilot, Grok */

function KeyAgentSettings({ a, reload }: { a: KeyAgent; reload: () => Promise<void> }) {
  const { busy, run } = useAction(reload);
  const [key, setKey] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const model = modelDraft ?? a.model ?? "";
  const base = `/settings/agents/${a.id}`;
  const login = a.login;
  return (
    <>
      <Block title={`${a.name} account`}>
        <Rows>
          {a.connected ? (
            <AccountRow label={a.label ?? `${a.name} key`} note={KEPT} button={login?.state === "connected" ? "Sign out" : "Remove key"} busy={busy} onRemove={() => void run(() => api(`${base}/logout`, {}), setKeyError)} />
          ) : (
            <div className="space-y-3 px-4 py-4">
              <ol className="list-decimal space-y-1 pl-5 text-body text-muted-foreground">
                {a.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              {a.signIn && login?.state === "pending" ? (
                login.code ? (
                  <DeviceCode intro="Open the page and enter this code:" code={login.code} url={login.url} urlLabel="Open page" note="The code expires after 15 minutes. This page updates by itself once you confirmed it." />
                ) : (
                  <p className="flex items-center gap-2 text-body text-muted-foreground">
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Preparing the sign-in…
                  </p>
                )
              ) : (
                a.signIn && (
                  <Button disabled={busy} onClick={() => void run(() => api(`${base}/login`, {}), setKeyError)}>
                    {a.signIn}
                  </Button>
                )
              )}
              {login?.state === "failed" && login.lines && <Log text={login.lines} className="border-bad/40 text-bad" />}
              <p className="text-body text-muted-foreground">{a.signIn ? "Or paste a key or token:" : "Paste the token or key:"}</p>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => api(`${base}/key`, { key: key.trim() }), setKeyError)) setKey("");
                }}
              >
                <Input type="password" aria-label={`${a.name} key`} autoComplete="off" className="max-w-sm font-mono" value={key} onChange={(e) => setKey(e.target.value)} />
                <Button type="submit" size="sm" disabled={busy || !key.trim()}>
                  {busy ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : null} Connect
                </Button>
                <LinkButton href={a.keyUrl} target="_blank" rel="noreferrer" size="sm" variant="ghost">
                  Get a key <ExternalLink className="size-3.5" />
                </LinkButton>
              </form>
            </div>
          )}
        </Rows>
        {keyError && <p className="mt-2 text-body text-bad">{keyError}</p>}
      </Block>
      <Block title="Model" aside="Optional. For all projects, unless a project sets its own in Setup">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api(`${base}/model`, { model: model.trim() }), setModelError)) setModelDraft(null);
          }}
        >
          <Input aria-label={`${a.name} model`} list={`${a.id}-models`} className="max-w-sm font-mono" placeholder={`${a.name}'s default`} value={model} onChange={(e) => setModelDraft(e.target.value)} maxLength={100} />
          <datalist id={`${a.id}-models`}>
            {a.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Button type="submit" size="sm" disabled={busy || model.trim() === (a.model ?? "")}>
            Save
          </Button>
        </form>
        {modelError && <p className="mt-2 text-body text-bad">{modelError}</p>}
        <p className="mt-2.5 text-small text-muted-foreground">Empty uses {a.name}'s default model. The tester needs a model that calls tools and reads screenshots.</p>
      </Block>
    </>
  );
}

/* ---------------------------------------------------------------- Agent */

function AgentSection({ d, reload }: { d: Settings; reload: () => Promise<void> }) {
  const { busy, run } = useAction(reload);
  const [failed, setFailed] = useState<string | null>(null);
  const keyAgent = d.keyAgents.find((a) => a.id === d.agent);
  return (
    <SettingsPane title="Agent" lead="The tester, the environment setup and the fixes run in this agent. It applies to all your projects.">
      <Block title="Who runs the tester">
        <Rows>
          <div role="radiogroup" aria-label="Agent provider" className="divide-y divide-border">
            {AGENTS.map((o) => {
              const on = d.agent === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => !on && void run(() => api("/settings/agent", { agent: o.id }), setFailed)}
                  className={cn("grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3 text-left transition-colors disabled:cursor-default", on ? "bg-foreground/[0.04]" : "hover:bg-muted/50")}
                >
                  <span className="mt-1">
                    <Radio on={on} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">{o.title}</span>
                    <span className="block text-small text-muted-foreground">{o.text}</span>
                  </span>
                  {on ? agentBadge(d) : <span />}
                </button>
              );
            })}
          </div>
        </Rows>
        {failed && <p className="mt-2 text-body text-bad">{failed}</p>}
      </Block>
      {keyAgent ? (
        <KeyAgentSettings key={keyAgent.id} a={keyAgent} reload={reload} />
      ) : d.agent === "openrouter" ? (
        <OpenRouterSettings d={d} reload={reload} />
      ) : (
        <CodexSettings d={d} reload={reload} />
      )}
    </SettingsPane>
  );
}

/* --------------------------------------------------------- Agent access */

/** Agent sign-ins and personal tokens for the MCP endpoint, and how to connect Claude Code or Codex. */
function AgentAccess() {
  const { data, error, reload } = useResource<Tokens>("/tokens");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Loading…</p>;
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
    <SettingsPane
      title="Agent access"
      lead="Lets Claude Code or Codex read your runs over MCP: status, issues, the review text, screenshots and recordings. An agent can also rerun a pull request (at most 3 times per commit), but cannot cancel or approve anything, and sees only the projects you see."
    >
      {data.tokens.length > 0 && (
        <Block title="Connected">
          <Rows>
            {data.tokens.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <span className="font-medium">{t.name}</span>
                {t.client ? <Badge tone="info">signed in</Badge> : <Mono className="text-muted-foreground">gsp_…{t.hint}</Mono>}
                <span className="text-small text-muted-foreground">
                  {t.client ? "connected" : "created"} {ago(t.created)}, {t.last_used ? `used ${ago(t.last_used)}` : "never used"}
                </span>
                <Button size="sm" variant="danger" className="ml-auto" disabled={busy} onClick={() => void act(async () => void (await api(`/tokens/${t.id}/revoke`, {})))}>
                  Revoke
                </Button>
              </div>
            ))}
          </Rows>
        </Block>
      )}
      {failed && <p className="text-body text-bad">{failed}</p>}
      <Block title="Add gespann to your agent">
        <p className="mb-3 text-body text-muted-foreground">It opens this site in your browser; you allow it once and are connected, no token to copy.</p>
        <div className="space-y-1">
          <span className="text-small text-muted-foreground">Claude Code</span>
          <Log text={claude} />
          <span className="text-small text-muted-foreground">Codex</span>
          <Log text={codex} />
        </div>
      </Block>
      <details className="group rounded-lg border border-border bg-card" open={!!fresh}>
        <summary className="cursor-pointer px-4 py-3 text-body font-medium select-none">Use a token instead (CI, scripts, agents without OAuth)</summary>
        <div className="space-y-3 border-t border-border px-4 py-4">
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
    </SettingsPane>
  );
}

/* ----------------------------------------------------------------- Page */

type Item = { id: string; title: string; value?: ReactNode };

function SectionList({ groups, current }: { groups: { title: string; items: Item[] }[]; current: string }) {
  return (
    <nav aria-label="Settings" className="flex flex-wrap gap-1 md:block md:space-y-6">
      {groups.map((g) => (
        <div key={g.title} className="contents md:block">
          <p className="hidden px-2.5 pb-1.5 text-small text-muted-foreground md:block">{g.title}</p>
          {g.items.map((it) => (
            <a
              key={it.id}
              href={`#${it.id}`}
              aria-current={it.id === current ? "page" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setHash(it.id);
                window.scrollTo(0, 0);
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-body md:py-2",
                it.id === current ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <span className="min-w-0 truncate">{it.title}</span>
              {it.value !== undefined && <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-small whitespace-nowrap text-muted-foreground md:inline-flex">{it.value}</span>}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

const Dot = ({ tone }: { tone: "info" | "warn" }) => <span className={cn("size-1.5 rounded-full", tone === "info" ? "bg-info" : "bg-warn")} aria-hidden="true" />;

/** Settings: a list of sections, one open at a time. `/settings#<id>` opens one (`#plan`, `#sandboxes`, …); the agent opens by default. */
export function SettingsPage() {
  const hash = useHash();
  const { data, error, reload } = useResource<Settings>("/settings", codexPending, 3000);
  const modules = useResource<{ sections: SettingsSection[]; error?: string }>("/settings/sections");
  const boxes = useResource<Boxes>("/boxes", boxesLive, 5000).data;
  const tokens = useResource<Tokens>("/tokens").data;
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Loading…</p>;
  const sections = modules.data?.sections ?? [];
  const problem = modules.error ?? modules.data?.error;
  const agent = AGENTS.find((a) => a.id === data.agent);
  const groups: { title: string; items: Item[] }[] = [
    {
      title: "Testing",
      items: [
        {
          id: "agent",
          title: "Agent",
          value: agentReady(data) ? (
            agent?.short
          ) : (
            <>
              <Dot tone="warn" />
              {agent?.short}
            </>
          ),
        },
        {
          id: "sandboxes",
          title: "Sandboxes",
          value: boxes?.running.length ? (
            <>
              <Dot tone="info" />
              {boxes.running.length} running
            </>
          ) : boxes?.limit ? (
            `${boxes.limit} at once`
          ) : undefined,
        },
      ],
    },
    { title: "Your coding agents", items: [{ id: "access", title: "Agent access", value: tokens ? (tokens.tokens.length ? `${tokens.tokens.length} connected` : "none") : undefined }] },
  ];
  if (sections.length) groups.push({ title: "Account", items: sections.map((s) => ({ id: s.id, title: s.title, value: s.badge?.text })) });
  const module = sections.find((s) => s.id === hash);
  const known = hash === "agent" || hash === "sandboxes" || hash === "access" || !!module;
  // A module's section is not loaded yet: wait for it instead of opening the agent.
  const waiting = !known && hash !== "" && !modules.data && !modules.error;
  const current = known ? hash : "agent";
  return (
    <>
      <h1 className="mb-4 text-title font-semibold md:hidden">Settings</h1>
      <div className="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-10">
        <aside className="mb-8 md:mb-0">
          <h1 className="mb-5 hidden px-2.5 text-title font-semibold md:block">Settings</h1>
          <SectionList groups={groups} current={current} />
        </aside>
        <div className="max-w-[45rem] min-w-0 md:pt-1">
          {problem && <p className="mb-6 text-body text-bad">{problem}</p>}
          {waiting ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : current === "sandboxes" ? (
            <Sandboxes />
          ) : current === "access" ? (
            <AgentAccess />
          ) : module ? (
            <ModuleSection key={module.id} s={module} reload={modules.reload} />
          ) : (
            <AgentSection d={data} reload={reload} />
          )}
        </div>
      </div>
    </>
  );
}
