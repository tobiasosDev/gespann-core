# gespann

Acceptance testing for pull requests. For every PR, gespann starts a production-near copy of your app in a cloud sandbox, an agent on your own Codex plan clicks through the change like a tester, and the verdict with screenshots lands on the PR as the check `gespann/verify`.

**Start at [app.gespann.app](https://app.gespann.app):** sign in with GitHub, connect your ChatGPT plan once in Settings, add a repository. Codex prepares the environment by itself; then every pull request is tested. Nothing to install or run.

- Sandboxes: one per project, kept between jobs, so later PRs start fast; PRs are tested side by side. Settings shows your running sandboxes and your sandbox time per month, and lets you run fewer jobs at once.
- Model: Codex on each user's own ChatGPT plan (`codex login --device-auth`), so there is no model bill from gespann.
- Environment: a recipe ([docs/recipe.md](docs/recipe.md)) that Codex writes once per repo; `gespann verify prepare|finish` runs it.
- Gaps heal themselves: when the tester is blocked only because the copy lacks something (a site not built, a provider not faked), Codex adds it to the recipe, the copy is checked, and the test runs once more. The PR gets the second result. A fix that does not work is rolled back.
- Every run comes with a video of the tester's screen, first on the run page and linked above the screenshots in the PR comment.
- Agents read results over MCP: status, issues, the review, screenshots and the recording of each run. They can also rerun a PR, for example after a run failed on something outside the PR (at most 3 runs of the same commit); they cannot cancel or approve anything. Sign in once in the browser (OAuth) or use a token from Settings → Agent access:

  ```bash
  claude mcp add --transport http gespann https://app.gespann.app/mcp   # then /mcp → gespann → Authenticate
  codex mcp add gespann --url https://app.gespann.app/mcp && codex mcp login gespann
  ```
- How pilots count results: [docs/measure.md](docs/measure.md).

Everything is open source under Apache-2.0.

## CLI

```bash
npm install -g github:tobiasosDev/gespann-core
cd your-repo
gespann init          # installs the stop hook for Claude Code and Codex
```

`init` merges one `Stop` hook into `.claude/settings.json` and `.codex/hooks.json` and leaves your other hooks alone. If `gespann` is not installed on a teammate's machine, the hook does nothing. Codex runs new project hooks only after you trust them: open Codex in the repo and run `/hooks` once.

```bash
gespann status        # which hooks are installed
gespann recipe        # validate .gespann/verify.yml and print the run plan
gespann uninstall     # remove gespann's hooks, keep all others
```

## Stop hook

At each stop the hook runs gespann's stop checks. If one returns a reason, the agent is sent back with it as its next prompt, at most twice per session, so a check that cannot pass never traps the agent. Errors in the hook go to `<git-common-dir>/gespann/errors.log` and never break the agent.

## Earlier versions

Up to `v0.2.0` gespann was a rule loop (observe sessions, propose and approve versioned rules, measure them in a trial). That code is archived at the tag [`v0.2.0`](https://github.com/tobiasosDev/gespann-core/tree/v0.2.0). `gespann init` removes the hooks it installed.

## Develop

```bash
npm install
npm run check    # typecheck (server + web) and tests (node --test, Node ≥ 22.18)
npm run build    # server to dist/, React app to dist/web
DATA_DIR=.data node src/bin.ts serve   # the UI on http://localhost:3000
cargo test --manifest-path orchestrator/Cargo.toml   # the orchestrator (Rust), which runs the jobs
DATA_DIR=.data SANDBOX_PROVIDER=docker SANDBOX_IMAGE=… cargo run --manifest-path orchestrator/Cargo.toml
```

The UI (TypeScript) serves the web app, MCP and the GitHub webhook; the orchestrator (Rust, `orchestrator/`) runs every job in the sandboxes. Both share the database under `DATA_DIR`: [docs/orchestrator.md](docs/orchestrator.md).

## Run your own instance

gespann is open source, so you can run it yourself: [docs/self-host.md](docs/self-host.md). You need a public HTTPS URL, your own GitHub App, a sandbox host with Docker or SSH access, and for UI checks a desktop with Chrome and `ffmpeg` on that host. You keep it updated and running.

We support the hosted service only. Self-hosted instances get no help with setup or operation; bug reports are welcome when they also happen on [app.gespann.app](https://app.gespann.app).

## License

Apache-2.0
