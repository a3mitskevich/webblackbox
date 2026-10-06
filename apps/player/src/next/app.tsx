import { CSPProvider } from "@base-ui/react/csp-provider";
import { useRef } from "react";

import { ArchiveInfoDialog, ProfileBanners } from "./components/archive-info.js";
import { HintProvider } from "./components/hint.js";
import {
  ArchiveStatusLine,
  DropOverlay,
  EmptyState,
  PassphraseDialog
} from "./components/open-archive.js";
import { Header } from "./components/header.js";
import { PanelBoundary } from "./components/panel-boundary.js";
import { Rail } from "./components/rail.js";
import { ShortcutsDialog } from "./components/shortcuts-dialog.js";
import { BodySplit } from "./components/split-layout.js";
import { Stage } from "./components/stage.js";
import { Timeline } from "./components/timeline.js";
import { ToastHost } from "./components/toasts.js";
import { Transport } from "./components/transport.js";
import { PlayerProvider, useI18n, usePlayerState } from "./context.js";
import { ProblemsStrip } from "./features/feed/index.js";
import { GenerateDialogs } from "./features/generate/index.js";
import type { PlayerController } from "./controller.js";
import {
  useArchiveDropTarget,
  useHashSync,
  useKeyboardShortcuts,
  useMediaQuery,
  useThemeAttribute
} from "./hooks.js";
import { WIDE_LAYOUT_QUERY } from "./layout.js";

/** Tooltips open after this hover delay; moving along a toolbar shows the next one at once. */
const HINT_DELAY_MS = 500;

function LiveRegion() {
  const announcement = usePlayerState((state) => state.announcement);

  return (
    <div className="visually-hidden" aria-live="polite" role="status" data-testid="live-region">
      {announcement}
    </div>
  );
}

function StageColumn() {
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);

  return (
    <section className="stage-col" aria-label={i18n.tn("stageLabel")}>
      <PanelBoundary resetKeys={[archive]}>
        <ProfileBanners />
      </PanelBoundary>
      <PanelBoundary resetKeys={[archive]}>
        <ProblemsStrip />
      </PanelBoundary>
      <ArchiveStatusLine />
      <PanelBoundary resetKeys={[archive]}>
        <Stage />
      </PanelBoundary>
      <Transport />
      <PanelBoundary resetKeys={[archive]}>
        <Timeline />
      </PanelBoundary>
    </section>
  );
}

/**
 * Stage and rail: side by side with a splitter on wide screens, one column below 900 px. One tree
 * for both, so crossing the breakpoint (a resize, a rotation) never remounts the stage or the rail.
 */
function Workspace() {
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const railWide = usePlayerState((state) => state.railWide);
  const layout = wide ? "body body-split" : "body body-stacked";

  return (
    <main className={railWide ? `${layout} body-rail-wide` : layout} data-testid="workspace">
      <BodySplit stacked={!wide} stage={<StageColumn />} rail={<Rail />} />
    </main>
  );
}

function Layout() {
  const searchRef = useRef<HTMLInputElement>(null);
  const hasArchive = usePlayerState((state) => state.archive !== null);

  useKeyboardShortcuts(searchRef);
  useHashSync();
  useThemeAttribute();
  useArchiveDropTarget();

  return (
    <div className="app" data-testid="player">
      <Header searchRef={searchRef} />
      {hasArchive ? (
        <Workspace />
      ) : (
        <main className="body body-empty">
          <EmptyState />
        </main>
      )}
      <DropOverlay />
      <PassphraseDialog />
      <ShortcutsDialog />
      <ArchiveInfoDialog />
      <GenerateDialogs />
      <ToastHost />
      <LiveRegion />
    </div>
  );
}

type AppProps = {
  controller: PlayerController;
};

/**
 * The React player. `CSPProvider disableStyleElements` keeps Base UI from rendering any `<style>`
 * element, so the UI works under a `style-src` without 'unsafe-inline' (e2e CSP guard).
 */
export function App({ controller }: AppProps) {
  return (
    <CSPProvider disableStyleElements>
      <PlayerProvider controller={controller}>
        <HintProvider delay={HINT_DELAY_MS}>
          <Layout />
        </HintProvider>
      </PlayerProvider>
    </CSPProvider>
  );
}
