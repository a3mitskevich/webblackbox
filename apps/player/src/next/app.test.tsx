/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../core/media-cache.js";
import { App } from "./app.js";
import { createPlayerController } from "./controller.js";
import { createInitialState, type PlayerState } from "./state.js";
import { createStore } from "./store.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.location.hash = "";
});

function renderPlayer() {
  const store = createStore<PlayerState>(createInitialState("en", "system"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  return { store, controller };
}

async function openArchive(controller: ReturnType<typeof renderPlayer>["controller"]) {
  await act(async () => {
    await controller.openFile({
      name: "synthetic.webblackbox",
      arrayBuffer: async () => archiveBytes.slice().buffer
    });
  });
}

/** The physical key (`event.code`) a US layout produces `key` with; the keymap matches codes. */
function codeOf(key: string): string {
  if (/^[a-z]$/i.test(key)) {
    return `Key${key.toUpperCase()}`;
  }

  if (/^[0-9]$/.test(key)) {
    return `Digit${key}`;
  }

  return { "/": "Slash", "?": "Slash", ",": "Comma", ".": "Period", " ": "Space" }[key] ?? key;
}

/** A key press on the focused element, as the browser sends it (key + code + Shift for `?`). */
function key(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key,
      code: codeOf(key),
      shiftKey: key === "?" || (key.length === 1 && key !== key.toLowerCase()),
      ...init
    });
  });
}

