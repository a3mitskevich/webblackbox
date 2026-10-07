import {
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy,
  type RecorderConfig,
  type TabsContextLevel
} from "@webblackbox/protocol";

export const ENTERPRISE_POLICY_STORAGE_KEY = "enterprisePolicy";

type ManagedStorageArea = {
  get(keys?: string[] | string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
};

/**
 * Enterprise policy from `chrome.storage.managed`: the `enterprisePolicy` object, the flat
 * top-level layout the managed schema also accepts, or both (scoped keys win). Chrome returns
 * only the keys asked for, so the whole area is read. Never throws; null when unavailable.
 */
export async function readManagedEnterprisePolicy(
  managed: ManagedStorageArea | undefined,
  key: string = ENTERPRISE_POLICY_STORAGE_KEY
): Promise<Record<string, unknown> | null> {
  try {
    const values = await managed?.get(null);

    if (!values || typeof values !== "object") {
      return null;
    }

    const scoped = values[key];
    const flat = Object.fromEntries(Object.entries(values).filter(([entry]) => entry !== key));

    return scoped !== null && typeof scoped === "object" && !Array.isArray(scoped)
      ? { ...flat, ...(scoped as Record<string, unknown>) }
      : flat;
  } catch {
    return null;
  }
}

type ManagedPolicyRead = () => Promise<Record<string, unknown> | null>;

/**
 * Bounds the wait for the managed policy. With a `managed_schema` declared, Chrome answers
 * `storage.managed` only once it has set up the extension's policy domain, which it can postpone
 * for as long as a page opened at browser start keeps requests in flight. Callers then go on after
 * `timeoutMs` without a policy (as when the read fails) instead of hanging; concurrent callers share
 * the pending read, and the first call after it settles reads again.
 */
export function createBoundedManagedPolicyReader(
  read: ManagedPolicyRead,
  options: { timeoutMs: number; onTimeout?: () => void }
): ManagedPolicyRead {
  let pending: Promise<Record<string, unknown> | null> | null = null;

  return () => {
    if (!pending) {
      const current = read().finally(() => {
        if (pending === current) {
          pending = null;
        }
      });
      pending = current;
    }

    const shared = pending;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        options.onTimeout?.();
        resolve(null);
      }, options.timeoutMs);

      const settle = (value: Record<string, unknown> | null) => {
        clearTimeout(timer);
        resolve(value);
      };

      shared.then(settle, () => settle(null));
    });
  };
}

export type EnterpriseRecorderPolicy = {
  siteAllowlist: string[];
  siteDenylist: string[];
  dataCategoryCaps: Partial<CapturePolicy["categories"]>;
  disableLabMode: boolean;
  retention: {
    localTtlMs?: number;
    shareTtlMs?: number;
  };
};

export function normalizeEnterprisePolicy(value: unknown): EnterpriseRecorderPolicy {
  const record = asRecord(value);

  return {
    siteAllowlist: normalizeStringList(record?.siteAllowlist),
    siteDenylist: normalizeStringList(record?.siteDenylist),
    dataCategoryCaps: normalizeDataCategoryCaps(record?.dataCategoryCaps),
    disableLabMode: record?.disableLabMode === true,
    retention: normalizeRetentionPolicy(record?.retention)
  };
}

export function isEnterpriseOriginAllowed(
  origin: string,
  policy: EnterpriseRecorderPolicy
): boolean {
  const normalizedOrigin = origin.trim();

  if (normalizedOrigin.length === 0) {
    return false;
  }

  if (policy.siteDenylist.some((pattern) => matchesOriginPattern(normalizedOrigin, pattern))) {
    return false;
  }

  if (policy.siteAllowlist.length === 0) {
    return true;
  }

  return policy.siteAllowlist.some((pattern) => matchesOriginPattern(normalizedOrigin, pattern));
}

