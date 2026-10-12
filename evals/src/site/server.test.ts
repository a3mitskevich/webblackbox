import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCENARIOS } from "../scenarios/index.js";
import { type BugZooSite, startBugZooSite } from "./server.js";

describe("bug zoo site", () => {
  let site: BugZooSite;

  beforeAll(async () => {
    site = await startBugZooSite(SCENARIOS);
  });

  afterAll(async () => {
    await site.close();
  });

  it("serves the home page and every scenario page and script", async () => {
    const paths = [
      "/",
      ...SCENARIOS.flatMap((scenario) => [
        ...Object.keys(scenario.pages),
        ...Object.keys(scenario.scripts ?? {})
      ])
    ];

    for (const path of paths) {
      const response = await fetch(`${site.origin}${path}`);
      expect(response.status, path).toBe(200);
      await response.text();
    }
  });

  it("answers scenario APIs with their status, headers and JSON body", async () => {
    const saved = await fetch(`${site.origin}/api/profile`, { method: "PUT", body: "{}" });
    expect(saved.status).toBe(500);
    expect(await saved.json()).toMatchObject({ error: "profile_store_unavailable" });

    const address = await fetch(`${site.origin}/api/checkout/address`, {
      method: "POST",
      body: JSON.stringify({ zipcode: "00-590" })
    });
    expect(address.status).toBe(400);
    await address.text();

    const fixed = await fetch(`${site.origin}/api/checkout/address`, {
      method: "POST",
      body: JSON.stringify({ postalCode: "00-590" })
    });
    expect(fixed.status).toBe(200);
    await fixed.text();

    const cart = await fetch(`${site.origin}/api/cart`);
    expect(cart.headers.get("cache-control")).toBe("private, max-age=600");
    await cart.text();
  });

  it("keeps per-server state between calls", async () => {
    const first = await fetch(`${site.origin}/api/orders`, { method: "POST", body: "{}" });
    const second = await fetch(`${site.origin}/api/orders`, { method: "POST", body: "{}" });

    expect(await first.json()).toMatchObject({ orderId: 5001 });
    expect(await second.json()).toMatchObject({ orderId: 5002 });
  }, 10_000);

  it("holds a request until the server closes", async () => {
    const controller = new AbortController();
    const outcome = await Promise.race([
      fetch(`${site.origin}/api/reports/sales?range=30d`, { signal: controller.signal }).then(
        () => "answered",
        () => "aborted"
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 300))
    ]);
    controller.abort();

    expect(outcome).toBe("pending");
  });

  it("answers unknown paths with 404", async () => {
    const response = await fetch(`${site.origin}/nope`);

    expect(response.status).toBe(404);
    await response.text();
  });

  it("opens the order WebSocket, sends a status and closes with 1011", async () => {
    const messages: string[] = [];
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const socket = new WebSocket(`${site.origin.replace("http", "ws")}/ws/orders?orderId=1042`);
      socket.addEventListener("message", (event) => messages.push(String(event.data)));
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason })
      );
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
    });

    expect(messages).toEqual([JSON.stringify({ orderId: 1042, status: "preparing" })]);
    expect(closed).toEqual({ code: 1011, reason: "upstream restart" });
  }, 10_000);

  it("rejects duplicate routes across scenarios", async () => {
    const first = SCENARIOS[0];

    if (!first) {
      throw new Error("No scenarios");
    }

    await expect(startBugZooSite([first, { ...first, id: "copy" }])).rejects.toThrow(
      /already taken/
    );
  });
});
