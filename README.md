# gespann

A quality loop for coding agents. gespann watches how Claude Code and Codex work in your repo. When it sees a check go missing, it proposes a change, and nothing ships until your team approves it. The approved version reaches every developer's next session, and gespann measures whether the change helped. If it did not, you roll it back.

```
observe ──► finding ──► proposal ──► approve ──► next session ──► trial ──► adopt / rollback
 hooks       "lint did     versioned     team       skill + stop     effect vs
 + git        not run"     rule diff                hook active      before
```

This repository is the open core: the runner, the rule format, and the adapters for Claude Code and Codex, licensed under Apache-2.0. The hosted service, with automatic PR runs without your own CI, cross-repo history and the acceptance agent, is planned as a separate commercial product.

## Why

Over two months of real Claude Code and Codex sessions on one production monorepo, 352 sessions changed lintable files. Lint ran in the package after the last edit in 29 of them (8 %). It ran in 0 of the 38 Codex sessions. All 29 runs were piped or chained (`| tail`, `; git status`), so their exit codes said nothing about lint. Instructions alone don't fix that: an agent can skip them, and nothing fails when it does. gespann fixes each finding at the highest level that works. If the check exists as a command, a stop hook runs it. Agent instructions (skills) cover judgment calls. CI catches what the local loop missed.

## Install

```bash
npm install -g github:tobiasosDev/gespann-core
cd your-repo
gespann init          # detects lint/typecheck/test, writes .gespann/, installs hooks
```

`init` writes:

- `.gespann/rules/<id>/v1.json`: one rule per detected check, in observe mode. An observe-mode rule only measures and changes nothing.
- `.claude/settings.json` and `.codex/hooks.json`: hook entries, merged with the hooks you already have. If `gespann` is not installed on a teammate's machine, the hooks do nothing.
- `.gitignore`: entries for the generated skill folders.

Commit `.gespann/` and the hook config. Codex runs new project hooks only after you trust them: open Codex in the repo and run `/hooks` once.

## The loop

```bash
gespann scan                 # baseline from past Claude Code + Codex transcripts of this repo
gespann findings             # sessions where a check was expected and did not end green
gespann propose lint         # next version, highest level that works, with evidence and diff
gespann approve lint-v2-ab12 --note "pilot"   # or --edit to change it first; starts a 14-day trial
#   … the next session picks it up …
gespann trial lint           # trial vs before: check after last edit, caught, false alarms, time
gespann adopt lint           # or: extend lint --days 7 | rollback lint
gespann ci-block lint --note "two weeks, no false alarms"   # merge blocking is its own decision
```

A finding means the rule's files changed in a session, and the session did not end with a passing check after the last change.

Two other commands feed the loop:

- `gespann add <id> --title … [--command …] [--paths …]` turns a review or manual-test finding into a new rule proposal.
- `gespann flag <session> --rule lint --false-alarm` marks a false alarm, which the trial counts.

## How observation works

gespann reads edits from git, not from tool calls. The agent may write a file with an Edit tool, `sed -i` or a Python heredoc, and git sees all of them the same way. At session start, gespann records `HEAD` and the files that were already dirty, so it never blames a session for earlier changes. At each stop it compares the rule's files with that snapshot.

gespann counts a check run when a shell command matches the rule's `check.match`. It trusts the exit code only when the check is the last unpiped step of that command. `npm run lint | tail` and `npm run lint; git status` count as "ran, result unknown". When a rule is at hook level, gespann then runs the check itself.

| | Claude Code | Codex |
|---|---|---|
| Hooks | SessionStart, PostToolUse, PostToolUseFailure, Stop, SessionEnd | SessionStart, PostToolUse, Stop, SessionEnd |
| Shell exit code | in the hook payload | read from the session transcript at stop (the hook payload has none) |
| Skills | `.claude/skills/gespann-<id>/` | `.agents/skills/gespann-<id>/` |
| Stop can send the agent back | yes | yes |

If gespann did not see a session start (hooks installed mid-session, `gespann` missing), the status is `unknown`, not a finding. A gap in observation never counts as a failure.

## Rules

Rule versions are immutable files: `.gespann/rules/<id>/v<N>.json`. The active version, the trial and the history live in `.gespann/state.json`.

```json
{
  "id": "lint",
  "version": 2,
  "title": "Lint passes before a change is reported as done",
  "why": "Lint errors found in review cost a round trip.",
  "paths": ["apps/web/**/*.{ts,tsx}"],
  "check": { "command": "bun run lint", "cwd": "apps/web", "match": "\\beslint\\b|\\bbun run lint\\b", "requires": [{ "env": "DATABASE_URL" }] },
  "level": "hook",
  "ci": "report",
  "skill": "Before you report a change … run `bun run lint` …"
}
```

- `level`:
  - `observe` only measures.
  - `skill` distributes the instruction.
  - `hook` also runs the check at stop. If the check fails, gespann sends the agent back with the output, at most twice per session.
- `ci`:
  - `report` annotates the PR.
  - `block` fails the job, and only `gespann ci-block` can turn it on.

Approved skills are written at every session start (`gespann sync`). New sessions use the new version. Hook rules apply at the next stop, even in a running session. If someone edited a generated skill file by hand, gespann keeps that file and reports a conflict. `gespann sync --force` overwrites it.

## CI

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: tobiasosDev/gespann-core@main
```

Locally and in CI the same runner (`gespann run`) runs the rules whose paths changed against the PR base. It records commit, command, rule version, result and time in the job summary. Rules in report mode never fail the job. A rule whose `requires` are missing is reported as `blocked`, not as failed.

## Transfer

```bash
gespann export lint --out lint.json                                  # repo A
gespann import lint.json --command "pnpm lint" --paths "src/**/*.ts" # repo B: a proposal, approved by team B
```

## Data

Session journals, the scan baseline and the sync manifest live in `<git-common-dir>/gespann/`. They are shared by all worktrees and never committed. Nothing leaves the machine. Only `.gespann/` (rules, state, proposals) is shared through git.

## Limits

- gespann measures through git state. When two agent sessions share one checkout at the same time, it can count one session's edits against the other. Give each session its own worktree; T3 Code, Claude Code and Codex all support that.
- A check counts as run only when it starts a step in the rule's directory, for example `cd apps/web && bun run lint`. A root script that fans out (`bun --filter '*' lint`) does not count for a package rule. At hook level gespann then runs the check itself.
- A hook-level check runs over the whole project, as the command does. If it already fails on the base branch, every session gets sent back for errors it did not make. Fix the base first.
- Rule files are trusted like `package.json` scripts. gespann records a digest of each approved version and refuses one edited in place. That catches mistakes. It is not a security boundary.
- Codex runs new project hooks only after you trust them in `/hooks`.

## Develop

```bash
npm install
npm run check    # typecheck + tests (node --test, Node ≥ 22.18)
npm run build
```

## License

Apache-2.0
