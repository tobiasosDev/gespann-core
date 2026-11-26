# Recipe: `.gespann/verify.yml`

A recipe tells `gespann verify` how to bring up a production-near copy of one pull request and what the tester agent needs to know about it. It lives in your repo, next to the code it starts, and changes through PRs like the rest.

Check a recipe and see the order it runs in:

```bash
gespann recipe                     # validates .gespann/verify.yml, prints the plan
git diff --name-only origin/dev... | gespann recipe trigger --base dev --labels verify
```

## Example

```yaml
version: 1
mode: shadow            # shadow: report only. gate: a FAIL verdict fails the check.
timeout: 25             # minutes, setup to verdict

trigger:
  branches: [main]      # PR base branches; leave out for any
  label: verify         # this label always runs
  paths: ["app/**", "lib/**", "db/migrations/**"]
  ignore: ["**/*.test.ts", "**/e2e/**"]

setup:
  - name: install
    run: npm ci
  - name: images
    run: docker compose build

services:
  - name: fake payments
    run: node test/fakes/payments.js > "$GESPANN_WORK/payments.log" 2>&1
    ready: grep -o 'http://[^ ]*' "$GESPANN_WORK/payments.log" | sed 's/^/PAYMENTS_URL=/' >> "$GESPANN_ENV"

flags:
  run: node scripts/prod-flags.js     # stdout becomes the tester's flag sheet
  admin: /admin/flags

env:
  up: |
    docker compose -p "verify-$GESPANN_RUN" up -d --wait
    echo "WEB_URL=http://127.0.0.1:$(docker compose -p "verify-$GESPANN_RUN" port web 3000 | cut -d: -f2)" >> "$GESPANN_ENV"
  down: docker compose -p "verify-$GESPANN_RUN" down -v
  url: $WEB_URL

replay:
  misses: $GESPANN_WORK/misses

alongside:
  - name: smoke suite
    run: npx playwright test e2e/smoke > "$GESPANN_WORK/smoke.md"
    output: smoke.md

login:
  path: /login
  user: admin@example.test
  password: admin-on-the-copy-only

seeds:
  - name: paid
    run: node scripts/seed.js paid
    about: a user with an active subscription

prompt: .gespann/verify.md

cleanup:
  - name: logs
    run: docker compose -p "verify-$GESPANN_RUN" logs > "$GESPANN_OUT/compose.log"
```

## Order

A run executes the recipe in this order. Steps marked *always* run even when an earlier one failed.

1. `setup`, in order
2. `services` start; each waits for its `ready` command
3. `flags`
4. `env.up`
5. `alongside` checks start in the background
6. the tester works against `env.url`
7. the run waits for the `alongside` checks
8. `verdict.json` is validated. When the PR resolves GitHub issues (`Fixes #12`, or linked in the PR sidebar), the server writes their title and description to `$GESPANN_WORK/issues.md` and their refs to `issues.json`; the tester then judges each issue's goal (`goals` in `verdict.json`: met, missed or blocked), and a missed goal fails the run
9. *always:* `env.down`, the services stop, `cleanup` in order

## Commands

Every command runs with `sh -c` in the repo root. These variables are set:

| Variable | |
|---|---|
| `GESPANN_PR`, `GESPANN_HEAD`, `GESPANN_BASE` | the PR and the two commits under test |
| `GESPANN_RUN` | short id of this run (12 hex characters); use it to name containers |
| `GESPANN_WORK` | scratch directory the tester can read: fixtures, flag state, logs |
| `GESPANN_OUT` | the tester's output: `verdict.json`, screenshots, recording |
| `GESPANN_ENV` | append `KEY=value` lines; later steps see them as variables |

`env.url` may use `$VAR` from `GESPANN_ENV`.

## Fields

| Field | Required | |
|---|---|---|
| `version` | yes | `1` |
| `trigger.paths` | yes, or `label` | a changed file matching one of these starts a run |
| `trigger.ignore` | | changed files matching these never start a run |
| `trigger.branches` | | PR base branches; empty means any |
| `trigger.label` | | a PR with this label always runs (still only into `branches`) |
| `mode` | | `shadow` (default) or `gate` |
| `timeout` | | minutes, default 25 |
| `setup[]` | | `{name, run}` |
| `services[]` | | `{name, run, ready?, readyTimeout?}`: background processes for the whole run. `ready` is polled every second until it exits 0 (default 60 s). |
| `flags` | | `{run, admin?}`: `run` prints the flag state the tester judges against; `admin` is the page where it switches a flag to test both states |
| `env` | yes | `{up, down, url}` |
| `replay.misses` | | directory where your replay layer writes one file per request it had no recording for. A replay miss is never a failed check. |
| `alongside[]` | | `{name, run, output?, required?}`: scripted checks beside the tester. `output` is a file in `GESPANN_WORK` the tester reads. With `required` (default true) a non-zero exit fails the run. |
| `login` | | `{user, password, path?, note?}`: an account that exists only on the copy. Never a real credential. |
| `seeds[]` | | `{name, run, about}`: data states the tester may load |
| `prompt` | | repo-relative file appended to the generic tester prompt: domain knowledge, fixtures, what to ignore |
| `cleanup[]` | | `{name, run}`, always run |

Unknown fields are errors, so a typo never drops a setting silently.

## What stays out of a recipe

Secrets. Commands get credentials from the CI environment or a secret manager at run time, never from the recipe.
