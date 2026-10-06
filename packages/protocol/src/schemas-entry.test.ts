import { describe, expect, it } from "vitest";

import * as root from "./index.js";
import * as schemasEntry from "./schemas-entry.js";

describe("@webblackbox/protocol/schemas subpath", () => {
  it("exposes the event and message schemas with their validators", () => {
    expect(typeof schemasEntry.exportManifestSchema.safeParse).toBe("function");
    expect(typeof schemasEntry.webBlackboxMessageSchema.safeParse).toBe("function");
    expect(typeof schemasEntry.validateEvent).toBe("function");
    expect(typeof schemasEntry.validateMessage).toBe("function");
  });

  it("re-exports the same schema objects the package root still exposes", () => {
    for (const [name, value] of Object.entries(schemasEntry)) {
      expect(root[name as keyof typeof root], name).toBe(value);
    }
  });

  it("carries nothing but schemas and validators", () => {
    const unexpected = Object.keys(schemasEntry).filter(
      (name) => !/Schema$/.test(name) && !/^(validate|get)\w+/.test(name)
    );

    expect(unexpected).toEqual([]);
  });
});
