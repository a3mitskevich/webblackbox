import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseAst } from "vite";

import { MANAGED_SCHEMA_FILE } from "./managed-schema.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const appRoot = resolve(scriptDir, "..", "..");
export const buildDir = resolve(appRoot, "build");
export const distDir = resolve(appRoot, "dist");
export const packageJsonPath = resolve(appRoot, "package.json");

const EXTENSION_DEFAULT_LOCALE = "en";
const EXTENSION_NAME = "__MSG_extensionName__";
const EXTENSION_DESCRIPTION = "__MSG_extensionDescription__";
const EXTENSION_ARCHIVE_NAME = "WebBlackbox";
const EXTENSION_ARCHIVE_SLUG = "webblackbox";
const EXTENSION_MINIMUM_CHROME_VERSION = "125";
const EXTENSION_DEVELOPMENT_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2HDVz1RBsIjEKY/KUOuP3glU4SmMUtvdXXER0JV9mksg6cufsMXUwPpzj7M4aCqCPMV8NkMhRHuGEumnDx/lhc/UI1OUyGpMSP2DSozID5w1s6NY2NbBERcNe0QPwlG9DBkZHHrSXycAHBK8IOaGcsju3Dzmbxr9RI7boLVE0dchdo5bt9tyOxT6LQL1ZlQOgErRf2pSQpU/dqngQ0Wd3/rj5aZ9c04TkycJrXq1FBY4uBiUdFOjuQ6djW4UtJsudYuDaqZ5PsRErilDAbWttkQsN7w5lS7aJANEU/83nIyz8YZ56vn1P1wBqWOxJ2CsyW/lFJdKjgZor6AS5AWCRQIDAQAB";
const EXTENSION_PAGE_CSP =
  "script-src 'self'; object-src 'self'; style-src 'self'; img-src 'self' data:;";
const REQUIRED_BUILD_FILES = [
  "manifest.json",
  MANAGED_SCHEMA_FILE,
  "_locales/en/messages.json",
  "_locales/ru/messages.json",
  "_locales/zh_CN/messages.json",
  "content.js",
  "content-agent.js",
  "injected.js",
  "offscreen.html",
  "offscreen.js",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "sessions.html",
  "sessions.js",
  "styles.css",
  "options.css",
  "sessions.css",
  "sw.js",
  "icon/16.png",
  "icon/32.png",
  "icon/48.png",
  "icon/96.png",
  "icon/128.png"
];

export const EXTENSION_MANIFEST_PROFILES = ["dev", "store-safe"];

/**
 * Bundles Chrome runs as classic scripts: `content.js`, the content script (isolated world), and
 * `injected.js`, the page hooks injected with `scripting.executeScript({ world: "MAIN", files })`.
 */
export const CLASSIC_SCRIPT_CHUNKS = Object.freeze(["content.js", "injected.js"]);

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
const ARCHIVE_FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const ARCHIVE_EXCLUDED_FILE_NAMES = new Set([".DS_Store"]);

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function readAppPackage() {
  return readJson(packageJsonPath);
}

/**
 * Profile and release flag of a build. `scripts/build-extension.mjs` sets them for `wxt build`;
 * without them a build is the development profile with the development key.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ profile: string, release: boolean }}
 */
export function readBuildTarget(env) {
  return {
    profile: normalizeManifestProfile(env.WB_EXTENSION_PROFILE || "dev"),
    release: env.WB_EXTENSION_RELEASE === "1"
  };
}

/**
 * WXT empties its output directory before every build (`rm -r`). Refuses a directory that would
 * take more than a previous build with it: the app itself or one of its parents, or (other than
 * `build/`) a non-empty directory without a `manifest.json`.
 *
 * @param {string} outputDir absolute path
 */
export async function assertDisposableOutputDir(outputDir) {
  const appFromOutput = relative(outputDir, appRoot);

  if (
    appFromOutput === "" ||
    (appFromOutput.split(sep)[0] !== ".." && !isAbsolute(appFromOutput))
  ) {
    throw new Error(
      `Refusing to build into ${outputDir}: WXT empties it first and it contains ${appRoot}.`
    );
  }

  if (outputDir === buildDir) {
    return;
  }

  const entries = await readdir(outputDir).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  if (entries.length > 0 && !entries.includes("manifest.json")) {
    throw new Error(
      `Refusing to build into ${outputDir}: WXT empties it first and it is not an extension build. Pass an empty or new directory.`
    );
  }
}

/**
 * The manifest fields WXT takes from `wxt.config.ts`. WXT adds `manifest_version`, `version` (from
 * `package.json`) and the fields of the entrypoints: `background`, `action.default_popup` and the
 * options page ({@link normalizeWxtManifest} keeps them as before WXT).
 */
