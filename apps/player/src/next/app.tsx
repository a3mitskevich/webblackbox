import { useRef } from "react";

import {
  ArchiveStatusLine,
  DropOverlay,
  EmptyState,
  PassphraseDialog
} from "./components/open-archive.js";
import { Header } from "./components/header.js";
import { Rail } from "./components/rail.js";
import { ShortcutsDialog } from "./components/shortcuts-dialog.js";
import { Stage } from "./components/stage.js";
import { Timeline } from "./components/timeline.js";
import { Transport } from "./components/transport.js";
import { PlayerProvider, useI18n, usePlayerState } from "./context.js";
import type { PlayerController } from "./controller.js";
import {
  useArchiveDropTarget,
  useHashSync,
  useKeyboardShortcuts,
  useThemeAttribute
} from "./hooks.js";

function LiveRegion() {
  const announcement = usePlayerState((state) => state.announcement);

  return (
    <div className="visually-hidden" aria-live="polite" role="status" data-testid="live-region">
      {announcement}
    </div>
  );
}

function Layout() {
  const i18n = useI18n();
  const searchRef = useRef<HTMLInputElement>(null);
  const hasArchive = usePlayerState((state) => state.archive !== null);

  useKeyboardShortcuts(searchRef);
  useHashSync();
  useThemeAttribute();
  useArchiveDropTarget();

  return (
    <div className="app" data-testid="player-next">
      <Header searchRef={searchRef} />
      {hasArchive ? (
        <main className="body">
          <section className="stage-col" aria-label={i18n.tn("stageLabel")}>
            <ArchiveStatusLine />
            <Stage />
            <Transport />
            <Timeline />
          </section>
          <Rail />
        </main>
      ) : (
        <main className="body body-empty">
          <EmptyState />
        </main>
      )}
      <DropOverlay />
      <PassphraseDialog />
      <ShortcutsDialog />
      <LiveRegion />
    </div>
  );
}

type AppProps = {
  controller: PlayerController;
};

export function App({ controller }: AppProps) {
  return (
    <PlayerProvider controller={controller}>
      <Layout />
    </PlayerProvider>
  );
}
