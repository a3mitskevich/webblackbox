import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyEnterprisePolicyToRecorderConfig,
  createBoundedManagedPolicyReader,
  getSessionStartBlockReason,
  isEnterpriseOriginAllowed,
  normalizeEnterprisePolicy,
  readManagedEnterprisePolicy
} from "./options-storage.js";

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

describe("createBoundedManagedPolicyReader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A managed read that settles only when the test says so, like Chrome's while it starts up. */
  const deferredRead = () => {
    const resolvers: Array<(value: Record<string, unknown> | null) => void> = [];
    const read = vi.fn(
      () =>
        new Promise<Record<string, unknown> | null>((resolve) => {
          resolvers.push(resolve);
        })
    );

    return { read, settle: (value: Record<string, unknown> | null) => resolvers.shift()?.(value) };
  };

  it("returns the policy when the read answers in time", async () => {
    const readPolicy = createBoundedManagedPolicyReader(async () => ({ siteDenylist: ["a"] }), {
      timeoutMs: 1_000
    });

    await expect(readPolicy()).resolves.toEqual({ siteDenylist: ["a"] });
  });

  it("treats a failed read as no policy", async () => {
    const readPolicy = createBoundedManagedPolicyReader(
      () => Promise.reject(new Error("managed storage unavailable")),
      { timeoutMs: 1_000 }
    );

    await expect(readPolicy()).resolves.toBeNull();
  });

  it("gives up after the timeout without a policy and reports it", async () => {
    vi.useFakeTimers();
    const { read } = deferredRead();
    const onTimeout = vi.fn();
    const readPolicy = createBoundedManagedPolicyReader(read, { timeoutMs: 1_000, onTimeout });

    const result = readPolicy();
    await vi.advanceTimersByTimeAsync(999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeNull();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("shares one pending read and reads afresh once it settles", async () => {
    vi.useFakeTimers();
    const { read, settle } = deferredRead();
    const readPolicy = createBoundedManagedPolicyReader(read, { timeoutMs: 1_000 });

    const first = readPolicy();
    const second = readPolicy();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    // Still pending after the timeout: a later caller waits for the same read.
    const third = readPolicy();
    expect(read).toHaveBeenCalledTimes(1);

    settle({ siteAllowlist: ["late"] });
    await expect(third).resolves.toEqual({ siteAllowlist: ["late"] });

    const fourth = readPolicy();
    expect(read).toHaveBeenCalledTimes(2);
    settle({ siteAllowlist: ["fresh"] });
    await expect(fourth).resolves.toEqual({ siteAllowlist: ["fresh"] });
  });
});
