# Orchestrator

gespann runs as two services:

| Service | Language | What it does | Deploys |
|---|---|---|---|
| **UI** (`gespann serve`) | TypeScript | Web app, MCP endpoint, GitHub webhook, everything that talks to GitHub (checks, comments, merge gate), the server module (billing, pages) | often |
| **Orchestrator** (`gespann-orchestrator`) | Rust (`orchestrator/`) | The job queue, sandboxes and their setup (gespann install, screen, recording, Codex sign-in), every job step (setup, suggest, PR run, repair, Codex login), proof collection | rarely |

They share the SQLite database and the files under `DATA_DIR` (one volume, one host). The orchestrator
reaches the UI over an internal HTTP API for everything that needs GitHub or the server module.

A deploy of the UI does not touch a running test. A deploy or crash of the orchestrator does not end one
either: every long step runs as a background process on the sandbox host, and the next orchestrator picks
the job up where it was (see [Picking a job up again](#picking-a-job-up-again)).

The recipe runner inside the sandbox (`gespann verify prepare|finish`, prompts, recipe checks) stays the
TypeScript CLI that the orchestrator installs into every sandbox at `GESPANN_REF`.

The UI runs no jobs itself: without the orchestrator, jobs stay queued and Codex sign-in waits.

## Picking a job up again

Each job has a journal (`job_steps`): every step with side effects runs once under a fixed key, and its
result is stored. Each long command (copy up, tester, verdict, Codex setup and repair) is started under a
key, and its background process id is stored before the orchestrator waits on it. When an orchestrator
takes over a running job, it runs the job's code again from the top: finished steps return their stored
result at once, and the step that was running attaches to the background process that is still running
(or has finished meanwhile) instead of starting it again.

A job ends in one transaction with an `outbox` entry that tells the UI (`ended`, and `report` for a
run that failed), so the server module hears of every job and the PR of every failed run, also when the
UI is down right then or the orchestrator stops in between.

Leases: `jobs.owner` is the orchestrator instance, `jobs.heartbeat` its last beat (every 2 s). A job
whose owner has not beaten for 60 s is taken over. On SIGTERM the orchestrator stops claiming jobs,
stops its job tasks (their background processes keep running), clears its leases so the next instance
takes them over at once, and exits.

## Internal API (UI side)

All under `/internal/`, `Authorization: Bearer <token>` with
`token = hex(sha256("gespann-internal:" + SESSION_SECRET))`. Any other request gets 401. JSON in and out.
The orchestrator calls `UI_URL` (default `BASE_URL`) and retries with backoff while the UI is down
(a deploy), up to 20 minutes per call.

| Call | Body | Answer | Does |
|---|---|---|---|
| `POST /internal/jobs/:id/admit` | – | `{ "refused": string \| null }` | The server module's `admit` (null without one). A module error answers `{ "refused": "<name> could not check this job: <message>" }`. |
| `POST /internal/jobs/:id/ended` | – | `{}` or 503 | The server module's `jobEnded`, once per job: `jobs.ended_noted` is set after it went through, so a second call does nothing; 503 when it failed (the orchestrator sends it again). |
| `GET /internal/runs/:id/pull` | – | `{ "pull": { "state": "open"\|"closed", "merged": bool, "head": sha } \| null }` | The run's PR on GitHub; null when GitHub does not answer. |
| `POST /internal/runs/:id/skip-closed` | – | `{ "skipped": bool }` | Under the PR lock: `skipClosedRuns` for this run when the PR is still merged or closed; `false` when it reopened or GitHub did not answer (the run goes ahead). |
| `POST /internal/runs/:id/await-checks` | `{ "jobId" }` | `{ "step": "go"\|"later"\|"skipped" }` | The PR's other checks first (`awaitChecks`): `later` put the job back into the queue until `not_before`, `skipped` ended the run as SKIP (the orchestrator then ends the job unstarted). |
| `POST /internal/runs/:id/check` | `{ "title", "summary" }` | `{}` | Moves the run's GitHub check to in progress with this text (nothing without a check). |
| `POST /internal/projects/:id/git-token` | – | `{ "token" }` | A short-lived installation token that may read the repo. |
| `GET /internal/runs/:id/context` | – | `{ "prText", "issues": [{ref,title,url,body}], "issuesMd", "unread": string \| null }` | PR title and body as the tester reads them (`# title\n\nbody\n`), the issues it resolves, `issuesText(issues)`, and the note when GitHub did not list them. |
| `POST /internal/runs/:id/report` | `{ "jobId", "judged": Judged \| null, "files": string[] }` | `{}` | Gate, check and PR comment for the run as the database has it now (outcome, error, conflict). Lines for the job log go into `jobId`'s log. |

The orchestrator also writes `settings.orchestrator` = `{"kind","parallel","why","instance","beat"}`
every 10 s. The UI reads it for the host size on Settings → Sandboxes, and treats the orchestrator as
present (Codex sign-in possible) while `beat` is younger than 60 s.

The server module's per-owner cap (`jobCap`, e.g. a plan's parallel tests) cannot be asked from the
orchestrator: the UI writes it to `users.job_cap` every 10 s, and the orchestrator starts no job of an
owner who already runs that many.

Codex sign-in: the UI only sets the user's `codex_state` to `pending` (`codex_login` null). The
orchestrator runs the sign-in for every pending user and writes `codex_login`, then `codex_auth`
(AES-256-GCM with a key from `SESSION_SECRET`, see `orchestrator/src/codex.rs`) or `failed`. The UI does
not fail pending sign-ins when it starts.

## In-sandbox CLI used by the orchestrator

- `gespann verify recipe --recipe <file>` prints one JSON line: `{"ok":true,"timeout":<minutes>,"prompt":<path|null>}` or `{"ok":false,"error":"…"}`. Exit 0 either way.
- `gespann verify prompt <tester|setup|repair|suggest> --input <file.json>` prints the prompt. The input
  is the TypeScript function's input (`TesterInput` with `recipeFile` instead of `recipe`, `SetupInput`,
  `RepairInput`, or `{repo, repoDir, out, current}` for suggest).
- `gespann verify prepare|finish` as before.

## Running it

```
cargo build --release --manifest-path orchestrator/Cargo.toml
DATA_DIR=/data SESSION_SECRET=… BASE_URL=https://gespann.example.com SANDBOX_PROVIDER=ssh SSH_HOST=… \
  orchestrator/target/release/gespann-orchestrator
```

It reads `DATA_DIR`, `SESSION_SECRET` and `BASE_URL` like `gespann serve`, the sandbox variables
(`SANDBOX_PROVIDER` docker or ssh, `SANDBOX_*`, `SSH_*`, `MAX_PARALLEL_JOBS`, `GESPANN_REF`), plus
`UI_URL` and `HEALTH_PORT` (default 3001, `GET /healthz`). With Docker: [self-host.md](self-host.md#run).
