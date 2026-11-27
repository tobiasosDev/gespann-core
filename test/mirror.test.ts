import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { MIRROR_PATH, mirrorCanvas, startMirror } from "../src/verify/mirror.ts";
import { testerPrompt } from "../src/verify/prompt.ts";
import { parseRecipe } from "../src/verify/recipe.ts";
import { finish, prepare, type RunContext } from "../src/verify/run.ts";
import { viewportsOf } from "../src/verify/viewports.ts";

/** A copy that refuses frames, sets a cookie for its own domain and redirects to its own absolute address. */
async function copy(): Promise<{ server: Server; origin: string; seen: { host?: string; origin?: string }[] }> {
  const seen: { host?: string; origin?: string }[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    seen.push({ ...(req.headers.host ? { host: req.headers.host } : {}), ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
    if (req.url === "/login") {
      res.writeHead(303, { location: `${origin}/home`, "set-cookie": "s=1; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None" });
      return res.end();
    }
    const html = `<a href="${origin}/pricing">Pricing</a>`;
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; default-src 'self'" });
    res.end(gzipSync(html));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, seen };
}

test("the mirror serves the copy so it loads in a frame, keeps its links and cookies, and opens pages in the mirror", async () => {
  const c = await copy();
  const notes = join(realpathSync(mkdtempSync(join(tmpdir(), "gespann-mirror-"))), "notes.txt");
  const m = await startMirror({ target: c.origin, viewports: viewportsOf("phone-s,desktop"), notes });
  const at = new URL(m.url).origin;
  try {
    const page = await fetch(`${at}/home`, { headers: { "sec-fetch-dest": "iframe" } });
    assert.equal(page.headers.get("x-frame-options"), null);
    assert.equal(page.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(await page.text(), `<a href="${at}/pricing">Pricing</a>`, "an absolute link to the copy stays in the mirror");
    assert.deepEqual(c.seen.at(-1), { host: new URL(c.origin).host }, "the copy sees its own host");

    const login = await fetch(`${at}/login`, { method: "POST", redirect: "manual", headers: { origin: at, "sec-fetch-dest": "iframe" } });
    assert.equal(login.headers.get("location"), `${at}/home`);
    assert.equal(login.headers.get("set-cookie"), "s=1; Path=/; HttpOnly; SameSite=Lax");
    assert.deepEqual(c.seen.at(-1), { host: new URL(c.origin).host, origin: c.origin }, "a CSRF check comparing Origin and Host passes");

    const tab = await fetch(`${at}/orders?x=1`, { redirect: "manual", headers: { "sec-fetch-dest": "document" } });
    assert.equal(tab.status, 302);
    assert.equal(tab.headers.get("location"), `${MIRROR_PATH}?path=%2Forders%3Fx%3D1`);

    assert.match(await (await fetch(m.url)).text(), /"path":"\/"/, "without a path the mirror opens the copy's own address");
    const mirror = await (await fetch(`${m.url}?path=%2Forders%3Fx%3D1`)).text();
    assert.match(mirror, /"path":"\/orders\?x=1"/);
    assert.match(mirror, /Small phone.*Desktop/s);

    await fetch(`${at}/__gespann/note`, { method: "POST", body: 'Small phone 375x667: could not click the link "Pricing"' });
    assert.match(readFileSync(notes, "utf8"), /Z Small phone 375x667: could not click the link "Pricing"\n$/);
  } finally {
    await m.close();
    c.server.close();
  }
});

test("the mirror's canvas fits every size at full scale, capped at a 4K screen", () => {
  assert.deepEqual(mirrorCanvas(viewportsOf("phone-s,desktop-l")), { width: 2343, height: 1232 });
  assert.deepEqual(mirrorCanvas(viewportsOf("phone-s,phone-l,tablet,laptop,desktop,desktop-l")), { width: 3408, height: 2040 });
});

test("with the mirror, the tester checks every size at once instead of one after the other", () => {
  const recipe = parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nlogin: { user: a, password: b, path: /login }\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1\n');
  const base = { repo: "acme/shop", pr: 4, head: "h", base: "b", url: "http://localhost:1", out: "/o", work: "/w", criteria: "", recipe, viewports: viewportsOf("phone-s,desktop-l") };
  const p = testerPrompt({ ...base, mirror: "http://127.0.0.1:5000/__gespann/mirror" });
  assert.match(p, /Test them all at once, not one after the other\. The mirror at http:\/\/127\.0\.0\.1:5000\/__gespann\/mirror/);
  assert.match(p, /viewport to 2343x1232/);
  assert.match(p, /You drive Large desktop first/);
  assert.match(p, /\/w\/mirror-notes\.txt/);
  assert.match(p, /at http:\/\/127\.0\.0\.1:5000\/login with a \/ b/, "the login goes through the mirror, so its cookie is the mirror's");
  assert.match(p, /Each check covers every size/);
  assert.match(p, /an order placed in the mirror is placed 2 times/);
  const entry = testerPrompt({ ...base, url: "http://localhost:1/app/", recipe: parseRecipe('version: 1\ntrigger: { paths: ["**"] }\nlogin: { user: a, password: b, path: login }\nenv:\n  up: "true"\n  down: "true"\n  url: http://localhost:1/app/\n'), mirror: "http://127.0.0.1:5000/__gespann/mirror" });
  assert.match(entry, /at http:\/\/127\.0\.0\.1:5000\/app\/login with a \/ b/, "a login path relative to the copy's entry stays below it");
  assert.doesNotMatch(p, /one size after the other:|one screenshot per size|One check per size/);
  const without = testerPrompt(base);
  assert.match(without, /one size after the other/, "without a mirror, sizes are checked in turn");
  assert.doesNotMatch(without, /mirror/);
  assert.doesNotMatch(testerPrompt({ ...base, viewports: viewportsOf("tablet"), mirror: "http://127.0.0.1:5000/__gespann/mirror" }), /mirror/, "one size needs no mirror");
});

test("prepare starts the mirror for two sizes or more, and finish stops it", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gespann-run-")));
  writeFileSync(join(dir, "verify.yml"), "");
  const c: RunContext = { root: dir, recipeFile: join(dir, "verify.yml"), pr: "7", head: "a".repeat(40), base: "b".repeat(40), run: "0123456789ab", work: join(dir, "work"), out: join(dir, "out") };
  const app = await copy();
  const r = parseRecipe(`version: 1\ntrigger: { paths: ["**"] }\nenv:\n  up: "true"\n  down: "true"\n  url: ${app.origin}/\n`);
  try {
    const p = await prepare(c, r, viewportsOf("phone-s,desktop"));
    assert.equal(p.ok, true);
    assert.match(p.mirror ?? "", /^http:\/\/127\.0\.0\.1:\d+\/__gespann\/mirror$/);
    assert.equal((await fetch(p.mirror as string)).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(c.work, "prepared.json"), "utf8")), p);
    await finish(c, r, 1000);
    let stopped = false;
    for (let i = 0; i < 50 && !stopped; i++) {
      stopped = await fetch(p.mirror as string).then(() => false, () => true);
      if (!stopped) await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.ok(stopped, "teardown stops the mirror");
  } finally {
    app.server.close();
  }
});
