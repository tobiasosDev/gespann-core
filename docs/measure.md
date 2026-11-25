# Measuring the acceptance agent

A pilot counts the same way in every repo, so its numbers can be compared.

## Unit

One verdict: one run on one PR head. A rerun on the same head is another verdict. Only `FAIL` and `BLOCKED` verdicts are classified; `PASS` and `SKIP` are counted, not classified.

## Cause of a FAIL or BLOCKED verdict

Read the verdict's checks, the PR's later commits and the review. Give each failed or blocked check one cause:

| Cause | The check failed or was blocked because … | Evidence |
|---|---|---|
| real bug | the code under test was wrong | a later commit in the same PR fixes it, or a reviewer confirms it |
| environment gap | the copy could not produce what the check needed: missing seed data, fake provider, credential, service, or a recording for a new call site | the observation names what was missing |
| false alarm | the behaviour was correct and the tester judged it wrong, including a replay miss counted as a failure | the same flow works in production or on a rerun |
| other | the run itself broke: timeout, crash, infrastructure | job log |

The verdict takes the first cause in this order that any of its checks has: real bug, environment gap, false alarm, other. A verdict that found one real bug counts as a real-bug verdict, even if other checks hit gaps.

## Numbers

- **Real-bug share** = real-bug verdicts / (FAIL + BLOCKED verdicts). Goal: up.
- **Environment-gap share** = environment-gap verdicts / (FAIL + BLOCKED verdicts). Goal: down.
- **Acceptance time per PR**: minutes a human spends testing the PR by hand before merge. Goal: down.

Report each share with its counts (for example `3 / 20`), the period and the number of PRs, never as a bare percentage.
