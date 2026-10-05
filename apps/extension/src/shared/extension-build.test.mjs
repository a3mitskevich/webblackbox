import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { runInNewContext } from "node:vm";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  contentScriptScopePlugin,
  wrapInScriptScope
} from "../../scripts/lib/content-script-scope.mjs";

import {
  createChromeArchive,
  createExtensionManifest,
  validateExtensionManifest
} from "../../scripts/lib/extension-build.mjs";
import {
  createManagedStorageSchema,
  MANAGED_CATEGORY_LEVELS,
  MANAGED_SCHEMA_FILE
} from "../../scripts/lib/managed-schema.mjs";
import { CAPTURE_CATEGORY_LEVELS } from "./profiles/categories.ts";

describe("managed storage schema", () => {
  it("is declared by every manifest profile", () => {
    for (const profile of ["dev", "store-safe"]) {
      const manifest = createExtensionManifest({ version: "1.0.0", profile });

      expect(manifest.storage).toEqual({ managed_schema: MANAGED_SCHEMA_FILE });
    }

    const manifest = createExtensionManifest({ version: "1.0.0" });
    delete manifest.storage;
    expect(validateExtensionManifest(manifest, { version: "1.0.0" })).toContain(
      `Manifest must declare storage.managed_schema = ${MANAGED_SCHEMA_FILE}.`
    );
  });

  it("keeps category enums in sync with the extension", () => {
    expect(MANAGED_CATEGORY_LEVELS).toEqual(CAPTURE_CATEGORY_LEVELS);
  });

  it("accepts profiles and rules in the scoped and flat layouts", () => {
    const schema = createManagedStorageSchema();

    for (const scope of [schema.properties, schema.properties.enterprisePolicy.properties]) {
      expect(scope.profiles.items.properties.categories.properties.console.enum).toContain("allow");
      expect(scope.rules.items.properties.match.properties.hosts.type).toBe("array");
      expect(scope.dataCategoryCaps.type).toBe("object");
    }
  });
});

describe("content script scope", () => {
  // A content script with a guard, as bundled: top-level `var` state, then the guard check.
  const guardedScript = `
    var state = { started: false };
    if (!globalThis.claimed) {
      globalThis.claimed = true;
      state.started = true;
      globalThis.readStarted = () => state.started;
    }
  `;

  it("keeps a second run in the same world from resetting the first run's state", () => {
    const bare = {};
    runInNewContext(guardedScript, bare);
    runInNewContext(guardedScript, bare);
    // Without a scope of its own the second run re-initialized the shared `var`.
    expect(bare.readStarted()).toBe(false);

    const scoped = {};
    runInNewContext(wrapInScriptScope(guardedScript), scoped);
    runInNewContext(wrapInScriptScope(guardedScript), scoped);
    expect(scoped.readStarted()).toBe(true);
  });

  it("wraps only content.js and keeps its line numbers", () => {
    const plugin = contentScriptScopePlugin();
    const code = "// module\nvar a = 1;\n//# sourceMappingURL=content.js.map";

    expect(plugin.renderChunk(code, { path: "/x/build/content-agent.js" })).toBeUndefined();
    expect(plugin.renderChunk(code, { path: "/x/build/sw.js" })).toBeUndefined();

    const wrapped = plugin.renderChunk(code, { path: "/x/build/content.js" })?.code ?? "";

    expect(wrapped.split("\n")[1]).toBe("var a = 1;");
    expect(wrapped.trimEnd().endsWith("})();")).toBe(true);
  });
});

