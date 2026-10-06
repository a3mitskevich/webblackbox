# Contributing to WebBlackbox

This guide is for working on the monorepo itself: building apps locally, running tests, and making changes across the extension, Player, SDKs, and release tooling.

## Prerequisites

- Node.js `>= 22.0.0` (`.nvmrc` pins 22, the version CI uses)
- pnpm `10.28.1` (the `packageManager` field in `package.json`)

## Setup

This is the fork `a3mitskevich/webblackbox` of upstream `webllm/webblackbox`.

```bash
git clone https://github.com/a3mitskevich/webblackbox.git
cd webblackbox
git remote add upstream https://github.com/webllm/webblackbox.git
pnpm install
pnpm build
```

For watch mode across the workspace:

```bash
pnpm dev
```

## Workspace Layout

```text
webblackbox/
├── apps/
│   ├── extension/      # Chrome extension (MV3, tsup)
│   ├── player/         # Hosted archive player (React, Vite)
│   ├── mcp-server/     # MCP server CLI
│   └── share-server/   # Optional sharing backend
├── packages/
│   ├── protocol/       # Shared schema and defaults
│   ├── recorder/       # Event normalization and ring buffer
│   ├── pipeline/       # Chunking, storage, export
│   ├── webblackbox/    # Browser lite capture SDK
│   ├── player-sdk/     # Archive loading and analysis APIs
│   └── cdp-router/     # Chrome DevTools Protocol routing
├── benchmarks/         # bench:ci thresholds and last report
├── bundle-size/        # Bundle-size budgets
├── config/
│   └── typescript/     # Shared TypeScript config
├── scripts/            # Repo scripts (bench and bundle-size gates, workspace checks)
└── docs/               # Architecture, performance, generated API docs
```

## Common Commands

| Command              | What it does                                                           |
| -------------------- | ---------------------------------------------------------------------- |
| `pnpm build`         | Build the whole workspace                                              |
| `pnpm dev`           | Run workspace watch tasks                                              |
| `pnpm test`          | Run workspace tests (Vitest)                                           |
| `pnpm test:scripts`  | Run the `node --test` tests of `scripts/lib`                           |
| `pnpm lint`          | Run ESLint across packages, plus `scripts/`, `config/` and path checks |
| `pnpm typecheck`     | Run TypeScript checks                                                  |
| `pnpm format`        | Format the repo with Prettier                                          |
| `pnpm format:check`  | Verify formatting                                                      |
| `pnpm coverage:core` | Coverage gates for recorder, pipeline, player-sdk and `webblackbox`    |
| `pnpm bench`         | Run the recorder, pipeline and Player benchmarks                       |
| `pnpm bench:ci`      | Benchmark regression gate (see [Performance](docs/PERFORMANCE.md))     |
| `pnpm bundle:size`   | Check built bundles after `pnpm build` (see `bundle-size/README.md`)   |
| `pnpm player`        | Build the Player and serve it on port 4177                             |
| `pnpm commit`        | Write a Conventional Commit message with Commitizen                    |

Use `pnpm --filter <package-name> <script>` for package-specific work.

Examples:

```bash
pnpm --filter @webblackbox/extension build
pnpm --filter @webblackbox/player test
pnpm --filter @webblackbox/mcp-server build
pnpm --filter webblackbox typecheck
```

## Working on the Chrome Extension

Build once:

```bash
pnpm --filter @webblackbox/extension build
```

Watch during development:

```bash
pnpm --filter @webblackbox/extension dev
```

Then load `apps/extension/build` in `chrome://extensions/` with `Developer mode` enabled. The build bundles one tsup entry per extension context (`apps/extension/tsup.config.ts`) and generates `manifest.json` in code (`apps/extension/scripts/lib/extension-build.mjs`); there is no static manifest file.

Useful extension commands:

```bash
pnpm --filter @webblackbox/extension verify          # lint, typecheck, test, package:chrome
pnpm --filter @webblackbox/extension e2e:check
pnpm --filter @webblackbox/extension e2e:fullchain:lite
pnpm --filter @webblackbox/extension e2e:fullchain:full
pnpm --filter @webblackbox/extension e2e:perf:lite
pnpm --filter @webblackbox/extension package:chrome  # zip in apps/extension/dist
```

The `e2e:*` scripts are Node scripts that drive a real Chrome over CDP against `apps/extension/build`, so build first. They need a Chrome binary: set `WB_E2E_CHROME_BIN` (the built-in fallbacks are macOS and `/usr/bin` paths). They run headless by default; `WB_E2E_HEADLESS=0` shows the window. `apps/extension/package.json` lists the rest (Full completeness, CDP tab isolation, injection modes, service worker restart, tabs context, at-rest encryption, UI screenshots, memory).

