import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_EXPORT_POLICY,
  DEFAULT_RECORDER_CONFIG
} from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionOutboundMessage } from "../shared/messages.js";
import type { PipelineExportDownloadResult } from "../shared/offscreen-messages.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  buildExportPrivacyWarning,
  createSessionExportController,
  downloadExportedBundle,
  EXPORT_AUDIT_MAX_EVENTS,
  EXPORT_AUDIT_STORAGE_KEY,
  normalizeExportBoundedInt,
  redactOperationalMessage,
  resolveExportPolicy,
  resolveSessionExportPolicy,
  type ExportAuditEvent,
  type SessionExportController,
  type SessionExportDeps
} from "./export-session.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";
import type { SnapshotStorageAreaLike } from "./stopped-session-store.js";

type FakeArea = SnapshotStorageAreaLike & {
  read: (key: string) => unknown;
};

function createArea(): FakeArea {
  let stored: Record<string, unknown> = {};

  return {
    get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      stored = { ...stored, ...items };
    }),
    read: (key: string) => stored[key]
  };
}

type PipelineStub = SessionPipelineClient & {
  exportAndDownload: ReturnType<typeof vi.fn>;
};

function createPipelineStub(overrides: Partial<SessionPipelineClient> = {}): PipelineStub {
  const stub: PipelineStub = {
    start: vi.fn(async () => undefined),
    ingest: vi.fn(async () => undefined),
    ingestBatch: vi.fn(async () => 0),
    flush: vi.fn(async () => undefined),
    putBlob: vi.fn(async () => "blob-id"),
    exportAndDownload: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    close: vi.fn(async () => undefined)
  };

  return Object.assign(stub, overrides);
}

function createFullBodyCaptureStub(): FullBodyCapture {
  return new FullBodyCapture({
    isEnabled: () => false,
    resolveRule: () => ({ enabled: false, maxBytes: 0, mimeAllowlist: [] }),
    readResponseBody: () => Promise.resolve({ ok: false, error: "unavailable" }),
    storeBody: () => Promise.resolve(0),
    emitSkip: () => undefined
  });
}

function createRuntimeInit(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntimeInit {
  return {
    sid: "S-1",
    tabId: 7,
    mode: "lite",
    profile: {
      request: "auto",
      selection: { profile: createDefaultProfile(), source: "default", extended: false },
      profileConfig: DEFAULT_RECORDER_CONFIG,
      visualsCaptured: { screenshots: true, screenRecordings: false }
    },
    url: "https://example.test/app",
    title: "Example",
    annotation: { tags: [] },
    config: DEFAULT_RECORDER_CONFIG,
    startedAt: 1_000,
    pipeline: createPipelineStub(),
    recorderPlugins: createDefaultRecorderPlugins(),
    performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET },
    ...overrides
  };
}

