import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alertJobEnded, classify, confirmLink, readConfirmToken } from "../src/server/alerts.ts";
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { Db, type JobKind, type JobStatus, type Run } from "../src/server/db.ts";
import { Github } from "../src/server/github.ts";
import { internalToken } from "../src/server/internal.ts";
import { createMailer, type Mail, type Mailer, mailSettings } from "../src/server/mail.ts";
import { endJob, startJob } from "./jobs.ts";

const BASE = "https://gespann.example.com";
const SECRET = "alerts-test-secret-alerts-test-secret";

function fakeMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { sends: true, sent, send: async (m) => void sent.push(m) };
}

function world() {
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: "Tobi", avatar: null });
  const p = db.createProject({ owner_id: u.id, installation_id: 1, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const mailer = fakeMailer();
  const d = { db, config: { baseUrl: BASE }, mailer };
  let pr = 0;
  /** A job of the project that ended: a run with this run status and outcome, or a setup. */
  const end = async (kind: JobKind, status: JobStatus, run?: Partial<Pick<Run, "status" | "outcome" | "error" | "conflict">>) => {
    let runId: number | null = null;
    if (kind === "run") {
      runId = db.createRun({ project_id: p, pr: ++pr, title: `Change ${pr}`, head: `h${pr}`, base: "b", base_ref: "main", token: "t".repeat(32) });
      db.updateRun(runId, { status: "done", ...run });
    }
    const job = db.enqueue(p, kind, runId);
    startJob(db, job);
    endJob(db, job, status);
    if (status === "failed") db.sql.prepare("update jobs set error = ? where id = ?").run("sandbox did not start", job);
    await alertJobEnded(d, job);
    return job;
  };
  return { db, u, p, mailer, end };
}

test("an ended job counts into one kind of trouble, breaks the others of its group, or says nothing", () => {
  const run = (status: Run["status"], outcome: Run["outcome"], conflict: string | null = null) => ({ status, outcome, conflict });
  assert.deepEqual(classify({ kind: "run", status: "done" }, run("done", "PASS")), { hit: null, group: "run" });
  assert.deepEqual(classify({ kind: "run", status: "done" }, run("done", "FAIL")), { hit: "fail", group: "run" });
  assert.deepEqual(classify({ kind: "run", status: "done" }, run("done", "BLOCKED")), { hit: "blocked", group: "run" });
  // The orchestrator stores a run that threw as failed with outcome FAIL: not tested, so not a FAIL.
  assert.deepEqual(classify({ kind: "run", status: "failed" }, run("failed", "FAIL")), { hit: "error", group: "run" });
  assert.deepEqual(classify({ kind: "run", status: "done" }, run("failed", null)), { hit: "error", group: "run" });
  assert.equal(classify({ kind: "run", status: "done" }, run("done", "SKIP")), null);
  assert.equal(classify({ kind: "run", status: "done" }, run("done", null, '["a.ts"]')), null, "a merge conflict tested nothing");
  assert.equal(classify({ kind: "run", status: "cancelled" }, run("cancelled", null)), null);
  assert.deepEqual(classify({ kind: "setup", status: "failed" }, null), { hit: "setup", group: "setup" });
  assert.deepEqual(classify({ kind: "setup", status: "done" }, null), { hit: null, group: "setup" });
  assert.equal(classify({ kind: "suggest", status: "failed" }, null), null);
});

test("runs that cannot test mail the owner once at the third in a row, and again only after a streak broke", async () => {
  const { db, u, mailer, end } = world();
  db.offerEmail(u.id, "tobi@example.com", "github");
  await end("run", "failed", { status: "failed", outcome: "FAIL", error: "sandbox did not start" });
  await end("run", "failed", { status: "failed", outcome: "FAIL", error: "sandbox did not start" });
  assert.equal(mailer.sent.length, 0);
  await end("run", "failed", { status: "failed", outcome: "FAIL", error: "the agent ran out of credits" });
  assert.equal(mailer.sent.length, 1);
  const m = mailer.sent[0] as Mail;
  assert.equal(m.to, "tobi@example.com");
  assert.equal(m.subject, "gespann could not test acme/shop 3 times in a row");
  assert.match(m.text, /Last: PR #3, "Change 3"/);
  assert.match(m.text, /Reason: the agent ran out of credits/);
  assert.match(m.text, /Details: https:\/\/gespann\.example\.com\/runs\/3/);
  assert.match(m.text, /https:\/\/gespann\.example\.com\/settings#mail/);
  await end("run", "failed", { status: "failed", outcome: "FAIL" });
  assert.equal(mailer.sent.length, 1, "one mail per streak");
  // A tested run breaks the streak: three more failures make a new mail.
  await end("run", "done", { outcome: "PASS" });
  for (let i = 0; i < 3; i++) await end("run", "failed", { status: "failed", outcome: "FAIL" });
  assert.equal(mailer.sent.length, 2);
  // Neutral runs neither count nor break.
  await end("run", "done", { outcome: "PASS" });
  await end("run", "failed", { status: "failed", outcome: "FAIL" });
  await end("run", "done", { outcome: "SKIP" });
  await end("run", "cancelled", { status: "cancelled" });
  await end("run", "failed", { status: "failed", outcome: "FAIL" });
  await end("run", "failed", { status: "failed", outcome: "FAIL" });
  assert.equal(mailer.sent.length, 3);
});

test("the owner's own rules: FAIL mails only when switched on, at their number; off sends nothing; no address sends nothing", async () => {
  const { db, u, mailer, end } = world();
  await end("setup", "failed");
  assert.equal(mailer.sent.length, 0, "no address yet");
  db.offerEmail(u.id, "tobi@example.com", "github");
  await end("run", "done", { outcome: "FAIL" });
  await end("run", "done", { outcome: "FAIL" });
  assert.equal(mailer.sent.length, 0, "FAIL is off by default: the PR shows it already");
  db.setAlertRule(u.id, { category: "fail", on: 1, after: 2 });
  // The streak is already at 2 and was never mailed: the next one mails.
  await end("run", "done", { outcome: "FAIL" });
  assert.deepEqual(mailer.sent.map((m) => m.subject), ["3 PR tests of acme/shop failed in a row"]);
  db.setAlertRule(u.id, { category: "setup", on: 0, after: 1 });
  await end("setup", "done");
  await end("setup", "failed");
  assert.equal(mailer.sent.length, 1, "setup mails are off");
  db.setAlertRule(u.id, { category: "setup", on: 1, after: 1 });
  await end("setup", "done");
  await end("setup", "failed");
  assert.equal(mailer.sent.at(-1)?.subject, "The copy of acme/shop could not be built");
  assert.match(mailer.sent.at(-1)?.text ?? "", /\/projects\/1\/setup/);
});

test("a sign-in's address fills an empty one and follows its own source, but never replaces the user's choice", () => {
  const { db, u } = world();
  db.offerEmail(u.id, "old@github.example", "github");
  db.offerEmail(u.id, "new@github.example", "github");
  assert.equal(db.user(u.id)?.email, "new@github.example");
  db.offerEmail(u.id, "sso@company.example", "workos");
  assert.equal(db.user(u.id)?.email, "new@github.example", "another source does not take over");
  db.setPendingEmail(u.id, "me@home.example");
  assert.equal(db.confirmEmail(u.id, "other@home.example"), false);
  assert.equal(db.confirmEmail(u.id, "me@home.example"), true);
  db.offerEmail(u.id, "newer@github.example", "github");
  assert.deepEqual([db.user(u.id)?.email, db.user(u.id)?.email_source, db.user(u.id)?.email_pending], ["me@home.example", "user", null]);
});

test("confirmation links carry their own proof and expire after a day", () => {
  const link = confirmLink(BASE, SECRET, 7, "a@b.example", 1_000);
  const token = new URL(link).searchParams.get("t") as string;
  assert.deepEqual(readConfirmToken(SECRET, token, 2_000), { userId: 7, email: "a@b.example" });
  assert.equal(readConfirmToken(SECRET, token, 1_000 + 25 * 3_600_000), null, "expired");
  assert.equal(readConfirmToken("another-secret", token, 2_000), null, "forged");
  const [payload, sig] = token.split(".");
  const other = Buffer.from(JSON.stringify({ u: 8, e: "a@b.example", x: 9e15 })).toString("base64url");
  assert.equal(readConfirmToken(SECRET, `${other}.${sig}`, 2_000), null, "another user's payload with this signature");
  assert.ok(payload);
});

test("SMTP_URL and MAIL_FROM: off without a URL, refused when they cannot work", () => {
  assert.deepEqual(mailSettings({}), { smtpUrl: "", from: "" });
  assert.deepEqual(mailSettings({ SMTP_URL: "smtps://u:p@smtp.example.com:465", MAIL_FROM: "gespann <noreply@example.com>" }), { smtpUrl: "smtps://u:p@smtp.example.com:465", from: "gespann <noreply@example.com>" });
  assert.throws(() => mailSettings({ SMTP_URL: "smtps://u:p@smtp.example.com" }), /MAIL_FROM/);
  assert.throws(() => mailSettings({ SMTP_URL: "https://api.mailersend.com", MAIL_FROM: "x@y.z" }), /smtp:\/\/ or smtps:\/\//);
  assert.throws(() => mailSettings({ SMTP_URL: "not a url", MAIL_FROM: "x@y.z" }), /not a URL/);
  assert.equal(createMailer({ smtpUrl: "", from: "" }).sends, false);
});

/** A mail server that speaks just enough SMTP for one message, and keeps what it got. */
async function smtpServer(): Promise<{ port: number; got: { auth: string; from: string; to: string; data: string }[]; close: () => void }> {
  const got: { auth: string; from: string; to: string; data: string }[] = [];
  const server = createServer((s: Socket) => {
    const cur = { auth: "", from: "", to: "", data: "" };
    let inData = false;
    let buf = "";
    s.write("220 test ESMTP\r\n");
    s.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            got.push({ ...cur });
            s.write("250 queued\r\n");
          } else cur.data += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") s.write("250-test\r\n250 AUTH PLAIN\r\n");
        else if (cmd === "AUTH") {
          cur.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString().split("\0").slice(1).join(":");
          s.write("235 ok\r\n");
        } else if (cmd === "MAIL") (cur.from = line), s.write("250 ok\r\n");
        else if (cmd === "RCPT") (cur.to = line), s.write("250 ok\r\n");
        else if (cmd === "DATA") (inData = true), s.write("354 go\r\n");
        else if (cmd === "QUIT") s.end("221 bye\r\n");
        else s.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, got, close: () => server.close() };
}

test("the SMTP mailer delivers to the server SMTP_URL names, with its login and MAIL_FROM", async () => {
  const smtp = await smtpServer();
  try {
    const mailer = createMailer({ smtpUrl: `smtp://mailer%40x:p%40ss@127.0.0.1:${smtp.port}`, from: "gespann <noreply@gespann.example>" });
    await mailer.send({ to: "tobi@example.com", subject: "gespann could not test acme/shop 3 times in a row", text: "Hi Tobi,\n\nDetails: https://x/runs/3\n" });
    assert.equal(smtp.got.length, 1);
    const g = smtp.got[0] as (typeof smtp.got)[number];
    assert.equal(g.auth, "mailer@x:p@ss");
    assert.match(g.from, /<noreply@gespann\.example>/);
    assert.match(g.to, /<tobi@example\.com>/);
    assert.match(g.data, /Subject: gespann could not test acme\/shop 3 times in a row/);
    assert.match(g.data, /Details: https:\/\/x\/runs\/3/);
  } finally {
    smtp.close();
  }
});

function app(mailer: Mailer | null) {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), "gespann-alerts-")), SESSION_SECRET: SECRET, BASE_URL: BASE });
  const db = new Db(":memory:");
  const u = db.upsertUser({ github_id: 1, login: "tobi", name: null, avatar: null });
  db.createSession("s".repeat(64), u.id);
  const server = createApp({ config, db, github: () => ({}) as Github, githubReady: () => false, mailer });
  const headers = { Cookie: `gs=${"s".repeat(64)}`, "x-gespann": "1", "Content-Type": "application/json" };
  const get = async (path: string) => (await server.request(path, { headers })).json();
  const post = async (path: string, body: unknown) => server.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { db, u, server, get, post };
}

