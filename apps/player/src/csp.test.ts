import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { devCsp, parseCsp, readCsp, withCsp } from "../scripts/lib/csp-policy.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
// Vite's HTML entry; the build copies it (with hashed asset links) to build/index.html.
const indexPath = resolve(testDir, "../index.html");
const html = readFileSync(indexPath, "utf8");

function sourcesOf(policy: string, directive: string): string[] {
  return parseCsp(policy).find(([name]) => name === directive)?.[1] ?? [];
}

describe("player CSP", () => {
  it("allows no inline scripts and no inline or injected styles", () => {
    const csp = readCsp(html);

    expect(sourcesOf(csp, "script-src")).toEqual(["'self'"]);
    expect(sourcesOf(csp, "style-src")).toEqual(["'self'"]);
    expect(sourcesOf(csp, "media-src")).toEqual(["'self'", "blob:", "data:"]);
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it("forbids eval, WebAssembly and remote fonts or styles", () => {
    const csp = readCsp(html);

    expect(sourcesOf(csp, "default-src")).toEqual(["'self'"]);
    expect(sourcesOf(csp, "font-src")).toEqual([]);
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval/u);
  });

  it("loads the app only from the module entry, without inline scripts", () => {
    expect(html).toMatch(/<script type="module" src="\.\/src\/main\.ts"><\/script>/u);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
  });

  it("relaxes only the dev server policy for React refresh, HMR and Vite's dev CSS", () => {
    const dev = devCsp(readCsp(html));

    expect(sourcesOf(dev, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(sourcesOf(dev, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(sourcesOf(dev, "connect-src")).toContain("ws:");
    expect(parseCsp(dev).map(([name]) => name)).toEqual(
      parseCsp(readCsp(html)).map(([name]) => name)
    );
    expect(readCsp(withCsp(html, dev))).toBe(dev);
  });

  it("refuses to rewrite a page without a CSP meta tag", () => {
    expect(() => withCsp("<html></html>", "default-src 'self'")).toThrow(/no Content-Security/u);
  });
});
