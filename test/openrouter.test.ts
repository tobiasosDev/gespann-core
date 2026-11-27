import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import { listModels, open, seal, suggestModels } from "../src/server/openrouter.ts";

const vision = { supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } };
const MODELS = {
  data: [
    { id: "anthropic/claude-x", name: "Claude X", context_length: 200_000, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.000003", completion: "0.000015" } },
    { id: "acme/text-only", name: "Text only", context_length: 32_000, supported_parameters: ["tools"], architecture: { input_modalities: ["text"] } },
    { id: "acme/no-tools", name: "No tools", context_length: 32_000, supported_parameters: ["temperature"], architecture: { input_modalities: ["text", "image"] } },
    { id: "openrouter/auto", name: "Auto", supported_parameters: ["tools"], pricing: { prompt: "-1", completion: "-1" } },
    { id: "openai/gpt-6.1-terra", name: "OpenAI: GPT-6.1 Terra", context_length: 1_050_000, ...vision, pricing: { prompt: "0.000001", completion: "0.000005" } },
    { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5", context_length: 1_000_000, ...vision, pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001" } },
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", context_length: 262_144, ...vision, pricing: { prompt: "0", completion: "0" } },
    { id: "openrouter/free", name: "Free Models Router", context_length: 200_000, ...vision, pricing: { prompt: "0", completion: "0" } },
  ],
};

/** OpenRouter as the tests need it: one accepted key, and the model list. */
function fakeOpenRouter(seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/key")) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer sk-or-v1-good-key-0123456789") return new Response(JSON.stringify({ error: { message: "Missing Authentication header", code: 401 } }), { status: 401 });
      return new Response(JSON.stringify({ data: { label: "sk-or-v1-goo...789", usage: 0 } }));
    }
    if (url.endsWith("/models")) return new Response(JSON.stringify(MODELS));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("a key sealed here opens with the same secret only", () => {
  const sealed = seal("s".repeat(40), "sk-or-v1-abc");
  assert.equal(sealed.split(".").length, 3);
  assert.equal(open("s".repeat(40), sealed), "sk-or-v1-abc");
  assert.throws(() => open("t".repeat(40), sealed));
});

test("the model list keeps models that call tools and read images, with their price per 1M tokens", async () => {
  const models = await listModels(fakeOpenRouter());
  assert.deepEqual(
    models.map((m) => m.id),
    ["anthropic/claude-haiku-5.5", "anthropic/claude-x", "google/gemma-4-31b-it:free", "openai/gpt-6.1-terra", "openrouter/auto", "openrouter/free"],
  );
  assert.deepEqual(models[1], { id: "anthropic/claude-x", name: "Claude X", context: 200_000, price: { input: 3, cached: 3, output: 15 } }, "no cache price: cached input costs the full rate");
  assert.deepEqual(models[0]?.price, { input: 0.1, cached: 0.01, output: 0.5 });
  assert.equal(models.find((m) => m.id === "openrouter/auto")?.price, null, "a router has no fixed price");
});

test("the picker offers only the listed picks: vision models, then free ones without routers", async () => {
  const picks = suggestModels(await listModels(fakeOpenRouter()));
  assert.deepEqual(
    picks.map((m) => [m.id, m.kind]),
    [
      ["openai/gpt-6.1-terra", "vision"],
      ["anthropic/claude-haiku-5.5", "vision"],
      ["google/gemma-4-31b-it:free", "free"],
    ],
    "a pick OpenRouter no longer lists is left out",
  );
});

test("when none of the free picks is listed any more, the largest free models fill in", () => {
  const m = (id: string, context: number, price: number) => ({ id, name: id, context, price: { input: price, cached: price, output: price } });
  const picks = suggestModels([m("a/small:free", 100_000, 0), m("b/big:free", 1_000_000, 0), m("c/mid:free", 500_000, 0), m("d/paid", 2_000_000, 1), m("openrouter/free", 2_000_000, 0)]);
  assert.deepEqual(
    picks.map((p) => p.id),
    ["b/big:free", "c/mid:free"],
  );
});

