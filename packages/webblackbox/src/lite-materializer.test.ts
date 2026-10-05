import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig
} from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import { materializeLiteRawEvent, shouldMaterializeLiteRawEvent } from "./lite-materializer.js";

function createRawEvent(rawType: string, payload: Record<string, unknown>): RawRecorderEvent {
  return {
    source: "content",
    rawType,
    tabId: 7,
    sid: "S-test",
    t: 1,
    mono: 1,
    payload
  };
}

function cloneConfig(): RecorderConfig {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    sampling: {
      ...DEFAULT_RECORDER_CONFIG.sampling
    },
    redaction: {
      ...DEFAULT_RECORDER_CONFIG.redaction,
      redactHeaders: [...DEFAULT_RECORDER_CONFIG.redaction.redactHeaders],
      redactCookieNames: [...DEFAULT_RECORDER_CONFIG.redaction.redactCookieNames],
      redactBodyPatterns: [...DEFAULT_RECORDER_CONFIG.redaction.redactBodyPatterns],
      blockedSelectors: [...DEFAULT_RECORDER_CONFIG.redaction.blockedSelectors]
    },
    sitePolicies: [...DEFAULT_RECORDER_CONFIG.sitePolicies]
  };
}

describe("lite-materializer", () => {
  it("detects which raw events need lite materialization", () => {
    expect(
      shouldMaterializeLiteRawEvent(
        createRawEvent("screenshot", {
          dataUrl: "data:image/png;base64,AA=="
        })
      )
    ).toBe(true);

    expect(
      shouldMaterializeLiteRawEvent(
        createRawEvent("networkBody", {
          reqId: "R-1",
          body: "ok"
        })
      )
    ).toBe(true);

    expect(
      shouldMaterializeLiteRawEvent({
        ...createRawEvent("screenshot", {
          dataUrl: "data:image/png;base64,AA=="
        }),
        source: "cdp"
      })
    ).toBe(false);

    expect(
      shouldMaterializeLiteRawEvent(
        createRawEvent("networkBody", {
          reqId: "R-1"
        })
      )
    ).toBe(false);
  });

  it("materializes screenshot data-url payloads into blob references", async () => {
    const putBlobCalls: Array<{ mime: string; bytes: Uint8Array }> = [];

    const rawEvent = createRawEvent("screenshot", {
      dataUrl: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}`,
      w: 640,
      h: 360,
      reason: "start"
    });

    const result = await materializeLiteRawEvent(rawEvent, {
      config: cloneConfig(),
      putBlob: async (mime, bytes) => {
        putBlobCalls.push({ mime, bytes });
        return "hash-shot";
      }
    });

    expect(putBlobCalls).toHaveLength(1);
    expect(putBlobCalls[0]?.mime).toBe("image/png");
    expect(putBlobCalls[0]?.bytes.byteLength).toBe(4);
    expect(result?.payload).toMatchObject({
      shotId: "hash-shot",
      format: "png",
      w: 640,
      h: 360,
      reason: "start",
      size: 4
    });
  });

  it("drops screenshot payloads that are not png/webp images", async () => {
    const putBlob = vi.fn(async () => "hash-shot");

    for (const dataUrl of [
      `data:text/html;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`,
      "data:text/html,<script>alert(1)</script>",
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`
    ]) {
      const result = await materializeLiteRawEvent(createRawEvent("screenshot", { dataUrl }), {
        config: cloneConfig(),
        putBlob
      });

      expect(result).toBeNull();
    }

    expect(putBlob).not.toHaveBeenCalled();
  });

  it("materializes network bodies with redaction and byte caps", async () => {
    const config = cloneConfig();
    config.sampling.bodyCaptureMaxBytes = 4 * 1024;

    const putBlobCalls: Array<{ mime: string; text: string; bytes: Uint8Array }> = [];
    const body = `token=secret-token&mode=lite&chunk=${"x".repeat(6000)}`;

    const rawEvent = createRawEvent("networkBody", {
      reqId: "R-2",
      url: "https://example.test/api/login",
      mimeType: "application/x-www-form-urlencoded",
      encoding: "utf8",
      body,
      size: new TextEncoder().encode(body).byteLength
    });

    const result = await materializeLiteRawEvent(rawEvent, {
      config,
      putBlob: async (mime, bytes) => {
        putBlobCalls.push({
          mime,
          text: new TextDecoder().decode(bytes),
          bytes
        });
        return "hash-body";
      }
    });

    expect(result).not.toBeNull();
    expect(putBlobCalls).toHaveLength(1);
    expect(putBlobCalls[0]?.mime).toBe("application/x-www-form-urlencoded");
    expect(putBlobCalls[0]?.text.startsWith("token=[REDACTED]&mode=lite&chunk=")).toBe(true);
    expect(putBlobCalls[0]?.text).not.toContain("secret-token");
    expect(putBlobCalls[0]?.bytes.byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(putBlobCalls[0]?.bytes.byteLength).toBeLessThan(
      new TextEncoder().encode(body).byteLength
    );
    expect(result?.payload).toMatchObject({
      reqId: "R-2",
      requestId: "R-2",
      contentHash: "hash-body",
      redacted: true,
      truncated: true
    });
  });

  it("redacts base64-encoded textual network bodies", async () => {
    const config = cloneConfig();
    config.sampling.bodyCaptureMaxBytes = 4 * 1024;
    const putBlobCalls: string[] = [];
    const body = "login=qa%40example.test&password=hunter2&remember=1";

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-b64",
        url: "https://example.test/api/login",
        mimeType: "application/x-www-form-urlencoded; charset=UTF-8",
        encoding: "base64",
        body: Buffer.from(body, "utf8").toString("base64")
      }),
      {
        config,
        putBlob: async (_mime, bytes) => {
          putBlobCalls.push(new TextDecoder().decode(bytes));
          return "hash-b64";
        }
      }
    );

    expect(putBlobCalls).toEqual(["login=qa%40example.test&password=[REDACTED]&remember=1"]);
    expect(result?.payload).toMatchObject({ contentHash: "hash-b64", redacted: true });
  });

  it("keeps base64 binary network bodies byte-exact and unredacted", async () => {
    const config = cloneConfig();
    config.sampling.bodyCaptureMaxBytes = 4 * 1024;
    config.sitePolicies = [
      {
        originPattern: "https://example.test",
        mode: "lite",
        enabled: true,
        allowBodyCapture: true,
        bodyMimeAllowlist: ["application/octet-stream"],
        pathAllowlist: [],
        pathDenylist: []
      }
    ];
    const bytes = new Uint8Array([0, 1, 2, ...new TextEncoder().encode("password=hunter2")]);
    const putBlobCalls: Uint8Array[] = [];

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-bin",
        url: "https://example.test/api/blob",
        mimeType: "application/octet-stream",
        encoding: "base64",
        body: Buffer.from(bytes).toString("base64")
      }),
      {
        config,
        putBlob: async (_mime, blobBytes) => {
          putBlobCalls.push(blobBytes);
          return "hash-bin";
        }
      }
    );

    expect([...(putBlobCalls[0] ?? [])]).toEqual([...bytes]);
    expect(result?.payload).toMatchObject({ redacted: false });
  });

  it("respects site policy deny rules for body capture", async () => {
    const config = cloneConfig();
    config.sitePolicies = [
      {
        originPattern: "https://example.test",
        mode: "lite",
        enabled: true,
        allowBodyCapture: false,
        bodyMimeAllowlist: [],
        pathAllowlist: [],
        pathDenylist: []
      }
    ];

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-3",
        url: "https://example.test/api/private",
        mimeType: "application/json",
        encoding: "utf8",
        body: '{"token":"abc"}',
        size: 15
      }),
      {
        config,
        putBlob: async () => "unused"
      }
    );

    expect(result).toBeNull();
  });

  it("drops localStorage entry samples during materialization", async () => {
    const putBlob = vi.fn(async () => "unused");

    const result = await materializeLiteRawEvent(
      createRawEvent("localStorageSnapshot", {
        count: 1,
        entries: {
          token: {
            length: 19,
            sample: "storage-secret-token"
          }
        }
      }),
      {
        config: cloneConfig(),
        putBlob
      }
    );

    expect(putBlob).not.toHaveBeenCalled();
    expect(result?.payload).toMatchObject({
      count: 1,
      mode: "counts-only",
      redacted: true
    });
    expect(result?.payload).not.toHaveProperty("hash");
    expect(JSON.stringify(result)).not.toContain("storage-secret-token");
  });

  it("drops cookie and IndexedDB names during materialization", async () => {
    const putBlob = vi.fn(async () => "unused");
    const context = {
      config: cloneConfig(),
      putBlob
    };

    const cookieResult = await materializeLiteRawEvent(
      createRawEvent("cookieSnapshot", {
        names: ["sessionSecret", "tenant-cookie"],
        count: 2
      }),
      context
    );
    const idbResult = await materializeLiteRawEvent(
      createRawEvent("indexedDbSnapshot", {
        databaseNames: ["customer-secret-db"],
        count: 1
      }),
      context
    );

    expect(putBlob).not.toHaveBeenCalled();
    expect(cookieResult?.payload).toMatchObject({
      count: 2,
      mode: "counts-only",
      redacted: true
    });
    expect(idbResult?.payload).toMatchObject({
      count: 1,
      mode: "counts-only",
      redacted: true
    });
    expect(JSON.stringify(cookieResult)).not.toContain("sessionSecret");
    expect(JSON.stringify(idbResult)).not.toContain("customer-secret-db");
  });

  it("passes default counts-only snapshots through unchanged, field order included", async () => {
    const context = { config: cloneConfig(), putBlob: vi.fn(async () => "unused") };
    const agentPayloads = {
      localStorageSnapshot: {
        reason: "start",
        count: 2,
        truncated: false,
        mode: "counts-only",
        redacted: true
      },
      indexedDbSnapshot: {
        reason: "start",
        count: 1,
        mode: "counts-only",
        redacted: true,
        truncated: false
      },
      cookieSnapshot: { reason: "start", count: 3, mode: "counts-only", redacted: true }
    };

    for (const [rawType, payload] of Object.entries(agentPayloads)) {
      const result = await materializeLiteRawEvent(createRawEvent(rawType, payload), context);
      expect(JSON.stringify(result?.payload), rawType).toBe(JSON.stringify(payload));
    }
  });

  it("keeps storage snapshot details the capture policy allows", async () => {
    const config = cloneConfig();
    const putBlob = vi.fn(async () => "unused");
    const withCategories = (categories: Partial<CapturePolicy["categories"]>) => ({
      config: {
        ...config,
        capturePolicy: {
          ...DEFAULT_CAPTURE_POLICY,
          categories: { ...DEFAULT_CAPTURE_POLICY.categories, ...categories }
        }
      },
      putBlob
    });

    const local = await materializeLiteRawEvent(
      createRawEvent("localStorageSnapshot", {
        count: 2,
        entries: [
          { key: "theme", value: "dark", valueLength: 4 },
          { key: "big", value: "x".repeat(5_000), valueLength: 5_000 }
        ]
      }),
      withCategories({ storage: "allow" })
    );
    const names = await materializeLiteRawEvent(
      createRawEvent("localStorageSnapshot", { count: 1, keys: ["theme"], entries: [] }),
      withCategories({ storage: "names-only" })
    );
    const idb = await materializeLiteRawEvent(
      createRawEvent("indexedDbSnapshot", { count: 1, databaseNames: ["app-db"] }),
      withCategories({ indexedDb: "names-only" })
    );
    const cookies = await materializeLiteRawEvent(
      createRawEvent("cookieSnapshot", { count: 1, names: ["theme"] }),
      withCategories({ cookies: "names-only" })
    );

    expect(local?.payload).toMatchObject({
      mode: "allow",
      redacted: false,
      entries: [
        { key: "theme", value: "dark", valueLength: 4 },
        { key: "big", valueLength: 5_000, valueTruncated: true }
      ]
    });
    expect(
      ((local?.payload as { entries: Array<{ value: string }> }).entries[1]?.value ?? "").length
    ).toBe(2_048);
    expect(names?.payload).toMatchObject({ mode: "names-only", keys: ["theme"] });
    expect(names?.payload).not.toHaveProperty("entries");
    expect(idb?.payload).toMatchObject({ mode: "names-only", databaseNames: ["app-db"] });
    expect(cookies?.payload).toMatchObject({ mode: "names-only", names: ["theme"] });
    expect(putBlob).not.toHaveBeenCalled();

    const cookieValues = await materializeLiteRawEvent(
      createRawEvent("cookieSnapshot", {
        count: 2,
        cookies: [{ name: "theme", value: "dark" }, { name: "broken" }]
      }),
      withCategories({ cookies: "allow" })
    );
    const idbRecords = await materializeLiteRawEvent(
      createRawEvent("indexedDbSnapshot", {
        count: 1,
        databaseNames: ["app-db"],
        databases: [
          {
            name: "app-db",
            version: 2,
            stores: [{ name: "kv", count: 1, records: [{ key: "1", value: '{"a":1}', x: 1 }] }],
            injected: "<script>"
          }
        ]
      }),
      withCategories({ indexedDb: "allow" })
    );
    // A page asking for more than the policy allows still gets names only.
    const cookieNamesOnly = await materializeLiteRawEvent(
      createRawEvent("cookieSnapshot", {
        count: 1,
        names: ["theme"],
        cookies: [{ name: "theme", value: "dark" }]
      }),
      withCategories({ cookies: "names-only" })
    );

    expect(cookieValues?.payload).toMatchObject({
      mode: "allow",
      redacted: false,
      cookies: [{ name: "theme", value: "dark" }]
    });
    expect(idbRecords?.payload).toEqual({
      count: 1,
      mode: "allow",
      redacted: false,
      databaseNames: ["app-db"],
      databases: [
        {
          name: "app-db",
          version: 2,
          stores: [{ name: "kv", count: 1, records: [{ key: "1", value: '{"a":1}' }] }]
        }
      ]
    });
    expect(cookieNamesOnly?.payload).not.toHaveProperty("cookies");
  });

  it("treats a zero body-capture budget as disabled", async () => {
    const config = cloneConfig();
    config.sampling.bodyCaptureMaxBytes = 0;

    const result = await materializeLiteRawEvent(
      createRawEvent("networkBody", {
        reqId: "R-4",
        url: "https://example.test/api/private",
        mimeType: "application/json",
        encoding: "utf8",
        body: '{"token":"abc"}',
        size: 15
      }),
      {
        config,
        putBlob: async () => "unused"
      }
    );

    expect(result).toBeNull();
  });
});
