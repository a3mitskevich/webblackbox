import { describe, expect, it } from "vitest";

import { displayProfileName } from "./display-name.js";

const t = (key: string): string => `t:${key}`;

describe("displayProfileName", () => {
  it("translates the built-in profiles and keeps other names", () => {
    expect(displayProfileName({ id: "builtin:maximum", name: "Maximum" }, t)).toBe(
      "t:profileNameMaximum"
    );
    expect(displayProfileName({ id: "builtin:lite", name: "Light" }, t)).toBe("t:profileNameLight");
    expect(displayProfileName({ id: "team", name: "Team" }, t)).toBe("Team");
    expect(displayProfileName({ name: "No id" }, t)).toBe("No id");
  });
});
