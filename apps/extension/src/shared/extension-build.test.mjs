import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  assertExtensionBuild,
  CLASSIC_SCRIPT_FILES,
  createManifestFields,
  isStrictScopedScript,
  profileForMode,
  validateExtensionManifest
} from "../../scripts/lib/extension-build.mjs";
import {
  createManagedStorageSchema,
  MANAGED_CATEGORY_LEVELS,
  MANAGED_SCHEMA_FILE
} from "../../scripts/lib/managed-schema.mjs";
import { EXTENSION_FILES } from "./extension-files.ts";
import { CAPTURE_CATEGORY_LEVELS } from "./profiles/categories.ts";

/** What WXT emits for the `manifest` of `wxt.config.ts`, the entrypoints and `package.json`. */
function wxtManifest(profile = "dev") {
  return {
    manifest_version: 3,
    ...createManifestFields({ profile }),
    version: "1.2.3",
    icons: { 16: "icon/16.png", 128: "icon/128.png" },
    background: { type: "module", service_worker: EXTENSION_FILES.serviceWorker },
    action: { default_title: "WebBlackbox", default_popup: EXTENSION_FILES.popupPage },
    options_ui: { open_in_tab: true, page: EXTENSION_FILES.optionsPage }
  };
}

describe("managed storage schema", () => {
  it("is declared by every manifest profile", () => {
    for (const profile of ["dev", "store-safe"]) {
      expect(createManifestFields({ profile }).storage).toEqual({
        managed_schema: MANAGED_SCHEMA_FILE
      });
    }

    expect(validateExtensionManifest({ ...wxtManifest(), storage: undefined })).toContain(
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
      expect(scope.playerUrl.type).toBe("string");
    }
  });
});

