import { describe, expect, it } from "vitest";

import {
  CHROME_DEFAULT_RESOURCE_BUFFER_BYTES,
  CHROME_DEFAULT_TOTAL_BUFFER_BYTES,
  NETWORK_RESOURCE_BUFFER_MAX_BYTES,
  NETWORK_TOTAL_BUFFER_MAX_BYTES,
  resolveNetworkEnableParams
} from "./network-buffers.js";

const MIB = 1024 * 1024;

describe("resolveNetworkEnableParams", () => {
  it("keeps Chrome's defaults when the session keeps no bodies", () => {
    expect(resolveNetworkEnableParams(0)).toEqual({});
    expect(resolveNetworkEnableParams(-1)).toEqual({});
    expect(resolveNetworkEnableParams(Number.NaN)).toEqual({});
  });

  it("sizes the buffers from the Full default body limit", () => {
    expect(resolveNetworkEnableParams(MIB)).toEqual({
      maxTotalBufferSize: 256 * MIB,
      maxResourceBufferSize: CHROME_DEFAULT_RESOURCE_BUFFER_BYTES,
      maxPostDataSize: MIB
    });
  });

  it("never goes below what Chrome keeps by default", () => {
    expect(resolveNetworkEnableParams(4 * 1024)).toEqual({
      maxTotalBufferSize: CHROME_DEFAULT_TOTAL_BUFFER_BYTES,
      maxResourceBufferSize: CHROME_DEFAULT_RESOURCE_BUFFER_BYTES,
      maxPostDataSize: 4 * 1024
    });
  });

  it("caps both buffers at the largest body limit", () => {
    expect(resolveNetworkEnableParams(8 * MIB)).toEqual({
      maxTotalBufferSize: NETWORK_TOTAL_BUFFER_MAX_BYTES,
      maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_MAX_BYTES,
      maxPostDataSize: 8 * MIB
    });
    expect(resolveNetworkEnableParams(3 * MIB).maxResourceBufferSize).toBe(48 * MIB);
  });

  it("sends whole numbers Chrome accepts as 32-bit integers", () => {
    for (const limit of [4 * 1024, 333_333.7, MIB, 8 * MIB]) {
      for (const value of Object.values(resolveNetworkEnableParams(limit))) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeLessThan(2 ** 31);
      }
    }
  });
});
