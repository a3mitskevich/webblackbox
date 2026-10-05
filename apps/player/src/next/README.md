# React player (`?ui=next`)

The Player rewrite in React (stages R1–R5, one MR). It mounts when the page URL has `?ui=next`;
the classic UI (`src/main.ts`) stays the default until R5. This file is the map for the stages
that build features in parallel (R2, R3, R4): **each stage works inside its own feature folder**
and touches shared files only with small, additive edits.

## Layout

| Path                                  | What lives there                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `index.tsx`                           | `mountNextPlayer`: store, controller, `createRoot`, the stylesheet import                  |
| `app.tsx`                             | App shell: header, stage column, rail, dialogs; `CSPProvider`, tooltip provider, splitters |
| `state.ts`, `store.ts`, `context.tsx` | The one external store (`useSyncExternalStore`), `usePlayerState`, `useI18n`               |
| `controller.ts`                       | Everything that is not rendering: open/decrypt, playback clock, seeking, selection         |
| `hooks.ts`                            | Keyboard map (react-hotkeys-hook), URL hash sync, theme, drop target, `useMediaQuery`      |
| `layout.ts`                           | Splitter defaults and persisted sizes                                                      |
| `components/`                         | Shared UI: header, stage, transport, timeline, rail, and the building blocks below         |
| `features/<feature>/`                 | One folder per feature, owned by one stage (see below)                                     |
| `styles/next.css`                     | The hand-written token sheet (Replay mockups), self-hosted Onest and JetBrains Mono        |

Non-UI logic shared with the classic player lives in `src/core/*` and `src/lib/*`. Archive data
comes only from `@webblackbox/player-sdk`; new derived data belongs in the SDK, with tests.

## Build

Vite 8 (`vite.config.ts`). `pnpm --filter @webblackbox/player dev` starts the dev server with HMR
(open `http://localhost:4177/?ui=next`); `build` writes `build/`. The React player is its own
chunk, loaded only for `?ui=next`, with its CSS as a file. A feature can split further:

```tsx
// features/compare/index.ts — the panel and its libraries (jsdiff, microdiff) load on first use
const ComparePanel = lazy(() => import("./compare-panel.js"));
```