describe("extension build manifest", () => {
  it("creates a development manifest with explicit CSP", () => {
    const manifest = createExtensionManifest({ version: "1.2.3" });

    expect(manifest.version).toBe("1.2.3");
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.key).toBeTypeOf("string");
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).toContain("tabCapture");
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'");
    expect(manifest.content_security_policy?.extension_pages).not.toContain("'unsafe-inline'");
    expect(validateExtensionManifest(manifest, { version: "1.2.3" })).toEqual([]);
  });

  it("leaves the content script to runtime registration in the development manifest", () => {
    const manifest = createExtensionManifest({ version: "1.2.3" });

    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest.permissions).toEqual(expect.arrayContaining(["scripting", "webNavigation"]));
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);

    const withStaticScript = {
      ...manifest,
      content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], all_frames: true }]
    };

    expect(validateExtensionManifest(withStaticScript, { version: "1.2.3" })).toContain(
      "Dev manifest must not declare static content_scripts; the service worker registers the content script at runtime."
    );

    const withoutNavigation = {
      ...manifest,
      permissions: manifest.permissions.filter((permission) => permission !== "webNavigation")
    };

    expect(validateExtensionManifest(withoutNavigation, { version: "1.2.3" })).toContain(
      "Dev manifest must include 'webNavigation' permission."
    );
  });

  it("creates a store-safe manifest without broad capture permissions", () => {
    const manifest = createExtensionManifest({
      version: "1.2.3",
      release: true,
      profile: "store-safe"
    });

    expect(manifest).not.toHaveProperty("key");
    expect(manifest.permissions).toContain("activeTab");
    expect(manifest.permissions).toContain("tabCapture");
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("webRequest");
    expect(manifest.permissions).not.toContain("webNavigation");
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(
      validateExtensionManifest(manifest, {
        version: "1.2.3",
        release: true,
        profile: "store-safe"
      })
    ).toEqual([]);
  });

  it("creates a release manifest without the development key", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });

    expect(manifest).not.toHaveProperty("key");
    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toEqual([]);
  });

  it("fails validation when explicit CSP is removed", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });

    delete manifest.content_security_policy;

    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toContain(
      "Manifest must declare an explicit content_security_policy.extension_pages."
    );
  });

  it("fails validation when inline styles are re-enabled in the CSP", () => {
    const manifest = createExtensionManifest({ version: "1.2.3", release: true });
    manifest.content_security_policy.extension_pages =
      "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;";

    expect(validateExtensionManifest(manifest, { version: "1.2.3", release: true })).toContain(
      "Manifest content_security_policy.extension_pages must not include 'unsafe-inline'."
    );
  });

  it("packages a release archive without the development key", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-build-test-"));
    const sourceDir = resolve(root, "build");
    const archivePath = resolve(root, "archive.zip");

    try {
      await writeBuildFixture(sourceDir, createExtensionManifest({ version: "1.2.3" }));

      const archive = await createChromeArchive({
        sourceDir,
        outputPath: archivePath
      });

      const zip = await JSZip.loadAsync(await readFile(archive.path));
      const packagedManifest = JSON.parse(await zip.file("manifest.json").async("text"));

      expect(archive.manifest.version).toBe("1.2.3");
      expect(archive.strippedKeys).toEqual(["key"]);
      expect(packagedManifest.version).toBe("1.2.3");
      expect(packagedManifest).not.toHaveProperty("key");
      expect(zip.file("popup.js")).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("packages store-safe archives without reintroducing broad permissions", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-store-test-"));
    const sourceDir = resolve(root, "build");
    const archivePath = resolve(root, "archive.zip");

    try {
      await writeBuildFixture(
        sourceDir,
        createExtensionManifest({
          version: "1.2.3",
          profile: "store-safe"
        })
      );

      const archive = await createChromeArchive({
        sourceDir,
        outputPath: archivePath
      });

      const zip = await JSZip.loadAsync(await readFile(archive.path));
      const packagedManifest = JSON.parse(await zip.file("manifest.json").async("text"));

      expect(packagedManifest).not.toHaveProperty("key");
      expect(packagedManifest.permissions).toContain("tabCapture");
      expect(packagedManifest.permissions).not.toContain("debugger");
      expect(packagedManifest.permissions).not.toContain("webRequest");
      expect(packagedManifest).not.toHaveProperty("host_permissions");
      expect(packagedManifest).not.toHaveProperty("content_scripts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeBuildFixture(outputDir, manifest) {
  const fixtureFiles = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    [MANAGED_SCHEMA_FILE]: `${JSON.stringify(createManagedStorageSchema())}\n`,
    "_locales/en/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "_locales/zh_CN/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "content-agent.js": "export {};\n",
    "content.js": "export {};\n",
    "injected.js": "export {};\n",
    "offscreen.html": "<!doctype html><title>offscreen</title>\n",
    "offscreen.js": "export {};\n",
    "options.html": "<!doctype html><title>options</title>\n",
    "options.js": "export {};\n",
    "popup.html": "<!doctype html><title>popup</title>\n",
    "popup.js": "export {};\n",
    "sessions.html": "<!doctype html><title>sessions</title>\n",
    "sessions.js": "export {};\n",
    "styles.css": "body{margin:0;}\n",
    "options.css": "main{margin:0;}\n",
    "sessions.css": "main{margin:0;}\n",
    "sw.js": "export {};\n",
    "icon/16.png": "icon",
    "icon/32.png": "icon",
    "icon/48.png": "icon",
    "icon/96.png": "icon",
    "icon/128.png": "icon"
  };

  await Promise.all(
    Object.entries(fixtureFiles).map(async ([relativePath, content]) => {
      const absolutePath = resolve(outputDir, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    })
  );
}

const CHROME_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "additionalProperties",
  "title",
  "description"
]);

describe("managed storage schema dialect", () => {
  it("only uses keywords and single types Chrome policy schemas support", () => {
    const visit = (node, path) => {
      for (const [key, value] of Object.entries(node)) {
        expect(CHROME_SCHEMA_KEYWORDS.has(key), `${path}.${key}`).toBe(true);

        if (key === "type") {
          expect(typeof value, `${path}.type`).toBe("string");
        }

        if (key === "properties") {
          for (const [name, child] of Object.entries(value)) {
            visit(child, `${path}.${name}`);
          }
        }

        if (key === "items" || key === "additionalProperties") {
          visit(value, `${path}.${key}`);
        }
      }
    };

    visit(createManagedStorageSchema(), "$");
  });
});
