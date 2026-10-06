# Bundle-size gate

`pnpm bundle:size` (`scripts/check-bundle-size.mjs`) checks the built bundles after `pnpm build`.
`bundle-size/budgets.json` holds two kinds of checks.

## Absolute budgets: page bundles

Strict limits for the bundles that run inside recorded pages. These cost every tested page on every
navigation and in every frame:

| Bundle                                  | Where it runs                                    |
| --------------------------------------- | ------------------------------------------------ |
| `apps/extension/build/injected.js`      | MAIN world of the recorded page                  |
| `apps/extension/build/content.js`       | Every recorded frame (isolated world)            |
| `apps/extension/build/content-agent.js` | Imported by `content.js` in every recorded frame |

Each entry has `maxBytes` and `maxGzipBytes`, measured on the minified build. It also has
`forbidSources`, which lists path fragments that must not appear in the bundle's sourcemap
`sources`. Today the only fragment is `node_modules/zod/`. The protocol schemas pull in Zod, which
is ~300 KB minified and used to be 87% of `injected.js`.

If one of these bundles has to grow past its budget, raise the number in `budgets.json` in the same
PR and say why in the entry's `note`. Changes here are expected to be rare and deliberate.

## Delta check: everything else

Service worker, offscreen document, extension pages, the Player and the library `dist/` files are
compared with the **base branch** instead of fixed numbers. Parallel PRs therefore no longer
conflict on `budgets.json`.

- A tracked bundle fails when its raw size grows by more than `maxGrowthPercent` (8%) **and** more
  than `minGrowthBytes` (2 KB) compared to the base.
- Growth you intend is accepted when the PR explains it with a line in a commit message or in the
  PR body:

  ```text
  size-increase: sw.js typed offscreen protocol and its validators
  ```

  The target is the bundle's file name, its full path (`apps/extension/build/sw.js`) or `*` for
  all tracked bundles, followed by the reason. CI reads the PR body when the job runs. After you
  edit it, re-run the job.

- The baseline is the `bundle-size-report` artifact uploaded by CI on `main`. The PR job takes the
  one from the base commit's run, or else the newest `main` run that has one. With no baseline (a
  stacked PR whose base is not `main`, or expired artifacts), only the absolute budgets are checked
  and the job says so.

To add a bundle to the delta check, append its path to `delta.entries`.

## Running locally

```bash
pnpm build
pnpm bundle:size                                   # absolute budgets only
node scripts/check-bundle-size.mjs --baseline main-report.json --notes-file notes.txt
```

To get a baseline, run `pnpm build && pnpm bundle:size` on `main` and copy
`bundle-size/latest-report.json`. Each run writes that report. The pure logic lives in
`scripts/lib/bundle-size.mjs` and has tests: run `pnpm test:scripts`.