A feature's stylesheet is imported by the feature (`import "./network.css";`) and ships with the
feature's chunk. Use the tokens of `styles/next.css` (`--surface`, `--ink-2`, `--bad`, `--ws`, …).
Tailwind is not part of the build (see the stage V summary on PR #20).

## Building blocks (use these, do not hand-roll)

| Need                                         | Use                                                                 | Notes                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Long list or table                           | `components/virtual-list.tsx` (`@tanstack/react-virtual`)           | `measureElement` for variable rows                                                                           |
| Dialog                                       | `components/modal-dialog.tsx` (Base UI `Dialog`)                    | Name it with `<DialogTitle>`; focus returns to the opener                                                    |
| Tooltip                                      | `components/hint.tsx` (Base UI `Tooltip`)                           | Instead of `title` on icon buttons                                                                           |
| Tabs, menus, popovers, toasts, toggle groups | `@base-ui/react/*`                                                  | The app root has `CSPProvider disableStyleElements`                                                          |
| Icon                                         | `components/icon.tsx` (`lucide-react`)                              | Add a name to `ICONS`; features ask for the player's names                                                   |
| Splitter                                     | `components/split-layout.tsx` (`react-resizable-panels`)            | `ListDetailsSplit name="network"` persists per name (`detailsPercent` sets the default); `F` widens the rail |
| A panel that can fail or load lazily         | `components/panel-boundary.tsx` (`react-error-boundary` + Suspense) | Rail tab panels already run inside one                                                                       |
| Keyboard                                     | `core/keymap.ts` + `hooks.ts` (`react-hotkeys-hook`)                | Physical keys (work on a Russian layout)                                                                     |
| Highlighted code, JSON tree, hex dump        | `features/network/{code-view,viewers}.tsx`                          | Shiki (JS regex engine) loads as its own chunk; R5 may move them to components                               |

Other libraries are vetted in `LIBRARIES.md` (Shiki with the JavaScript regex engine, uPlot,
jsdiff, microdiff, uFuzzy, TanStack Table). Never inject `<style>` (no runtime CSS-in-JS), never
`eval`/`new Function`/WebAssembly, no `innerHTML`/`dangerouslySetInnerHTML`.

## Extension points

### 1. Feature folders

| Folder                | Owner | Contents                                                                                   |
| --------------------- | ----- | ------------------------------------------------------------------------------------------ |
| `features/feed/`      | R2    | Activity feed (action → consequences), problems strip. Today: R1's Activity list + details |
| `features/network/`   | R3    | Network table and details, WebSocket / SSE (`network` and `realtime` tabs)                 |
| `features/console/`   | R4    | Console with symbolicated stacks                                                           |
| `features/storage/`   | R4    | Storage                                                                                    |
| `features/tabs/`      | R4    | Parallel tabs                                                                              |
| `features/perf/`      | R4    | Perf charts                                                                                |
| `features/compare/`   | R4    | Compare + regressions (lazy)                                                               |
| `features/share/`     | R4    | Share links                                                                                |
| `features/inspector/` | R5    | Event inspector                                                                            |
| `features/generate/`  | R5    | Playwright / bug report / HAR / GitHub / Jira (lazy)                                       |

Each folder has an `index.ts` that exports its `PlayerFeature`. All ten are already listed in
`features/registry.ts`, so a stage never edits the registry.

### 2. Rail tabs

A feature registers its tabs in its `index.ts`:

```ts
export const networkFeature: PlayerFeature = {
  id: "network",
  messages: networkMessages,
  railTabs: [
    {
      id: "network", // a RAIL_TABS id: its position, URL hash value and digit key
      label: (locale) => networkMessages.translate(locale, "networkTab"),
      count: (archive, query) => archive.model.waterfall.length, // memoized per archive + filter
      isAlert: (count) => count > 0, // optional: red count
      Panel: NetworkPanel // rendered inside an error boundary and Suspense
    }
  ]
};
```

Until a stage lands, its tabs show `placeholderPanel(...)` ("arrives in a later stage"). A new
tab id is the only shared edit: add it to `RAIL_TABS` (`src/core/url-hash.ts`) — the registry
test checks that every id there is registered exactly once.

### 3. Strings (EN / RU / 中文)

Each feature keeps its own dictionaries in `features/<feature>/locales/{en,ru,zh-CN}.json` and
declares them in `messages.ts`:

```ts
import EN from "./locales/en.json" with { type: "json" };
import RU from "./locales/ru.json" with { type: "json" };
import ZH_CN from "./locales/zh-CN.json" with { type: "json" };

export const networkMessages = defineFeatureMessages<keyof typeof EN>("network", {
  en: EN,
  ru: RU,
  "zh-CN": ZH_CN
});
```

In components: `const t = useFeatureI18n(networkMessages); t("bodyNotCaptured", { size })`.
Keys are typed from the English file; switching the language re-renders in place (no reload).
All feature dictionaries are merged into one catalog at startup (`FEATURE_CATALOG`; it is the
startup check that no two features claim the same namespace, components read their own
dictionary through `useFeatureI18n`), and
`src/lib/locales.test.ts` checks every feature: same keys in all three files, same `{placeholders}`,
no empty strings. Shared player strings (`useI18n().tn(...)`) stay in `src/lib/locales/*.json`
(the `next` section); add there only what several features use.

### 4. Store slices

Feature state lives in the one store, next to the playhead and selection, under
`PlayerState.slices`. A feature declares its slice type by module augmentation (no shared edit):

```ts
// features/network/slice.ts
import { defineFeatureSlice } from "../slice.js";

export type NetworkSlice = { sort: "start" | "duration"; hideThirdParty: boolean };

declare module "../../state.js" {
  interface FeatureSlices {
    network: NetworkSlice;
  }
}

export const networkSlice = defineFeatureSlice("network", { sort: "start", hideThirdParty: true });
```

Read with `useFeatureSlice(networkSlice, (slice) => slice.sort)` (re-renders only when that part
changes) and write with `useFeatureSliceUpdate(networkSlice)((slice) => ({ ...slice, sort }))`
— always a new object. Outside React: `networkSlice.select(state)` / `networkSlice.update(store, fn)`.
Slices survive opening another archive; reset what must not.

### 5. e2e scenarios

`e2e:player-next` runs the shell scenarios (`scripts/e2e-next/shell.mjs`), then every
`features/<feature>/<feature>.e2e.mjs`, then a pass under a CSP without `style-src
'unsafe-inline'`. A scenario file:

```js
export default {
  feature: "network",
  scenarios: [
    {
      name: "select a request and see its body",
      async run(ctx) {
        await ctx.openSynthetic({ hash: "#tab=network" }); // fresh page, synthetic archive open
        await ctx.click("request-row");
        await ctx.waitForSelector(ctx.testId("response-body"), "No body");
        return { ok: true }; // a small JSON result for the log
      }
    }
  ]
};
```

The context (`createScenarioContext` in `scripts/lib/next-e2e.mjs`) has `client` (CDP),
`openSynthetic`, `snapshot`, `waitForSnapshot`, `waitForSelector`, `press` (physical keys),
`click`, `hover`, `dragBy`, `evaluate`, `setViewport`, `testId`, `assert` and `sleep`. Drive the UI
only through `data-testid` hooks; check archive data correctness in player-sdk tests, not here.
`openSynthetic` serves every scenario page under the strict style policy (no `style-src
'unsafe-inline'`), so a panel that injects a `<style>` fails the run.
`WB_E2E_NEXT_FEATURES=network pnpm --filter @webblackbox/player e2e:player-next` runs only
your feature's scenarios (the shell scenarios and the CSP passes always run); a name without a
scenario file, or no scenario files at all, fails the run.

## Shared files: allowed edits

Small and additive only, so parallel merges resolve trivially: a new id in `RAIL_TABS`, a binding
in `core/keymap.ts`, a shared string in `src/lib/locales/*.json`, your rows in `PARITY.md`, your
dependencies in `package.json` (and the lockfile), a budget note in `bundle-size/budgets.json`.
Anything else in `components/`, `app.tsx`, `state.ts` or `controller.ts` — coordinate first.
