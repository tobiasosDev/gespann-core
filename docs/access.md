# Outside services: a fake by default, a key when the PR needs the real one

Some checks need something the copy does not have: a payment provider, a mail service, a third-party account, a Mac with Xcode. gespann handles each such service in one of two ways:

- **Fake (default).** The copy stands in for the service with a local fake that answers the way the real one does. Every PR is tested against it, with no account, no cost and no secret in the sandbox. What gets tested is the app's own code around the service: its pages, its state, its errors.
- **Key.** The project stores a key for the service. PRs that change the code that talks to the service then run against the real one; every other PR keeps the fake.

## How a fake comes about

When the tester is blocked because the copy lacks an outside service, it says so in the check's `fix`. gespann's repair then builds a fake for it, lists it in the recipe's `access` list and tests the PR again ([recipe.md](recipe.md)). The setup does the same for every provider it fakes from the start. A repair gives up (`cannot:`) only when not even a fake can stand in, such as physical hardware the app reads (a camera, a sensor).

The run page, the PR comment and `get_run` over MCP name every service the run faked ("Tested against a fake: Mac sandbox provider") and every one it reached with the project's key.

## The recipe's `access` list

```yaml
access:
  - name: MAC_PROVIDER_TOKEN          # the environment variable that carries the key
    about: Mac sandbox provider       # how the run page and the Setup page name it
    paths: ["orchestrator/src/sandbox/**", "src/server/macos.ts"]   # the code that talks to it
```

The scripts use the real service when `$MAC_PROVIDER_TOKEN` is set and the fake when it is not. gespann sets the variable only when both are true:

1. the project stored a key for it on its Setup page, and
2. the PR changes a file matching `paths` (`git diff --name-only base...head`).

Otherwise the variable is unset for every recipe command, even when the sandbox's own environment has it, so the fake runs.

## Storing a key

On the project's **Setup** page, **Outside services** lists every service of the recipe. The owner pastes a key with **Store key** (at least 8 characters). gespann keeps it encrypted with `SESSION_SECRET`, the way it keeps agent keys, and never shows it again (only its last four characters, for keys of 16 characters or more). **Remove key** forgets it. The run page's link "Store a key" leads to the service's row.

Use a test account with a small budget. While a run that gets the key starts, the PR's own code runs as the sandbox's user and can read the key, just as it can read the agent's key. That is why gespann tests only branches of the repository itself, never forks.

## What the key reaches

- The orchestrator writes the project's keys into the run's folder in the sandbox (mode 600) just before `gespann verify prepare` and passes the file with `--keys`. `prepare` reads it and deletes it at once.
- Only `prepare`'s commands get the key: `setup`, `services`, `flags.run`, `env.up` and `alongside`. The tester's agent, `env.down`, `cleanup` and `flags.switch` do not, so a flag switch that restarts the app restarts it without the key. The result then says that checks after a flag switch may have used the fake.
- Recipe command output that contains a key is written to the run log as `[key]`. Output of background services goes to their own log files unchanged, so do not print keys there.
- `$GESPANN_WORK/access.json` records for each service whether this run used the real one and why, never the key. `finish` adds it to the result.

## CI runners

`gespann verify prepare` without `--keys` takes the keys from its own environment, the way a CI runner sets secrets. The `paths` rule still applies: a PR that does not change the service's code runs against the fake.
