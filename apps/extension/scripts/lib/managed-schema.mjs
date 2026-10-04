// Chrome `storage.managed_schema` for enterprise policy (chrome://policy). Without a schema Chrome
// never delivers managed storage to the extension. Chrome accepts only a JSON-schema subset
// (single `type`, properties, items, enum, minimum/maximum, additionalProperties, title,
// description). Keep enums in sync with src/shared/profiles/categories.ts
// (extension-build.test.mjs checks it).

export const MANAGED_SCHEMA_FILE = "managed-schema.json";

export const MANAGED_CATEGORY_LEVELS = {
  actions: ["metadata", "masked", "allow"],
  inputs: ["none", "length-only", "masked", "allow"],
  dom: ["off", "wireframe", "masked", "allow"],
  screenshots: ["off", "masked", "allow"],
  screenRecordings: ["off", "allow"],
  console: ["off", "metadata", "sanitized", "allow"],
  network: ["metadata", "headers-allowlist", "body-allowlist"],
  storage: ["off", "counts-only", "names-only", "lengths-only", "allow"],
  indexedDb: ["off", "counts-only", "names-only"],
  cookies: ["off", "count-only", "names-only"],
  cdp: ["off", "safe-subset", "full"],
  heapProfiles: ["off", "lab-only"]
};

const stringList = (description) => ({
  type: "array",
  description,
  items: { type: "string" }
});

const integer = (description, minimum = 0) => ({ type: "integer", minimum, description });

function categoriesSchema(description) {
  return {
    type: "object",
    description,
    properties: Object.fromEntries(
      Object.entries(MANAGED_CATEGORY_LEVELS).map(([key, levels]) => [
        key,
        { type: "string", enum: levels }
      ])
    )
  };
}

const redactionSchema = {
  type: "object",
  properties: {
    redactHeaders: stringList("Header names whose values are masked."),
    redactCookieNames: stringList("Cookie names whose values are masked."),
    redactBodyPatterns: stringList("Keys whose values are masked in bodies and payloads."),
    blockedSelectors: stringList("DOM selectors whose text and values are never recorded."),
    hashSensitiveValues: { type: "boolean" },
    unmaskSelectors: stringList("Selectors that stay readable; password fields never do.")
  }
};

const profileSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable id; shown to users as managed:<id>." },
    name: { type: "string" },
    description: { type: "string" },
    base: { type: "string", enum: ["lite", "full"] },
    categories: categoriesSchema("Capture level per data category."),
    redaction: redactionSchema,
    unmaskSelectors: stringList("Selectors that stay readable; password fields never do."),
    network: {
      type: "object",
      properties: {
        bodyMimeAllowlist: stringList("MIME types whose bodies may be captured."),
        bodyMaxBytes: integer("Max captured bytes per body."),
        includeUrls: stringList("URL globs whose bodies may be captured."),
        excludeUrls: stringList("URL globs whose bodies are never captured.")
      }
    },
    pointer: {
      type: "object",
      properties: {
        mousemoveHz: integer("Pointer sampling rate.", 1),
        hover: { type: "boolean" },
        drag: { type: "boolean" },
        wheel: { type: "boolean" }
      }
    },
    visual: { type: "string", enum: ["none", "screenshots", "recording", "both"] },
    sampling: {
      type: "object",
      properties: {
        mousemoveHz: integer("", 1),
        scrollHz: integer("", 1),
        domFlushMs: integer("", 1),
        screenshotIdleMs: integer(""),
        snapshotIntervalMs: integer("", 1),
        actionWindowMs: integer("", 1),
        bodyCaptureMaxBytes: integer("")
      }
    },
    recorder: {
      type: "object",
      properties: {
        ringBufferMinutes: integer("", 1),
        freezeOnError: { type: "boolean" }
      }
    },
    sitePolicies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          originPattern: { type: "string" },
          mode: { type: "string", enum: ["lite", "full"] },
          enabled: { type: "boolean" },
          allowBodyCapture: { type: "boolean" },
          bodyMimeAllowlist: stringList(""),
          pathAllowlist: stringList(""),
          pathDenylist: stringList("")
        }
      }
    },
    export: {
      type: "object",
      properties: {
        encryption: { type: "string", enum: ["required", "optional"] },
        privacyScanner: { type: "string", enum: ["block", "warn"] }
      }
    },
    localData: {
      type: "object",
      properties: {
        deleteAfterExport: { type: "boolean" },
        unexportedRetentionMinutes: { type: "integer", minimum: 1, maximum: 1440 }
      }
    }
  }
};

const ruleSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    profileId: {
      type: "string",
      description: "A managed profile id or a built-in preset (builtin:qa, builtin:full-capture …)."
    },
    priority: { type: "integer", minimum: -1000, maximum: 1000 },
    enabled: { type: "boolean" },
    match: {
      type: "object",
      properties: {
        hosts: stringList("Host globs: example.com, *.stage.example.com, localhost:*."),
        paths: stringList("Path globs: /admin/**."),
        query: {
          type: "object",
          description:
            "Query parameter -> exact value. Chrome policy schemas allow one type per field, so " +
            "presence-only matches (true) are only available in locally configured rules.",
          additionalProperties: { type: "string" }
        },
        titleRegex: { type: "string" },
        selectorPresent: { type: "string" },
        metaTag: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "string" } }
        },
        incognito: { type: "boolean" }
      }
    }
  }
};

const policyProperties = {
  siteAllowlist: stringList("Origins (or *.domain) where recording is allowed."),
  siteDenylist: stringList("Origins (or *.domain) where recording is blocked."),
  dataCategoryCaps: categoriesSchema("Ceiling for every profile's capture levels."),
  disableLabMode: { type: "boolean" },
  retention: {
    type: "object",
    properties: {
      localTtlMs: integer("", 1),
      shareTtlMs: integer("", 1)
    }
  },
  profiles: {
    type: "array",
    description: "Read-only recording profiles offered to users.",
    items: profileSchema
  },
  rules: {
    type: "array",
    description: "Site rules that select a profile (never start recording).",
    items: ruleSchema
  }
};

/** Accepts the scoped `enterprisePolicy` object and the legacy flat layout. */
export function createManagedStorageSchema() {
  return {
    type: "object",
    properties: {
      enterprisePolicy: {
        type: "object",
        title: "WebBlackbox enterprise policy",
        properties: structuredClone(policyProperties)
      },
      ...structuredClone(policyProperties)
    }
  };
}
