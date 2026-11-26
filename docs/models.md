# Which Codex model to pick

**Use GPT-6.2-Sol.** In our benchmark it judged every test PR right, and it is the newest of the accurate models. GPT-6.1 Terra and GPT-6.1-Sol were just as accurate and about as fast. GPT-6-Luna passed a PR that broke a total, and it was not faster, so we do not recommend it for testing. Settings → Codex marks the recommended model.

## Result (2026-11-26)

4 models × 7 PRs × 2 runs = 56 tester runs. The Astra models were not part of this round.

| Model | Right verdicts | Bugs caught | False alarms | Copy gap reported as BLOCKED | Median time | Tokens per run |
|---|---|---|---|---|---|---|
| GPT-6.2-Sol | 14 / 14 | 6 / 6 | 0 / 4 | 2 / 2 | 100 s | 386k (2.9k out) |
| GPT-6.1 Terra | 14 / 14 | 6 / 6 | 0 / 4 | 2 / 2 | 101 s | 406k (2.7k out) |
| GPT-6.1-Sol | 14 / 14 | 6 / 6 | 0 / 4 | 2 / 2 | 104 s | 425k (3.1k out) |
| GPT-6-Luna | 13 / 14 | 5 / 6 | 0 / 4 | 2 / 2 | 103 s | 387k (3.6k out) |

Every FAIL named the planted bug, not something else. Luna's miss: on the status-badge PR it read the "Open amount", which now also summed paid invoices (CHF 10,380.65 instead of 4,240.15), and wrote that the amount "matches the seeded open-plus-paid total", so it passed the PR. Its second run on the same PR caught it.

## How we measured

- **App:** a small invoicing app (sign-in, invoice list with the open amount, invoice page, new invoice, mark as paid), no dependencies.
- **PRs**, each with a known right verdict:
  - FAIL: VAT shown at 81 % instead of 8.1 %; a new due-date field whose name does not match the server, so creating an invoice always fails; status badges that also change the open amount to include paid invoices (the bug sits next to the change, not in it).
  - PASS: search by customer; a confirmation and a notice when marking an invoice as paid.
  - SKIP: README only.
  - BLOCKED: send an invoice by email through an SMTP provider the copy does not have.
- **Tester:** the production tester prompt (`gespann verify prompt tester`), default checks, `codex exec` with reasoning effort `medium` as in a PR run, Playwright's MCP server in headless Chromium as the browser tool, 20 minutes per run, four runs at a time. The tester could not see the expected verdicts.
- **Right verdict:** the verdict in `verdict.json` equals the expected one. For FAIL and BLOCKED we also checked that the failed or blocked check names the planted cause.

## Limits

14 runs per model on one small app tell a clear miss from no miss, but not small differences between the three accurate models. Median times were within 4 % of each other, tokens within 10 %. A real app with longer flows can separate them more; we will rerun this when the model list changes.
