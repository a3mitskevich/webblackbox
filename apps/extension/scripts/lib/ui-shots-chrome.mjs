// Chrome plumbing of the UI screenshot check: launch, CDP connection, extension id.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CDP_TIMEOUT_MS = 30_000;

/** CDP over the browser websocket; events resolve matching `pendingEvents` waiters. */
export async function connectBrowser(port, pendingEvents) {
  let version;

  for (let attempt = 0; attempt < 100 && !version; attempt += 1) {
    version = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.json())
      .catch(() => undefined);

    if (!version) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
    }
  }

  if (!version) {
    throw new Error("Chrome DevTools endpoint did not come up");
  }

  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP socket error")), {
      once: true
    });
  });

  let sequence = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));

    if (typeof message.id === "number" && pending.has(message.id)) {
      const { resolveCall, rejectCall, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);

      if (message.error) {
        rejectCall(new Error(message.error.message));
      } else {
        resolveCall(message.result);
      }

      return;
    }

    if (typeof message.method === "string") {
      for (const waiter of [...pendingEvents]) {
        if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
          pendingEvents.splice(pendingEvents.indexOf(waiter), 1);
          waiter.resolve(message.params);
        }
      }
    }
  });

  return {
    send(method, params = {}, sessionId) {
      const id = ++sequence;

      return new Promise((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`CDP timeout: ${method}`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, { resolveCall, rejectCall, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close: () => socket.close()
  };
}

/** Headless Chrome with the unpacked extension and a throwaway profile. */
export async function launchChrome({ chromeBin, extensionDir, uiLanguage }) {
  const port = await reservePort();
  const profileDir = await mkdtemp(join(tmpdir(), "wb-ui-shots-profile-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    `--lang=${uiLanguage}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--disable-lcd-text",
    ...(process.platform === "linux"
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : []),
    "about:blank"
  ];
  const proc = spawn(chromeBin, args, {
    stdio: "ignore",
    env: { ...process.env, LANG: `${uiLanguage.replace("-", "_")}.UTF-8` }
  });
  return { proc, port, profileDir };
}

function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Unpacked extensions with a manifest `key` get an id derived from it. */
export async function resolveExtensionId(dir) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));

  if (typeof manifest.key !== "string") {
    throw new Error("The extension manifest has no key; build the development profile.");
  }

  return [
    ...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
  ]
    .map((char) => String.fromCharCode(97 + parseInt(char, 16)))
    .join("");
}