function createRuntime(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntime {
  return createSessionRuntime(createRuntimeInit(overrides), {
    createFullBodyCapture: () => createFullBodyCaptureStub()
  });
}

function createExportResult(
  overrides: Partial<PipelineExportDownloadResult> = {}
): PipelineExportDownloadResult {
  return {
    fileName: "session.wbbx",
    sizeBytes: 4_096,
    downloadUrl: "blob:https://example.test/archive",
    integrity: { manifestSha256: "c".repeat(64), files: {} },
    ...overrides
  };
}

type Harness = {
  controller: SessionExportController;
  deps: SessionExportDeps;
  auditArea: FakeArea;
  broadcasts: ExtensionOutboundMessage[];
  downloads: { download: ReturnType<typeof vi.fn> };
};

function createHarness(
  runtime: SessionRuntime | undefined,
  overrides: Partial<SessionExportDeps> = {}
): Harness {
  const auditArea = createArea();
  const broadcasts: ExtensionOutboundMessage[] = [];
  const downloads = { download: vi.fn(async () => 42) };
  const deps: SessionExportDeps = {
    getRuntimeBySid: (sid) => (runtime?.sid === sid ? runtime : undefined),
    stopSession: vi.fn(async () => {
      if (runtime) {
        runtime.stoppedAt = 2_000;
      }
    }),
    flushBufferedPipelineEvents: vi.fn(async () => undefined),
    attachStoppedPipeline: vi.fn(async () => undefined),
    disposeStoppedSession: vi.fn(async () => undefined),
    enqueueWithResult: async (_runtime, task) => task(),
    downloads,
    auditStorageArea: auditArea,
    broadcast: (message) => {
      broadcasts.push(message);
    },
    ...overrides
  };

  return {
    controller: createSessionExportController(deps),
    deps,
    auditArea,
    broadcasts,
    downloads
  };
}

function storedAuditEvents(area: FakeArea): ExportAuditEvent[] {
  return (area.read(EXPORT_AUDIT_STORAGE_KEY) ?? []) as ExportAuditEvent[];
}

function auditEvent(overrides: Partial<ExportAuditEvent> = {}): ExportAuditEvent {
  return {
    schemaVersion: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    sid: "S-1",
    mode: "lite",
    outcome: "ok",
    encrypted: true,
    includeScreenshots: false,
    includeScreenRecordings: false,
    maxArchiveBytes: DEFAULT_EXPORT_POLICY.maxArchiveBytes,
    recentWindowMs: DEFAULT_EXPORT_POLICY.recentWindowMs,
    ...overrides
  };
}

describe("normalizeExportBoundedInt", () => {
  it("returns the fallback for non-numbers, non-finite and non-positive values", () => {
    expect(normalizeExportBoundedInt(undefined, 100, 1, 1_000)).toBe(100);
    expect(normalizeExportBoundedInt("50", 100, 1, 1_000)).toBe(100);
    expect(normalizeExportBoundedInt(Number.NaN, 100, 1, 1_000)).toBe(100);
    expect(normalizeExportBoundedInt(Number.POSITIVE_INFINITY, 100, 1, 1_000)).toBe(100);
    expect(normalizeExportBoundedInt(0, 100, 1, 1_000)).toBe(100);
    expect(normalizeExportBoundedInt(-5, 100, 1, 1_000)).toBe(100);
  });

  it("rounds and clamps into [min, max]", () => {
    expect(normalizeExportBoundedInt(3.6, 100, 1, 1_000)).toBe(4);
    expect(normalizeExportBoundedInt(1, 100, 10, 1_000)).toBe(10);
    expect(normalizeExportBoundedInt(5_000, 100, 10, 1_000)).toBe(1_000);
    expect(normalizeExportBoundedInt(500, 100, 10, 1_000)).toBe(500);
  });
});

describe("resolveExportPolicy", () => {
  it("falls back to the default policy for missing or malformed input", () => {
    expect(resolveExportPolicy(undefined)).toEqual(DEFAULT_EXPORT_POLICY);
    expect(resolveExportPolicy(null)).toEqual(DEFAULT_EXPORT_POLICY);
    expect(resolveExportPolicy("policy")).toEqual(DEFAULT_EXPORT_POLICY);
    expect(resolveExportPolicy([])).toEqual(DEFAULT_EXPORT_POLICY);
    expect(
      resolveExportPolicy({
        includeScreenshots: "yes",
        includeScreenRecordings: 1,
        maxArchiveBytes: "big",
        recentWindowMs: null
      })
    ).toEqual(DEFAULT_EXPORT_POLICY);
  });

  it("keeps explicit booleans and clamps the bounded numbers", () => {
    expect(
      resolveExportPolicy({
        includeScreenshots: true,
        includeScreenRecordings: true,
        maxArchiveBytes: 1,
        recentWindowMs: Number.MAX_SAFE_INTEGER
      })
    ).toEqual({
      includeScreenshots: true,
      includeScreenRecordings: true,
      maxArchiveBytes: 64 * 1024,
      recentWindowMs: 30 * 24 * 60 * 60 * 1000
    });
  });

  it("clamps the upper archive bound at 5 GiB and the lower window bound at one minute", () => {
    const policy = resolveExportPolicy({
      maxArchiveBytes: 10 * 1024 * 1024 * 1024,
      recentWindowMs: 1
    });

    expect(policy.maxArchiveBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(policy.recentWindowMs).toBe(60 * 1000);
  });
});

describe("resolveSessionExportPolicy", () => {
  it("returns the policy unchanged for lite sessions", () => {
    const runtime = createRuntime({ mode: "lite" });
    const policy = { ...DEFAULT_EXPORT_POLICY, includeScreenshots: true };

    expect(resolveSessionExportPolicy(runtime, policy)).toBe(policy);
  });

  it("returns the policy unchanged for full sessions without a capture policy", () => {
    const runtime = createRuntime({
      mode: "full",
      config: { ...DEFAULT_RECORDER_CONFIG, capturePolicy: undefined }
    });
    const policy = { ...DEFAULT_EXPORT_POLICY, includeScreenshots: true };

    expect(resolveSessionExportPolicy(runtime, policy)).toBe(policy);
  });

  it("overrides the visual inclusions from the visuals the session actually captured", () => {
    const runtime = createRuntime({
      mode: "full",
      config: { ...DEFAULT_RECORDER_CONFIG, capturePolicy: DEFAULT_CAPTURE_POLICY }
    });
    runtime.profile = {
      ...runtime.profile,
      visualsCaptured: { screenshots: false, screenRecordings: true }
    };

    const resolved = resolveSessionExportPolicy(runtime, {
      includeScreenshots: true,
      includeScreenRecordings: false,
      maxArchiveBytes: 1_024,
      recentWindowMs: 2_048
    });

    expect(resolved).toEqual({
      includeScreenshots: false,
      includeScreenRecordings: true,
      maxArchiveBytes: 1_024,
      recentWindowMs: 2_048
    });
  });
});

describe("buildExportPrivacyWarning", () => {
  const finding = (kind: "jwt" | "email", path: string, matchCount = 1) => ({
    kind,
    severity: "high" as const,
    path,
    matchCount,
    sampleSha256: "a".repeat(64)
  });

  it("returns undefined unless the scanner blocked the archive with findings", () => {
    expect(buildExportPrivacyWarning(undefined)).toBeUndefined();
    expect(
      buildExportPrivacyWarning({
        scannedAt: "2026-01-01T00:00:00.000Z",
        preEncryption: true,
        status: "passed",
        findings: [finding("jwt", "events.ndjson")]
      })
    ).toBeUndefined();
    expect(
      buildExportPrivacyWarning({
        scannedAt: "2026-01-01T00:00:00.000Z",
        preEncryption: true,
        status: "blocked",
        findings: []
      })
    ).toBeUndefined();
  });

  it("caps the listed findings at 8 and builds the summary from the first 5", () => {
    const findings = Array.from({ length: 10 }, (_, index) =>
      finding(index % 2 === 0 ? "jwt" : "email", `file-${index}.txt`, index + 1)
    );
    const warning = buildExportPrivacyWarning({
      scannedAt: "2026-01-01T00:00:00.000Z",
      preEncryption: true,
      status: "blocked",
      findings
    });

    expect(warning?.findingCount).toBe(10);
    expect(warning?.findings).toHaveLength(8);
    expect(warning?.findings[0]).toEqual({ kind: "jwt", path: "file-0.txt", matchCount: 1 });
    expect(warning?.summary).toBe(
      "jwt in file-0.txt, email in file-1.txt, jwt in file-2.txt, email in file-3.txt, jwt in file-4.txt"
    );
  });
});

describe("redactOperationalMessage", () => {
  it("redacts emails, bearer tokens and URLs", () => {
    expect(redactOperationalMessage("notify alice@example.com now")).toBe(
      "notify [redacted-email] now"
    );
    expect(redactOperationalMessage("Authorization: Bearer abc.def-123+/=")).toBe(
      "Authorization: Bearer [redacted-token]"
    );
    expect(redactOperationalMessage("GET https://example.test/secret?token=1 failed")).toBe(
      "GET [redacted-url] failed"
    );
    expect(redactOperationalMessage("read file:///tmp/dump.json failed")).toBe(
      "read [redacted-url] failed"
    );
  });

  it("truncates to 240 characters", () => {
    const redacted = redactOperationalMessage("x".repeat(500));

    expect(redacted).toHaveLength(240);
  });
});

describe("downloadExportedBundle", () => {
  it("throws when the downloads API is unavailable", async () => {
    await expect(downloadExportedBundle(undefined, createExportResult(), true)).rejects.toThrow(
      "Downloads API is unavailable in service worker context."
    );
  });

  it("downloads under the webblackbox folder and records the download id", async () => {
    const downloads = { download: vi.fn(async () => 77) };
    const exported = createExportResult();

    await downloadExportedBundle(downloads, exported, false);

    expect(downloads.download).toHaveBeenCalledWith({
      url: "blob:https://example.test/archive",
      filename: "webblackbox/session.wbbx",
      saveAs: false
    });
    expect(exported.downloadId).toBe(77);
  });
});

describe("appendExportAuditEvent", () => {
  it("appends events and caps the log at EXPORT_AUDIT_MAX_EVENTS", async () => {
    const { controller, auditArea } = createHarness(undefined);

    for (let index = 0; index < EXPORT_AUDIT_MAX_EVENTS + 5; index += 1) {
      await controller.appendExportAuditEvent(auditEvent({ sid: `S-${index}` }));
    }

    const events = storedAuditEvents(auditArea);

    expect(events).toHaveLength(EXPORT_AUDIT_MAX_EVENTS);
    expect(events[0]?.sid).toBe("S-5");
    expect(events.at(-1)?.sid).toBe(`S-${EXPORT_AUDIT_MAX_EVENTS + 4}`);
  });

  it("ignores malformed stored values and is a no-op without a storage area", async () => {
    const { controller, auditArea } = createHarness(undefined);

    await auditArea.set({ [EXPORT_AUDIT_STORAGE_KEY]: "not-an-array" });
    await controller.appendExportAuditEvent(auditEvent());

    expect(storedAuditEvents(auditArea)).toHaveLength(1);

    const noStorage = createHarness(undefined, { auditStorageArea: undefined });
    await noStorage.controller.appendExportAuditEvent(auditEvent());
  });
});

describe("exportSession", () => {
  it("fails without touching storage when the session is unknown", async () => {
    const { controller, auditArea, broadcasts } = createHarness(undefined);

    const result = await controller.exportSession("S-missing", "passphrase-1");

    expect(result).toEqual({ ok: false, error: "Session not found for export." });
    expect(broadcasts).toEqual([
      {
        kind: "sw.export-status",
        sid: "S-missing",
        ok: false,
        error: "Session not found for export."
      }
    ]);
    expect(storedAuditEvents(auditArea)).toHaveLength(0);
  });

  it("refuses a weak passphrase before stopping the recording and audits the refusal", async () => {
    const runtime = createRuntime();
    const { controller, deps, auditArea, broadcasts } = createHarness(runtime);

    const result = await controller.exportSession("S-1", "  short ");

    expect(result.ok).toBe(false);
    expect(deps.stopSession).not.toHaveBeenCalled();
    expect(runtime.stoppedAt).toBeUndefined();

    const events = storedAuditEvents(auditArea);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "error", encrypted: false, sid: "S-1" });
    expect(events[0]?.error).toContain("passphrase");
    expect(broadcasts.at(-1)).toMatchObject({ kind: "sw.export-status", ok: false });
  });

  it("runs the happy path: stop, flush, export, download, audit, warning and disposal", async () => {
    const pipeline = createPipelineStub({
      exportAndDownload: vi.fn(async () =>
        createExportResult({
          privacyScanner: {
            scannedAt: "2026-01-01T00:00:00.000Z",
            preEncryption: true,
            status: "blocked",
            findings: [
              {
                kind: "jwt",
                severity: "high",
                path: "events.ndjson",
                matchCount: 2,
                sampleSha256: "b".repeat(64)
              }
            ]
          }
        })
      )
    });
    const runtime = createRuntime({ pipeline });
    const { controller, deps, auditArea, broadcasts, downloads } = createHarness(runtime);

    const result = await controller.exportSession("S-1", "  passphrase-1  ", false, {
      includeScreenshots: true,
      includeScreenRecordings: false,
      maxArchiveBytes: 12_288,
      recentWindowMs: 300_000
    });

    expect(deps.stopSession).toHaveBeenCalledWith(7);
    expect(deps.flushBufferedPipelineEvents).toHaveBeenCalledWith(runtime);
    expect(deps.attachStoppedPipeline).toHaveBeenCalledWith(runtime);
    expect(pipeline.exportAndDownload).toHaveBeenCalledWith({
      passphrase: "passphrase-1",
      includeScreenshots: true,
      includeScreenRecordings: false,
      maxArchiveBytes: 12_288,
      recentWindowMs: 300_000
    });
    expect(downloads.download).toHaveBeenCalledWith({
      url: "blob:https://example.test/archive",
      filename: "webblackbox/session.wbbx",
      saveAs: false
    });

    const warning = {
      findingCount: 1,
      summary: "jwt in events.ndjson",
      findings: [{ kind: "jwt", path: "events.ndjson", matchCount: 2 }]
    };

    expect(result).toEqual({ ok: true, fileName: "session.wbbx", privacyWarning: warning });
    expect(broadcasts.at(-1)).toEqual({
      kind: "sw.export-status",
      sid: "S-1",
      ok: true,
      fileName: "session.wbbx",
      privacyWarning: warning
    });

    const events = storedAuditEvents(auditArea);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "ok",
      encrypted: true,
      sid: "S-1",
      sizeBytes: 4_096,
      downloadId: 42,
      includeScreenshots: true,
      includeScreenRecordings: false,
      maxArchiveBytes: 12_288,
      recentWindowMs: 300_000
    });

    // The default profile deletes the local copy after a successful export.
    expect(deps.disposeStoppedSession).toHaveBeenCalledWith(runtime);
  });

  it("keeps the stopped session when the profile keeps local data after export", async () => {
    const profile = createDefaultProfile();

    profile.localData = { deleteAfterExport: false, unexportedRetentionMinutes: 30 };

    const pipeline = createPipelineStub({
      exportAndDownload: vi.fn(async () => createExportResult())
    });
    const runtime = createRuntime({ pipeline, stoppedAt: 2_000 });
    runtime.profile = {
      ...runtime.profile,
      selection: { profile, source: "default", extended: false }
    };

    const { controller, deps } = createHarness(runtime);

    const result = await controller.exportSession("S-1", "passphrase-1");

    expect(result.ok).toBe(true);
    expect(deps.stopSession).not.toHaveBeenCalled();
    expect(deps.disposeStoppedSession).not.toHaveBeenCalled();
  });

  it("surfaces pipeline failures, audits them redacted and broadcasts the raw error", async () => {
    const pipeline = createPipelineStub({
      exportAndDownload: vi.fn(async () => {
        throw new Error("upload to https://example.test/hook?token=secret failed");
      })
    });
    const runtime = createRuntime({ pipeline });
    const { controller, auditArea, broadcasts } = createHarness(runtime);

    const result = await controller.exportSession("S-1", "passphrase-1");

    expect(result).toEqual({
      ok: false,
      error: "upload to https://example.test/hook?token=secret failed"
    });
    expect(broadcasts.at(-1)).toEqual({
      kind: "sw.export-status",
      sid: "S-1",
      ok: false,
      error: "upload to https://example.test/hook?token=secret failed"
    });

    const events = storedAuditEvents(auditArea);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "error",
      encrypted: true,
      error: "upload to [redacted-url] failed"
    });
  });
});