UI strings of the extension pages live in per-feature fragments,
`apps/extension/src/shared/locales/<feature>.<locale>.json`, one per locale (`en`, `ru`, `zh-CN`).
A new feature adds its own three files instead of editing a shared dictionary. `build`, `dev`,
`test` and `typecheck` merge the fragments into the git-ignored `locales/generated/`; a key defined
by two features fails the merge, and `locales.test.ts` checks that every locale has every key.
Run `node apps/extension/scripts/generate-locales.mjs` if your editor reports a missing
`locales/generated/*.json` before the first build.

## Working on the Player

```bash
pnpm --filter @webblackbox/player dev     # Vite dev server with HMR
pnpm --filter @webblackbox/player build   # vite build → apps/player/build
pnpm --filter @webblackbox/player serve   # serve the build on port 4177
pnpm --filter @webblackbox/player e2e:player  # build + Chrome e2e (set WB_E2E_CHROME_BIN)
```

GitHub Pages helpers:

```bash
pnpm player:pages:build
pnpm player:pages:deploy
```

## Working on the MCP Server

```bash
pnpm --filter @webblackbox/mcp-server build
pnpm --filter @webblackbox/mcp-server test
pnpm --filter @webblackbox/mcp-server inspect
```

CLI smoke checks:

```bash
pnpm --filter @webblackbox/mcp-server exec node dist/cli.js --help
pnpm --filter @webblackbox/mcp-server exec node dist/cli.js --version
```

## Testing and Quality

Pre-commit hooks (husky + lint-staged) run:

- Prettier on staged files
- ESLint `--fix` on staged JS/TS files

Common targeted checks:

```bash
pnpm --filter @webblackbox/pipeline test
pnpm --filter @webblackbox/player-sdk test
pnpm --filter @webblackbox/recorder test
pnpm --filter @webblackbox/pipeline exec vitest run src/privacy.test.ts   # one file
pnpm docs:api
```

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`:

- `verify` job: `format:check`, `lint`, `typecheck`, `test`, `test:scripts`, `bench:ci`, `build`, then the bundle-size gate (absolute budgets for the page bundles, plus a delta check against the size report of the base branch's CI run; explain intended growth with a `size-increase: <bundle> <reason>` line in the PR body or a commit message).
- `product-matrix` job, one gate per surface: `coverage:core` (recorder, pipeline and player-sdk at 80% lines / 65% branches, stricter floors on `redaction.ts` and `privacy.ts`; `webblackbox` at 65% / 55%), `share-server e2e:share`, `player e2e:player`, `player-sdk test:pressure`, and the extension gates `e2e:realworld:ci`, `e2e:perf:lite:ci`, `e2e:isolation:full`, `e2e:fullchain:full`, `e2e:full:reload`, `e2e:completeness:full`, `e2e:completeness:full:reload`, `e2e:memory:full:ci`, `e2e:injection` + `e2e:fullchain:lite:on-demand`, `e2e:tabs-context` and `e2e:ui`.

## Commits and Pull Requests

- Commit messages follow Conventional Commits with a scope, e.g. `fix(extension): ...`, `feat(player): ...`.
- Open pull requests against the fork: repository `a3mitskevich/webblackbox`, base branch `main`. `gh` may default to upstream in this checkout, so pass the repository explicitly, e.g. `gh pr create --repo a3mitskevich/webblackbox --base main`.
- Write the PR title and description in English.

## Versioning and Releases

Changesets is configured (`.changeset/config.json`, `pnpm changeset`, `pnpm version-packages`), but in practice no changeset files are committed: package versions are bumped by hand, in lockstep, in a `chore(version): update version to X.Y.Z` commit. Don't add changesets unless asked.

Notes:

- The extension manifest is generated at build time with the version from `apps/extension/package.json`, so there is nothing to sync.
- This fork publishes no releases, so the two release workflows below are inherited from upstream and are not used here; they are described for completeness.
- Publishing a GitHub release runs `.github/workflows/release.yml`: lint, typecheck, test and build, then `pnpm release` (`changeset publish`) publishes the npm packages with npm trusted publishing.
- `.github/workflows/release-assets.yml` uploads the Chrome extension ZIP to the release and deploys the Player to GitHub Pages (see [apps/player/README.md](apps/player/README.md) for the `--site-url` caveat).

## Architecture Touchpoints

If you change a cross-cutting behavior, update all affected layers:

- New event type:
  Update `packages/protocol`, then `packages/recorder`, `packages/pipeline`, `packages/player-sdk`, and any app UI or MCP tools that expose it.
- Archive format:
  Update protocol schemas, pipeline export/import behavior, Player SDK loading, and backward-compatibility coverage.
- Extension capture behavior:
  Check `apps/extension`, `packages/webblackbox`, and the perf/fullchain scripts together.

## Reference Docs

- [Root README](README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Performance](docs/PERFORMANCE.md)
- [Extension Guide](apps/extension/README.md)
- [Player Guide](apps/player/README.md)
