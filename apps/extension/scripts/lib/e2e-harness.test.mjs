import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpClient } from "./cdp-client.mjs";
import { buildChromeArgs, CHROME_LAUNCH_PROFILES } from "./chrome-launcher.mjs";
import {
  computeExtensionIdFromManifestKey,
  normalizeTargetDescriptor,
  resolvePreferredExtensionId,
  summarizeTargetsForDebug
} from "./devtools-targets.mjs";
import { readPositiveInteger, waitFor, withTimeout } from "./e2e-utils.mjs";

// Public key baked into dev builds by extension-build.mjs; Chrome assigns it this id.
const DEV_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2HDVz1RBsIjEKY/KUOuP3glU4SmMUtvdXXER0JV9mksg6cufsMXUwPpzj7M4aCqCPMV8NkMhRHuGEumnDx/lhc/UI1OUyGpMSP2DSozID5w1s6NY2NbBERcNe0QPwlG9DBkZHHrSXycAHBK8IOaGcsju3Dzmbxr9RI7boLVE0dchdo5bt9tyOxT6LQL1ZlQOgErRf2pSQpU/dqngQ0Wd3/rj5aZ9c04TkycJrXq1FBY4uBiUdFOjuQ6djW4UtJsudYuDaqZ5PsRErilDAbWttkQsN7w5lS7aJANEU/83nIyz8YZ56vn1P1wBqWOxJ2CsyW/lFJdKjgZor6AS5AWCRQIDAQAB";
const DEV_EXTENSION_ID = "mnchbdadipodplbijhmmcogomfbcobkd";

function createOpenClient(options) {
  const client = new CdpClient("ws://127.0.0.1:0/devtools/page/test", options);
  const sent = [];
  client.socket = {
    readyState: WebSocket.OPEN,
    send: (message) => {
      sent.push(JSON.parse(message));
    },
    close: () => undefined
  };
  return { client, sent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitFor", () => {
  it("returns the first non-nullish result and retries thrown errors", async () => {
    let calls = 0;
    const result = await waitFor(
      async () => {
        calls += 1;

        if (calls === 1) {
          throw new Error("not yet");
        }

        return calls === 2 ? null : "ready";
      },
      1_000,
      1,
      "never"
    );

    expect(result).toBe("ready");
    expect(calls).toBe(3);
  });

  it("reports elapsed time and the last error on timeout", async () => {
    await expect(
      waitFor(
        async () => {
          throw new Error("endpoint refused");
        },
        30,
        5,
        () => "Lazy message"
      )
    ).rejects.toThrow(/^Lazy message \(timed out after \d+ms\): endpoint refused$/);
  });

  it("abandons an attempt that never settles instead of hanging", async () => {
    vi.useFakeTimers();
    const pending = waitFor(() => new Promise(() => undefined), 1_000, 10, "Hung attempt");
    const assertion = expect(pending).rejects.toThrow(
      /^Hung attempt \(timed out after \d+ms\): attempt did not settle within 6000ms$/
    );

    await vi.advanceTimersByTimeAsync(6_100);
    await assertion;
  });
});

describe("withTimeout", () => {
  it("rejects with the given message when the promise is too slow", async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, "too slow")).rejects.toThrow(
      "too slow"
    );
    await expect(withTimeout(Promise.resolve(7), 1_000, "unused")).resolves.toBe(7);
  });
});

describe("readPositiveInteger", () => {
  it("floors positive numbers and falls back otherwise", () => {
    expect(readPositiveInteger("1500.9", 10)).toBe(1500);
    expect(readPositiveInteger(undefined, 10)).toBe(10);
    expect(readPositiveInteger("-1", 10)).toBe(10);
    expect(readPositiveInteger("abc", 10)).toBe(10);
  });
});

