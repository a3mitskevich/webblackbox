/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { createMediaUrlCache } from "../../../core/media-cache.js";
import { App } from "../../app.js";
import { createPlayerController } from "../../controller.js";
import { createInitialState, type PlayerState } from "../../state.js";
import { createStore } from "../../store.js";
import { loadSyntheticArchive } from "../test-archive.js";
import {
  decideShareLink,
  fetchSharedArchive,
  ShareError,
  uploadArchive,
  type ShareSettingsStore
} from "./share-service.js";
import { shareSlice } from "./slice.js";

let archiveBytes: Uint8Array;

beforeAll(async () => {
  archiveBytes = await createPlainArchive();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function memorySettings(baseUrl = "https://share.example.test"): ShareSettingsStore & {
  remembered: Array<[string, string]>;
} {
  const remembered: Array<[string, string]> = [];

  return {
    remembered,
    readBaseUrl: () => baseUrl,
    readApiKeys: () => ({ "https://share.example.test": "saved-key" }),
    remember: (url, key) => {
      remembered.push([url, key]);
    }
  };
}

describe("share links", () => {
  it("loads trusted links at once and asks before untrusted ones", () => {
    const settings = memorySettings();
    const page = "https://player.example.test";

    expect(decideShareLink(`${page}/?ui=next`, page, settings)).toEqual({ kind: "none" });
    expect(decideShareLink(`${page}/?share=share-abc1`, page, settings)).toEqual({
      kind: "trusted",
      reference: "share-abc1",
      apiKey: "saved-key"
    });
    expect(
      decideShareLink(`${page}/?share=https://evil.example.net/share/x1`, page, settings)
    ).toEqual({
      kind: "confirm",
      reference: "https://evil.example.net/share/x1",
      origin: "https://evil.example.net"
    });
    expect(
      decideShareLink(`${page}/?share=${encodeURIComponent("ftp://x/y")}`, page, settings).kind
    ).toBe("invalid");
  });

  it("uploads with the share summary and remembers the server and key", async () => {
    const archive = await loadSyntheticArchive();
    const settings = memorySettings();
    const upload = vi.fn(
      async (
        _url: string,
        _headers: Record<string, string>,
        _body: ArrayBuffer,
        onProgress: (loaded: number, total: number | null) => void
      ) => {
        onProgress(5, 10);
        return { shareId: "share-s1" };
      }
    );
    const progress = vi.fn();

    await expect(
      uploadArchive({
        baseUrl: "https://share.example.test/",
        apiKey: " key ",
        fileName: "a.webblackbox",
        bytes: archive.bytes,
        player: archive.player,
        locale: "en",
        onProgress: progress,
        settings,
        upload
      })
    ).resolves.toBe("https://share.example.test/share/share-s1");

    const [url, headers] = upload.mock.calls[0] ?? [];
    expect(url).toBe("https://share.example.test/api/share/upload");
    expect(headers).toMatchObject({
      "x-webblackbox-filename": "a.webblackbox",
      "x-webblackbox-api-key": "key"
    });
    expect(
      JSON.parse(decodeURIComponent(headers?.["x-webblackbox-share-summary"] ?? "{}"))
    ).toMatchObject({
      schemaVersion: 1,
      source: "client"
    });
    expect(progress).toHaveBeenCalledWith({ loaded: 5, total: 10 });
    expect(settings.remembered).toEqual([["https://share.example.test", "key"]]);

    await expect(
      uploadArchive({
        baseUrl: "javascript:alert(1)",
        apiKey: "",
        fileName: "a",
        bytes: archive.bytes,
        player: archive.player,
        locale: "en",
        onProgress: progress,
        settings,
        upload
      })
    ).rejects.toBeInstanceOf(ShareError);
    await expect(
      uploadArchive({
        baseUrl: "https://share.example.test",
        apiKey: "",
        fileName: "a",
        bytes: archive.bytes,
        player: archive.player,
        locale: "en",
        onProgress: progress,
        settings,
        upload: async () => ({})
      })
    ).rejects.toMatchObject({ code: "missing-url" });
  });

  it("downloads shared archives and reports server errors", async () => {
    const settings = memorySettings();
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer
    }));

    const shared = await fetchSharedArchive({
      reference: "share-s1",
      apiKey: "k",
      persist: false,
      settings,
      fetch
    });
    expect(shared.request.shareId).toBe("share-s1");
    expect([...shared.bytes]).toEqual([1, 2]);
    // A redirect must not carry the key to another origin.
    expect(fetch).toHaveBeenCalledWith(shared.request.archiveUrl, {
      headers: { "x-webblackbox-api-key": "k" },
      redirect: "error"
    });
    expect(settings.remembered).toEqual([]);

    await fetchSharedArchive({
      reference: "share-s1",
      apiKey: " ",
      persist: false,
      settings,
      fetch
    });
    expect(fetch).toHaveBeenLastCalledWith(shared.request.archiveUrl, {
      headers: {},
      redirect: "follow"
    });

    await expect(
      fetchSharedArchive({
        reference: "share-s1",
        apiKey: "",
        persist: true,
        settings,
        fetch: async () => ({
          ok: false,
          status: 404,
          text: async () => "not found",
          arrayBuffer: async () => new ArrayBuffer(0)
        })
      })
    ).rejects.toThrow("not found");
    expect(settings.remembered).toHaveLength(1);
    await expect(
      fetchSharedArchive({ reference: "ftp://nope", apiKey: "", persist: false, settings, fetch })
    ).rejects.toMatchObject({ code: "invalid-reference" });
  });
});

