# Bug zoo and the MCP evaluation

A repeatable yardstick for priority 3 (analysis through MCP): how often an agent that only has
the WebBlackbox MCP server finds the real cause of a bug from a tester's report and the recording.
Every change to the MCP tools or to what the recorder captures is judged by it.

The pipeline:

1. **Bug zoo** (`src/scenarios/`, `src/site/`): a small "Northwind Shop" fixture site with 13
   seeded, realistic bugs, each on its own route and each needing different evidence. Routes,
   titles and archive names do not hint at the cause (a test enforces it).
2. **Tester reports**: per scenario, a short report in Russian and English, symptom only.
3. **Recording** (`src/record.ts`): drives Chrome with the built extension over CDP (the profile
   e2e harness of `apps/extension`), records each scenario with **Maximum** (the default profile,
   Full engine) and with **Light**, and exports encrypted archives into `evals/archives/` (git-ignored).
4. **Rubric** (`src/rubric.ts`): per scenario, the real root cause, its key evidence, required
   facts (each a set of regexes, any one matches), bonus facts and forbidden wrong conclusions.
5. **Evaluation** (`src/run-eval.ts`): for each archive, `claude -p` with **only** our MCP server
   (`--strict-mcp-config`, no built-in tools, user/project settings ignored, MCP limited to
   `--allow-dir evals/archives`) gets the report, the archive path and the passphrase, and ends
   with a JSON answer (`rootCause`, `evidence`, `missingData`, `confidence`), always in English
   because the rubric patterns are English (the report itself may be Russian). The answer is scored
   deterministically; an LLM judge (`--judge`, prompt in `prompts/judge.md`) is asked only when
   some but not all required facts matched.
6. **Report** (`reports/<date>-<label>.md|json`): pass/fail and score per scenario and profile,
   the tools used, tokens, cost and time, totals per profile, which evidence each archive held,
   and for every failed analysis what was missing.

It is not a CI gate: it needs a model, a browser and a few minutes. The unit tests (rubric,
scenario integrity, fixture server, report) run in CI as part of `pnpm test`.

## Running it

```bash
pnpm install
pnpm build                                     # extension .output/chrome-mv3/ (WXT) and mcp-server dist/

# 1. Record (≈ 18 s per scenario and profile, ≈ 10 min for all 26)
export WB_E2E_CHROME_BIN=$HOME/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
timeout 1800 pnpm --filter @webblackbox/evals record
#   --scenario case-03 --scenario search-race   only these (id or case id)
#   --profile maximum | light                   only this profile
#   --passphrase …                               default "webblackbox-bug-zoo-eval" (WB_EVAL_PASSPHRASE)

# 2. Evaluate (needs the `claude` CLI, logged in)
timeout 3600 pnpm --filter @webblackbox/evals eval --label baseline
#   --model sonnet | opus | haiku | <full model id>   default sonnet (WB_EVAL_MODEL)
#   --lang ru | en                                    report language, default ru
#   --judge [--judge-model <model>]                   LLM judge for partial matches
#   --concurrency 2  --timeout-ms 900000  --max-budget-usd 3   per agent run
#   --bare                                            claude --bare (needs ANTHROPIC_API_KEY)
#   --report-dir <dir>                                default evals/reports

# Look at the site by hand
pnpm --filter @webblackbox/evals site            # prints the URL (WB_EVAL_SITE_PORT=4300 to fix it)
```

The recorder writes `evals/archives/manifest.json` (which archive is which scenario and profile,
whether the symptom reproduced, the passphrase). It exits non-zero when a recording failed or the
bug did not reproduce. Raw agent transcripts (stream-json) go to `evals/runs/` (git-ignored).

Commit the report (`reports/*.md` and `*.json`), never the archives. Run
`pnpm exec prettier --write evals/reports/*.md` first (CI checks Markdown formatting; the JSON is
exempt). A hand-written findings section at the end of the Markdown is worth keeping: `--rescore`
rewrites the file, so copy it back.

After a rubric fix, `eval --rescore evals/reports/<report>.json` scores the stored answers again
without running any agent.

## Cost and time

See the header and totals of the latest report in `reports/`. On the baseline (Sonnet) one
archive took 15–90 s and 40–200k tokens (mostly cached input), about $0.10–0.40; all 26 runs
cost a few dollars. `--max-budget-usd` caps each run. Results differ between models and between
runs of the same model: compare reports made with the same model, and re-run a scenario that
flips before reading much into it. The report header records the model.

The `2026-10-12-baseline` report predates the Maximum and Light profiles: it compares the old
`default` (Lite) and `full-capture` setups, so its totals do not line up with later runs. Clear
`evals/archives/` (or pick profiles with `--profile`) before re-recording, or the manifest keeps
the old archives next to the new ones.

## Adding a scenario

1. Add a `Scenario` to one of `src/scenarios/*.ts` (or a new file) and list it in
   `src/scenarios/index.ts`. Give it the next `caseId` (`case-14`, …).
2. Pages (`pages`), scripts and API handlers live in the scenario; routes must be unique across
   scenarios and must not name the bug (product-like paths: `/checkout/…`, `/api/…`). Never use
   `alert()`/`confirm()`/`prompt()` — a dialog blocks every CDP command on the page.
3. `steps` reproduce the bug as a tester would (`navigate`, `click` at the element's centre,
   `type`, `wait`, `waitFor`); `setup` runs before the recording starts (state the tester already
   had, e.g. localStorage). `symptom` is a page expression that is true once the bug is visible —
   the recorder checks it.
4. Write the tester report in Russian and English: the symptom only, no cause, no status codes.
5. Write the rubric: `rootCause` and `keyEvidence` in plain words; `required` facts that every
   correct analysis states (keep patterns broad enough for different wording); `bonus` facts;
   `forbidden` wrong conclusions (checked in the stated root cause only). List the `evidence`
   kinds the analysis needs.
6. `pnpm --filter @webblackbox/evals test` checks that the reference cause passes its own rubric,
   an unrelated answer fails it, and nothing leaks the cause. Then record and evaluate just the
   new case: `record --scenario case-14`, `eval --scenario case-14 --label case-14`.
