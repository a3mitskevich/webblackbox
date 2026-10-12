import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  UNTRUSTED_CONTENT_NOTICE,
  UNTRUSTED_IMAGE_NOTICE,
  createServer,
  nowUtcIsoString,
  type CreateServerOptions
} from "./index.js";
import { writeArchive } from "./tools/test-archive.js";
import { checkoutScenario, SCREENSHOT_AFTER } from "./tools/test-scenario.js";

const NO_DECODER: CreateServerOptions["frameDecoder"] = async () => ({
  decoder: null,
  note: "no decoder"
});

async function connectClient(options: CreateServerOptions = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await createServer(options).connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

function readTextBlocks(result: Awaited<ReturnType<Client["callTool"]>>): string[] {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "");
}

describe("mcp-server", () => {
  it("creates server instance", () => {
    expect(createServer()).toBeDefined();
  });

  it("exposes stable server metadata helpers", () => {
    expect(SERVER_NAME).toBe("webblackbox-mcp-server");
    expect(nowUtcIsoString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("marks archive-derived tool output as untrusted", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "wb-mcp-server-")));
    const client = await connectClient();

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);

    const result = await client.callTool({ name: "list_archives", arguments: { dir } });
    const [notice, payload] = readTextBlocks(result);

    expect(notice).toBe(UNTRUSTED_CONTENT_NOTICE);
    expect(JSON.parse(payload ?? "")).toMatchObject({ dir, count: 0 });

    await client.close();
  });

  it("rejects paths outside --allow-dir directories", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "wb-mcp-server-")));
    const allowed = join(root, "allowed");
    await mkdir(allowed);
    const client = await connectClient({ allowedDirs: [allowed] });

    const inside = await client.callTool({ name: "list_archives", arguments: { dir: allowed } });
    expect(inside.isError).not.toBe(true);

    const outside = await client.callTool({
      name: "session_summary",
      arguments: { path: join(root, "other.webblackbox") }
    });
    expect(outside.isError).toBe(true);
    expect(readTextBlocks(outside).join("\n")).toContain("outside the allowed directories");

    await client.close();
  });

  it("guards both symbolicate_stack paths with --allow-dir", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "wb-mcp-server-")));
    const allowed = join(root, "allowed");
    const archive = join(allowed, "session.webblackbox");
    await mkdir(allowed);
    await writeFile(archive, "");
    const client = await connectClient({ allowedDirs: [allowed] });

    const outsideArchive = await client.callTool({
      name: "symbolicate_stack",
      arguments: { path: join(root, "other.webblackbox") }
    });
    expect(outsideArchive.isError).toBe(true);
    expect(readTextBlocks(outsideArchive).join("\n")).toContain("outside the allowed directories");

    const outsideMaps = await client.callTool({
      name: "symbolicate_stack",
      arguments: { path: archive, mapsDir: root }
    });
    expect(outsideMaps.isError).toBe(true);
    expect(readTextBlocks(outsideMaps).join("\n")).toContain("outside the allowed directories");

    await client.close();
  });

  it("registers the drill-down tools as read-only archive tools", async () => {
    const client = await connectClient({ frameDecoder: NO_DECODER });
    const { tools } = await client.listTools();

    for (const name of ["timeline", "action_detail", "request_detail", "frame_at"]) {
      const tool = tools.find((entry) => entry.name === name);

      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool?.inputSchema.required).toContain("path");
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("passphrase");
    }

    expect(SERVER_INSTRUCTIONS).toMatch(/timeline.*action_detail.*request_detail.*frame_at/s);

    await client.close();
  });

  it("frames drill-down JSON and images as untrusted archive content", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "wb-mcp-server-")));
    const { events, blobs } = checkoutScenario();
    const archive = await writeArchive(dir, events, blobs);
    const client = await connectClient({ allowedDirs: [dir], frameDecoder: NO_DECODER });

    const result = await client.callTool({
      name: "frame_at",
      arguments: { path: archive, actionId: "A-1", offsetMs: 300 }
    });
    const content = result.content as Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    >;

    expect(result.isError).not.toBe(true);
    expect(content.map((block) => block.type)).toEqual(["text", "text", "text", "image"]);
    expect(content[0]).toEqual({ type: "text", text: UNTRUSTED_CONTENT_NOTICE });
    expect(JSON.parse((content[1] as { text: string }).text)).toMatchObject({
      frame: { eventId: "E-14", distanceMs: 0 }
    });
    expect((content[2] as { text: string }).text.startsWith(UNTRUSTED_IMAGE_NOTICE)).toBe(true);
    expect(content[3]).toEqual({
      type: "image",
      mimeType: "image/webp",
      data: Buffer.from(SCREENSHOT_AFTER.bytes).toString("base64")
    });

    const timeline = await client.callTool({
      name: "timeline",
      arguments: { path: archive, aroundEventId: "E-12", windowMs: 15 }
    });
    const [notice, payload] = readTextBlocks(timeline);

    expect(notice).toBe(UNTRUSTED_CONTENT_NOTICE);
    expect(JSON.parse(payload ?? "")).toMatchObject({ total: 3 });

    await client.close();
  });

  it("guards the drill-down tools with --allow-dir and reports bad arguments as errors", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "wb-mcp-server-")));
    const allowed = join(root, "allowed");
    await mkdir(allowed);
    const { events, blobs } = checkoutScenario();
    const archive = await writeArchive(allowed, events, blobs);
    const client = await connectClient({ allowedDirs: [allowed], frameDecoder: NO_DECODER });

    const outside = await client.callTool({
      name: "request_detail",
      arguments: { path: join(root, "other.webblackbox"), requestId: "R-1" }
    });
    const unknown = await client.callTool({
      name: "action_detail",
      arguments: { path: archive, actionId: "nope" }
    });

    expect(outside.isError).toBe(true);
    expect(readTextBlocks(outside).join("\n")).toContain("outside the allowed directories");
    expect(unknown.isError).toBe(true);
    expect(readTextBlocks(unknown).join("\n")).toContain("Unknown actionId");

    await client.close();
  });
});
