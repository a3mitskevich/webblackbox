/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  RRWEB_EVENT_SCHEMA,
  RRWEB_RAW_TYPE,
  type CapturePolicy,
  type RrwebEventBatchPayload
} from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import { LiteCaptureAgent } from "./lite-capture-agent.js";
import { serializeRawDom } from "./raw-dom-snapshot.js";
import {
  buildRrwebRecordOptions,
  createRrwebDomRecorder,
  joinSelectors,
  RRWEB_BATCH_FLUSH_MS
} from "./rrweb-recorder.js";
import type { DomRecorder, DomRecorderContext } from "./types.js";

function policyWith(
  categories: Partial<CapturePolicy["categories"]>,
  redaction: Partial<CapturePolicy["redaction"]> = {}
): CapturePolicy {
  return {
    ...DEFAULT_CAPTURE_POLICY,
    categories: { ...DEFAULT_CAPTURE_POLICY.categories, ...categories },
    redaction: { ...DEFAULT_CAPTURE_POLICY.redaction, ...redaction }
  };
}

type SerializedNode = {
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SerializedNode[];
};

function findNode(
  node: SerializedNode,
  match: (node: SerializedNode) => boolean
): SerializedNode | null {
  if (match(node)) {
    return node;
  }

  for (const child of node.childNodes ?? []) {
    const found = findNode(child, match);

    if (found) {
      return found;
    }
  }

  return null;
}

function snapshotRoot(batches: RrwebEventBatchPayload[]): SerializedNode {
  const fullSnapshot = batches.flatMap((batch) => batch.events).find((event) => event.type === 2);
  return (fullSnapshot!.data as { node: SerializedNode }).node;
}

const byId = (id: string) => (node: SerializedNode) => node.attributes?.id === id;

function renderFixture(): void {
  document.body.innerHTML = `
    <p id="greeting">Hello Alice</p>
    <div class="secret" id="card">4111 1111 1111 1111</div>
    <input id="name" value="Alice" />
    <input id="pin" name="pin" value="1234" />
    <input id="pass" type="password" value="hunter2" />
    <button id="go">Go</button>
    <div data-webblackbox-indicator="true" id="indicator">WebBlackbox REC lite</div>`;
}

function startRecorder(policy: CapturePolicy) {
  const batches: RrwebEventBatchPayload[] = [];
  const monos: number[] = [];
  const context: DomRecorderContext = {
    policy,
    mode: "lite",
    emit: (payload, mono) => {
      batches.push(payload);
      monos.push(mono);
    }
  };
  const recorder = createRrwebDomRecorder(context);
  return { recorder, batches, monos };
}

let running: DomRecorder | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("buildRrwebRecordOptions", () => {
  it("records nothing when the profile records no DOM or a blocked selector is invalid", () => {
    expect(buildRrwebRecordOptions(policyWith({ dom: "off" }))).toBeNull();
    expect(
      buildRrwebRecordOptions(policyWith({ dom: "allow" }, { blockedSelectors: ["[broken"] }))
    ).toBeNull();
  });

  it("maps blocked selectors, sampling and the heavy features that stay off", () => {
    const options = buildRrwebRecordOptions(policyWith({ dom: "allow" }));

    expect(options?.blockSelector).toBe(
      joinSelectors([
        "[data-webblackbox-indicator]",
        ...DEFAULT_CAPTURE_POLICY.redaction.blockedSelectors
      ])
    );
    // Text goes through the raw DOM's heuristics (and editors are masked like fields).
    expect(options?.maskTextSelector).toBe("*");
    expect(options).toMatchObject({
      maskAllInputs: true,
      recordCanvas: false,
      collectFonts: false,
      inlineImages: false,
      slimDOMOptions: "all",
      sampling: { mousemove: 50, scroll: 150, input: "last" }
    });
  });

  it("masks all text for masked and wireframe DOM, and blocks media in wireframe", () => {
    const masked = buildRrwebRecordOptions(policyWith({ dom: "masked" }));
    const wireframe = buildRrwebRecordOptions(policyWith({ dom: "wireframe" }));

    expect(masked?.maskTextSelector).toBe("*");
    expect(masked?.maskTextFn?.("Hello Alice", null)).toBe("***** *****");
    expect(masked?.blockSelector).not.toContain("img");
    expect(wireframe?.blockSelector).toContain("img");
    expect(wireframe?.blockSelector).toContain("canvas");
  });

  it("records text as it is only when nothing masks it", () => {
    const options = buildRrwebRecordOptions(
      policyWith({ dom: "allow", inputs: "allow" }, { contentRedaction: false })
    );

    expect(options?.maskTextSelector).toBeUndefined();
    expect(options?.maskTextFn).toBeUndefined();
  });

  it("applies DOM value patterns to text when the DOM is recorded as is", () => {
    const options = buildRrwebRecordOptions(
      policyWith({ dom: "allow" }, { valuePatterns: [{ pattern: "alice", targets: ["dom"] }] })
    );

    expect(options?.maskTextSelector).toBe("*");
    expect(options?.maskTextFn?.("Hello Alice", null)).not.toContain("Alice");
  });
});

