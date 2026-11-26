import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db } from "../src/server/db.ts";

function owner(db: Db, id: number, login: string) {
  const u = db.upsertUser({ github_id: id, login, name: null, avatar: null });
  const a = db.createProject({ owner_id: u.id, installation_id: 9, repo: `${login}/a`, repo_id: id * 10 + 1, default_branch: "main" });
  const b = db.createProject({ owner_id: u.id, installation_id: 9, repo: `${login}/b`, repo_id: id * 10 + 2, default_branch: "main" });
  return { u, a, b };
}

test("an owner's own job limit holds their next job back; other owners and freed boxes go on", () => {
  const db = new Db(":memory:");
  const t = owner(db, 1, "tobi");
  const e = owner(db, 2, "eve");
  db.setMaxJobs(t.u.id, 1);
  const j1 = db.enqueue(t.a, "suggest");
  const j2 = db.enqueue(t.b, "suggest");
  const j3 = db.enqueue(e.a, "suggest");
  assert.equal(db.nextJob()?.id, j1);
  assert.ok(db.claimJob(j1));
  assert.equal(db.nextJob()?.id, j3, "tobi has 1 of 1 running; eve's job goes first");
  assert.ok(db.claimJob(j3));
  assert.equal(db.nextJob(), undefined, "tobi's second job waits for his box");
  db.endJob(j1, "done");
  assert.equal(db.nextJob()?.id, j2);
  db.setMaxJobs(t.u.id, null);
  assert.equal(db.maxJobs(t.u.id), null);
});

test("box time sums job durations per UTC day of this month; a running job counts up to now", () => {
  const db = new Db(":memory:");
  const t = owner(db, 1, "tobi");
  const e = owner(db, 2, "eve");
  const job = (project: number, started: string, finished: string | null) => {
    const id = db.enqueue(project, "suggest");
    db.sql.prepare("update jobs set status = ?, started = ?, finished = ? where id = ?").run(finished ? "done" : "running", started, finished, id);
    return id;
  };
  job(t.a, "2026-10-31T23:00:00.000Z", "2026-10-31T23:30:00.000Z"); // last month: 30 min
  job(t.a, "2026-11-03T10:00:00.000Z", "2026-11-03T10:12:30.000Z"); // 750 s
  job(t.b, "2026-11-03T11:00:00.000Z", "2026-11-03T11:05:00.000Z"); // 300 s
  const running = job(t.b, "2026-11-25T12:00:00.000Z", null); // 10 min up to `at`
  job(e.a, "2026-11-03T10:00:00.000Z", "2026-11-03T20:00:00.000Z"); // eve's, not tobi's
  const at = new Date("2026-11-25T12:10:00.000Z");
  const time = db.boxTime(t.u.id, at);
  assert.equal(time.month, "2026-11");
  assert.equal(time.days.length, 30);
  assert.equal(time.days[2]?.seconds, 1050);
  assert.equal(time.days[24]?.seconds, 600);
  assert.equal(time.monthSeconds, 1650);
  assert.equal(time.totalSeconds, 1650 + 1800);
  assert.equal(time.jobs, 3);
  assert.deepEqual(db.runningBoxes(t.u.id).map((r) => [r.job_id, r.repo]), [[running, "tobi/b"]]);
  assert.equal(db.runningBoxes(e.u.id).length, 0);
});

test("API: the limit is 1 to the host's maximum; a chosen number stays when the host grows", async () => {
  const config = loadConfig({ DATA_DIR: "/tmp/gespann-test-data" });
  const db = new Db(":memory:");
  const server = createApp({ config, db, github: () => { throw new Error("no github"); }, githubReady: () => false, parallel: () => 4 });
  const { u } = owner(db, 1, "tobi");
  db.createSession("s".repeat(64), u.id);
  const h = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1", "Content-Type": "application/json" };
  const get = async () => (await server.request("/api/boxes", { headers: h })).json();
  const set = (limit: unknown) => server.request("/api/boxes/limit", { method: "POST", headers: h, body: JSON.stringify({ limit }) });
  assert.deepEqual(await get().then((b) => [b.host, b.limit, b.own, b.queued, b.running]), [4, 4, null, 0, []]);
  assert.equal((await set(5)).status, 400);
  assert.equal((await set(0)).status, 400);
  assert.equal((await set(1.5)).status, 400);
  assert.equal((await set(2)).status, 200);
  assert.deepEqual(await get().then((b) => [b.limit, b.own]), [2, 2]);
  assert.equal((await set(4)).status, 200);
  assert.deepEqual(await get().then((b) => [b.limit, b.own]), [4, 4]);
  const bigger = createApp({ config, db, github: () => { throw new Error("no github"); }, githubReady: () => false, parallel: () => 8 });
  const after = await (await bigger.request("/api/boxes", { headers: h })).json();
  assert.deepEqual([after.host, after.limit], [8, 4], "a chosen limit stays when the host grows");
  assert.equal((await server.request("/api/boxes/limit", { method: "POST", headers: { Cookie: h.Cookie, "Content-Type": "application/json" }, body: '{"limit":1}' })).status, 403, "no x-gespann header, no change");
});