const asWxtIife = (code) => `(function(){"use strict";${code}})();\n`;

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
    runInNewContext(asWxtIife(guardedScript), scoped);
    runInNewContext(asWxtIife(guardedScript), scoped);
    expect(scoped.readStarted()).toBe(true);
  });

  it("keeps the page's own globals when the page hooks run in the MAIN world", () => {
    // `injected.js` runs as a classic script in the page; minified, its bindings are `$`, `N`…
    const minifiedHooks = "var $ = false; function N() {} class G {}";
    const jQuery = () => "jQuery";

    const bare = { $: jQuery };
    runInNewContext(minifiedHooks, bare);
    expect(bare.$).toBe(false);
    expect(bare).toHaveProperty("N");

    const scoped = { $: jQuery };
    runInNewContext(asWxtIife(minifiedHooks), scoped);
    expect(scoped.$).toBe(jQuery);
    expect(Object.keys(scoped)).toEqual(["$"]);
  });

  it("runs the bundle in strict mode, so a stray assignment cannot create a page global", () => {
    const sloppyAssignment = "leaked = 1;";

    const bare = {};
    runInNewContext(sloppyAssignment, bare);
    expect(bare).toHaveProperty("leaked", 1);

    const scoped = {};
    expect(() => runInNewContext(asWxtIife(sloppyAssignment), scoped)).toThrow(
      /leaked is not defined/
    );
    expect(scoped).not.toHaveProperty("leaked");
  });

  it("accepts only one anonymous strict-mode IIFE", () => {
    const map = "//# sourceMappingURL=content.js.map";

    expect(isStrictScopedScript(`${asWxtIife("var a=1;")}${map}`)).toBe(true);
    expect(isStrictScopedScript(`(() => { "use strict"; var a = 1; })();`)).toBe(true);
    // Scoped, but sloppy: a bundle built without the directive (before #50).
    expect(isStrictScopedScript(`(function(){var a=1;})();`)).toBe(false);
    // Strict, but the directive is not the body's first statement.
    expect(isStrictScopedScript(`(function(){var a=1;"use strict";})();`)).toBe(false);
    expect(isStrictScopedScript(`var a=1;${map}`)).toBe(false);
    expect(isStrictScopedScript("function N() {}")).toBe(false);
    expect(isStrictScopedScript("class G {}")).toBe(false);
    // Rolldown's `output.strict`: a named IIFE declares its name in the page.
    expect(isStrictScopedScript(`"use strict";var injected=${asWxtIife("")}`)).toBe(false);
    expect(isStrictScopedScript(`${asWxtIife("")}${asWxtIife("")}`)).toBe(false);
    expect(isStrictScopedScript("export {};")).toBe(false);
  });

  it("fails the build check when a classic script leaks top-level bindings", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "webblackbox-extension-scope-test-"));

    try {
      await writeBuildFixture(root, wxtManifest());
      await expect(assertExtensionBuild(root)).resolves.toBeTruthy();

      for (const file of CLASSIC_SCRIPT_FILES) {
        await writeBuildFixture(root, wxtManifest());
        await writeFile(resolve(root, file), "var $=!1;\n");
        await expect(assertExtensionBuild(root)).rejects.toThrow(file);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("extension manifest", () => {
  it("takes the profile from the WXT mode", () => {
    expect(profileForMode("production")).toBe("dev");
    expect(profileForMode("development")).toBe("dev");
    expect(profileForMode("store-safe")).toBe("store-safe");
    expect(() => createManifestFields({ profile: "firefox" })).toThrow(/firefox/);
  });

  it("leaves the version, icons and entrypoint fields to WXT", () => {
    const fields = createManifestFields();

    for (const field of [
      "manifest_version",
      "version",
      "icons",
      "background",
      "action",
      "options_ui",
      "options_page",
      "content_scripts",
      "web_accessible_resources",
      "key"
    ]) {
      expect(fields).not.toHaveProperty(field);
    }
  });

  it("accepts what WXT emits for both profiles", () => {
    expect(validateExtensionManifest(wxtManifest())).toEqual([]);
    expect(validateExtensionManifest(wxtManifest("store-safe"), { profile: "store-safe" })).toEqual(
      []
    );
  });

  it("keeps the dev profile's capture permissions and the store-safe profile's limits", () => {
    const dev = wxtManifest();

    expect(dev.permissions).toEqual(
      expect.arrayContaining(["debugger", "tabCapture", "scripting", "webNavigation"])
    );
    expect(dev.permissions).not.toContain("activeTab");
    expect(dev.permissions).not.toContain("cookies");
    expect(dev.host_permissions).toEqual(["<all_urls>"]);
    expect(
      validateExtensionManifest({
        ...dev,
        permissions: dev.permissions.filter((permission) => permission !== "webNavigation")
      })
    ).toContain(`permissions must be exactly: ${dev.permissions.join(", ")}.`);

    const storeSafe = wxtManifest("store-safe");

    expect(storeSafe.permissions).toContain("activeTab");
    for (const permission of ["debugger", "tabs", "webRequest", "webNavigation"]) {
      expect(storeSafe.permissions).not.toContain(permission);
    }
    expect(storeSafe).not.toHaveProperty("host_permissions");
    expect(
      validateExtensionManifest(
        { ...storeSafe, host_permissions: ["<all_urls>"] },
        { profile: "store-safe" }
      )
    ).toContain("Store-safe manifest must not declare host_permissions.");
  });

  it("rejects what a page could probe or what would inject the content script statically", () => {
    const manifest = wxtManifest();

    expect(
      validateExtensionManifest({
        ...manifest,
        web_accessible_resources: [{ resources: ["injected.js"], matches: ["<all_urls>"] }]
      })
    ).toContain("Manifest must not declare web_accessible_resources.");
    expect(
      validateExtensionManifest({
        ...manifest,
        content_scripts: [{ matches: ["<all_urls>"], js: [EXTENSION_FILES.contentScript] }]
      })
    ).toContain(
      "Manifest must not declare content_scripts: the service worker registers or injects the content script."
    );
  });

  it("keeps an explicit extension-page CSP without inline styles", () => {
    const manifest = wxtManifest();
    const csp = manifest.content_security_policy.extension_pages;

    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self';");
    expect(
      validateExtensionManifest({ ...manifest, content_security_policy: undefined })
    ).toContain("Manifest must declare content_security_policy.extension_pages.");
    expect(
      validateExtensionManifest({
        ...manifest,
        content_security_policy: {
          extension_pages: csp.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        }
      })
    ).toContain("content_security_policy.extension_pages must not include 'unsafe-inline'.");
  });

  it("lets the WXT dev server serve the pages' stylesheets during `wxt dev` only", () => {
    expect(
      createManifestFields({ command: "serve" }).content_security_policy.extension_pages
    ).toContain("style-src 'self' http://localhost:*;");
    expect(
      createManifestFields({ command: "build" }).content_security_policy.extension_pages
    ).not.toContain("localhost");
  });

  it("requires the service worker the e2e scripts and the build look for", () => {
    expect(
      validateExtensionManifest({
        ...wxtManifest(),
        background: { type: "module", service_worker: "sw.js" }
      })
    ).toContain(`background.service_worker must be ${EXTENSION_FILES.serviceWorker}.`);
  });
});

async function writeBuildFixture(outputDir, manifest) {
  const fixtureFiles = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    [MANAGED_SCHEMA_FILE]: `${JSON.stringify(createManagedStorageSchema())}\n`,
    "_locales/en/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "_locales/ru/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    "_locales/zh_CN/messages.json": '{"extensionName":{"message":"WebBlackbox"}}\n',
    ...Object.fromEntries(
      Object.values(EXTENSION_FILES).map((file) => [
        file,
        CLASSIC_SCRIPT_FILES.includes(file) ? asWxtIife("void 0;") : "export {};\n"
      ])
    )
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
