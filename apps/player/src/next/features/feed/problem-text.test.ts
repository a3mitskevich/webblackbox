import type { ProblemGroup } from "@webblackbox/player-sdk";
import { describe, expect, it } from "vitest";

import { feedMessages, type FeedTranslator } from "./messages.js";
import {
  formatOrdinal,
  netErrorLabel,
  problemPhrase,
  problemTitle,
  problemsCount
} from "./problem-text.js";

const t: FeedTranslator = (key, values) => feedMessages.translate("en", key, values);
const ru: FeedTranslator = (key, values) => feedMessages.translate("ru", key, values);

function group(extra: Partial<ProblemGroup>): ProblemGroup {
  return {
    key: "k",
    category: "client",
    where: "",
    hosts: [],
    thirdParty: false,
    count: 1,
    firstMono: 0,
    lastMono: 0,
    occurrences: [],
    ...extra
  };
}

describe("problem text", () => {
  it("names HTTP, network, exception and console problems", () => {
    expect(problemTitle(group({ category: "auth", status: 401, reason: "Unauthorized" }), t)).toBe(
      "401 Unauthorized"
    );
    expect(problemTitle(group({ category: "network", errorCode: "ERR_CONNECTION_RESET" }), t)).toBe(
      "Connection reset"
    );
    expect(problemTitle(group({ category: "network" }), t)).toBe("Request failed");
    expect(problemTitle(group({ category: "exception", message: "x".repeat(80) }), t)).toHaveLength(
      48
    );
    expect(problemTitle(group({ category: "console" }), t)).toBe("Console error");
    expect(problemTitle(group({ category: "exception" }), t)).toBe("Exception");
  });

  it("maps Chromium net errors to plain words, unknown codes stay", () => {
    expect(netErrorLabel("ERR_ADDRESS_INVALID", t)).toBe("Failed to load");
    expect(netErrorLabel("ERR_NAME_NOT_RESOLVED", ru)).toBe("Не загрузилось");
    expect(netErrorLabel("ERR_CERT_DATE_INVALID", t)).toBe("Certificate error");
    expect(netErrorLabel("ERR_HTTP2_PROTOCOL_ERROR", t)).toBe("Protocol error");
    expect(netErrorLabel("ERR_SOMETHING_NEW", t)).toBe("ERR_SOMETHING_NEW");
  });

  it("speaks of auth failures in a sentence", () => {
    expect(problemPhrase(group({ category: "auth", status: 403, reason: "Forbidden" }), t)).toBe(
      "auth failure"
    );
    expect(problemPhrase(group({ category: "client", status: 404, reason: "Not Found" }), t)).toBe(
      "404 Not Found"
    );
  });

  it("uses the plural forms of the locale", () => {
    expect(problemsCount(1, "en", t)).toBe("1 problem");
    expect(problemsCount(4, "en", t)).toBe("4 problems");
    expect(problemsCount(1, "ru", ru)).toBe("1 проблема");
    expect(problemsCount(3, "ru", ru)).toBe("3 проблемы");
    expect(problemsCount(5, "ru", ru)).toBe("5 проблем");
  });

  it("formats visit ordinals per locale", () => {
    expect(["1", "2", "3", "4", "11", "22"].map((n) => formatOrdinal(Number(n), "en"))).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "22nd"
    ]);
    expect(formatOrdinal(2, "ru")).toBe("2-й");
    expect(formatOrdinal(2, "zh-CN")).toBe("第2次");
  });
});
