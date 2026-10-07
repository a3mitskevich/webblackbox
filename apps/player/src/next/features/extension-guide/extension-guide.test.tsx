/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMediaUrlCache } from "../../../core/media-cache.js";
import type { PlayerLocale } from "../../../lib/i18n.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";

const METADATA = {
  version: "0.7.0",
  file: "webblackbox-chrome.zip",
  size: 1536,
  sha256: "a".repeat(64),
  builtAt: "2026-10-07T12:00:00.000Z"
};

function renderPlayer(locale: PlayerLocale = "en") {
  const store = createStore<PlayerState>(createInitialState(locale, "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  return { store, controller };
}

function stubMetadataFetch(ok: boolean, body: unknown = METADATA): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("not found", { status: 404 })
    )
  );
}

async function openGuideFromEmptyState() {
  fireEvent.click(screen.getByTestId("empty-extension-guide"));
  return await screen.findByTestId("extension-guide");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("extension guide", () => {
  it("renders without an archive, from the empty state", async () => {
    stubMetadataFetch(false);
    renderPlayer();

    const dialog = await openGuideFromEmptyState();

    expect(within(dialog).getByRole("heading", { name: "WebBlackbox extension" })).toBeVisible();
    for (const section of [
      "Download",
      "Install in Chrome",
      "Update",
      "Connect to this Player",
      "Record and share",
      "Troubleshooting"
    ]) {
      expect(within(dialog).getByRole("heading", { name: section })).toBeVisible();
    }
    // The start screen stays behind the dialog; no archive was needed.
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("opens from the header menu too", async () => {
    stubMetadataFetch(false);
    renderPlayer();

    fireEvent.click(screen.getByTestId("player-menu"));
    fireEvent.click(await screen.findByTestId("menu-extension-guide"));

    expect(await screen.findByTestId("extension-guide")).toBeVisible();
  });

  it("offers the download with version, size and SHA-256 from the metadata", async () => {
    stubMetadataFetch(true);
    renderPlayer();

    const dialog = await openGuideFromEmptyState();

    const link = await within(dialog).findByTestId("extension-download-link");
    expect(link).toHaveAttribute("href", "extension/webblackbox-chrome.zip");
    expect(link).toHaveAttribute("download", "webblackbox-chrome.zip");
    expect(within(dialog).getByTestId("extension-version")).toHaveTextContent(
      "Version 0.7.0 · 1.5 KB"
    );
    expect(within(dialog).getByTestId("extension-sha256")).toHaveTextContent(METADATA.sha256);
    expect(within(dialog).queryByTestId("extension-download-missing")).not.toBeInTheDocument();
  });

  it("explains instead of linking when the build has no extension metadata", async () => {
    stubMetadataFetch(false);
    renderPlayer();

    const dialog = await openGuideFromEmptyState();

    expect(await within(dialog).findByTestId("extension-download-missing")).toHaveTextContent(
      "This Player build does not bundle the extension."
    );
    expect(within(dialog).queryByTestId("extension-download-link")).not.toBeInTheDocument();
  });

  it("treats malformed metadata as missing", async () => {
    stubMetadataFetch(true, { version: "0.7.0", file: "../../evil.zip", size: -1 });
    renderPlayer();

    const dialog = await openGuideFromEmptyState();

    expect(await within(dialog).findByTestId("extension-download-missing")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("extension-download-link")).not.toBeInTheDocument();
  });

  it("copies this Player's URL for the extension's Player URL option", async () => {
    stubMetadataFetch(false);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPlayer();

    const dialog = await openGuideFromEmptyState();

    expect(within(dialog).getByTestId("player-url")).toHaveTextContent(
      `${window.location.origin}${window.location.pathname}`
    );
    fireEvent.click(within(dialog).getByTestId("player-url-copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}${window.location.pathname}`
      );
    });
    expect(within(dialog).getByTestId("player-url-copy-status")).toHaveTextContent("Copied");
  });

  it("switches the guide's language live", async () => {
    stubMetadataFetch(false);
    renderPlayer();

    const dialog = await openGuideFromEmptyState();
    fireEvent.click(screen.getByTestId("locale-ru"));

    expect(within(dialog).getByRole("heading", { name: "Расширение WebBlackbox" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Скачивание" })).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Запись и отправка" })).toBeVisible();
  });

  it("closes from its button and with Esc", async () => {
    stubMetadataFetch(false);
    renderPlayer();

    const dialog = await openGuideFromEmptyState();
    fireEvent.click(within(dialog).getByTestId("extension-guide-close"));

    expect(screen.queryByTestId("extension-guide")).not.toBeInTheDocument();
  });
});