test("first sign-in without an address: asked once, the typed address counts after its link is opened", async () => {
  const mailer = fakeMailer();
  const { db, u, server, get, post } = app(mailer);
  assert.equal((await get("/api/me")).askEmail, true);
  assert.equal((await post("/api/settings/email", { email: "not-an-address" })).status, 400);
  assert.equal((await post("/api/settings/email", { email: "tobi@home.example" })).status, 200);
  assert.equal((await get("/api/me")).askEmail, false, "asked once: the address waits for its link");
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]?.to, "tobi@home.example");
  const link = /https:\/\/\S+\/email\/confirm\?t=\S+/.exec(mailer.sent[0]?.text ?? "")?.[0] as string;
  assert.ok(link);
  assert.equal(db.user(u.id)?.email, null);
  // The link works without a session, e.g. opened on the phone.
  const res = await server.request(link.replace(BASE, ""));
  assert.equal(res.headers.get("location"), "/settings?email=confirmed#mail");
  assert.deepEqual([db.user(u.id)?.email, db.user(u.id)?.email_source], ["tobi@home.example", "user"]);
  // Opened again: the address is no longer pending.
  assert.equal((await server.request(link.replace(BASE, ""))).headers.get("location"), "/settings?email=stale#mail");
  const s = await get("/api/settings/mail");
  assert.deepEqual([s.sends, s.email, s.source, s.pending], [true, "tobi@home.example", "user", null]);
  assert.deepEqual(
    s.kinds.map((k: { id: string; on: boolean; after: number }) => [k.id, k.on, k.after]),
    [
      ["error", true, 3],
      ["setup", true, 1],
      ["fail", false, 1],
      ["blocked", false, 3],
    ],
  );
});

