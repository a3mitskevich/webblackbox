import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type RecorderConfig,
  type RedactionProfile
} from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import type { RawRecorderEvent } from "./types.js";
import { WebBlackboxRecorder } from "./recorder.js";

const BEARER = "Bearer abcdefghijklmnopqrstuvwx";
const REQUEST_URL = "https://api.test/users/12345/orders?token=URLTOKEN1&page=2";

/** One recording's worth of content that carries secrets in every place masking looks at. */
const RAW_EVENTS: Array<Omit<RawRecorderEvent, "sid" | "tabId" | "t" | "mono">> = [
  {
    source: "cdp",
    rawType: "Network.requestWillBeSent",
    payload: {
      requestId: "R-1",
      documentURL: REQUEST_URL,
      request: {
        url: REQUEST_URL,
        method: "POST",
        headers: {
          Authorization: BEARER,
          Cookie: "session=COOKIESECRET1; theme=dark",
          "X-Session-Id": "HEADERSECRET1"
        },
        postData: '{"password":"BODYSECRET1","note":"acct-555"}'
      }
    }
  },
  {
    source: "content",
    rawType: "console",
    payload: {
      source: "injected",
      method: "log",
      level: "log",
      args: ["password=CONSOLE1 acct-777"]
    }
  },
  {
    source: "content",
    rawType: "localStorageOp",
    payload: { op: "setItem", key: "sessionToken", value: "STORAGESECRET1", valueLength: 14 }
  },
  {
    source: "content",
    rawType: "input",
    payload: { inputType: "text", length: 12, value: "typed acct-999" }
  },
  { source: "content", rawType: "click", payload: { selector: "button#pay-now" } }
];

function record(redaction: Partial<RedactionProfile>): string {
  const config: RecorderConfig = {
    ...DEFAULT_RECORDER_CONFIG,
    mode: "full",
    redaction: { ...DEFAULT_RECORDER_CONFIG.redaction, ...redaction },
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        actions: "allow",
        inputs: "allow",
        console: "allow",
        network: "body-allowlist",
        storage: "allow"
      }
    }
  };
  const recorder = new WebBlackboxRecorder(config);

  return JSON.stringify(
    RAW_EVENTS.map(
      (raw, index) =>
        recorder.ingest({ ...raw, sid: "S-raw", tabId: 1, t: 1_000 + index, mono: index }).event
    )
  );
}

describe("content redaction switch in the recorder", () => {
  it("masks content by default", () => {
    const recorded = record({});

    for (const secret of [
      "abcdefghijklmnopqrstuvwx",
      "COOKIESECRET1",
      "HEADERSECRET1",
      "BODYSECRET1",
      "CONSOLE1",
      "STORAGESECRET1",
      "URLTOKEN1",
      "pay-now"
    ]) {
      expect(recorded, secret).not.toContain(secret);
    }
  });

  it("records everything as captured with contentRedaction: false", () => {
    const recorded = record({ contentRedaction: false });

    for (const raw of [
      BEARER,
      "session=COOKIESECRET1",
      "HEADERSECRET1",
      "BODYSECRET1",
      "password=CONSOLE1",
      "STORAGESECRET1",
      "typed acct-999",
      "button#pay-now",
      REQUEST_URL
    ]) {
      expect(recorded, raw).toContain(raw);
    }

    // No keyed hashes either.
    expect(recorded).not.toMatch(/selector:[a-f0-9]{12}/);
  });

  it("applies only the user's rules when the built-in heuristics are off", () => {
    const recorded = record({
      builtInHeuristics: false,
      hashSensitiveValues: false,
      redactBodyPatterns: ["password"],
      redactQueryParams: ["token"],
      redactStorageKeys: ["sessiontoken"],
      valuePatterns: [{ pattern: "acct-\\d+", targets: ["bodies", "console", "inputs"] }]
    });

    // User rules apply…
    for (const secret of ["BODYSECRET1", "CONSOLE1", "STORAGESECRET1", "URLTOKEN1", "acct-"]) {
      expect(recorded, secret).not.toContain(secret);
    }

    // …the heuristics do not: the session-named header stays, URLs keep their other parameters.
    expect(recorded).toContain("HEADERSECRET1");
    expect(recorded).toContain("page=2");
    expect(recorded).toContain("users/12345");
  });

  it("masks readable action labels with the profile's DOM rules, even from a stale page", () => {
    const config: RecorderConfig = {
      ...DEFAULT_RECORDER_CONFIG,
      redaction: {
        ...DEFAULT_RECORDER_CONFIG.redaction,
        valuePatterns: [{ pattern: "acct-\\d+", targets: ["dom"] }]
      },
      capturePolicy: {
        ...DEFAULT_CAPTURE_POLICY,
        categories: { ...DEFAULT_CAPTURE_POLICY.categories, actions: "allow", dom: "allow" }
      }
    };
    const recorder = new WebBlackboxRecorder(config);
    const readable = { text: "Pay acct-55", ariaLabel: "acct-22", css: '[aria-label="acct-22"]' };
    const click = recorder.ingest({
      source: "content",
      rawType: "click",
      sid: "S-labels",
      tabId: 1,
      t: 1_000,
      mono: 1,
      payload: { x: 1, y: 1, target: { tag: "BUTTON", readable } }
    }).event;
    const selection = recorder.ingest({
      source: "content",
      rawType: "selection",
      sid: "S-labels",
      tabId: 1,
      t: 1_001,
      mono: 2,
      payload: { length: 11, text: "see acct-99", target: { tag: "P" } }
    }).event;

    expect(click?.data).toMatchObject({
      target: { readable: { text: "Pay [REDACTED]", ariaLabel: "[REDACTED]" } }
    });
    expect(JSON.stringify(click?.data)).not.toContain("acct-");
    expect(selection?.data).toMatchObject({ text: "see [REDACTED]" });
  });
});
