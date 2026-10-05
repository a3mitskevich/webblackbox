import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  applyEnterprisePolicyToRecorderConfig,
  getSessionStartBlockReason,
  isEnterpriseOriginAllowed,
  migrateStoredRecorderConfig,
  normalizeEnterprisePolicy,
  OPTIONS_STORAGE_VERSION,
  readManagedEnterprisePolicy
} from "./options-storage.js";

describe("options-storage", () => {
  it("migrates legacy lite screenshot defaults back to the new runtime default", () => {
    const migrated = migrateStoredRecorderConfig({
      sampling: {
        screenshotIdleMs: 0,
        bodyCaptureMaxBytes: 0
      }
    });

    expect(migrated.optionsVersion).toBe(OPTIONS_STORAGE_VERSION);
    expect(migrated.sampling).toMatchObject({
      screenshotIdleMs: DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs,
      bodyCaptureMaxBytes: 0
    });
  });

  it("preserves explicit post-migration values", () => {
    const migrated = migrateStoredRecorderConfig({
      optionsVersion: OPTIONS_STORAGE_VERSION,
      sampling: {
        screenshotIdleMs: 0
      }
    });

    expect(migrated.sampling).toMatchObject({
      screenshotIdleMs: 0
    });
  });
});

describe("enterprise recorder policy", () => {
  it("normalizes managed site policy and category caps", () => {
    const policy = normalizeEnterprisePolicy({
      siteAllowlist: ["https://app.example", "*.trusted.example", ""],
      siteDenylist: ["https://admin.example"],
      dataCategoryCaps: {
        screenshots: "off",
        network: "metadata",
        cdp: "full",
        unknown: "allow"
      },
      disableLabMode: true,
      retention: {
        localTtlMs: 3600000,
        shareTtlMs: 7200000
      }
    });

    expect(isEnterpriseOriginAllowed("https://app.example", policy)).toBe(true);
    expect(isEnterpriseOriginAllowed("https://team.trusted.example", policy)).toBe(true);
    expect(isEnterpriseOriginAllowed("https://admin.example", policy)).toBe(false);
    expect(isEnterpriseOriginAllowed("https://other.example", policy)).toBe(false);
    expect(policy.dataCategoryCaps).toMatchObject({
      screenshots: "off",
      network: "metadata",
      cdp: "full"
    });
    expect(policy.retention.localTtlMs).toBe(3600000);
  });

  it("reports a tab without a web origin separately from an enterprise policy block", () => {
    const noPolicy = normalizeEnterprisePolicy({});
    const policy = normalizeEnterprisePolicy({ siteDenylist: ["https://admin.example"] });

    expect(getSessionStartBlockReason("https://app.example", noPolicy)).toBeNull();
    expect(getSessionStartBlockReason("", noPolicy)).toBe(
      "This tab has no web origin to record; open an http(s) page first."
    );
    expect(getSessionStartBlockReason("  ", policy)).toBe(
      "This tab has no web origin to record; open an http(s) page first."
    );
    expect(getSessionStartBlockReason("https://admin.example", policy)).toBe(
      "Recording is blocked by enterprise site policy."
    );
  });

  it("applies managed caps and disables lab-only capture", () => {
    const config = applyEnterprisePolicyToRecorderConfig(
      {
        ...DEFAULT_RECORDER_CONFIG,
        capturePolicy: {
          ...DEFAULT_RECORDER_CONFIG.capturePolicy!,
          mode: "lab",
          categories: {
            ...DEFAULT_RECORDER_CONFIG.capturePolicy!.categories,
            screenshots: "allow",
            network: "body-allowlist",
            cdp: "full",
            heapProfiles: "lab-only"
          }
        }
      },
      normalizeEnterprisePolicy({
        siteAllowlist: ["https://app.example"],
        siteDenylist: ["https://blocked.example"],
        dataCategoryCaps: {
          screenshots: "off",
          network: "metadata"
        },
        disableLabMode: true,
        retention: {
          localTtlMs: 60000
        }
      })
    );

    expect(config.capturePolicy?.mode).toBe("private");
    expect(config.capturePolicy?.scope.allowedOrigins).toEqual(["https://app.example"]);
    expect(config.capturePolicy?.scope.deniedOrigins).toContain("https://blocked.example");
    expect(config.capturePolicy?.categories.screenshots).toBe("off");
    expect(config.capturePolicy?.categories.network).toBe("metadata");
    expect(config.capturePolicy?.categories.cdp).toBe("off");
    expect(config.capturePolicy?.categories.heapProfiles).toBe("off");
    expect(config.capturePolicy?.retention.localTtlMs).toBe(60000);
  });

  it("does not broaden safer defaults when managed caps are more permissive", () => {
    const config = applyEnterprisePolicyToRecorderConfig(
      DEFAULT_RECORDER_CONFIG,
      normalizeEnterprisePolicy({
        dataCategoryCaps: {
          screenshots: "allow",
          network: "body-allowlist",
          storage: "allow",
          cdp: "full",
          heapProfiles: "lab-only"
        },
        retention: {
          localTtlMs: DEFAULT_RECORDER_CONFIG.capturePolicy!.retention.localTtlMs * 2
        }
      })
    );

    expect(config.capturePolicy?.categories.screenshots).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.screenshots
    );
    expect(config.capturePolicy?.categories.network).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.network
    );
    expect(config.capturePolicy?.categories.storage).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.storage
    );
    expect(config.capturePolicy?.categories.cdp).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.cdp
    );
    expect(config.capturePolicy?.categories.heapProfiles).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.categories.heapProfiles
    );
    expect(config.capturePolicy?.retention.localTtlMs).toBe(
      DEFAULT_RECORDER_CONFIG.capturePolicy?.retention.localTtlMs
    );
  });

  it("intersects storage name and length caps without introducing new detail", () => {
    const lengthsOnlyConfig = applyEnterprisePolicyToRecorderConfig(
      {
        ...DEFAULT_RECORDER_CONFIG,
        capturePolicy: {
          ...DEFAULT_RECORDER_CONFIG.capturePolicy!,
          categories: {
            ...DEFAULT_RECORDER_CONFIG.capturePolicy!.categories,
            storage: "lengths-only"
          }
        }
      },
      normalizeEnterprisePolicy({
        dataCategoryCaps: {
          storage: "names-only"
        }
      })
    );
    const namesOnlyConfig = applyEnterprisePolicyToRecorderConfig(
      {
        ...DEFAULT_RECORDER_CONFIG,
        capturePolicy: {
          ...DEFAULT_RECORDER_CONFIG.capturePolicy!,
          categories: {
            ...DEFAULT_RECORDER_CONFIG.capturePolicy!.categories,
            storage: "names-only"
          }
        }
      },
      normalizeEnterprisePolicy({
        dataCategoryCaps: {
          storage: "lengths-only"
        }
      })
    );

    expect(lengthsOnlyConfig.capturePolicy?.categories.storage).toBe("counts-only");
    expect(namesOnlyConfig.capturePolicy?.categories.storage).toBe("counts-only");
  });
});

describe("readManagedEnterprisePolicy", () => {
  const area = (values: Record<string, unknown>) => ({
    get: async (keys?: unknown) =>
      typeof keys === "string" ? (keys in values ? { [keys]: values[keys] } : {}) : values
  });

  it("reads scoped, flat and mixed layouts", async () => {
    await expect(
      readManagedEnterprisePolicy(area({ enterprisePolicy: { siteAllowlist: ["a"] } }))
    ).resolves.toEqual({ siteAllowlist: ["a"] });
    await expect(readManagedEnterprisePolicy(area({ siteDenylist: ["b"] }))).resolves.toEqual({
      siteDenylist: ["b"]
    });
    await expect(
      readManagedEnterprisePolicy(
        area({ enterprisePolicy: { siteAllowlist: ["a"] }, siteDenylist: ["b"] })
      )
    ).resolves.toEqual({ siteAllowlist: ["a"], siteDenylist: ["b"] });
  });

  it("never throws", async () => {
    await expect(readManagedEnterprisePolicy(undefined)).resolves.toBeNull();
    await expect(
      readManagedEnterprisePolicy({ get: async () => Promise.reject(new Error("no policy")) })
    ).resolves.toBeNull();
  });
});
