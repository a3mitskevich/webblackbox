import { describe, expect, it } from "vitest";

import { getShareServerApiKeyForBaseUrl, setShareServerApiKeyForBaseUrl } from "./share-api-key.js";

describe("share API keys by origin", () => {
  it("stores a trimmed key under the server origin without mutating the input", () => {
    const original: Record<string, string> = {};
    const next = setShareServerApiKeyForBaseUrl(
      original,
      "https://share.example.com/share/abc12345",
      "  secret-key  "
    );

    expect(next).toEqual({ "https://share.example.com": "secret-key" });
    expect(original).toEqual({});
  });

  it("does not delete a saved key when the new key is empty", () => {
    const saved = { "https://share.example.com": "secret-key" };

    expect(setShareServerApiKeyForBaseUrl(saved, "https://share.example.com", "")).toEqual(saved);
    expect(setShareServerApiKeyForBaseUrl(saved, "https://share.example.com", "   ")).toEqual(
      saved
    );
  });

  it("replaces an existing key for the same origin only", () => {
    const saved = {
      "https://share.example.com": "old-key",
      "http://localhost:8787": "local-key"
    };

    expect(setShareServerApiKeyForBaseUrl(saved, "https://share.example.com/", "new-key")).toEqual({
      "https://share.example.com": "new-key",
      "http://localhost:8787": "local-key"
    });
  });

  it("ignores invalid base URLs", () => {
    const saved = { "https://share.example.com": "secret-key" };

    expect(setShareServerApiKeyForBaseUrl(saved, "not a url", "key")).toBe(saved);
  });

  it("reads keys by origin", () => {
    const saved = { "https://share.example.com": "secret-key" };

    expect(getShareServerApiKeyForBaseUrl(saved, "https://share.example.com/share/x")).toBe(
      "secret-key"
    );
    expect(getShareServerApiKeyForBaseUrl(saved, "https://other.example.com")).toBe("");
    expect(getShareServerApiKeyForBaseUrl(saved, null)).toBe("");
  });
});