/** Why a session cannot start on `origin`, or null when it may. */
export function getSessionStartBlockReason(
  origin: string,
  policy: EnterpriseRecorderPolicy
): string | null {
  if (origin.trim().length === 0) {
    return "This tab has no web origin to record; open an http(s) page first.";
  }

  return isEnterpriseOriginAllowed(origin, policy)
    ? null
    : "Recording is blocked by enterprise site policy.";
}

export function applyEnterprisePolicyToRecorderConfig(
  config: RecorderConfig,
  policy: EnterpriseRecorderPolicy
): RecorderConfig {
  const basePolicy = config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy;
  const capturePolicy: CapturePolicy | undefined = basePolicy
    ? {
        ...basePolicy,
        mode: policy.disableLabMode && basePolicy.mode === "lab" ? "private" : basePolicy.mode,
        scope: {
          ...basePolicy.scope,
          allowedOrigins:
            policy.siteAllowlist.length > 0
              ? [...policy.siteAllowlist]
              : [...basePolicy.scope.allowedOrigins],
          deniedOrigins: [...new Set([...basePolicy.scope.deniedOrigins, ...policy.siteDenylist])]
        },
        categories: applyDataCategoryCaps(basePolicy.categories, {
          ...policy.dataCategoryCaps,
          ...(policy.disableLabMode
            ? {
                cdp: "off" as const,
                heapProfiles: "off" as const
              }
            : {})
        }),
        retention: applyRetentionCaps(basePolicy.retention, policy.retention)
      }
    : undefined;

  return {
    ...config,
    capturePolicy
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();

    if (!trimmed || output.includes(trimmed)) {
      continue;
    }

    output.push(trimmed);
  }

  return output;
}

function normalizeDataCategoryCaps(value: unknown): EnterpriseRecorderPolicy["dataCategoryCaps"] {
  const record = asRecord(value);

  if (!record) {
    return {};
  }

  const output: EnterpriseRecorderPolicy["dataCategoryCaps"] = {};

  setEnumCap(output, "actions", record.actions, ["metadata", "masked", "allow"]);
  setEnumCap(output, "inputs", record.inputs, ["none", "length-only", "masked", "allow"]);
  setEnumCap(output, "dom", record.dom, ["off", "wireframe", "masked", "allow"]);
  setEnumCap(output, "screenshots", record.screenshots, ["off", "masked", "allow"]);
  setEnumCap(output, "screenRecordings", record.screenRecordings, ["off", "allow"]);
  setEnumCap(output, "console", record.console, ["off", "metadata", "sanitized", "allow"]);
  setEnumCap(output, "network", record.network, [
    "metadata",
    "headers-allowlist",
    "body-allowlist"
  ]);
  setEnumCap(output, "storage", record.storage, [
    "off",
    "counts-only",
    "names-only",
    "lengths-only",
    "allow"
  ]);
  setEnumCap(output, "indexedDb", record.indexedDb, ["off", "counts-only", "names-only", "allow"]);
  setEnumCap(output, "cookies", record.cookies, ["off", "count-only", "names-only", "allow"]);
  setEnumCap(output, "cdp", record.cdp, ["off", "safe-subset", "full"]);
  setEnumCap(output, "heapProfiles", record.heapProfiles, ["off", "lab-only"]);
  setEnumCap(output, "tabsContext", record.tabsContext, ["off", "metadata", "allow"]);

  return output;
}

function setEnumCap<TKey extends keyof CapturePolicy["categories"]>(
  output: Partial<CapturePolicy["categories"]>,
  key: TKey,
  value: unknown,
  allowed: Array<CapturePolicy["categories"][TKey]>
): void {
  if (typeof value !== "string") {
    return;
  }

  if (allowed.includes(value as CapturePolicy["categories"][TKey])) {
    output[key] = value as CapturePolicy["categories"][TKey];
  }
}

