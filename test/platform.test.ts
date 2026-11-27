import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";
import type { ModuleJob } from "../src/server/extension.ts";
import { hostSizeFor, type OrchestratorState, servesMacos } from "../src/server/internal.ts";
import { refusal } from "../src/server/jobs.ts";
import { repairPrompt, setupPrompt, testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe } from "../src/verify/recipe.ts";
import { screenshotTries } from "../src/verify/run.ts";
import { viewportsOf } from "../src/verify/viewports.ts";

const linux = { spec: "remote", kind: "cloud", parallel: 90, why: "", logins: [], default: true, platform: "linux" as const };
const mac = { spec: "remote", kind: "cloud mac", parallel: 4, why: "", logins: [], default: true, platform: "macos" as const };

function server() {
  const db = new Db(":memory:");
  const app = createApp({ config: loadConfig({ DATA_DIR: "/tmp/gespann-test-data" }), db, github: () => { throw new Error("no github"); }, githubReady: () => false });
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const id = db.createProject({ owner_id: u.id, installation_id: 9, repo: "tobi/app", repo_id: 11, default_branch: "main" });
  db.setRepos(u.id, [{ repo_id: 11, installation_id: 9, account: "tobi", full_name: "tobi/app", private: false, default_branch: "main" }]);
  db.createSession("s".repeat(64), u.id);
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1", "Content-Type": "application/json" };
  const get = async () => (await app.request(`/api/projects/${id}`, { headers: h })).json();
  const set = (platform: unknown) => app.request(`/api/projects/${id}/platform`, { method: "POST", headers: h, body: JSON.stringify({ platform }) });
  return { db, id, get, set };
}

test("API: a project runs on Linux until it switches to macOS, which resets its environment", async () => {
  const { db, id, get, set } = server();
  const before = await get();
  assert.equal(before.platform, "linux");
  assert.equal(before.macos_available, false, "no orchestrator with macOS sandboxes");
  db.setSetting("orchestrator", JSON.stringify({ kind: "cloud", parallel: 90, why: "", providers: [linux, mac], instance: "i", beat: Date.now() }));
  assert.equal((await get()).macos_available, true);

  db.updateProject(id, { setup: "ready", bundle: 3, sandbox_id: "boat-1" });
  assert.equal((await set("macos")).status, 200);
  const p = db.project(id);
  assert.deepEqual([p?.platform, p?.setup, p?.bundle, p?.sandbox_id], ["macos", "none", 0, null], "a Linux recipe is no use on a Mac");
  assert.equal((await get()).platform, "macos");

  assert.equal((await set("windows")).status, 400);
  db.enqueue(id, "setup");
  assert.equal((await set("linux")).status, 409, "not while a job of the project waits or runs");
  assert.equal(db.project(id)?.platform, "macos");
  assert.equal((await set("macos")).status, 200, "the same platform again changes nothing");
});

test("Settings: macOS sandboxes add no room to a user's Linux number; servesMacos says whether projects may choose macOS", () => {
  const s: OrchestratorState = { kind: "cloud", parallel: 90, why: "", providers: [mac, linux], instance: "i", beat: 0 };
  assert.equal(hostSizeFor(s, "acme"), 90, "the Linux provider's number, even listed after the Mac one");
  assert.equal(hostSizeFor({ ...s, providers: [mac] }, "acme"), null, "a Mac alone serves no web project");
  assert.equal(servesMacos(s), true);
  assert.equal(servesMacos({ ...s, providers: [linux] }), false);
  assert.equal(servesMacos({ kind: "ssh", parallel: 3, why: "", instance: "i", beat: 0 }), false, "an orchestrator from before platforms");
  assert.equal(servesMacos(null), false);
});

test("server module: every job says which platform it runs on, so Mac minutes can cost more", async () => {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  const id = db.createProject({ owner_id: u.id, installation_id: 9, repo: "tobi/app", repo_id: 11, default_branch: "main" });
  const seen: ModuleJob[] = [];
  const module = { name: "test", admit: (j: ModuleJob) => (seen.push(j), null) };
  const job = { id: db.enqueue(id, "setup"), kind: "setup" as const };
  await refusal({ db, module }, job, db.project(id)!);
  db.updateProject(id, { platform: "macos" });
  await refusal({ db, module }, job, db.project(id)!);
  assert.deepEqual(seen.map((j) => j.platform), ["linux", "macos"]);
});

test("prompts: an iOS app is built with Xcode and driven in the iOS Simulator, never in Chrome", () => {
  const recipe = parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nenv:\n  up: "true"\n  down: "true"\n  url: com.acme.shop on the booted iPhone 17 simulator\nlogin:\n  path: /login\n  user: a@b.test\n  password: pw\n');
  const base = { repo: "acme/shop", pr: 4, head: "h", base: "b", url: "com.acme.shop on the booted iPhone 17 simulator", out: "/o", work: "/w", criteria: "", recipe };
  const ios = testerPrompt({ ...base, platform: "macos", viewports: viewportsOf("phone-s,desktop-l"), mirror: "http://127.0.0.1:9/" });
  assert.match(ios, /runs in the iOS Simulator on this Mac: com\.acme\.shop on the booted iPhone 17 simulator\./);
  assert.match(ios, /in the iOS Simulator with the simulator tools \(look at the screen, tap, type, swipe\)/);
  assert.doesNotMatch(ios, /Chrome|browser_resize|mirror|screen sizes/, "screen sizes and the mirror are for browsers");
  assert.match(ios, /Sign in through the normal login page with a@b\.test/, "no URL built from a simulator description");
  assert.match(testerPrompt({ ...base, url: "http://localhost:1", recipe: parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1\n') }), /open http:\/\/localhost:1 in Chrome/);

  const setup = setupPrompt({ repo: "acme/shop", repoDir: "/r", projectDir: "/p", criteria: "", platform: "macos" });
  assert.match(setup, /xcodebuild/);
  assert.match(setup, /xcrun simctl list devices available/);
  assert.match(setup, /Xcode and the iOS Simulator are installed; Docker may not be\./);
  assert.doesNotMatch(setup, /Chrome/);
  assert.match(setupPrompt({ repo: "acme/shop", repoDir: "/r", projectDir: "/p", criteria: "" }), /Docker is installed\./);

  const repair = repairPrompt({ repo: "acme/shop", repoDir: "/r", projectDir: "/p", gaps: [], platform: "macos" });
  assert.match(repair, /Look at the app in the iOS Simulator/);
  assert.doesNotMatch(repair, /Chrome/);
});

test("gespann shot: a Mac captures the booted iOS Simulator first, then the desktop", () => {
  assert.deepEqual(screenshotTries("/o/a.png", "darwin"), ['xcrun simctl io booted screenshot --type=png "/o/a.png"', 'screencapture -x -t png "/o/a.png"']);
  assert.match(screenshotTries("/o/a.png", "linux", ":7")[0] ?? "", /^import -display :7 /);
});
