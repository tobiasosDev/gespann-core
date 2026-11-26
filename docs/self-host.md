# Run gespann yourself

> The supported way to use gespann is the hosted service at [app.gespann.app](https://app.gespann.app): sign in with GitHub and add a repository, nothing to run. This page is for running your own instance. You operate it yourself; there is no help with setup or operation, and bug reports are taken when they also happen on the hosted service.

gespann is one Node process: web app, GitHub webhook and job worker. It keeps its data in SQLite under `DATA_DIR`. PR code runs in sandboxes on Docker or on your own CI server over SSH ([Sandboxes](#sandboxes)); the model runs on each user's own ChatGPT plan through Codex, so the instance pays no model costs.

## Run

```bash
docker build -t gespann .
docker run -p 3000:3000 -v gespann-data:/data \
  -e BASE_URL=https://gespann.example.com \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e SANDBOX_PROVIDER=ssh -e SSH_HOST=gespann@ci.example.com -e SSH_PRIVATE_KEY="$(cat gespann_ci)" \
  -e ADMIN_TOKEN=$(openssl rand -hex 16) \
  gespann
```

| Variable | |
|---|---|
| `BASE_URL` | public https URL; GitHub sends webhooks and sign-ins here |
| `SESSION_SECRET` | at least 32 characters; also encrypts the stored Codex sign-ins, so keep it stable |
| `SANDBOX_PROVIDER` | `docker`, `ssh` or `module:<path>` ([Sandboxes](#sandboxes)). Without a provider, jobs stay queued |
| `SANDBOX_PROVIDER_BY_USER` | other providers for some users, e.g. `tobi=ssh,ops=module:/app/own.js` ([Several providers](#several-providers)) |
| `ADMIN_TOKEN` | guards `/setup`; remove it after the GitHub App exists |
| `ALLOWED_USERS` | GitHub logins that may sign in, comma-separated (`alice,bob`). Everyone else is turned away, and sessions and agent tokens of users not on the list stop working. Default: every GitHub user may sign in |
| `GESPANN_REF` | git ref of gespann-core that sandboxes install (default `main`) |
| `MAX_PARALLEL_JOBS` | how many jobs each sandbox provider runs at once ([Parallel jobs](#parallel-jobs)); default: computed from its host |
| `MEDIA_RETENTION_DAYS` | days after a PR is merged or closed until its runs' screenshots and recordings are deleted; verdicts and checks stay. Default `10`, `off` keeps them |
| `DATA_DIR` | default `/data` in the image |
| `SERVER_MODULE` | path of a module that adds pages, Settings cards and a say over jobs ([Server module](#server-module)); default: none |

Restarting or redeploying the server never loses a job. A job whose server stops (a deploy, a crash) goes back into the queue about a minute later and starts again from the beginning. Before that, gespann stops the commands it left running in the sandbox and takes a copy that was still up down. While the old server keeps running during a rolling deploy, the job stays with it. A job lost in three restarts fails instead of starting again.

## Sandboxes

Every project gets a sandbox that keeps its checkout, its recipe and its built images between jobs. A job writes the owner's Codex sign-in into it, runs Codex and the recipe, and deletes the sign-in again. When PRs come in while the project's sandboxes are busy, the project gets another one, so its PRs are tested side by side ([Parallel jobs](#parallel-jobs)). `SANDBOX_PROVIDER` picks where sandboxes live; nothing else changes. Some users can have their own provider ([Several providers](#several-providers)).

### Parallel jobs

At startup gespann reads the sandbox host's size and runs as many jobs at once as fit: one per 4 CPUs and 8 GB of memory, whichever allows fewer, at least one. A host with 32 CPUs and 64 GB runs 8. The log says what it chose, e.g. `parallel jobs: 7 (32 CPUs and 61 GB on the sandbox host, 4 CPUs and 8 GB per job)`. `MAX_PARALLEL_JOBS=12` sets the number yourself, e.g. when the host also runs other work or your recipes are lighter. Docker reads the engine's machine, SSH the host; a provider module can report its size with an optional `capacity()`, otherwise gespann runs 2.

That number is shared by everyone on the same provider; with [several providers](#several-providers) each counts its own jobs, and `MAX_PARALLEL_JOBS` sets the number for each. In Settings → Sandboxes each user sees which of their jobs hold a sandbox now, can run fewer of their own jobs at once (from 1 up to the instance's number, or up to a server module's cap, see [Server module](#server-module)), and sees their sandbox time: from the start to the end of each job of their projects, counted on the UTC day and calendar month the job started.

Jobs of one project and one owner run side by side, each in its own sandbox with its own checkout. Only a project's setup runs alone. A new sandbox takes over the project's current recipe: after each setup and each fix of the copy, gespann keeps the recipe directory as `DATA_DIR/projects/<id>/recipe.tgz` and copies it into the project's other sandboxes before their next job. Its first job builds the app's images from scratch unless the host's Docker cache already has them.

All parallel jobs of an owner use the same Codex sign-in. Codex refreshes a sign-in after 8 days, and OpenAI accepts each refresh token once, so two jobs must not refresh the same copy: while a refresh is due, one job starts Codex first and the others wait until its refresh is stored, then start with the new sign-in.

| Provider | A sandbox is | Good for |
|---|---|---|
| `docker` | a container from your image, on the local engine or a remote one (`DOCKER_HOST`) | a CI server that runs Docker; isolation per project |
| `ssh` | a directory on a Linux machine you already run, used as `HOME` | a CI server without Docker, or one that already has your toolchain |
| `module:<path>` | whatever your module makes | a sandbox service of your own ([Your own provider](#your-own-provider)) |

Whatever the provider, the machine needs `bash`, `git`, `curl`, Node.js 22.18 or newer with `npm`, and the `codex` CLI on `PATH`, plus what your recipe uses (often Docker). gespann installs itself there on the first job. For UI checks the tester needs a screen: a desktop (`DISPLAY`) with Chrome, and Codex configured with a computer-use or browser tool. Without one it can only test what it reaches with commands. Every run is recorded as a video of the tester's screen, shown first on the run page and linked above the screenshots in the PR comment. Docker and SSH sandboxes record with `ffmpeg` (x11grab) on the sandbox's `DISPLAY`, so the machine needs `ffmpeg` next to its screen; a provider of your own records with `startRecording` ([Your own provider](#your-own-provider)). When a run cannot be recorded, the run page says so and the job log names the reason.

### Several providers

One instance can serve different users from different sandbox providers, e.g. the team's own CI server for the team and a sandbox service for everyone else:

```bash
-e SANDBOX_PROVIDER=module:/app/providers/cloud.js \
-e SANDBOX_PROVIDER_BY_USER="tobi=ssh,ops=ssh" \
-e SSH_HOST=gespann@ci.example.com -e SSH_PRIVATE_KEY="$(cat gespann_ci)"
```

`SANDBOX_PROVIDER_BY_USER` maps GitHub logins (any case) to a provider, written as for `SANDBOX_PROVIDER`; comma-separated. A user it names gets that provider for their projects' sandboxes and their Codex sign-in; everyone else gets `SANDBOX_PROVIDER`. Without `SANDBOX_PROVIDER`, only the named users get sandboxes and the jobs of everyone else stay queued. Each provider is made once and runs its own number of jobs at once, so a full CI server never holds up the users of the sandbox service. `docker` and `ssh` read their settings from the variables below, so each of them exists once per instance; modules can be as many as you like. The log names every provider and whom it serves, e.g. `sandboxes: ssh (tobi, ops)` and `sandboxes: cloud (everyone else)`.

When a user moves to another provider, their projects' next jobs get a new sandbox there, which takes over the project's current recipe ([Parallel jobs](#parallel-jobs)) and builds the app from scratch on its first job. Their sandboxes on the old provider stay until you delete them.

### Docker

```bash
-e SANDBOX_PROVIDER=docker \
-e SANDBOX_IMAGE=ghcr.io/acme/gespann-sandbox:1 \
-e SANDBOX_COMMAND="sleep infinity" \
-e SANDBOX_DOCKER_ARGS="--cpus 4 --memory 8g" \
-e DOCKER_HOST=ssh://ci@ci.example.com
```

| Variable | |
|---|---|
| `SANDBOX_IMAGE` | image for every sandbox (required) |
| `SANDBOX_COMMAND` | what the container runs; it has to keep running. Leave it out for images that start their own desktop; plain images need `sleep infinity` |
| `SANDBOX_DOCKER_ARGS` | extra `docker run` arguments, quoted like a shell. Recipes that start Docker themselves need Docker inside the sandbox: `--privileged` with an image that runs its own engine, or the engine's socket mounted. The socket gives PR code control over every container on that engine, gespann's own included, so mount it only from an engine that runs nothing else |
| `SANDBOX_USER` | user inside the container; default the image's |
| `SANDBOX_HOME` | the sandbox's home directory (default `/home/user`); letters, digits, `. _ - /` only |
| `DOCKER_HOST`, `DOCKER_CONTEXT` | which engine, as for the `docker` CLI. `ssh://user@host` reaches a CI server; the key comes from `~/.ssh` of the user running gespann |

The gespann image contains the `docker` CLI. For the local engine, mount its socket and give the `node` user access: `-v /var/run/docker.sock:/var/run/docker.sock --group-add $(stat -c %g /var/run/docker.sock)`. A stopped container keeps its disk; `docker rm` deletes a sandbox, and gespann makes a new one on the next job.

### SSH

```bash
-e SANDBOX_PROVIDER=ssh \
-e SSH_HOST=ci@ci.example.com \
-e SSH_PRIVATE_KEY="$(cat gespann_ci_key)" \
-e SSH_KNOWN_HOSTS="$(ssh-keyscan ci.example.com)"
```

| Variable | |
|---|---|
| `SSH_HOST` | `user@host` (required) |
| `SSH_PORT` | default 22 |
| `SSH_PRIVATE_KEY` | the key itself (`\n` for line breaks works too); or `SSH_KEY_FILE` with a path |
| `SSH_KNOWN_HOSTS` | the host's key line; then a changed host key stops gespann. Without it, the first key seen is pinned in `DATA_DIR/ssh/known_hosts` |
| `SANDBOX_ROOT` | directory on the host for the sandboxes (default `~/gespann-sandboxes`); letters, digits, `. _ - /` only |

Each sandbox is a directory under `SANDBOX_ROOT`. Every command gespann runs there has it as `HOME`, so `~/.codex` and gespann's own install stay per sandbox. On a host with a screen (`DISPLAY` set and Xvfb installed), each sandbox gets its own virtual screen while it runs a job, so parallel testers never see each other's browser: gespann starts Xvfb on a free display and sets `DISPLAY` for everything in that sandbox, Codex's browser tool included when its config forwards `DISPLAY` (step 7). When a project picks screen sizes on its Setup page, the run's screen grows to fit the largest one, and the tester sets each size with its browser tool's resize (Playwright's MCP server has `browser_resize`). The SSH user's own `~/.codex/config.toml` is linked into every sandbox: give Codex its browser or computer-use tool there (e.g. an MCP server such as Playwright's on an Xvfb display), and export `DISPLAY` at the top of the user's `~/.bashrc` so `gespann shot` sees the same screen. All projects still share the machine's user, its processes and its Docker engine, and PR code runs with that user's rights: use a dedicated user on a machine that holds no secrets you would not hand to a PR. Recipes should name their Docker projects and ports after `$GESPANN_RUN` so two projects can run side by side. gespann starts no login shell: check with `ssh ci@ci.example.com 'command -v node npm git codex'` that the tools are on that `PATH`.

#### Prepare a Debian or Ubuntu host

These steps set up a CI server so the tester can click through the app in a real browser. Run them as an admin on the host; `GESPANN_IP` is the address your gespann server connects from.

1. A user for gespann, with Docker but without sudo. PR code runs as this user.

   ```bash
   sudo useradd -m -s /bin/bash -G docker gespann
   ```

2. Its key, usable only from the gespann server. Generate the key pair anywhere; the private half goes into `SSH_PRIVATE_KEY`.

   ```bash
   ssh-keygen -t ed25519 -N '' -f gespann_ci -C gespann
   sudo install -d -m 700 -o gespann -g gespann /home/gespann/.ssh
   echo "from=\"$GESPANN_IP\",no-agent-forwarding,no-X11-forwarding,no-port-forwarding $(cat gespann_ci.pub)" \
     | sudo tee /home/gespann/.ssh/authorized_keys
   sudo chown gespann:gespann /home/gespann/.ssh/authorized_keys && sudo chmod 600 /home/gespann/.ssh/authorized_keys
   ```

3. SSH reachable from the gespann server. With ufw, and only for that address:

   ```bash
   sudo ufw allow from "$GESPANN_IP" to any port 22 proto tcp comment gespann
   ```

4. Tools for the user: Node.js 22.18 or newer, git, curl and Docker system-wide; Codex, Playwright's MCP server and a matching Chromium in the user's home. Chromium also needs its system libraries (`npx playwright install-deps chromium` as an admin).

   ```bash
   sudo apt-get install -y xvfb imagemagick ffmpeg
   sudo -u gespann -H bash -c 'cd ~ && npm i -g --prefix ~/.local @openai/codex @playwright/mcp \
     && PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node ~/.local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install chromium'
   ```

5. A virtual screen for the browser, display `:77`:

   ```bash
   sudo tee /etc/systemd/system/gespann-xvfb.service <<'EOF'
   [Unit]
   Description=Virtual screen :77 for the gespann tester
   [Service]
   User=gespann
   ExecStart=/usr/bin/Xvfb :77 -screen 0 1440x900x24 -nolisten tcp
   Restart=always
   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload && sudo systemctl enable --now gespann-xvfb
   ```

6. The environment every gespann command sees. gespann starts no login shell, so these lines go at the very top of the user's `~/.bashrc`, before its check for interactive shells:

   ```bash
   export PATH=/home/gespann/.local/bin:$PATH DISPLAY=:77 PLAYWRIGHT_BROWSERS_PATH=/home/gespann/.cache/ms-playwright
   ```

7. Codex's browser tool, in `/home/gespann/.codex/config.toml`. gespann links this file into every sandbox. `env_vars` passes the sandbox's own `DISPLAY` to the browser; a fixed `DISPLAY = ":77"` in `env` would put the browsers of parallel jobs on one screen:

   ```toml
   [mcp_servers.browser]
   command = "/home/gespann/.local/bin/playwright-mcp"
   args = ["--browser", "chromium", "--viewport-size", "1440x900"]
   startup_timeout_sec = 60
   env_vars = ["DISPLAY"]
   env = { PLAYWRIGHT_BROWSERS_PATH = "/home/gespann/.cache/ms-playwright" }
   ```

8. Check over SSH from the gespann server (the key works only from there; add your own address to `from=` for a check from elsewhere): `ssh -i gespann_ci gespann@<host> 'command -v node npm git curl docker codex playwright-mcp; echo $DISPLAY'` lists every tool and `:77`. Then set the variables above and deploy; the log line `sandboxes: ssh` confirms the provider.

Undo: `sudo ufw delete allow from "$GESPANN_IP" to any port 22 proto tcp`, `sudo systemctl disable --now gespann-xvfb`, `sudo userdel -r gespann`.

### Your own provider

`SANDBOX_PROVIDER=module:/path/to/provider.js` loads an ES module whose default export gets the server's environment and returns the sandbox object (sync or async). It implements the `Sandboxes` interface in [src/server/sandbox.ts](../src/server/sandbox.ts): `create`, `exists`, `home`, `ensureRunning`, `keepAlive`, `stop`, `remove`, `exec`, `start`, `status`, `kill`, `readFile`, `writeFile`, `download`, and optionally `startRecording` and `stopRecording` for a video of the tester's screen, `jobScript(home)` for a shell script that runs before every job and may export variables through `<home>/gespann/env.sh` (for example a build cache that survives the sandbox stopping), `testerNote` for how to drive the browser your sandbox provides, and `capacity` for the host's size ([Parallel jobs](#parallel-jobs)). gespann checks the methods at startup and logs `sandboxes: <kind>`.

```js
// provider.js: read your settings from env, return the sandboxes
export default (env) => new MySandboxes(env.MY_SANDBOX_API_KEY);
```

## Server module

`SERVER_MODULE=/path/to/module.js` loads an ES module whose default export gets the server's environment and returns an object with a `name` (sync or async). Every other part is optional ([src/server/extension.ts](../src/server/extension.ts)):

- `routes(app, { user })` mounts routes on the server's Hono app, before the web app. `user(c)` is the signed-in user (`{ id, login }`) or null. API calls under `/api/` need the header `x-gespann: 1`; your own paths guard themselves against cross-site posts.
- `links` puts links in the sidebar for signed-in users, e.g. `[{ label: "Usage", href: "/usage" }]`.
- `settings(user)` returns cards for the top of the Settings page: `{ id, title, description?, badge?, rows }`. A row is text, a meter (`value` of `max`), a button, or a number field. Buttons and fields POST JSON to a path under `/api/` that your `routes` serve; answer `{ redirect: url }` to send the user on (a checkout, say), `{ error }` to show a message, or anything else to reload the card. `/settings#<id>` scrolls to a card. If `settings` throws, only its cards are missing.
- `admit(job)` runs before a job takes a sandbox. Return a string and the job fails with `not started: <string>` (a PR gets a neutral check with that text); return null to let it start. `job` names the job, its kind, its project and the project's owner.
- `jobEnded(end)` runs after a job ended and gave its sandbox back, with its status and `seconds` from start to end (the sandbox time Settings shows). Errors are logged, never fail the job.
- `jobCap(owner)` caps how many jobs of an owner's projects run at once: return `{ jobs, reason }` or null for no cap. A job over the cap waits in the queue and starts when one of the owner's jobs ends; it does not fail. The worker asks while it picks the next job, so answer right away from memory, without a network call. Settings → Sandboxes lets the owner choose at most the cap and shows `<reason> allows <jobs> at once`. Without `jobCap`, or when it throws, there is no cap.

The log says `server module: <name>` at startup.

```js
// module.js: e.g. a quota per user
export default (env) => ({
  name: "quota",
  admit: (job) => (overQuota(job.owner.login) ? "the monthly quota is used up" : null),
  jobEnded: (end) => record(end.owner.id, end.seconds),
  jobCap: (owner) => (isSmallTeam(owner.login) ? { jobs: 2, reason: "your quota" } : null),
});
```

## GitHub App

Open `https://<BASE_URL>/setup?token=<ADMIN_TOKEN>` and click **Create GitHub App**. GitHub creates the app from a manifest (checks write, pull requests write, contents write, commit statuses read, `pull_request` and `issue_comment` events) and sends you back; gespann stores the credentials. Add `&org=<name>` to create it under an organization. Then install the app on the repositories to test.

## How a project works

1. A user signs in with GitHub and connects Codex once in **Settings** (`codex login --device-auth` in a short-lived sandbox). gespann keeps the resulting `auth.json` encrypted and deletes the sandbox.
2. Adding a repository starts the setup: in the project's own sandbox, Codex reads the repo and writes `verify.yml` (see [recipe.md](recipe.md)), the scripts it calls, `NOTES.md` and `CHECKS.md`. gespann then starts and stops the copy once without Codex to check the recipe.
3. **Start** turns on PR testing. Each matching PR (not from forks) gets the check `gespann/verify`: the sandbox merges the PR onto its base branch as it is when the run starts (not the older base commit GitHub reports for the PR), brings the copy up, Codex tests it with the sandbox's computer-use tools, and the verdict, screenshots and a recording land on the run page and in a PR comment. A PR that does not merge onto its base is not tested: the run shows *conflict* in grey instead of a verdict, the check stays neutral, and the PR comment and the MCP issue `merge_conflict` name the files and tell the PR's agent to update the branch. gespann never resolves conflicts itself; a push that matches the triggers is tested again, otherwise *Rerun* tests the PR's new head. Without a conflict a PR needs no rebase to catch up with its base: *Rerun* tests the same head on top of the newest base.

The project sandbox stops after every job, and the Codex sign-in is only inside it while a job runs.

## Agent access (MCP)

Coding agents read runs over MCP at `<BASE_URL>/mcp` (Streamable HTTP, JSON responses, no sessions). An agent signs in with OAuth: it opens gespann in the browser, the user signs in with GitHub and allows it once. Agents without OAuth (CI, scripts) send a personal token from **Settings → Agent access** instead. Either way the agent sees the projects its user sees; `ADMIN_TOKEN` sees all of them. Only hashes of tokens are stored, and every sign-in and token can be revoked under **Settings → Agent access**. Which repositories a user can access is what GitHub reported at their last sign-in; access relies on that for 7 days, then the user signs in again (an OAuth agent sends them through the browser on its own). Every tool only reads, except `rerun`; none cancels or approves anything:

| Tool | Returns |
|---|---|
| `list_projects` | projects with setup state and newest run |
| `list_runs` | runs of a project, optionally of one PR |
| `get_run` | status, verdict, summary, every check, per linked GitHub issue whether its goal was met, the `issues` to act on and the run's files; `repo` + `pr` gives the newest run of a PR |
| `get_review` | the PR comment as Markdown |
| `get_run_file` | a screenshot as an image; the recording as a link (MCP has no video content); `verdict.json` as text |
| `get_run_log` | the end of the job log |
| `rerun` | starts a new run of the PR at its current head on its base branch as it is now, like *Rerun* on the run page (an agent uses it instead of a rebase when the base changed after a PASS); returns the queued or running run instead of starting one, refuses closed PRs and stops after 3 runs of the same head |

```bash
claude mcp add --transport http gespann https://gespann.example.com/mcp   # then /mcp → gespann → Authenticate
codex mcp add gespann --url https://gespann.example.com/mcp && codex mcp login gespann
```

With a token: `--header "Authorization: Bearer gsp_..."` for Claude Code; for Codex `bearer_token_env_var = "GESPANN_TOKEN"` under `[mcp_servers.gespann]` in `~/.codex/config.toml`.

The OAuth side follows the MCP authorization spec: `401` with `resource_metadata`, protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414) under `/.well-known/`, dynamic client registration (RFC 7591) at `/oauth/register`, and the authorization-code flow with PKCE S256 for public clients at `/oauth/authorize` and `/oauth/token`. A client id carries the client's name and redirect URIs, signed with `SESSION_SECRET`, so registration stores nothing; changing `SESSION_SECRET` makes agents register again. Access tokens last an hour; refresh tokens rotate on every use and lapse after 30 days without one. Authorization codes live in memory for 5 minutes, so a restart in the middle of a sign-in means clicking Authenticate again.

## Merge gate

The gate is a per-project setting (*Merge gate* on the project page), off for new projects. When it is on, a PR with the label `gespann` cannot be merged until gespann's test of its current commit passes. gespann turns the PR into a draft, which GitHub does not merge, and back to ready for review once the test passes. This works on every GitHub plan, also on private repositories without required checks. A person releases a PR without a passing test by commenting `/gespann approve` (needs the `issue_comment` event; apps created before it was added need it ticked under the app's *Permissions & events*), by clicking *Ready for review*, or by removing the label. A new push needs a new pass or approval. `/gespann approve` works on every PR, also without the label: it ends the commit's `gespann/verify` check as neutral, so a branch rule that requires that check lets the PR merge (a check that already passed stays green). GitHub lets an app switch a PR to draft only with *Contents: Read and write*; apps created before the gate need that permission raised and the installation needs to accept it. Without it, PRs are still tested but not held. Sandboxes only ever get a read-only token.

A run starts only after the PR's other checks passed (see the recipe docs). CI that reports through check runs (GitHub Actions) is seen with the app's checks permission. CI that reports commit statuses (Buildkite, Jenkins, CircleCI) needs *Commit statuses: Read-only*; apps created before it was added need it ticked under *Permissions & events*, and the installation needs to accept it. Until then those statuses are not waited for.