describe("CdpClient", () => {
  it("resolves command results and rejects protocol errors", async () => {
    const { client, sent } = createOpenClient();
    const ok = client.send("Runtime.enable");
    const failed = client.send("Page.navigate", { url: "about:blank" });

    client.handleMessage(JSON.stringify({ id: sent[0].id, result: { done: true } }));
    client.handleMessage(JSON.stringify({ id: sent[1].id, error: { message: "Cannot navigate" } }));

    await expect(ok).resolves.toEqual({ done: true });
    await expect(failed).rejects.toThrow("Cannot navigate");
    expect(client.pending.size).toBe(0);
  });

  it("bounds every command with the client timeout", async () => {
    vi.useFakeTimers();
    const { client } = createOpenClient({ commandTimeoutMs: 50 });
    const pending = client.send("Runtime.evaluate", { expression: "1" });
    const assertion = expect(pending).rejects.toThrow(
      "CDP command timed out after 50ms: Runtime.evaluate"
    );

    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(client.pending.size).toBe(0);
  });

  it("names the evaluated expression and the caller in a timeout", async () => {
    vi.useFakeTimers();
    const { client } = createOpenClient({ commandTimeoutMs: 50 });
    const pending = client.evaluate("(async () => {\n  await stopSession();\n})()");
    const assertion = expect(pending).rejects.toMatchObject({
      message:
        "CDP command timed out after 50ms: Runtime.evaluate ((async () => { await stopSession(); })())",
      stack: expect.stringContaining("e2e-harness.test.mjs")
    });

    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("routes flat-session commands and events", async () => {
    const { client, sent } = createOpenClient();
    const attach = client.attachToTarget("T-1");
    client.handleMessage(JSON.stringify({ id: sent[0].id, result: { sessionId: "S-1" } }));
    const session = await attach;

    const sessionEvents = [];
    const globalEvents = [];
    session.on("Runtime.consoleAPICalled", (params) => sessionEvents.push(params));
    client.on("Runtime.consoleAPICalled", (params) => globalEvents.push(params));

    const evaluation = session.evaluate("1 + 1");
    expect(sent[1]).toMatchObject({
      method: "Runtime.evaluate",
      sessionId: "S-1",
      params: { expression: "1 + 1", awaitPromise: true, returnByValue: true }
    });
    client.handleMessage(JSON.stringify({ id: sent[1].id, result: { result: { value: 2 } } }));
    await expect(evaluation).resolves.toBe(2);

    client.handleMessage(
      JSON.stringify({ method: "Runtime.consoleAPICalled", sessionId: "S-1", params: { n: 1 } })
    );
    client.handleMessage(
      JSON.stringify({ method: "Runtime.consoleAPICalled", sessionId: "S-2", params: { n: 2 } })
    );

    expect(sessionEvents).toEqual([{ n: 1 }]);
    expect(globalEvents).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("forwards extra evaluate options such as contextId", async () => {
    const { client, sent } = createOpenClient();
    const evaluation = client.evaluate("location.href", { contextId: 7 });

    expect(sent[0].params).toMatchObject({ expression: "location.href", contextId: 7 });
    expect(sent[0]).not.toHaveProperty("sessionId");
    client.handleMessage(
      JSON.stringify({ id: sent[0].id, result: { exceptionDetails: { text: "Boom" } } })
    );
    await expect(evaluation).rejects.toThrow("Boom");
  });

  it("rejects pending commands on close and refuses to send when not open", async () => {
    const { client } = createOpenClient();
    const pending = client.send("Runtime.enable");

    client.close();

    await expect(pending).rejects.toThrow("CDP client closed (Runtime.enable)");
    client.socket = null;
    await expect(client.send("Runtime.enable")).rejects.toThrow(
      "CDP socket is not open (Runtime.enable)"
    );
  });
});

describe("buildChromeArgs", () => {
  const base = {
    remotePort: 9222,
    profileDir: "/tmp/profile",
    extensionDir: "/tmp/ext",
    headless: true
  };

  it("keeps the minimal argv used by e2e:check", () => {
    expect(buildChromeArgs(base)).toEqual([
      "--headless=new",
      "--remote-debugging-port=9222",
      "--user-data-dir=/tmp/profile",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions-except=/tmp/ext",
      "--load-extension=/tmp/ext",
      "--enable-logging=stderr",
      "--v=1",
      "about:blank"
    ]);
  });

  it("adds script-specific switches and the Linux sandbox prefix", () => {
    const args = buildChromeArgs({
      ...base,
      headless: false,
      extraArgs: ["--window-size=1400,1000"],
      disableLinuxSandbox: true
    });

    expect(args).toContain("--window-size=1400,1000");
    expect(args).not.toContain("--headless=new");
    expect(args.at(-1)).toBe("about:blank");

    if (process.platform === "linux") {
      expect(args.slice(0, 3)).toEqual([
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]);
    } else {
      expect(args).not.toContain("--no-sandbox");
    }
  });

  // Argv each script's former inline launcher produced on Linux (headless, main @ ba2fbb0).
  const linuxSandboxPrefix = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage"
  ];
  const commonHead = [
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps"
  ];
  const commonTail = [
    "--disable-extensions-except=/tmp/ext",
    "--load-extension=/tmp/ext",
    "--enable-logging=stderr",
    "--v=1",
    "about:blank"
  ];
  const devtoolsAutomationSwitches = [
    "--remote-debugging-address=127.0.0.1",
    "--disable-popup-blocking",
    "--safebrowsing-disable-download-protection",
    "--window-size=1400,1000"
  ];

  it.each([
    ["extensionCheck", ["--headless=new", ...commonHead, ...commonTail]],
    [
      "fullMemory",
      [
        ...linuxSandboxPrefix,
        "--headless=new",
        ...commonHead,
        "--disable-popup-blocking",
        ...commonTail
      ]
    ],
    [
      "fullchain",
      [
        ...linuxSandboxPrefix,
        "--headless=new",
        ...commonHead,
        ...devtoolsAutomationSwitches,
        ...commonTail
      ]
    ],
    [
      "litePerf",
      [
        ...linuxSandboxPrefix,
        "--headless=new",
        ...commonHead,
        ...devtoolsAutomationSwitches,
        ...commonTail
      ]
    ],
    // Not a former inline launcher: without the sandbox prefix Chrome never came up on CI.
    ["profileHarness", [...linuxSandboxPrefix, "--headless=new", ...commonHead, ...commonTail]]
  ])("keeps the %s launch profile's Linux switch set", (profileName, expected) => {
    const args = buildChromeArgs({
      ...base,
      ...CHROME_LAUNCH_PROFILES[profileName],
      platform: "linux"
    });

    expect([...args].sort()).toEqual([...expected].sort());
    expect(args.at(-1)).toBe("about:blank");
  });

  it("warns on unexpected Chrome exits where the former launchers did", () => {
    expect(CHROME_LAUNCH_PROFILES.extensionCheck.warnOnExit).toBe(true);
    expect(CHROME_LAUNCH_PROFILES.fullchain.warnOnExit).toBe(true);
    expect(CHROME_LAUNCH_PROFILES.litePerf.warnOnExit).toBe(true);
    expect(CHROME_LAUNCH_PROFILES.fullMemory.warnOnExit).toBeUndefined();
  });
});

describe("devtools target helpers", () => {
  it("derives the Chrome extension id from the manifest key", async () => {
    expect(computeExtensionIdFromManifestKey(DEV_MANIFEST_KEY)).toBe(DEV_EXTENSION_ID);

    const dir = await mkdtemp(join(tmpdir(), "wb-e2e-harness-"));

    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({ key: DEV_MANIFEST_KEY }));
      await expect(resolvePreferredExtensionId(dir)).resolves.toBe(DEV_EXTENSION_ID);
      await writeFile(join(dir, "manifest.json"), "{not json");
      await expect(resolvePreferredExtensionId(dir)).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes HTTP and Target.getTargets descriptors to one shape", () => {
    expect(
      normalizeTargetDescriptor({ id: "A", type: "page", url: "https://a.test/", title: "A" })
    ).toEqual({
      key: "A",
      targetId: "A",
      id: "A",
      type: "page",
      url: "https://a.test/",
      title: "A",
      webSocketDebuggerUrl: undefined
    });
    expect(normalizeTargetDescriptor({ targetId: "B", type: "service_worker" })).toMatchObject({
      key: "B",
      id: "B",
      url: ""
    });
    expect(summarizeTargetsForDebug([])).toBe("[]");
    expect(
      summarizeTargetsForDebug([{ type: "page", url: `https://x.test/${"a".repeat(200)}` }])
    ).toMatch(/^page:https:\/\/x\.test\/a+\.\.\.$/);
  });
});