export function createManifestFields({ release = false, profile = "dev" } = {}) {
  const normalizedProfile = normalizeManifestProfile(profile);
  const storeSafe = normalizedProfile === "store-safe";

  return {
    default_locale: EXTENSION_DEFAULT_LOCALE,
    name: EXTENSION_NAME,
    description: EXTENSION_DESCRIPTION,
    ...(release ? {} : { key: EXTENSION_DEVELOPMENT_KEY }),
    minimum_chrome_version: EXTENSION_MINIMUM_CHROME_VERSION,
    permissions: storeSafe ? [...STORE_SAFE_PERMISSIONS] : [...DEV_PERMISSIONS],
    ...(storeSafe ? {} : { host_permissions: [...URL_MATCHES] }),
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      96: "icon/96.png",
      128: "icon/128.png"
    },
    action: {
      default_title: "__MSG_extensionActionTitle__",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png"
      }
    },
    storage: {
      managed_schema: MANAGED_SCHEMA_FILE
    },
    web_accessible_resources: [
      {
        resources: ["content-agent.js", "injected.js"],
        matches: [...URL_MATCHES]
      }
    ],
    content_security_policy: {
      extension_pages: EXTENSION_PAGE_CSP
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
 * The manifest a build must emit. `assertExtensionBuild` compares the built `manifest.json` with
 * it, so a WXT upgrade that changes a field WXT derives fails the build instead of shipping.
 */
export function createExtensionManifest({ version, release = false, profile = "dev" }) {
  const { action, ...fields } = createManifestFields({ release, profile });

  return {
    manifest_version: 3,
    ...fields,
    version,
    background: {
      service_worker: "sw.js",
      type: "module"
    },
    action: { ...action, default_popup: "popup.html" },
    options_page: "options.html"
  };
}

/**
 * `build:manifestGenerated` hook: turns WXT's conventions back into the manifest of the build
 * before WXT. WXT passes the manifest by reference, so this updates it in place.
 * - the service worker keeps its file name `sw.js` (WXT names it after the entrypoint);
 * - the options page stays `options_page`, opened in a tab, not an embedded `options_ui`;
 * - the action title stays the localized one: WXT replaces it with the popup's `<title>`.
 *
 * @param {Record<string, any>} manifest
 * @param {{ release?: boolean, profile?: string }} target
 */
export function normalizeWxtManifest(manifest, target) {
  const fields = createManifestFields(target);
  const optionsPage = manifest.options_ui?.page;

  if (typeof optionsPage !== "string") {
    throw new Error("WXT did not emit the options page in options_ui.page.");
  }

  delete manifest.options_ui;
  manifest.options_page = optionsPage;
  manifest.background = { ...manifest.background, service_worker: "sw.js" };
  manifest.action = { ...manifest.action, default_title: fields.action.default_title };
}

export function validateExtensionManifest(
  manifest,
  { version, release = false, profile = "dev" } = {}
) {
  const issues = [];
  const normalizedProfile = normalizeManifestProfile(profile);
  const storeSafe = normalizedProfile === "store-safe";

  if (manifest?.manifest_version !== 3) {
    issues.push("manifest_version must be 3.");
  }

  if (manifest?.default_locale !== EXTENSION_DEFAULT_LOCALE) {
    issues.push(`default_locale must be ${EXTENSION_DEFAULT_LOCALE}.`);
  }

  if (version && manifest?.version !== version) {
    issues.push(`Manifest version must match package version ${version}.`);
  }

  if (release && Object.hasOwn(manifest ?? {}, "key")) {
    issues.push("Release manifest must not include the extension key.");
  }

  if (!release && typeof manifest?.key !== "string") {
    issues.push("Development manifest must include the extension key.");
  }

  const extensionPagesCsp = manifest?.content_security_policy?.extension_pages;
  if (typeof extensionPagesCsp !== "string" || extensionPagesCsp.length === 0) {
    issues.push("Manifest must declare an explicit content_security_policy.extension_pages.");
  } else if (extensionPagesCsp.includes("'unsafe-inline'")) {
    issues.push(
      "Manifest content_security_policy.extension_pages must not include 'unsafe-inline'."
    );
  }

  const webAccessibleResources = manifest?.web_accessible_resources;
  const injectedResources =
    Array.isArray(webAccessibleResources) && webAccessibleResources.length === 1
      ? webAccessibleResources[0]?.resources
      : null;

  if (
    !Array.isArray(injectedResources) ||
    injectedResources.join(",") !== "content-agent.js,injected.js"
  ) {
    issues.push("Manifest must only expose content-agent.js and injected.js as web resources.");
  }

  if (manifest?.storage?.managed_schema !== MANAGED_SCHEMA_FILE) {
    issues.push(`Manifest must declare storage.managed_schema = ${MANAGED_SCHEMA_FILE}.`);
  }

  validateUniqueStringArray(manifest?.permissions, "permissions", issues);

  if (storeSafe) {
    validateStoreSafeManifest(manifest, issues);
  } else {
    validateUniqueStringArray(manifest?.host_permissions, "host_permissions", issues);
    validateDevManifest(manifest, issues);
  }

  return issues;
}

export async function assertExtensionBuild(outputDir, { version, release = false, profile } = {}) {
  await Promise.all(
    REQUIRED_BUILD_FILES.map((file) => access(resolve(outputDir, file), constants.R_OK))
  );

  const manifest = await readJson(resolve(outputDir, "manifest.json"));
  const resolvedProfile = profile ?? inferManifestProfile(manifest);
  const resolvedVersion = version ?? (await readAppPackage()).version;
  const issues = validateExtensionManifest(manifest, {
    version: resolvedVersion,
    release,
    profile: resolvedProfile
  });

  if (issues.length > 0) {
    throw new Error(`Build output manifest is invalid:\n- ${issues.join("\n- ")}`);
  }

  assertManifestMatches(
    manifest,
    createExtensionManifest({ version: resolvedVersion, release, profile: resolvedProfile })
  );
  await assertClassicScriptsScoped(outputDir);
  return manifest;
}

function assertManifestMatches(manifest, expected) {
  const keys = [...new Set([...Object.keys(manifest), ...Object.keys(expected)])];
  const differing = keys.filter((key) => !isDeepStrictEqual(manifest[key], expected[key]));

  if (differing.length > 0) {
    throw new Error(
      `Build output manifest differs from createExtensionManifest() in: ${differing.join(", ")}`
    );
  }
}

/**
 * Whether a classic script declares anything at its top level. Without its own scope every
 * top-level `var`, `function` and `class` of a bundle becomes a global of the world it runs in:
 * - in the isolated world a second run of the same file (the registered copy plus one injected on
 *   Start or after a navigation) re-initializes the running copy's state before the script's own
 *   guard can stop it;
 * - in the page's MAIN world the minified names (`$`, `N`, `_t`…) overwrite the page's own globals,
 *   e.g. jQuery's `$` (#48).
 * WXT bundles unlisted scripts as an anonymous IIFE, a single expression statement.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function declaresTopLevelBindings(code) {
  return parseAst(code).body.some((node) => node.type !== "ExpressionStatement");
}

async function assertClassicScriptsScoped(outputDir) {
  const unscoped = [];

  for (const file of CLASSIC_SCRIPT_CHUNKS) {
    if (declaresTopLevelBindings(await readFile(resolve(outputDir, file), "utf8"))) {
      unscoped.push(file);
    }
  }

  if (unscoped.length > 0) {
    throw new Error(`Classic scripts must not declare top-level bindings: ${unscoped.join(", ")}`);
  }
}

export async function createChromeArchive({ sourceDir = buildDir, outputPath } = {}) {
  await stat(sourceDir);

  const sourceManifest = await readJson(resolve(sourceDir, "manifest.json"));
  const version =
    typeof sourceManifest?.version === "string" && sourceManifest.version.length > 0
      ? sourceManifest.version
      : null;
  const sourceReleaseBuild = !Object.hasOwn(sourceManifest ?? {}, "key");
  const sourceProfile = inferManifestProfile(sourceManifest);

  if (!version) {
    throw new Error(`Missing manifest version in ${resolve(sourceDir, "manifest.json")}`);
  }

  await assertExtensionBuild(sourceDir, {
    version,
    release: sourceReleaseBuild,
    profile: sourceProfile
  });

  // The release manifest is the built one without the development key.
  const releaseManifest = Object.fromEntries(
    Object.entries(sourceManifest).filter(([field]) => field !== "key")
  );
  const releaseIssues = validateExtensionManifest(releaseManifest, {
    version,
    release: true,
    profile: sourceProfile
  });

  if (releaseIssues.length > 0) {
    throw new Error(`Release manifest is invalid:\n- ${releaseIssues.join("\n- ")}`);
  }

  const archiveSlug = slugify(EXTENSION_ARCHIVE_SLUG);
  const resolvedOutputPath = outputPath
    ? resolve(process.cwd(), outputPath)
    : resolve(distDir, `${archiveSlug}-${version}-chrome.zip`);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await mkdir(distDir, { recursive: true });

  if (!outputPath) {
    await removeStaleArchives(distDir, archiveSlug, resolvedOutputPath);
  }

  await rm(resolvedOutputPath, { force: true });

  const zip = new JSZip();
  const files = await listPackagedFiles(sourceDir);
  const releaseManifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

  for (const relativePath of files) {
    const bytes =
      relativePath === "manifest.json"
        ? releaseManifestBytes
        : await readFile(resolve(sourceDir, relativePath));

    zip.file(relativePath, bytes, {
      binary: true,
      date: ARCHIVE_FIXED_DATE
    });
  }

  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    },
    platform: "UNIX"
  });

  await writeFile(resolvedOutputPath, archiveBytes);

  const archiveStat = await stat(resolvedOutputPath);

  return {
    path: resolvedOutputPath,
    bytes: archiveStat.size,
    manifest: {
      name: EXTENSION_ARCHIVE_NAME,
      version: releaseManifest.version
    },
    strippedKeys: Object.hasOwn(sourceManifest ?? {}, "key") ? ["key"] : []
  };
}

function validateUniqueStringArray(value, fieldName, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${fieldName} must be an array.`);
    return;
  }

  const seen = new Set();

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push(`${fieldName} must only contain non-empty strings.`);
      continue;
    }

    if (seen.has(entry)) {
      issues.push(`${fieldName} must not contain duplicate value '${entry}'.`);
      continue;
    }

    seen.add(entry);
  }
}

function validateStoreSafeManifest(manifest, issues) {
  const permissions = new Set(manifest?.permissions ?? []);

  if (permissions.has("debugger")) {
    issues.push("Store-safe manifest must not request the debugger permission.");
  }

  if (permissions.has("tabs") || permissions.has("webRequest")) {
    issues.push("Store-safe manifest must not request persistent tabs or webRequest access.");
  }

  if (!permissions.has("activeTab")) {
    issues.push("Store-safe manifest must request activeTab for user-gesture scoped capture.");
  }

  if (Array.isArray(manifest?.host_permissions) && manifest.host_permissions.length > 0) {
    issues.push("Store-safe manifest must not declare persistent host_permissions.");
  }

  if (Array.isArray(manifest?.content_scripts) && manifest.content_scripts.length > 0) {
    issues.push("Store-safe manifest must not declare static content_scripts.");
  }
}

function validateDevManifest(manifest, issues) {
  const permissions = new Set(manifest?.permissions ?? []);

  for (const permission of DEV_PERMISSIONS) {
    if (!permissions.has(permission)) {
      issues.push(`Dev manifest must include '${permission}' permission.`);
    }
  }

  if (!Array.isArray(manifest?.host_permissions)) {
    return;
  }

  if (!manifest.host_permissions.includes("<all_urls>")) {
    issues.push("Dev manifest must include <all_urls> host permission.");
  }

  if (Array.isArray(manifest?.content_scripts) && manifest.content_scripts.length > 0) {
    issues.push(
      "Dev manifest must not declare static content_scripts; the service worker registers the content script at runtime."
    );
  }
}

function normalizeManifestProfile(profile) {
  if (EXTENSION_MANIFEST_PROFILES.includes(profile)) {
    return profile;
  }

  throw new Error(`Unknown extension manifest profile: ${profile}`);
}

function inferManifestProfile(manifest) {
  const permissions = new Set(manifest?.permissions ?? []);
  const hasHostPermissions =
    Array.isArray(manifest?.host_permissions) && manifest.host_permissions.length > 0;
  const hasContentScripts =
    Array.isArray(manifest?.content_scripts) && manifest.content_scripts.length > 0;

  if (!permissions.has("debugger") && !hasHostPermissions && !hasContentScripts) {
    return "store-safe";
  }

  return "dev";
}

async function removeStaleArchives(directory, slug, keepPath) {
  const entries = await readdir(directory).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${slug}-`) && entry.endsWith("-chrome.zip"))
      .map(async (entry) => {
        const candidatePath = resolve(directory, entry);

        if (candidatePath === keepPath) {
          return;
        }

        await rm(candidatePath, { force: true });
      })
  );
}

async function listPackagedFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listPackagedFiles(rootDir, absolutePath)));
      continue;
    }

    if (!entry.isFile() || shouldSkipPackagedFile(entry.name)) {
      continue;
    }

    files.push(relative(rootDir, absolutePath).split(sep).join("/"));
  }

  return files;
}

function shouldSkipPackagedFile(fileName) {
  return ARCHIVE_EXCLUDED_FILE_NAMES.has(fileName) || fileName.endsWith(".map");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