describe("React player", () => {
  it("starts on the empty state with one main landmark", () => {
    renderPlayer();

    expect(screen.getByRole("heading", { name: "Open a recording" })).toBeInTheDocument();
    expect(screen.getByTestId("archive-input")).toHaveAttribute("accept", ".webblackbox,.zip");
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("renders the header, stage, timeline and rail for a loaded archive", async () => {
    const { controller } = renderPlayer();
    await openArchive(controller);

    expect(screen.getByTestId("session")).toHaveTextContent("app.example.test");
    expect(screen.getByTestId("encryption-chip")).toHaveTextContent("Not encrypted");
    expect(screen.getByTestId("other-tabs-chip")).toHaveTextContent("Other tabs open: 2");
    expect(screen.getByTestId("clock")).toHaveTextContent("0:00.00 / 0:17.80");
    expect(screen.getAllByTestId("chapter").map((node) => node.textContent)).toContain("#/lobby");
    expect(screen.getAllByTestId("action-mark").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByRole("slider", { name: "Session timeline" })).toHaveAttribute(
      "aria-valuetext",
      "0.00s of 17.80s"
    );
    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(screen.getAllByTestId("event-row").length).toBeGreaterThan(5);
    expect(screen.getByTestId("now-line")).toHaveTextContent("now");
  });

  it("switches the language without a reload and keeps the playhead and selection", async () => {
    const { controller, store } = renderPlayer();
    await openArchive(controller);
    key("e");
    const selection = store.getState().selection;
    const clock = screen.getByTestId("clock").textContent;

    act(() => {
      fireEvent.click(screen.getByTestId("locale-ru"));
    });

    expect(screen.getByTestId("tab-activity")).toHaveTextContent("Хронология");
    expect(document.documentElement.lang).toBe("ru");
    expect(store.getState().selection).toEqual(selection);
    expect(screen.getByTestId("clock").textContent).toBe(clock?.replaceAll(".", ","));
    expect(window.localStorage.getItem("webblackbox.player.locale")).toBe("ru");

    act(() => {
      fireEvent.click(screen.getByTestId("locale-zh-CN"));
    });
    expect(screen.getByTestId("tab-activity")).toHaveTextContent("活动");
  });

  it("drives the player from the keyboard", async () => {
    const { controller, store } = renderPlayer();
    await openArchive(controller);

    key("e");
    expect(screen.getByTestId("live-region")).toHaveTextContent(/^Error 1 of 1/);
    const selected = store.getState().selection?.id;
    // jsdom has no layout, so the virtual list cannot scroll the row into its window; the
    // listbox still points at it. e2e:player-next checks the rendered row (and that it is the
    // present, not the dimmed future) in Chrome.
    expect(screen.getByTestId("event-list")).toHaveAttribute(
      "aria-activedescendant",
      `evt-${selected}`
    );

    key("Enter");
    expect(screen.getByTestId("details-json")).toHaveTextContent(selected ?? "-");
    key("Escape");
    expect(screen.queryByTestId("details-panel")).not.toBeInTheDocument();

    key("?");
    expect(screen.getByTestId("shortcuts-dialog")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("shortcuts-dialog")).getByText("Next user action")
    ).toBeInTheDocument();
    key("Escape");
    expect(screen.queryByTestId("shortcuts-dialog")).not.toBeInTheDocument();

    key("3", { code: "Digit3" });
    expect(screen.getByTestId("panel-placeholder-console")).toHaveTextContent(
      "Console arrives in a later stage"
    );

    key("Home");
    key("ArrowRight");
    expect(screen.getByTestId("clock")).toHaveTextContent("0:01.00");

    const search = screen.getByTestId("search");
    key("/");
    expect(search).toHaveFocus();
    act(() => {
      fireEvent.keyDown(search, { key: "e" });
    });
    expect(screen.getByTestId("clock")).toHaveTextContent("0:01.00");
  });

  it("filters the list, cycles the theme, seeks from chapters and shows the drop overlay", async () => {
    const { controller, store } = renderPlayer();
    await openArchive(controller);

    act(() => {
      fireEvent.change(screen.getByTestId("activity-filter"), { target: { value: "casino-user" } });
    });
    expect(store.getState().query).toBe("casino-user");
    expect(screen.getByTestId("search")).toHaveValue("casino-user");

    act(() => {
      fireEvent.click(screen.getByTestId("theme-toggle"));
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themePreference).toBe("light");
    act(() => {
      fireEvent.click(screen.getByTestId("theme-toggle"));
    });
    expect(document.documentElement.dataset.theme).toBe("dark");

    const lobby = screen.getAllByTestId("chapter").find((node) => node.textContent === "#/lobby");
    act(() => {
      fireEvent.click(lobby as HTMLElement);
    });
    expect(screen.getByTestId("clock")).toHaveTextContent("0:09.45");

    act(() => {
      fireEvent.click(screen.getByTestId("other-tabs-chip"));
    });
    expect(store.getState().selection?.kind).toBe("event");

    const drag = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(drag, "dataTransfer", { value: { types: ["Files"], files: [] } });
    act(() => {
      window.dispatchEvent(drag);
    });
    expect(screen.getByTestId("drop-overlay")).toHaveTextContent("Drop the archive to open it");
  });

  it("matches physical keys, so the keymap works on a Russian layout", async () => {
    const { controller, store } = renderPlayer();
    await openArchive(controller);

    // Russian ЙЦУКЕН: KeyE types "у", KeyL types "д", and "?" is Shift+7.
    key("у", { code: "KeyE" });
    expect(screen.getByTestId("live-region")).toHaveTextContent(/^Error 1 of 1/);
    const error = store.getState().selection?.id;

    key("д", { code: "KeyL" });
    expect(store.getState().selection?.id).not.toBe(error);

    key("?", { code: "Digit7", shiftKey: true });
    expect(screen.getByTestId("shortcuts-dialog")).toBeInTheDocument();
  });

  it("opens the shortcut sheet with ? from the scrubber, but not with Ctrl or Alt held", async () => {
    const { controller } = renderPlayer();
    await openArchive(controller);

    screen.getByTestId("scrubber").focus();
    key("?", { ctrlKey: true });
    key("?", { altKey: true });
    expect(screen.queryByTestId("shortcuts-dialog")).not.toBeInTheDocument();

    key("?");
    expect(screen.getByTestId("shortcuts-dialog")).toBeInTheDocument();
    key("Escape");
    expect(screen.queryByTestId("shortcuts-dialog")).not.toBeInTheDocument();

    // AltGr (Ctrl+Alt on Windows) is how some layouts type "?".
    screen.getByTestId("scrubber").focus();
    key("?", { ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect(screen.getByTestId("shortcuts-dialog")).toBeInTheDocument();
  });

  it("names each locale button by its visible label first (WCAG 2.5.3)", async () => {
    const { controller } = renderPlayer();
    await openArchive(controller);

    for (const [id, visible] of [
      ["locale-en", "EN"],
      ["locale-ru", "RU"]
    ] as const) {
      const button = screen.getByTestId(id);
      expect(button).toHaveTextContent(visible);
      expect(button).toHaveAccessibleName(expect.stringMatching(new RegExp(`^${visible}\\b`)));
    }
  });

  it("opens the Base UI dialog as a modal and returns focus to its opener", async () => {
    const { controller } = renderPlayer();
    await openArchive(controller);
    const opener = screen.getByTestId("shortcuts-button");
    opener.focus();

    act(() => {
      fireEvent.click(opener);
    });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toHaveAttribute("data-testid", "shortcuts-dialog");

    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    });
    expect(screen.queryByTestId("shortcuts-dialog")).not.toBeInTheDocument();
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });

  it("writes the URL hash after the playhead settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const { controller } = renderPlayer();
      await openArchive(controller);
      key("e");
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(window.location.hash).toMatch(/^#t=11\.07&sel=evt%3AE-\d+&tab=activity$/);
    } finally {
      vi.useRealTimers();
    }
  });
});
