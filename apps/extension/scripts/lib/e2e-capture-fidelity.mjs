// Full-mode capture fidelity for the fullchain e2e: a long console.error with a deep stack, SignalR
// WebSocket frames (a ~10 KB lobby update in, a 40 KB batch out) and an image served from the memory
// cache. The demo page runs the scenario (`window.__wbDemo.runFidelityScenario`); this module serves
// the socket and the cacheable image, and checks the exported archive with the built player-sdk.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const FIDELITY_SOCKET_PATH = "/ws/signalr";
export const FIDELITY_IMAGE_PATH = "/api/fidelity-image.png";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SIGNALR_RECORD_SEPARATOR = "\u001e";
const LOBBY_FRAME_MIN_CHARS = 10_500;
const MIN_CONSOLE_STACK_FRAMES = 15;
// 1x1 transparent PNG.
const FIDELITY_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** A SignalR invocation result shaped like a lobby update, at least `minChars` long. */
export function buildLobbySignalRFrame(minChars = LOBBY_FRAME_MIN_CHARS) {
  const games = [];
  let frame = "";

  while (frame.length < minChars) {
    games.push({
      gameId: 90_000_467_807 + games.length,
      gameEdition: `KN59${games.length}`,
      gameType: 9,
      currentRoundId: 1,
      gameTimeState: 4,
      bettingTimeInMs: 0,
      isBlur: false,
      startAfterInSec: 0,
      totalBettingTimeInSec: 170
    });
    frame = `${JSON.stringify({ type: 3, invocationId: "0", result: { data: games } })}${SIGNALR_RECORD_SEPARATOR}`;
  }

  return frame;
}

/**
 * Accepts WebSocket upgrades on {@link FIDELITY_SOCKET_PATH} and pushes one lobby frame to each
 * client. Client frames are ignored; `closeAll` drops the sockets so `server.close()` can finish.
 */
export function attachFidelitySocketServer(server) {
  const sockets = new Set();

  server.on("upgrade", (request, socket) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const key = request.headers["sec-websocket-key"];

    if (pathname !== FIDELITY_SOCKET_PATH || typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", () => undefined);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n")
    );
    socket.write(encodeTextFrame(buildLobbySignalRFrame()));
  });

  return {
    closeAll() {
      for (const socket of sockets) {
        socket.destroy();
      }

      sockets.clear();
    }
  };
}

/** Serves the cacheable image the scenario loads twice; returns false for other paths. */
export function serveFidelityImage(pathname, response) {
  if (pathname !== FIDELITY_IMAGE_PATH) {
    return false;
  }

  response.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "public, max-age=3600",
    "content-length": FIDELITY_IMAGE_BYTES.byteLength
  });
  response.end(FIDELITY_IMAGE_BYTES);
  return true;
}

export async function runCaptureFidelityScenario(demoClient) {
  return demoClient.evaluate(`
    (async () => {
      if (!window.__wbDemo || typeof window.__wbDemo.runFidelityScenario !== 'function') {
        return { ok: false, reason: 'fidelity-scenario-missing' };
      }

      try {
        return await window.__wbDemo.runFidelityScenario();
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    })()
  `);
}

/**
 * Opens the exported (encrypted) archive with the built player-sdk and checks that the console line,
 * both WebSocket frames and the cached image survived in full.
 */
export async function verifyCaptureFidelityArchive({
  archivePath,
  passphrase,
  playerSdkEntry,
  scenario
}) {
  const { WebBlackboxPlayer } = await import(pathToFileURL(playerSdkEntry).href);
  const player = await WebBlackboxPlayer.open(new Uint8Array(await readFile(archivePath)), {
    passphrase
  });
  const consoleCheck = checkConsoleEntry(player.query({}), scenario);
  const socketCheck = await checkSocketFrames(player, scenario);
  const cacheCheck = checkCachedImage(player.getNetworkWaterfall());

  return {
    ok: consoleCheck.ok && socketCheck.ok && cacheCheck.ok,
    console: consoleCheck,
    webSocket: socketCheck,
    cache: cacheCheck
  };
}

/** Expands the sent 40 KB frame in the player's realtime panel and waits for the full payload. */
export async function verifyPlayerRealtimePayload(playerClient, expectedChars, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    last = await playerClient.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('#realtime-list details.realtime-entry')];
        const sent = rows.find((row) => (row.querySelector('summary')?.textContent ?? '').includes('sent '));

        if (!sent) {
          return { ok: false, reason: 'sent-frame-row-missing', rows: rows.length };
        }

        if (!sent.open) {
          sent.open = true;
        }

        const text = sent.querySelector('pre')?.textContent ?? '';
        return {
          ok: text.length >= ${Number(expectedChars)} && text.includes('Record 1 of'),
          chars: text.length,
          head: text.slice(0, 120)
        };
      })()
    `);

    if (last?.ok) {
      return last;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { ok: false, reason: "timeout", last };
}

function checkConsoleEntry(events, scenario) {
  const entry = events.find(
    (event) =>
      event.type === "console.entry" &&
      typeof event.data?.text === "string" &&
      event.data.text.includes(scenario.consoleMarker)
  );
  const text = entry?.data?.text ?? "";
  const stackFrames =
    typeof entry?.data?.stack === "string" ? entry.data.stack.split("\n").length : 0;

  return {
    ok:
      Boolean(entry) &&
      text.length >= scenario.consoleChars &&
      entry.data.truncated !== true &&
      stackFrames >= MIN_CONSOLE_STACK_FRAMES,
    found: Boolean(entry),
    textChars: text.length,
    expectedChars: scenario.consoleChars,
    truncated: entry?.data?.truncated === true,
    stackFrames,
    stackTop: entry?.data?.stackTop ?? null
  };
}

async function checkSocketFrames(player, scenario) {
  const frames = player
    .getRealtimeNetworkTimeline()
    .filter((entry) => entry.eventType === "network.ws.frame");
  const received = frames.find(
    (entry) =>
      entry.direction === "received" && (entry.payloadLength ?? 0) >= scenario.receivedChars
  );
  const sent = frames.find(
    (entry) => entry.direction === "sent" && (entry.payloadLength ?? 0) >= scenario.sentChars
  );
  const receivedText = received ? await player.getRealtimePayloadText(received.eventId) : null;
  const sentText = sent ? await player.getRealtimePayloadText(sent.eventId) : null;

  return {
    ok:
      receivedText !== null &&
      receivedText.length === received.payloadLength &&
      sentText !== null &&
      sentText.length === sent.payloadLength &&
      typeof sent.payloadHash === "string" &&
      sentText.endsWith(SIGNALR_RECORD_SEPARATOR),
    frames: frames.length,
    receivedChars: receivedText?.length ?? 0,
    receivedInline: received ? received.payloadHash === undefined : null,
    sentChars: sentText?.length ?? 0,
    sentInBlob: typeof sent?.payloadHash === "string",
    truncated: frames.filter((entry) => entry.payloadTruncated === true).length
  };
}

function checkCachedImage(waterfall) {
  const images = waterfall.filter((entry) => entry.url.includes(FIDELITY_IMAGE_PATH));
  const pendingImages = images.filter((entry) => entry.pending === true);

  return {
    ok:
      images.length >= 2 &&
      pendingImages.length === 0 &&
      images.some((entry) => entry.fromCache === "memory"),
    requests: images.length,
    pending: pendingImages.length,
    fromCache: images.map((entry) => entry.fromCache ?? "network"),
    pendingRequestsInArchive: waterfall.filter((entry) => entry.pending === true).length
  };
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.byteLength;
  let header;

  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}
