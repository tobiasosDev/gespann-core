# Which Codex model to pick

**Use GPT-6.1 Terra.** In our benchmark it judged every test PR right, like GPT-6.2-Sol and GPT-6.1-Sol, and a test cost it 1.5 credits instead of 3.6 and 3.4: OpenAI charges half of Sol's rate per token for it. GPT-6-Luna is the cheapest (0.25 credits), but it passed a PR that broke a total, so we do not recommend it for testing. The model picker in Settings → Codex shows each model's result and cost.

## Result (2026-11-26)

4 models × 7 PRs × 2 runs = 56 tester runs. The Astra models were not part of this round.

| Model | Right verdicts | Bugs caught | False alarms | Copy gap reported as BLOCKED | Median time | Tokens per run | Credits per run |
|---|---|---|---|---|---|---|---|
| GPT-6.1 Terra | 14 / 14 | 6 / 6 | 0 / 4 | 2 / 2 | 98.5 s | 406k (2.7k out) | 1.5 |
| GPT-6.2-Sol | 14 / 14 | 6 / 6 | 0 / 4 | 2 / 2 | 99 s | 386k (2.9k out) | 3.6 |
| GPT-6.1-Sol | 14 / 14 | 6 / 6 | 0 / 4 | 2 / 2 | 102.5 s | 425k (3.1k out) | 3.4 |
| GPT-6-Luna | 13 / 14 | 5 / 6 | 0 / 4 | 2 / 2 | 101 s | 387k (3.6k out) | 0.25 |

Every FAIL named the planted bug, not something else. Luna's miss: on the status-badge PR it read the "Open amount", which now also summed paid invoices (CHF 10,380.65 instead of 4,240.15), and wrote that the amount "matches the seeded open-plus-paid total", so it passed the PR. Its second run on the same PR caught it.

## Cost

Credits per run are the run's tokens at [OpenAI's Codex rates](https://learn.chatgpt.com/docs/pricing) (credits per 1M tokens, input / cached input / output), averaged over its 14 runs. Most input is cached (87 to 93 %), so output and uncached input decide the cost.

| Model | Rates | Plus: messages per 5 hours (OpenAI's estimate) |
|---|---|---|
| GPT-6.1 Terra | 25 / 1.25 / 125 | 35–285 |
| GPT-6.2-Sol | 50 / 2.5 / 250 | 17–180 |
| GPT-6.1-Sol | 50 / 2.5 / 250 | 15–160 |
| GPT-6-Luna | 2.5 / 0.25 / 12.5 | 350–3,000 |
| GPT-6.2-Astra (not benchmarked) | 200 / 10 / 1,000 | 6–50 |
| GPT-6-Astra (not benchmarked) | 250 / 25 / 1,250 | 5–45 |

A test of a real app with longer flows uses more tokens than these small PRs; the ratios between the models should roughly hold.

## How we measured

- **App:** a small invoicing app (sign-in, invoice list with the open amount, invoice page, new invoice, mark as paid), no dependencies.
- **PRs**, each with a known right verdict:
  - FAIL: VAT shown at 81 % instead of 8.1 %; a new due-date field whose name does not match the server, so creating an invoice always fails; status badges that also change the open amount to include paid invoices (the bug sits next to the change, not in it).
  - PASS: search by customer; a confirmation and a notice when marking an invoice as paid.
  - SKIP: README only.
  - BLOCKED: send an invoice by email through an SMTP provider the copy does not have.
- **Tester:** the production tester prompt (`gespann verify prompt tester`), default checks, `codex exec` with reasoning effort `medium` as in a PR run, Playwright's MCP server in headless Chromium as the browser tool, 20 minutes per run, four runs at a time. The expected verdicts were in neither the prompt nor the checkout; the tester's file access was not sandboxed, but none of the 56 logs shows it opening the benchmark's own files.
- **Right verdict:** the verdict in `verdict.json` equals the expected one. For FAIL and BLOCKED we also checked that the failed or blocked check names the planted cause.

## Limits

14 runs per model on one small app tell a clear miss from no miss, but not small differences between the three accurate models. Median times were within 5 % of each other, tokens within 10 %. A real app with longer flows can separate them more; we will rerun this when the model list changes.
