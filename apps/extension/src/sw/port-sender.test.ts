import { describe, expect, it } from "vitest";

import { PORT_NAMES } from "../shared/messages.js";
import {
  classifyMessageSender,
  classifyPortSender,
  isBroadcastDeliveredToPort,
  isInboundKindAllowed,
  type SenderTrustContext
} from "./port-sender.js";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnop";
const CTX: SenderTrustContext = {
  extensionId: "abcdefghijklmnop",
  extensionOrigin: EXTENSION_ORIGIN,
  offscreenUrl: `${EXTENSION_ORIGIN}/offscreen.html`
};

describe("classifyPortSender", () => {
  it("accepts the offscreen port only from the extension offscreen document", () => {
    expect(
      classifyPortSender(
        PORT_NAMES.offscreen,
        { id: CTX.extensionId, url: `${EXTENSION_ORIGIN}/offscreen.html` },
        CTX
      )
    ).toBe("offscreen");
    expect(
      classifyPortSender(
        PORT_NAMES.offscreen,
        { id: CTX.extensionId, url: `${EXTENSION_ORIGIN}/offscreen.html#x` },
        CTX
      )
    ).toBe("offscreen");
  });

  it("rejects offscreen ports from web frames, other extension pages and tabs", () => {
    expect(
      classifyPortSender(
        PORT_NAMES.offscreen,
        { url: "https://evil.example/offscreen.html", tab: { id: 4 }, frameId: 0 },
        CTX
      )
    ).toBe("untrusted");
    expect(
      classifyPortSender(PORT_NAMES.offscreen, { url: `${EXTENSION_ORIGIN}/popup.html` }, CTX)
    ).toBe("untrusted");
    expect(
      classifyPortSender(
        PORT_NAMES.offscreen,
        { url: `${EXTENSION_ORIGIN}/offscreen.html`, tab: { id: 2 } },
        CTX
      )
    ).toBe("untrusted");
    expect(classifyPortSender(PORT_NAMES.offscreen, undefined, CTX)).toBe("untrusted");
    expect(
      classifyPortSender(
        PORT_NAMES.offscreen,
        { id: "someone-else", url: `${EXTENSION_ORIGIN}/offscreen.html` },
        CTX
      )
    ).toBe("untrusted");
  });

  it("accepts content ports only from tab frames", () => {
    expect(
      classifyPortSender(
        PORT_NAMES.content,
        { tab: { id: 7 }, frameId: 0, url: "https://app.example/" },
        CTX
      )
    ).toBe("content");
    expect(
      classifyPortSender(PORT_NAMES.content, { tab: { id: 7 }, url: "https://app.example/" }, CTX)
    ).toBe("untrusted");
    expect(
      classifyPortSender(PORT_NAMES.content, { frameId: 0, url: "https://app.example/" }, CTX)
    ).toBe("untrusted");
    expect(
      classifyPortSender(
        PORT_NAMES.content,
        { tab: { id: 7 }, frameId: 0, url: `${EXTENSION_ORIGIN}/popup.html` },
        CTX
      )
    ).toBe("untrusted");
  });

  it("accepts UI ports only from extension pages", () => {
    for (const name of [PORT_NAMES.popup, PORT_NAMES.options, PORT_NAMES.sessions]) {
      expect(classifyPortSender(name, { url: `${EXTENSION_ORIGIN}/popup.html` }, CTX)).toBe(
        "extension-page"
      );
      expect(
        classifyPortSender(
          name,
          { url: `${EXTENSION_ORIGIN}/sessions.html`, tab: { id: 3 }, frameId: 0 },
          CTX
        )
      ).toBe("extension-page");
      expect(
        classifyPortSender(name, { url: "https://evil.example/", tab: { id: 3 }, frameId: 0 }, CTX)
      ).toBe("untrusted");
      expect(classifyPortSender(name, {}, CTX)).toBe("untrusted");
    }
  });

  it("rejects unknown port names", () => {
    expect(classifyPortSender("webblackbox:other", { url: EXTENSION_ORIGIN }, CTX)).toBe(
      "untrusted"
    );
  });
});

describe("classifyMessageSender", () => {
  it("classifies one-shot message senders", () => {
    expect(classifyMessageSender({ url: `${EXTENSION_ORIGIN}/popup.html` }, CTX)).toBe(
      "extension-page"
    );
    expect(
      classifyMessageSender({ tab: { id: 1 }, frameId: 2, url: "https://app.example/" }, CTX)
    ).toBe("content");
    expect(classifyMessageSender({ url: "https://app.example/" }, CTX)).toBe("untrusted");
    expect(classifyMessageSender({ id: "other", url: `${EXTENSION_ORIGIN}/popup.html` }, CTX)).toBe(
      "untrusted"
    );
  });
});

describe("isInboundKindAllowed", () => {
  it("lets extension pages send ui commands only", () => {
    expect(isInboundKindAllowed("ui.start", "extension-page")).toBe(true);
    expect(isInboundKindAllowed("ui.export", "extension-page")).toBe(true);
    expect(isInboundKindAllowed("content.events", "extension-page")).toBe(false);
  });

  it("lets content scripts send capture traffic and ui commands", () => {
    expect(isInboundKindAllowed("content.events", "content")).toBe(true);
    expect(isInboundKindAllowed("content.ready", "content")).toBe(true);
    expect(isInboundKindAllowed("ui.start", "content")).toBe(true);
    expect(isInboundKindAllowed("sw.recording-status", "content")).toBe(false);
  });

  it("drops inbound commands from the offscreen document and untrusted senders", () => {
    expect(isInboundKindAllowed("ui.start", "offscreen")).toBe(false);
    expect(isInboundKindAllowed("content.events", "offscreen")).toBe(false);
    expect(isInboundKindAllowed("ui.start", "untrusted")).toBe(false);
    expect(isInboundKindAllowed("content.events", "untrusted")).toBe(false);
  });
});

describe("isBroadcastDeliveredToPort", () => {
  it("keeps a recording's status away from the content scripts of every tab", () => {
    // A content script only follows its own tab's status (sent to that tab); a broadcast would
    // hand it another tab's recording (sid, active/inactive).
    expect(isBroadcastDeliveredToPort("sw.recording-status", PORT_NAMES.content)).toBe(false);
  });

  it("delivers recording status to extension pages and the offscreen document", () => {
    expect(isBroadcastDeliveredToPort("sw.recording-status", PORT_NAMES.popup)).toBe(true);
    expect(isBroadcastDeliveredToPort("sw.recording-status", PORT_NAMES.sessions)).toBe(true);
    expect(isBroadcastDeliveredToPort("sw.recording-status", PORT_NAMES.offscreen)).toBe(true);
  });

  it("delivers other broadcasts to every port but the offscreen document", () => {
    expect(isBroadcastDeliveredToPort("sw.session-list", PORT_NAMES.content)).toBe(true);
    expect(isBroadcastDeliveredToPort("sw.session-list", PORT_NAMES.popup)).toBe(true);
    expect(isBroadcastDeliveredToPort("sw.session-list", PORT_NAMES.offscreen)).toBe(false);
    expect(isBroadcastDeliveredToPort("sw.export-status", PORT_NAMES.offscreen)).toBe(false);
    expect(isBroadcastDeliveredToPort("sw.freeze", PORT_NAMES.offscreen)).toBe(false);
  });
});
