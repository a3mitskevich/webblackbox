import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  UNTRUSTED_CONTENT_NOTICE,
  createServer,
  nowUtcIsoString,
  type CreateServerOptions
} from "./index.js";

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
});
