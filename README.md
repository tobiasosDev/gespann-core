# gespann

Acceptance testing for coding agents. When Claude Code or Codex opens a pull request, an independent agent starts the change in a production-near environment, clicks through it like a tester and writes a verdict per check, with screenshots as proof. The verdict lands on the PR as a GitHub check and goes back to the coding agent, which fixes what failed before a human looks at it.

Status: in development. The runner (`gespann verify`), the recipe format, the verdict and the back channel are being built in this repository. What works today is the stop hook that will carry the verdict back to the agent.

Everything is open source under Apache-2.0.

## Install

```bash
npm install -g github:tobiasosDev/gespann-core
cd your-repo
gespann init          # installs the stop hook for Claude Code and Codex
```

`init` merges one `Stop` hook into `.claude/settings.json` and `.codex/hooks.json` and leaves your other hooks alone. If `gespann` is not installed on a teammate's machine, the hook does nothing. Codex runs new project hooks only after you trust them: open Codex in the repo and run `/hooks` once.

```bash
gespann status        # which hooks are installed
gespann uninstall     # remove gespann's hooks, keep all others
```

## Stop hook

At each stop the hook runs gespann's stop checks. If one returns a reason, the agent is sent back with it as its next prompt, at most twice per session, so a check that cannot pass never traps the agent. Errors in the hook go to `<git-common-dir>/gespann/errors.log` and never break the agent.

## Earlier versions

Up to `v0.2.0` gespann was a rule loop (observe sessions, propose and approve versioned rules, measure them in a trial). That code is archived at the tag [`v0.2.0`](https://github.com/tobiasosDev/gespann-core/tree/v0.2.0). `gespann init` removes the hooks it installed.

## Develop

```bash
npm install
npm run check    # typecheck + tests (node --test, Node ≥ 22.18)
npm run build
```

## License

Apache-2.0
