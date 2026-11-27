# Remote sandboxes: the HTTP protocol

`SANDBOX_PROVIDER=remote` makes the orchestrator call a sandbox service over HTTP for every sandbox operation, so sandboxes can live anywhere an adapter of yours can reach: a cloud VM vendor, Kubernetes, a pool of machines. gespann ships no adapter; you write one that answers the calls below. Set it up: [self-host.md](self-host.md#remote). A service that makes Macs for iOS apps answers the same calls; the orchestrator reaches it through `SANDBOX_PROVIDER_MACOS=remote` and the `MACOS_` variables ([self-host.md](self-host.md#macos)).

## Basics

- Base URL `SANDBOX_REMOTE_URL`; every path below is relative to it.
- Every request carries `Authorization: Bearer <SANDBOX_REMOTE_TOKEN>`. Answer 401 to anything else.
- JSON in and out (`content-type: application/json`), except `download`.
- An error answers a non-2xx status with `{ "error": "…" }`. The message lands in the job log users read, so keep vendor secrets and internals out of it.
- 404 means "gone": a sandbox that no longer exists, a file that is not there. The orchestrator then makes a new sandbox, or treats the file as missing.
- 503 means "not now, nothing ran": the orchestrator sends the same request again with backoff for up to 10 minutes, as it does while the service does not accept connections (a deploy). Answer 503 only when the request started nothing, so a retry never makes a second sandbox or starts a command twice. 429, 502 and 504 are retried the same way for `GET` and `DELETE` only; a `POST` or `PUT` that gets one fails, since a proxy may send them after the service already acted. Any other error ends the call.
- Sandbox ids are yours: any string up to 200 characters; the orchestrator stores it and percent-encodes it in paths.

## Calls

| Call | Body | Answer | Does |
|---|---|---|---|
| `GET /info` | – | `{ kind, home, maxJobs?, pollSeconds?, jobScript?, testerNote? }` | Read once at startup. `kind`: the name users see in job logs ("created sandbox … (cloud)"). `home`: the sandboxes' home directory, absolute, the same for all. `maxJobs`: how many jobs the orchestrator runs on this service at once (`MAX_PARALLEL_JOBS` overrides it; without either, 2). `pollSeconds`: poll running processes no more often than this (default 2 s), which keeps the request rate down with many jobs. `jobScript`: a shell script run in the sandbox before every job, after gespann is installed (it may write `export` lines to `$HOME/gespann/env.sh`, which every recipe and Codex command sources). `testerNote`: text added to the tester, setup and repair prompts, e.g. how to drive the sandbox's browser. |
| `POST /sandboxes` | `{ name, purpose: "project"\|"login", labels: {…}, ttlSeconds: number\|null }` | `{ id }` | Makes a sandbox. `project`: it builds and runs the app, kept between jobs. `login`: it only runs `codex login`, removed after it. `ttlSeconds` null: no auto-delete. |
| `GET /sandboxes/:id` | – | `{ state }` or 404 | Exists? Any 2xx means yes. |
| `POST /sandboxes/:id/running` | `{}` | `{}` | Starts or resumes the sandbox and answers once it runs commands. May take minutes. |
| `POST /sandboxes/:id/keep-alive` | `{}` | `{}` | Called every 10 minutes while a job waits on a long command: push any idle timer out. |
| `POST /sandboxes/:id/stop` | `{}` | `{}` | The job is done; the sandbox may stop but keeps its disk (checkout, images, caches). |
| `DELETE /sandboxes/:id` | – | `{}` or 404 | Deletes it for good. |
| `POST /sandboxes/:id/exec` | `{ command, timeoutSeconds }` | `{ exitCode, stdout, stderr, timedOut }` | Runs `command` with `bash -c` in `home` and waits. `timedOut: true` when it ran out of time (killed). |
| `POST /sandboxes/:id/processes` | `{ command }` | `{ pid }` | Starts `command` in the background, detached, and answers its id (a positive integer). It has to outlive this request and any restart of the adapter or the orchestrator. |
| `GET /sandboxes/:id/processes/:pid?tailBytes=N` | – | `{ state: "running"\|"exited"\|"lost", exitCode, stdout, stderr }` | The process and the last `N` bytes of its output. `lost`: no exit code and not running (the sandbox restarted under it). |
| `DELETE /sandboxes/:id/processes/:pid` | – | `{}` or 404 | Kills it. |
| `GET /sandboxes/:id/file?path=P` | – | `{ content }` or 404 | A text file. |
| `PUT /sandboxes/:id/file` | `{ path, base64 }` | `{}` | Writes a file (parent directories exist), replacing it. |
| `GET /sandboxes/:id/download?path=P` | – | the raw bytes | A file of any size and type (screenshots, the run's video). |
| `POST /sandboxes/:id/recording` | `{ file }` | `{}` | Starts recording the sandbox's screen to an mp4 at `file`. An error says why there is no recording; the run goes on without one. |
| `DELETE /sandboxes/:id/recording` | – | `{}` | Stops it and finishes the file. |

## What the sandbox needs

The same as any provider ([self-host.md](self-host.md#sandboxes)): `bash`, `git`, `curl`, Node.js 22.18 or newer with `npm`, the `codex` CLI, what the recipes use (often Docker), and for UI checks a desktop with Chrome and a browser or computer-use tool for Codex. A macOS sandbox has Xcode and an iOS Simulator runtime instead, and a simulator tool for Codex; its `jobScript` can install Node.js and the agent CLIs, its `testerNote` says how to drive the simulator.

## Scale

Each running job polls one process about every `pollSeconds` and makes a few other calls per minute. At 200 jobs and `pollSeconds: 5` that is about 40 status calls a second; answer them from your own state where you can instead of asking the vendor each time.
