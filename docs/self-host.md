# Run gespann yourself

> The supported way to use gespann is the hosted service at [app.gespann.app](https://app.gespann.app): sign in with GitHub and add a repository, nothing to run. This page is for running your own instance. You operate it yourself; there is no help with setup or operation, and bug reports are taken when they also happen on the hosted service.

gespann is two services that share one SQLite database and its files under `DATA_DIR` (one volume, one host): the **UI** (`gespann serve`, Node: web app, MCP, GitHub webhook, everything that talks to GitHub) and the **orchestrator** (Rust: the job queue, sandboxes and every job step). A deploy of the UI leaves running tests alone. How they talk to each other: [orchestrator.md](orchestrator.md). PR code runs in sandboxes on Docker or on your own CI server over SSH ([Sandboxes](#sandboxes)); the agent runs on each user's own account (Codex on their ChatGPT plan or OpenRouter key, or Claude Code, the Copilot CLI or the Grok CLI on their key), so the instance pays no model costs.

## Run

```bash
docker build -t gespann .
docker build -f orchestrator/Dockerfile -t gespann-orchestrator .
docker volume create gespann-data
docker network create gespann
SECRET=$(openssl rand -hex 32)
docker run -d --name gespann --network gespann -p 3000:3000 -v gespann-data:/data \
  -e BASE_URL=https://gespann.example.com \
  -e SESSION_SECRET=$SECRET \
  -e ADMIN_TOKEN=$(openssl rand -hex 16) \
  gespann
docker run -d --name gespann-orchestrator --network gespann -v gespann-data:/data \
  -e BASE_URL=https://gespann.example.com -e UI_URL=http://gespann:3000 \
  -e SESSION_SECRET=$SECRET \
  -e SANDBOX_PROVIDER=ssh -e SSH_HOST=gespann@ci.example.com -e SSH_PRIVATE_KEY="$(cat gespann_ci)" \
  gespann-orchestrator
```

Both images run as uid 1000, so both can write the shared volume. The orchestrator needs no public port; it reaches the UI at `UI_URL` (default `BASE_URL`).

Both services:

| Variable | |
|---|---|
| `BASE_URL` | public https URL; GitHub sends webhooks and sign-ins here |
| `SESSION_SECRET` | at least 32 characters, the same for both; encrypts the stored Codex sign-ins and agent keys and signs the orchestrator's calls to the UI, so keep it stable |
| `DATA_DIR` | default `/data` in the images |

The UI (`gespann serve`):

| Variable | |
|---|---|
| `ADMIN_TOKEN` | guards `/setup`; remove it after the GitHub App exists |
| `ALLOWED_USERS` | GitHub logins that may sign in, comma-separated (`alice,bob`). Everyone else is turned away, and sessions and agent tokens of users not on the list stop working. Default: every GitHub user may sign in |
| `MEDIA_RETENTION_DAYS` | days after a PR is merged or closed until its runs' screenshots and recordings are deleted; verdicts and checks stay. Default `10`, `off` keeps them |
| `SERVER_MODULE` | path of a module that adds pages, Settings cards and a say over jobs ([Server module](#server-module)); default: none |

The orchestrator:

| Variable | |
|---|---|
| `SANDBOX_PROVIDER` | `docker`, `ssh` or `remote` ([Sandboxes](#sandboxes)). Without a provider, jobs stay queued |
| `SANDBOX_PROVIDER_BY_USER` | other providers for some users, e.g. `tobi=ssh,ops=ssh` ([Several providers](#several-providers)) |
| `GESPANN_REF` | git ref of gespann-core that sandboxes install (default `main`) |
| `MAX_PARALLEL_JOBS` | how many jobs each sandbox provider runs at once ([Parallel jobs](#parallel-jobs)); default: computed from its host, or what a sandbox service allows |
| `UI_URL` | where it reaches the UI (default `BASE_URL`) |
| `HEALTH_PORT` | port of its `GET /healthz` (default 3001) |

Restarting or redeploying either service never loses a job. Every long step runs as a background process in the sandbox; when the orchestrator stops (a deploy, a crash), the next one picks each job up where it was and attaches to what still runs. While the UI is down, the orchestrator waits for it, up to 20 minutes per call; a longer outage can fail the job. A job taken over more than ten times fails instead of starting again.

## Sandboxes

Every project gets a sandbox that keeps its checkout, its recipe and its built images between jobs. A job writes the owner's Codex sign-in into it, runs Codex and the recipe, and deletes the sign-in again. When PRs come in while the project's sandboxes are busy, the project gets another one, so its PRs are tested side by side ([Parallel jobs](#parallel-jobs)). `SANDBOX_PROVIDER` picks where sandboxes live; nothing else changes. Some users can have their own provider ([Several providers](#several-providers)).

### Parallel jobs

At startup gespann reads the sandbox host's size and runs as many jobs at once as fit: one per 4 CPUs and 8 GB of memory, whichever allows fewer, at least one. A host with 32 CPUs and 64 GB runs 8. The log says what it chose, e.g. `parallel jobs: 7 (32 CPUs and 61 GB on the sandbox host, 4 CPUs and 8 GB per job)`. `MAX_PARALLEL_JOBS=12` sets the number yourself, e.g. when the host also runs other work or your recipes are lighter. Docker reads the engine's machine, SSH the host; a sandbox service ([Remote](#remote)) says how many it allows; when none of them can tell, gespann runs 2.

That number is shared by everyone on the same provider; with [several providers](#several-providers) each counts its own jobs. In Settings → Sandboxes each user sees which of their jobs hold a sandbox now, can run fewer of their own jobs at once (from 1 up to their provider's number, or up to a server module's cap, see [Server module](#server-module)), and sees their sandbox time: from the start to the end of each job of their projects, counted on the UTC day and calendar month the job started.

Jobs of one project and one owner run side by side, each in its own sandbox with its own checkout. Only a project's setup runs alone. A new sandbox takes over the project's current recipe: after each setup and each fix of the copy, gespann keeps the recipe directory as `DATA_DIR/projects/<id>/recipe.tgz` and copies it into the project's other sandboxes before their next job. Its first job builds the app's images from scratch unless the host's Docker cache already has them.

All parallel jobs of an owner use the same Codex sign-in. Codex refreshes a sign-in after 8 days, and OpenAI accepts each refresh token once, so two jobs must not refresh the same copy: while a refresh is due, one job starts Codex first and the others wait until its refresh is stored, then start with the new sign-in.

| Provider | A sandbox is | Good for |
|---|---|---|
| `docker` | a container from your image, on the local engine or a remote one (`DOCKER_HOST`) | a CI server that runs Docker; isolation per project |
| `ssh` | a directory on a Linux machine you already run, used as `HOME` | a CI server without Docker, or one that already has your toolchain |
| `remote` | whatever a sandbox service of yours makes (a cloud VM, a pod), reached over HTTP ([Remote](#remote)) | many jobs at once, beyond one machine |

Whatever the provider, the machine needs `bash`, `git`, `curl`, Node.js 22.18 or newer with `npm`, and the `codex` CLI on `PATH` (for OpenRouter a version with the Responses API for custom providers; tested with 0.172), plus what your recipe uses (often Docker). gespann installs itself there on the first job. For UI checks the tester needs a screen: a desktop (`DISPLAY`) with Chrome, and Codex configured with a computer-use or browser tool. Without one it can only test what it reaches with commands. Claude Code, Copilot and Grok get the same tools: gespann copies the `[mcp_servers]` of Codex's `config.toml` into their own config for each step (`env_vars` and header variables read from the sandbox's environment). Their CLIs need no setup: `gespann agent` installs Claude Code (`npm i -g @anthropic-ai/claude-code`), the Copilot CLI (`npm i -g @github/copilot`) or the Grok CLI (`curl -fsSL https://x.ai/cli/install.sh | bash`) into the sandbox's home on first use, so the machine needs to reach npm and x.ai. Every run is recorded as a video of the tester's screen, shown first on the run page and linked above the screenshots in the PR comment. Sandboxes record with `ffmpeg` (x11grab) on the sandbox's `DISPLAY`, so the machine needs `ffmpeg` next to its screen. When a run cannot be recorded, the run page says so and the job log names the reason.

### Several providers

One instance can serve different users from different sandbox providers, e.g. the team's own CI server for the team and a sandbox service for everyone else:

```bash
-e SANDBOX_PROVIDER=remote -e SANDBOX_REMOTE_URL=http://sandboxes.internal/api -e SANDBOX_REMOTE_TOKEN=… \
-e SANDBOX_PROVIDER_BY_USER="tobi=ssh,ops=ssh" \
-e SSH_HOST=gespann@ci.example.com -e SSH_PRIVATE_KEY="$(cat gespann_ci)"
```

`SANDBOX_PROVIDER_BY_USER` maps GitHub logins (any case) to a provider, written as for `SANDBOX_PROVIDER`; comma-separated. A user it names gets that provider for their projects' sandboxes and their Codex sign-in; everyone else gets `SANDBOX_PROVIDER`. Without `SANDBOX_PROVIDER`, only the named users get sandboxes and the jobs of everyone else stay queued. Each provider is made once and runs its own number of jobs at once, so a full CI server never holds up the users of the sandbox service. Each of `docker`, `ssh` and `remote` reads its settings from the variables below, so each exists once per instance. The log names every provider, whom it serves and its number, e.g. `sandboxes: ssh (tobi, ops), parallel jobs: 7 (…)` and `sandboxes: cloud (everyone else), parallel jobs: 200 (the sandbox service allows 200 at once)`.

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
| `DOCKER_HOST`, `DOCKER_CONTEXT` | which engine, as for the `docker` CLI. `ssh://user@host` reaches a CI server; the key comes from `~/.ssh` of the user running the orchestrator |

The orchestrator image contains the `docker` CLI. For the local engine, mount its socket into the orchestrator and give its user access: `-v /var/run/docker.sock:/var/run/docker.sock --group-add $(stat -c %g /var/run/docker.sock)`. A stopped container keeps its disk; `docker rm` deletes a sandbox, and gespann makes a new one on the next job.

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

Each sandbox is a directory under `SANDBOX_ROOT`. Every command gespann runs there has it as `HOME`, so `~/.codex` and gespann's own install stay per sandbox. On a host with a screen (`DISPLAY` set and Xvfb installed), each sandbox gets its own virtual screen while it runs a job, so parallel testers never see each other's browser: gespann starts Xvfb on a free display and sets `DISPLAY` for everything in that sandbox, Codex's browser tool included when its config forwards `DISPLAY` (step 7). When a project picks screen sizes on its Setup page, the run's screen grows to fit them. With one size, the tester sets it with its browser tool's resize (Playwright's MCP server has `browser_resize`). With two or more, `gespann verify prepare` also starts the mirror (`gespann mirror`): a page on `127.0.0.1` that shows the copy at every size side by side and repeats each click, entry, key, scroll and page change of the size the tester drives in the others, so the tester goes through every check once for all sizes. It reaches the copy through a small proxy on the same address, which drops the copy's `X-Frame-Options` and CSP `frame-ancestors` so the copy loads in a frame. The run's screen then fits the mirror, up to 4K. The SSH user's own `~/.codex/config.toml` is linked into every sandbox: give Codex its browser or computer-use tool there (e.g. an MCP server such as Playwright's on an Xvfb display), and export `DISPLAY` at the top of the user's `~/.bashrc` so `gespann shot` sees the same screen. All projects still share the machine's user, its processes and its Docker engine, and PR code runs with that user's rights: use a dedicated user on a machine that holds no secrets you would not hand to a PR. Recipes should name their Docker projects and ports after `$GESPANN_RUN` so two projects can run side by side. gespann starts no login shell: check with `ssh ci@ci.example.com 'command -v node npm git codex'` that the tools are on that `PATH`.

### Remote

A sandbox service you reach over HTTP: an adapter of your own that turns gespann's calls into a vendor's API (cloud VMs, a Kubernetes operator, a pool of machines). gespann sends one request per sandbox call; the protocol is in [remote-sandboxes.md](remote-sandboxes.md).

```bash
-e SANDBOX_PROVIDER=remote \
-e SANDBOX_REMOTE_URL=http://sandboxes.internal/api \
-e SANDBOX_REMOTE_TOKEN=$(openssl rand -hex 32)
```

| Variable | |
|---|---|
| `SANDBOX_REMOTE_URL` | the service's base URL (required) |
| `SANDBOX_REMOTE_TOKEN` | bearer token on every request, at least 32 characters (required); the service checks it |

At startup the orchestrator reads the service's `GET /info` (its name for the job logs, the sandboxes' home, how many jobs it allows at once, how often to poll) and waits up to 10 minutes for it. While the service does not accept connections or answers 503, each call tries again for up to 10 minutes, so a deploy of the service pauses running tests instead of failing them. Reach the service directly, not through a proxy that cuts long requests: starting a sandbox can take minutes.

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

8. Check over SSH from the gespann server (the key works only from there; add your own address to `from=` for a check from elsewhere): `ssh -i gespann_ci gespann@<host> 'command -v node npm git curl docker codex playwright-mcp; echo $DISPLAY'` lists every tool and `:77`. Then set the variables above on the orchestrator and deploy; its log line `sandboxes: ssh` confirms the provider.

Undo: `sudo ufw delete allow from "$GESPANN_IP" to any port 22 proto tcp`, `sudo systemctl disable --now gespann-xvfb`, `sudo userdel -r gespann`.

## Server module

`SERVER_MODULE=/path/to/module.js` loads an ES module whose default export gets the server's environment and returns an object with a `name` (sync or async). Every other part is optional ([src/server/extension.ts](../src/server/extension.ts)):

- `routes(app, { user })` mounts routes on the server's Hono app, before the web app. `user(c)` is the signed-in user (`{ id, login }`) or null. API calls under `/api/` need the header `x-gespann: 1`; your own paths guard themselves against cross-site posts.
- `links` puts links in the sidebar for signed-in users, e.g. `[{ label: "Usage", href: "/usage" }]`.
- `settings(user)` returns cards for the top of the Settings page: `{ id, title, description?, badge?, rows }`. A row is text, a meter (`value` of `max`), a button, or a number field. Buttons and fields POST JSON to a path under `/api/` that your `routes` serve; answer `{ redirect: url }` to send the user on (a checkout, say), `{ error }` to show a message, or anything else to reload the card. `/settings#<id>` scrolls to a card. If `settings` throws, only its cards are missing.
The module runs in the UI; the orchestrator asks it through the UI's internal API.

- `admit(job)` runs before a job takes a sandbox. Return a string and the job fails with `not started: <string>` (a PR gets a neutral check with that text); return null to let it start. `job` names the job, its kind, its project and the project's owner.
- `jobEnded(end)` runs after a job ended and gave its sandbox back, with its status and `seconds` from start to end (the sandbox time Settings shows), once per job. When it throws, the orchestrator tells it again later; it never fails the job.
- `jobCap(owner)` caps how many jobs of an owner's projects run at once: return `{ jobs, reason }` or null for no cap. A job over the cap waits in the queue and starts when one of the owner's jobs ends; it does not fail. The UI asks every 10 s and writes the caps to the database, where the orchestrator reads them when it picks the next job; answer right away from memory, without a network call. Settings → Sandboxes lets the owner choose at most the cap and shows `<reason> allows <jobs> at once`. Without `jobCap`, or when it throws, there is no cap.

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

1. A user signs in with GitHub and picks the agent's model provider once in **Settings**:
   - **ChatGPT plan**: `codex login --device-auth` in a short-lived sandbox. gespann keeps the resulting `auth.json` encrypted and deletes the sandbox.
   - **OpenRouter**: the user pastes their own API key (checked with OpenRouter, then kept encrypted) and types any OpenRouter model id that calls tools and reads images, or picks one of a short list: four cheap vision models and two free ones, each with an estimated cost per test. They are suggestions: none is tested through OpenRouter by us (the page says so) (`OPENROUTER_PICKS` and `OPENROUTER_FREE_PICKS` in `src/server/openrouter.ts`). Free models cost nothing but OpenRouter rate-limits them hard, so a run can stop halfway. Every Codex step then runs `codex exec` with OpenRouter as its model provider (`wire_api = "responses"`). The key is written into the sandbox (`~/.gespann-openrouter-key`, mode 600) just before a Codex step, read into `OPENROUTER_API_KEY` and deleted before Codex starts, and `shell_environment_policy.exclude` keeps it out of the commands Codex runs. Like the Codex sign-in, it is still within reach of code running as the sandbox's user while Codex runs (Codex's process environment), so gespann tests only branches of the repo itself, never forks. Codex knows only OpenAI's models; gespann passes the model's context size from OpenRouter so Codex compacts in time. The user pays OpenRouter per token.
   - **Claude Code**, **GitHub Copilot** or **Grok**: the user pastes their key: an Anthropic API key (checked with Anthropic) or the token `claude setup-token` prints for a Claude Pro or Max plan (checked by its form), a GitHub token of an account with Copilot (fine-grained with the permission *Copilot Requests*; checked with GitHub), or an xAI API key (checked with xAI). A model is optional; without one the CLI's default runs, and a project's own model in Setup counts only for Codex and OpenRouter. Each step runs `gespann agent <claude|copilot|grok>` in the repo: the key is written to `~/.gespann-agent-key` (mode 600) just before, and `gespann agent` reads and deletes it before the CLI starts and passes it as `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `COPILOT_GITHUB_TOKEN` or `XAI_API_KEY`. Copilot keeps the token out of the commands it runs (`--secret-env-vars`); Claude Code and Grok do not, so as with OpenRouter the key is within reach of code running as the sandbox's user during the step. (Claude Code's own scrub would force every command into its sandbox, without Docker, where the copy cannot run.) Claude Code loads only the user's settings (`--setting-sources user`), so hooks a PR adds under `.claude/` do not run in the tester; Copilot's built-in GitHub tools are off.
2. Adding a repository starts the setup: in the project's own sandbox, Codex reads the repo and writes `verify.yml` (see [recipe.md](recipe.md)), the scripts it calls, `NOTES.md` and `CHECKS.md`. gespann then starts and stops the copy once without Codex to check the recipe.
3. **Start** turns on PR testing. Each matching PR (not from forks) gets the check `gespann/verify`: the sandbox merges the PR onto its base branch as it is when the run starts (not the older base commit GitHub reports for the PR), brings the copy up, Codex tests it with the sandbox's computer-use tools, and the verdict, screenshots and a recording land on the run page and in a PR comment. A PR that does not merge onto its base is not tested: the run shows *conflict* in grey instead of a verdict, the check stays neutral, and the PR comment and the MCP issue `merge_conflict` name the files and tell the PR's agent to update the branch. gespann never resolves conflicts itself; a push that matches the triggers is tested again, otherwise *Rerun* tests the PR's new head. Without a conflict a PR needs no rebase to catch up with its base: *Rerun* tests the same head on top of the newest base. A PR has one test at a time: a push of a new head stops the test of the old one, and a second start for the head already queued or running (a second webhook, *Rerun*, the MCP tool) joins that run instead of starting another.

The project sandbox stops after every job, and the Codex sign-in or agent key is only inside it while a job runs.

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

The gate is a per-project setting (*Merge gate* on the project page), off for new projects, and the only switch that lets a result block a merge. While it is off, every result is reported and the `gespann/verify` check never fails: a FAIL ends neutral, so a branch rule that requires the check still lets the PR merge. When it is on, a FAIL fails the check, and a PR with the label `gespann` cannot be merged until gespann's test of its current commit passes. gespann turns the PR into a draft, which GitHub does not merge, and back to ready for review once the test passes. This works on every GitHub plan, also on private repositories without required checks. A person releases a PR without a passing test by commenting `/gespann approve` (needs the `issue_comment` event; apps created before it was added need it ticked under the app's *Permissions & events*), by clicking *Ready for review*, or by removing the label. A new push needs a new pass or approval. `/gespann approve` works on every PR, also without the label: it ends the commit's `gespann/verify` check as neutral, so a branch rule that requires that check lets the PR merge (a check that already passed stays green). GitHub lets an app switch a PR to draft only with *Contents: Read and write*; apps created before the gate need that permission raised and the installation needs to accept it. Without it, PRs are still tested but not held. Sandboxes only ever get a read-only token.

A run starts only after the PR's other checks passed (see the recipe docs). CI that reports through check runs (GitHub Actions) is seen with the app's checks permission. CI that reports commit statuses (Buildkite, Jenkins, CircleCI) needs *Commit statuses: Read-only*; apps created before it was added need it ticked under *Permissions & events*, and the installation needs to accept it. Until then those statuses are not waited for.