test("Settings → Mail saves a kind's switch and number, and refuses what cannot work", async () => {
  const { get, post } = app(fakeMailer());
  assert.equal((await post("/api/settings/alerts", { id: "fail", on: true, after: 2 })).status, 200);
  assert.equal((await post("/api/settings/alerts", { id: "fail", on: true, after: 0 })).status, 400);
  assert.equal((await post("/api/settings/alerts", { id: "fail", on: true, after: 21 })).status, 400);
  assert.equal((await post("/api/settings/alerts", { id: "nope", on: true, after: 2 })).status, 400);
  const fail = (await get("/api/settings/mail")).kinds.find((k: { id: string }) => k.id === "fail");
  assert.deepEqual([fail.on, fail.after], [true, 2]);
});

test("an instance without SMTP_URL asks nobody for an address and refuses to send a confirmation", async () => {
  const { get, post } = app(createMailer({ smtpUrl: "", from: "" }));
  assert.equal((await get("/api/me")).askEmail, false);
  assert.equal((await post("/api/settings/email", { email: "tobi@home.example" })).status, 409);
  assert.equal((await get("/api/settings/mail")).sends, false);
});

test("the orchestrator's job end mails through the internal API, once per job", async () => {
  const mailer = fakeMailer();
  const { db, u, server } = app(mailer);
  db.offerEmail(u.id, "tobi@example.com", "github");
  const p = db.createProject({ owner_id: u.id, installation_id: 1, repo: "acme/shop", repo_id: 1, default_branch: "main" });
  const job = db.enqueue(p, "setup");
  startJob(db, job);
  endJob(db, job, "failed");
  const call = () => server.request(`/internal/jobs/${job}/ended`, { method: "POST", headers: { Authorization: `Bearer ${internalToken(SECRET)}` } });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(mailer.sent.map((m) => m.subject), ["The copy of acme/shop could not be built"]);
});

test("GitHub's verified primary address, or the public one when the app may not list addresses", async () => {
  const answer = (emails: unknown, status = 200) => (async () => new Response(JSON.stringify(emails), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  const app = { appId: "1", slug: "x", privateKey: "", webhookSecret: "", clientId: "c", clientSecret: "s" };
  const list = [
    { email: "old@x.example", primary: false, verified: true },
    { email: "main@x.example", primary: true, verified: true },
  ];
  assert.equal(await new Github(app, answer(list)).verifiedEmail("tok", "public@x.example"), "main@x.example");
  assert.equal(await new Github(app, answer([{ email: "main@x.example", primary: true, verified: false }])).verifiedEmail("tok", null), null, "never an unverified address");
  assert.equal(await new Github(app, answer({ message: "Resource not accessible by integration" }, 403)).verifiedEmail("tok", "public@x.example"), "public@x.example");
});
