import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { devCsp, parseCsp, readCsp, strictStyleCsp, withCsp } from "../scripts/lib/csp-policy.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
// Vite's HTML entry; the build copies it (with hashed asset links) to build/index.html.
const indexPath = resolve(testDir, "../index.html");
const html = readFileSync(indexPath, "utf8");

function sourcesOf(policy: string, directive: string): string[] {
  return parseCsp(policy).find(([name]) => name === directive)?.[1] ?? [];
}

describe("player CSP", () => {
  it("allows runtime style positioning without allowing inline scripts", () => {
    const csp = readCsp(html);

    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("media-src 'self' blob: data:");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("forbids eval, WebAssembly and remote fonts or styles", () => {
    const csp = readCsp(html);

    expect(sourcesOf(csp, "script-src")).toEqual(["'self'"]);
    expect(sourcesOf(csp, "default-src")).toEqual(["'self'"]);
    expect(sourcesOf(csp, "font-src")).toEqual([]);
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval/u);
  });

  it("loads the app only from the module entry, without inline scripts", () => {
    expect(html).toMatch(/<script type="module" src="\.\/src\/boot\.ts"><\/script>/u);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
  });

  it("relaxes only the dev server policy for React refresh and HMR", () => {
    const dev = devCsp(readCsp(html));

    expect(sourcesOf(dev, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(sourcesOf(dev, "connect-src")).toContain("ws:");
    expect(sourcesOf(dev, "style-src")).toEqual(sourcesOf(readCsp(html), "style-src"));
    expect(readCsp(withCsp(html, dev))).toBe(dev);
  });

  it("derives the strict style policy used by the e2e CSP guard", () => {
    const strict = strictStyleCsp(readCsp(html));

    expect(sourcesOf(strict, "style-src")).toEqual(["'self'"]);
    expect(sourcesOf(strict, "script-src")).toEqual(["'self'"]);
    expect(parseCsp(strict).map(([name]) => name)).toEqual(
      parseCsp(readCsp(html)).map(([name]) => name)
    );
  });

  it("refuses to rewrite a page without a CSP meta tag", () => {
    expect(() => withCsp("<html></html>", "default-src 'self'")).toThrow(/no Content-Security/u);
  });
});