test("API: OpenRouter key, model and provider; setup starts once the agent is ready; the key never leaves the server", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data" });
  const db = new Db(":memory:");
  const seen: string[] = [];
  const server = createApp({ config, db, github: () => { throw new Error("no github in this test"); }, githubReady: () => false, fetch: fakeOpenRouter(seen) });
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: "T", avatar: null });
  db.setRepos(u.id, [{ repo_id: 1, installation_id: 9, account: "acme", full_name: "acme/shop", private: true, default_branch: "main" }]);
  db.createSession("s".repeat(64), u.id);
  const p = db.createProject({ owner_id: u.id, installation_id: 9, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1" };
  const get = async (path: string) => (await server.request(`/api${path}`, { headers: h })).json();
  const post = async (path: string, body: unknown) => server.request(`/api${path}`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const s0 = await get("/settings");
  assert.equal(s0.agent, "codex");
  assert.deepEqual(s0.openrouter, { connected: false, label: null, model: null });

  assert.equal((await post("/settings/agent", { agent: "gemini" })).status, 400);
  assert.equal((await post("/settings/agent", { agent: "openrouter" })).status, 200);
  assert.equal((await post(`/projects/${p}/setup`, {})).status, 409, "no key yet");

  assert.equal((await post("/settings/openrouter/key", { key: "not-a-key" })).status, 400);
  const refused = await post("/settings/openrouter/key", { key: "sk-or-v1-wrong-key-0123456789" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /does not accept this key/);
  assert.equal((await post("/settings/openrouter/key", { key: "sk-or-v1-good-key-0123456789" })).status, 200);
  assert.equal(db.project(p)?.setup, "none", "a key without a model is not ready");

  assert.equal((await post("/settings/openrouter/model", { model: "bad model" })).status, 400);
  assert.equal((await post("/settings/openrouter/model", { model: "gpt-6.2-sol" })).status, 400, "OpenRouter ids name the vendor");
  assert.equal((await post("/settings/openrouter/model", { model: "anthropic/claude-x" })).status, 200);
  assert.equal(db.project(p)?.setup, "queued", "key and model: the setup starts by itself");
  assert.equal(db.agent(u.id)?.openrouter_context, 200_000, "the context size from OpenRouter's list");

  const s1 = await get("/settings");
  assert.equal(s1.agent, "openrouter");
  assert.deepEqual(s1.openrouter, { connected: true, label: "sk-or-v1-goo...789", model: "anthropic/claude-x" });
  const detail = await get(`/projects/${p}`);
  assert.deepEqual([detail.agent, detail.agent_ready, detail.openrouter_model], ["openrouter", true, "anthropic/claude-x"]);
  for (const body of [s1, detail]) assert.equal(JSON.stringify(body).includes("good-key"), false, "the key never leaves the server");
  const stored = db.sql.prepare("select openrouter_key from users where id = ?").get(u.id) as { openrouter_key: string };
  assert.equal(stored.openrouter_key.includes("good-key"), false, "kept sealed");
  assert.equal(open(config.sessionSecret, stored.openrouter_key), "sk-or-v1-good-key-0123456789");

  assert.deepEqual((await get("/settings/openrouter/models")).models.map((m: { id: string }) => m.id), ["openai/gpt-6.1-terra", "anthropic/claude-haiku-5.5", "google/gemma-4-31b-it:free"]);
  assert.equal(seen.filter((u) => u.endsWith("/models")).length, 1, "the model list is asked once an hour");

  // A project's own model may be an OpenRouter id.
  assert.equal((await post(`/projects/${p}/criteria`, { criteria: "", model: "openai/gpt-x" })).status, 200);
  assert.equal(db.project(p)?.model, "openai/gpt-x");

  assert.equal((await post("/settings/openrouter/logout", {})).status, 200);
  assert.equal(db.agentReady(u.id), false);
  assert.equal((await post(`/projects/${p}/suggest`, {})).status, 409);
  // Back to Codex: its own sign-in decides again.
  assert.equal((await post("/settings/agent", { agent: "codex" })).status, 200);
  db.setCodex(u.id, { codex_state: "connected" });
  assert.equal(db.agentReady(u.id), true);
});