class FakeXhr {
  status = 200;
  responseText = '{"shareId":"x9"}';
  upload = {
    addEventListener: (_: string, listener: (event: object) => void) =>
      this.onProgress.push(listener)
  };
  private onProgress: Array<(event: object) => void> = [];
  private listeners = new Map<string, () => void>();
  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  send(): void {
    queueMicrotask(() => {
      this.onProgress.forEach((listener) =>
        listener({ lengthComputable: true, loaded: 10, total: 10 })
      );
      this.listeners.get("load")?.();
    });
  }
}

/** An upload that stays open until the test answers it (or the dialog aborts it). */
class PendingXhr {
  static all: PendingXhr[] = [];
  status = 200;
  responseText = '{"shareId":"late"}';
  aborted = false;
  upload = {
    addEventListener: (_: string, listener: (event: object) => void) =>
      this.onProgress.push(listener)
  };
  private onProgress: Array<(event: object) => void> = [];
  private listeners = new Map<string, () => void>();
  constructor() {
    PendingXhr.all.push(this);
  }
  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  send(): void {}
  abort(): void {
    this.aborted = true;
    this.listeners.get("abort")?.();
  }
  finish(): void {
    this.onProgress.forEach((listener) =>
      listener({ lengthComputable: true, loaded: 10, total: 10 })
    );
    this.listeners.get("load")?.();
  }
}

function renderPlayer() {
  const store = createStore<PlayerState>(createInitialState("en", "light"));
  const controller = createPlayerController(store, {
    scheduler: { request: () => 0, cancel: () => undefined },
    mediaCache: createMediaUrlCache({ createUrl: () => "blob:frame", revokeUrl: () => undefined })
  });
  render(<App controller={controller} />);
  return { store, controller };
}

