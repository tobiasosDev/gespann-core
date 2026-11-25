# gespann

Acceptance testing for pull requests. For every PR, gespann starts a production-near copy of your app in a cloud sandbox, an agent on your own Codex plan clicks through the change like a tester, and the verdict with screenshots lands on the PR as the check `gespann/verify`.

Hosted at [app.gespann.app](https://app.gespann.app): sign in with GitHub, connect your ChatGPT plan once in Settings, add a repository. Codex prepares the environment by itself; then every pull request is tested. Run it yourself: [docs/self-host.md](docs/self-host.md).

- Sandboxes: per project, kept between jobs; PRs are tested side by side, as many at once as the sandbox host has room for (`MAX_PARALLEL_JOBS` overrides it). Docker (local or on a CI server), any Linux machine over SSH, or a provider module of your own, chosen by environment variables ([docs/self-host.md](docs/self-host.md#sandboxes)).
- Model: Codex on each user's own ChatGPT plan (`codex login --device-auth`), so there is no model bill from gespann.
- Environment: a recipe ([docs/recipe.md](docs/recipe.md)) that Codex writes once per repo; `gespann verify prepare|finish` runs it.
- Gaps heal themselves: when the tester is blocked only because the copy lacks something (a site not built, a provider not faked), Codex adds it to the recipe, the copy is checked, and the test runs once more. The PR gets the second result. A fix that does not work is rolled back.
- Agents read results over MCP: status, issues, the review, screenshots and the recording of each run, read-only, after a one-time OAuth sign-in in the browser or with a token from Settings ([docs/self-host.md](docs/self-host.md#agent-access-mcp)).
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
DATA_DIR=.data node src/bin.ts serve   # http://localhost:3000
```

## License

Apache-2.0