describe("createRrwebDomRecorder", () => {
  it("emits a full snapshot at once, masked like our raw DOM and input events", () => {
    renderFixture();
    const { recorder, batches } = startRecorder(policyWith({ dom: "allow", inputs: "allow" }));
    running = recorder;

    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0]!.schema).toBe(RRWEB_EVENT_SCHEMA);
    const root = snapshotRoot(batches);

    expect(findNode(root, byId("greeting"))?.childNodes?.[0]?.textContent).toBe("Hello Alice");
    // Blocked: kept as an empty placeholder, its text never serialized.
    expect(findNode(root, byId("card"))?.childNodes ?? []).toHaveLength(0);
    expect(JSON.stringify(root)).not.toContain("4111");
    expect(findNode(root, byId("name"))?.attributes?.value).toBe("Alice");
    // Never-captured fields (PIN, password) stay masked whatever the inputs level says.
    expect(findNode(root, byId("pin"))?.attributes?.value).toBe("****");
    expect(JSON.stringify(root)).not.toContain("hunter2");
    expect(JSON.stringify(root)).not.toContain("WebBlackbox REC");
  });

  it("masks every text and value under the default profile", () => {
    renderFixture();
    const { recorder, batches } = startRecorder(DEFAULT_CAPTURE_POLICY);
    running = recorder;
    const root = snapshotRoot(batches);

    expect(findNode(root, byId("greeting"))?.childNodes?.[0]?.textContent).toBe("***** *****");
    expect(findNode(root, byId("name"))?.attributes?.value).toBe("*****");
  });

  it("masks what the raw DOM masks: attributes, credentials, editors, hidden fields", async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-secret-1">';
    document.body.innerHTML = `
      <p id="tip" title="alice@example.com" aria-label="Alice Smith" data-token="dt-secret-2">x</p>
      <div data-props='{"auth":{"password":"json-secret-3"}}'>y</div>
      <p>token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c</p>
      <a href="/next?session=query-secret-4">next</a>
      <div contenteditable="true">editor-secret-5</div>
      <input id="nonce" type="hidden" value="hidden-secret-6" />
      <select><option value="option-secret-7">o</option></select>
      <span onclick="send('handler-secret-8')" style="background:url(/bg.png?sig=css-secret-9)">z</span>
      <iframe srcdoc="<p>srcdoc-secret-10</p>"></iframe>`;
    const secrets = /[a-z]+-secret-\d+|eyJhbGciOi/g;
    const leaked = (policy: CapturePolicy): string[] => {
      const { recorder, batches } = startRecorder(policy);
      recorder?.stop();
      return [...new Set(JSON.stringify(batches).match(secrets) ?? [])].sort();
    };
    const rawDom = (policy: CapturePolicy): string[] => {
      const snapshot = serializeRawDom(document, {
        blockedSelectors: policy.redaction.blockedSelectors,
        keepInputValues: policy.categories.inputs === "allow",
        sensitiveNamePatterns: policy.redaction.redactBodyPatterns,
        redaction: policy.redaction
      });
      return [...new Set(snapshot?.html.match(secrets) ?? [])].sort();
    };

    // Default: the current path records no raw DOM at all, so nothing may leak.
    expect(leaked(DEFAULT_CAPTURE_POLICY)).toEqual([]);
    expect(JSON.stringify(startRecorder(DEFAULT_CAPTURE_POLICY).batches)).not.toMatch(
      /alice@example\.com|Alice Smith/
    );
    running = null;

    // `dom: allow`: exactly what the raw DOM snapshot keeps for the same policy (nothing here).
    const allow = policyWith({ dom: "allow" });
    expect(rawDom(allow)).toEqual([]);
    expect(leaked(allow)).toEqual(rawDom(allow));

    // Later changes too: a hidden field set by script, an attribute and an editor's new text.
    const { recorder, batches } = startRecorder(allow);
    running = recorder;
    const before = batches.length;
    (document.querySelector("#nonce") as HTMLInputElement).setAttribute(
      "value",
      "hidden-secret-11"
    );
    document.querySelector("#tip")!.setAttribute("data-session-token", "attr-secret-12");
    document.querySelector("[contenteditable]")!.textContent = "editor-secret-13";
    await Promise.resolve();
    recorder?.flush();

    expect(batches.length).toBeGreaterThan(before);
    expect(JSON.stringify(batches.slice(before))).not.toMatch(secrets);
  });

  it("batches incremental events and stamps each batch with its first event's time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderFixture();
    const { recorder, batches, monos } = startRecorder(policyWith({ dom: "allow" }));
    running = recorder;
    const before = batches.length;

    document.querySelector("#greeting")!.textContent = "Hello Bob";
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(RRWEB_BATCH_FLUSH_MS);

    expect(batches.length).toBe(before + 1);
    expect(batches.at(-1)!.events.every((event) => event.type === 3)).toBe(true);
    expect(Number.isFinite(monos.at(-1))).toBe(true);
  });

  it("returns null when the policy records no DOM", () => {
    expect(startRecorder(policyWith({ dom: "off" })).recorder).toBeNull();
  });
});