describe("Share in the header", () => {
  it("uploads only after the privacy review and shows the link", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    const { controller } = renderPlayer();
    await act(async () => {
      await controller.openFile({
        name: "synthetic.webblackbox",
        arrayBuffer: async () => archiveBytes.slice().buffer
      });
    });

    fireEvent.click(screen.getByTestId("share-button"));
    fireEvent.click(await screen.findByTestId("share-upload-item"));
    const submit = await screen.findByTestId("share-upload-submit");
    expect(screen.getByTestId("share-preflight")).toHaveTextContent("Before you share");
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId("share-server-url"), {
      target: { value: "https://share.example.test" }
    });
    fireEvent.click(screen.getByTestId("share-reviewed"));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(await screen.findByTestId("share-url")).toHaveValue(
      "https://share.example.test/share/x9"
    );
    expect(window.localStorage.getItem("webblackbox.player.shareServerBaseUrl")).toBe(
      "https://share.example.test"
    );
  });

  it("aborts the upload when the dialog closes and ignores the late answer", async () => {
    PendingXhr.all = [];
    vi.stubGlobal("XMLHttpRequest", PendingXhr);
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { controller, store } = renderPlayer();
    await act(async () => {
      await controller.openFile({
        name: "synthetic.webblackbox",
        arrayBuffer: async () => archiveBytes.slice().buffer
      });
    });

    fireEvent.click(screen.getByTestId("share-button"));
    fireEvent.click(await screen.findByTestId("share-upload-item"));
    fireEvent.change(await screen.findByTestId("share-server-url"), {
      target: { value: "https://share.example.test" }
    });
    fireEvent.click(screen.getByTestId("share-reviewed"));
    fireEvent.click(screen.getByTestId("share-upload-submit"));
    await screen.findByTestId("share-progress");
    expect(screen.getByTestId("share-upload-status")).toHaveTextContent("Uploading the recording");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("share-upload-dialog")).toBeNull());
    expect(PendingXhr.all[0]?.aborted).toBe(true);
    expect(store.getState().announcement).toBe("Upload aborted.");

    fireEvent.click(screen.getByTestId("share-button"));
    fireEvent.click(await screen.findByTestId("share-upload-item"));
    await screen.findByTestId("share-upload-submit");
    await act(async () => {
      PendingXhr.all[0]?.finish();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("share-progress")).toBeNull();
    expect(screen.queryByTestId("share-url")).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
    expect(store.getState().announcement).toBe("Upload aborted.");
  });

  it("labels the share link and reports a failed copy", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }
    });
    const { controller, store } = renderPlayer();
    await act(async () => {
      await controller.openFile({
        name: "synthetic.webblackbox",
        arrayBuffer: async () => archiveBytes.slice().buffer
      });
    });

    fireEvent.click(screen.getByTestId("share-button"));
    fireEvent.click(await screen.findByTestId("share-upload-item"));
    fireEvent.change(await screen.findByTestId("share-server-url"), {
      target: { value: "https://share.example.test" }
    });
    fireEvent.click(screen.getByTestId("share-reviewed"));
    fireEvent.click(screen.getByTestId("share-upload-submit"));

    expect(await screen.findByRole("textbox", { name: "Share link" })).toHaveValue(
      "https://share.example.test/share/x9"
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("share-copy"));
    });
    await waitFor(() =>
      expect(store.getState().announcement).toBe("Could not copy the link; copy it from the field.")
    );
  });

  it("drops a shared download when its dialog closes", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const fetch = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          answer = resolve;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    vi.stubGlobal("fetch", fetch);
    const { store } = renderPlayer();

    fireEvent.click(screen.getByTestId("share-button"));
    fireEvent.click(await screen.findByTestId("share-open-item"));
    fireEvent.change(await screen.findByTestId("share-reference"), {
      target: { value: "share-abc1" }
    });
    fireEvent.click(screen.getByTestId("share-open-submit"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const signal = (fetch.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal;

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("share-open-dialog")).toBeNull());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      answer({
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => archiveBytes.slice().buffer
      });
      await Promise.resolve();
    });

    expect(store.getState().archive).toBeNull();
    expect(shareSlice.select(store.getState()).open).toEqual({ phase: "idle" });
  });

  it("asks before opening a ?share= link to an unknown server", async () => {
    window.history.replaceState(
      null,
      "",
      "/?ui=next&share=https%3A%2F%2Fevil.example.net%2Fshare%2Fx1"
    );
    renderPlayer();

    expect(await screen.findByTestId("share-untrusted")).toHaveTextContent(
      "https://evil.example.net"
    );
    expect(screen.getByTestId("share-reference")).toHaveValue("https://evil.example.net/share/x1");
    expect(window.localStorage.getItem("webblackbox.player.shareServerBaseUrl")).toBeNull();
  });

  it("opens a ?share= link to the default server at once", async () => {
    window.history.replaceState(null, "", "/?ui=next&share=share-abc1");
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => archiveBytes.slice().buffer
    }));
    vi.stubGlobal("fetch", fetch);
    const { store } = renderPlayer();

    await waitFor(() =>
      expect(store.getState().archive?.fileName).toBe("shared-share-abc1.webblackbox")
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