function normalizeRetentionPolicy(value: unknown): EnterpriseRecorderPolicy["retention"] {
  const record = asRecord(value);

  if (!record) {
    return {};
  }

  return {
    localTtlMs: normalizePositiveInteger(record.localTtlMs),
    shareTtlMs: normalizePositiveInteger(record.shareTtlMs)
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function applyDataCategoryCaps(
  categories: CapturePolicy["categories"],
  caps: EnterpriseRecorderPolicy["dataCategoryCaps"]
): CapturePolicy["categories"] {
  return {
    actions: capEnum(categories.actions, caps.actions, ["metadata", "masked", "allow"]),
    inputs: capEnum(categories.inputs, caps.inputs, ["none", "length-only", "masked", "allow"]),
    dom: capEnum(categories.dom, caps.dom, ["off", "wireframe", "masked", "allow"]),
    screenshots: capEnum(categories.screenshots, caps.screenshots, ["off", "masked", "allow"]),
    screenRecordings: capEnum(categories.screenRecordings, caps.screenRecordings, ["off", "allow"]),
    console: capEnum(categories.console, caps.console, ["off", "metadata", "sanitized", "allow"]),
    network: capEnum(categories.network, caps.network, [
      "metadata",
      "headers-allowlist",
      "body-allowlist"
    ]),
    storage: capStorageCategory(categories.storage, caps.storage),
    indexedDb: capEnum(categories.indexedDb, caps.indexedDb, [
      "off",
      "counts-only",
      "names-only",
      "allow"
    ]),
    cookies: capEnum(categories.cookies, caps.cookies, [
      "off",
      "count-only",
      "names-only",
      "allow"
    ]),
    cdp: capEnum(categories.cdp, caps.cdp, ["off", "safe-subset", "full"]),
    heapProfiles: capEnum(categories.heapProfiles, caps.heapProfiles, ["off", "lab-only"]),
    tabsContext: capEnum<TabsContextLevel>(categories.tabsContext ?? "metadata", caps.tabsContext, [
      "off",
      "metadata",
      "allow"
    ])
  };
}

function capEnum<TValue extends string>(
  current: TValue,
  cap: TValue | undefined,
  orderedValues: readonly TValue[]
): TValue {
  if (!cap) {
    return current;
  }

  const currentIndex = orderedValues.indexOf(current);
  const capIndex = orderedValues.indexOf(cap);

  if (currentIndex < 0 || capIndex < 0) {
    return current;
  }

  return capIndex < currentIndex ? cap : current;
}

function capStorageCategory(
  current: CapturePolicy["categories"]["storage"],
  cap: CapturePolicy["categories"]["storage"] | undefined
): CapturePolicy["categories"]["storage"] {
  if (!cap || cap === "allow") {
    return current;
  }

  if (current === "allow") {
    return cap;
  }

  if (current === "off" || cap === "off") {
    return "off";
  }

  if (current === "counts-only" || cap === "counts-only") {
    return "counts-only";
  }

  if (current === cap) {
    return current;
  }

  return "counts-only";
}

function applyRetentionCaps(
  retention: CapturePolicy["retention"],
  caps: EnterpriseRecorderPolicy["retention"]
): CapturePolicy["retention"] {
  return {
    localTtlMs: capPositiveInteger(retention.localTtlMs, caps.localTtlMs) ?? retention.localTtlMs,
    shareTtlMs: capPositiveInteger(retention.shareTtlMs, caps.shareTtlMs)
  };
}

function capPositiveInteger(
  current: number | undefined,
  cap: number | undefined
): number | undefined {
  if (typeof cap !== "number") {
    return current;
  }

  if (typeof current !== "number") {
    return cap;
  }

  return Math.min(current, cap);
}

function matchesOriginPattern(origin: string, pattern: string): boolean {
  if (origin === pattern) {
    return true;
  }

  if (!pattern.startsWith("*.")) {
    return false;
  }

  try {
    const originHost = new URL(origin).hostname;
    const suffix = pattern.slice(2);
    return originHost === suffix || originHost.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
