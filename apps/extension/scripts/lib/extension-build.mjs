import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAst } from "vite";

import { EXTENSION_FILES } from "../../src/shared/extension-files.ts";
import { MANAGED_SCHEMA_FILE } from "./managed-schema.mjs";

/** `dev` (default build, the full permission set) or `store-safe` (`wxt build --mode store-safe`). */
export const EXTENSION_MANIFEST_PROFILES = ["dev", "store-safe"];

const EXTENSION_MINIMUM_CHROME_VERSION = "125";
const EXTENSION_PAGE_CSP =
  "script-src 'self'; object-src 'self'; style-src 'self'; img-src 'self' data:;";

// Cookie snapshots are collected through the CDP Storage domain via `debugger`,
// and persistent host access comes from `<all_urls>`, so neither `cookies`
// nor `activeTab` belongs in the dev/enterprise permission set.
// The content script is not declared here: the service worker registers it with
// `scripting.registerContentScripts` ("always" injection) or injects it on Start and re-injects
// it into each committed frame of a recorded tab (`webNavigation`, "on-start" injection).
// `<all_urls>` stays: webRequest, executeScript, registerContentScripts and captureVisibleTab
// all need host access.
const DEV_PERMISSIONS = [
  "alarms",
  "debugger",
  "downloads",
  "offscreen",
  "scripting",
  "storage",
  "tabCapture",
  "tabs",
  "webNavigation",
  "webRequest"
];
const STORE_SAFE_PERMISSIONS = [
  "activeTab",
  "alarms",
  "downloads",
  "offscreen",
  "scripting",
  "storage",
  "tabCapture"
];
const URL_MATCHES = ["<all_urls>"];

/**
 * Bundles Chrome runs as classic scripts in a page: the content script and the capture agent in
 * the isolated world, the page hooks and the rrweb DOM recorder in the MAIN world.
 */
export const CLASSIC_SCRIPT_FILES = Object.freeze([
  EXTENSION_FILES.contentScript,
  EXTENSION_FILES.contentAgent,
  EXTENSION_FILES.injectedHooks,
  EXTENSION_FILES.domRecorder
]);

const REQUIRED_BUILD_FILES = [
  "manifest.json",
  MANAGED_SCHEMA_FILE,
  "_locales/en/messages.json",
  "_locales/ru/messages.json",
  "_locales/zh_CN/messages.json",
  ...Object.values(EXTENSION_FILES)
];

/**
 * The extension's profile for a WXT mode: `store-safe` for `--mode store-safe`, else `dev`.
 *
 * @param {string} mode
 * @returns {"dev" | "store-safe"}
 */
export function profileForMode(mode) {
  return mode === "store-safe" ? "store-safe" : "dev";
}

/**
 * The `manifest` of `wxt.config.ts`. WXT adds the rest: `manifest_version`, `version` (from
 * `package.json`), `icons` (from `public/icon/`), and the entrypoints' fields (`background`,
 * `action`, `options_ui`).
 *
 * @param {{ profile?: string, command?: string }} [options]
 */
export function createManifestFields({ profile = "dev", command = "build" } = {}) {
  const storeSafe = normalizeManifestProfile(profile) === "store-safe";

  return {
    default_locale: "en",
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    minimum_chrome_version: EXTENSION_MINIMUM_CHROME_VERSION,
    permissions: storeSafe ? [...STORE_SAFE_PERMISSIONS] : [...DEV_PERMISSIONS],
    ...(storeSafe ? {} : { host_permissions: [...URL_MATCHES] }),
    storage: {
      managed_schema: MANAGED_SCHEMA_FILE
    },
    content_security_policy: {
      // `wxt dev` serves the pages' stylesheets from its dev server; WXT adds that server to
      // `script-src` only.
      extension_pages:
        command === "serve"
          ? EXTENSION_PAGE_CSP.replace("style-src 'self'", "style-src 'self' http://localhost:*")
          : EXTENSION_PAGE_CSP
    },
    commands: {
      "mark-bug": {
        description: "__MSG_extensionCommandMarkBug__",
        suggested_key: {
          default: "Ctrl+Shift+M",
          mac: "Command+Shift+M"
        }
      }
    }
  };
}

/**
 * What recording depends on in a built manifest; the rest is WXT's. Returns the problems found.
 *
 * @param {Record<string, any>} manifest
 * @param {{ profile?: string }} [options]
 * @returns {string[]}
 */