describe("LiteCaptureAgent with a DOM recorder", () => {
  it("runs the recorder while recording and queues its batches as rrwebRecord events", () => {
    const emitBatch = vi.fn<(events: RawRecorderEvent[]) => void>();
    const stop = vi.fn();
    let context: DomRecorderContext | null = null;
    const agent = new LiteCaptureAgent({
      emitBatch,
      showIndicator: false,
      frameScope: "top",
      domRecorder: (next) => {
        context = next;
        return { flush: vi.fn(), stop };
      }
    });

    agent.setRecordingStatus({
      active: true,
      sid: "S-rrweb",
      tabId: 3,
      mode: "full",
      capturePolicy: DEFAULT_CAPTURE_POLICY
    });
    expect(context).not.toBeNull();
    context!.emit({ schema: RRWEB_EVENT_SCHEMA, events: [{ type: 4, timestamp: 1, data: {} }] }, 5);
    agent.setRecordingStatus({ active: false, mode: "full" });

    const emitted = emitBatch.mock.calls.flatMap(([events]) => events);
    const rrwebEvent = emitted.find((event) => event.rawType === RRWEB_RAW_TYPE);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(rrwebEvent?.mono).toBe(5);
    expect((rrwebEvent?.payload as RrwebEventBatchPayload).schema).toBe(RRWEB_EVENT_SCHEMA);
    agent.dispose();
  });

  it("keeps one recorder across equal policies and replaces the agent's own DOM summaries", async () => {
    document.body.innerHTML = `<div id="list"></div>`;
    const emitBatch = vi.fn<(events: RawRecorderEvent[]) => void>();
    const factory = vi.fn(() => ({ flush: vi.fn(), stop: vi.fn() }));
    const agent = new LiteCaptureAgent({
      emitBatch,
      showIndicator: false,
      frameScope: "top",
      domRecorder: factory
    });
    const status = () => ({
      active: true,
      sid: "S-rrweb",
      mode: "lite" as const,
      capturePolicy: structuredClone(DEFAULT_CAPTURE_POLICY)
    });

    agent.setRecordingStatus(status());
    agent.setRecordingStatus(status());
    document.querySelector("#list")!.append(document.createElement("p"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    agent.flush();

    const rawTypes = emitBatch.mock.calls.flatMap(([events]) =>
      events.map((event) => event.rawType)
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(rawTypes).not.toContain("mutation");
    expect(rawTypes).not.toContain("rrweb");
    expect(rawTypes).not.toContain("snapshot");
    agent.dispose();
  });

  it("emits its own mutation summaries without a DOM recorder (control)", async () => {
    document.body.innerHTML = `<div id="list"></div>`;
    const emitBatch = vi.fn<(events: RawRecorderEvent[]) => void>();
    const agent = new LiteCaptureAgent({ emitBatch, showIndicator: false, frameScope: "top" });

    agent.setRecordingStatus({ active: true, sid: "S-now", mode: "lite" });
    document.querySelector("#list")!.append(document.createElement("p"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    agent.flush();

    const rawTypes = emitBatch.mock.calls.flatMap(([events]) =>
      events.map((event) => event.rawType)
    );
    expect(rawTypes).toContain("mutation");
    agent.dispose();
  });

  it("does not start the recorder when the profile records no DOM", () => {
    const factory = vi.fn(() => ({ flush: vi.fn(), stop: vi.fn() }));
    const agent = new LiteCaptureAgent({
      emitBatch: vi.fn(),
      showIndicator: false,
      frameScope: "top",
      domRecorder: factory
    });

    agent.setRecordingStatus({
      active: true,
      mode: "lite",
      capturePolicy: policyWith({ dom: "off" })
    });

    expect(factory).not.toHaveBeenCalled();
    agent.dispose();
  });
});