export function validateExtensionManifest(manifest, { profile = "dev" } = {}) {
  const issues = [];
  const storeSafe = normalizeManifestProfile(profile) === "store-safe";
  const expectedPermissions = storeSafe ? STORE_SAFE_PERMISSIONS : DEV_PERMISSIONS;

  if (manifest?.manifest_version !== 3) {
    issues.push("manifest_version must be 3.");
  }

  if (!sameSet(manifest?.permissions, expectedPermissions)) {
    issues.push(`permissions must be exactly: ${expectedPermissions.join(", ")}.`);
  }

  if (!sameSet(manifest?.host_permissions ?? [], storeSafe ? [] : URL_MATCHES)) {
    issues.push(
      storeSafe
        ? "Store-safe manifest must not declare host_permissions."
        : "host_permissions must be exactly <all_urls>."
    );
  }

  const extensionPagesCsp = manifest?.content_security_policy?.extension_pages;
  if (typeof extensionPagesCsp !== "string" || !extensionPagesCsp.includes("script-src 'self'")) {
    issues.push("Manifest must declare content_security_policy.extension_pages.");
  } else if (extensionPagesCsp.includes("'unsafe-inline'")) {
    issues.push("content_security_policy.extension_pages must not include 'unsafe-inline'.");
  }

  // `executeScript({ files })` needs no web-accessible resource, and a page can probe each one.
  if (manifest?.web_accessible_resources !== undefined) {
    issues.push("Manifest must not declare web_accessible_resources.");
  }

  if (manifest?.content_scripts !== undefined) {
    issues.push(
      "Manifest must not declare content_scripts: the service worker registers or injects the content script."
    );
  }

  if (manifest?.storage?.managed_schema !== MANAGED_SCHEMA_FILE) {
    issues.push(`Manifest must declare storage.managed_schema = ${MANAGED_SCHEMA_FILE}.`);
  }

  if (manifest?.background?.service_worker !== EXTENSION_FILES.serviceWorker) {
    issues.push(`background.service_worker must be ${EXTENSION_FILES.serviceWorker}.`);
  }

  return issues;
}

/**
 * Checks a WXT build: the files the extension opens or injects by path exist, the manifest is
 * valid for its profile, and every classic script is one strict-mode anonymous IIFE.
 *
 * @param {string} outputDir
 * @param {{ profile?: string }} [options]
 */
export async function assertExtensionBuild(outputDir, { profile = "dev" } = {}) {
  await Promise.all(
    REQUIRED_BUILD_FILES.map((file) => access(resolve(outputDir, file), constants.R_OK))
  );

  const manifest = JSON.parse(await readFile(resolve(outputDir, "manifest.json"), "utf8"));
  const issues = validateExtensionManifest(manifest, { profile });

  if (issues.length > 0) {
    throw new Error(`Build output manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  await assertClassicScriptsScoped(outputDir);
  return manifest;
}

/**
 * Whether a classic script is one anonymous IIFE whose body starts in strict mode. Without its
 * own scope every top-level `var`, `function` and `class` of a bundle becomes a global of the
 * world it runs in:
 * - in the isolated world a second run of the same file (the registered copy plus one injected on
 *   Start or after a navigation) re-initializes the running copy's state before the script's own
 *   guard can stop it;
 * - in the page's MAIN world the minified names (`$`, `N`, `_t`…) overwrite the page's own globals,
 *   e.g. jQuery's `$` (#48).
 * Strict mode makes an assignment to an undeclared name throw instead of creating such a global
 * (#50). WXT bundles unlisted scripts as an anonymous IIFE; `wxt.config.ts` adds the directive.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isStrictScopedScript(code) {
  const statements = parseAst(code).body;
  const [statement] = statements;

  if (statements.length !== 1 || statement?.type !== "ExpressionStatement") {
    return false;
  }

  const call = statement.expression;
  const callee = call.type === "CallExpression" ? call.callee : null;
  const isFunction =
    callee?.type === "FunctionExpression" || callee?.type === "ArrowFunctionExpression";

  return isFunction && callee.body?.body?.[0]?.directive === "use strict";
}

async function assertClassicScriptsScoped(outputDir) {
  const unscoped = [];

  for (const file of CLASSIC_SCRIPT_FILES) {
    if (!isStrictScopedScript(await readFile(resolve(outputDir, file), "utf8"))) {
      unscoped.push(file);
    }
  }

  if (unscoped.length > 0) {
    throw new Error(
      `Classic scripts must be one anonymous strict-mode IIFE (wxt.config.ts): ${unscoped.join(", ")}`
    );
  }
}

function sameSet(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    expected.every((entry) => value.includes(entry))
  );
}

function normalizeManifestProfile(profile) {
  if (EXTENSION_MANIFEST_PROFILES.includes(profile)) {
    return profile;
  }

  throw new Error(`Unknown extension manifest profile: ${profile}`);
}
