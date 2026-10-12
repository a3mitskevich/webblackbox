import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlayerRange, WebBlackboxPlayer } from "@webblackbox/player-sdk";
import * as z from "zod";

import { openArchivePlayer } from "../session-tools.js";
import { toUntrustedPayload, type UntrustedImage } from "../untrusted-content.js";
import type { FrameDecoderProvider } from "./frame-decoder.js";

/**
 * One registry for the archive drill-down tools. A tool declares only its own arguments; the
 * registry adds `path` and `passphrase`, checks the path against `--allow-dir`, opens the archive
 * on demand and frames the result (JSON and images) as untrusted archive content.
 */

/** The archive a tool call is about: already checked against the allowed directories. */
export type ArchiveHandle = {
  path: string;
  /** Opens the archive; a range loads only the chunks that intersect it. */
  open(range?: PlayerRange): Promise<WebBlackboxPlayer>;
};

/** Server-side capabilities a tool may use. */
export type ArchiveToolServices = {
  frameDecoder: FrameDecoderProvider;
};

export type ArchiveToolOutput = {
  data: Record<string, unknown>;
  images?: UntrustedImage[];
};

export type ArchiveToolDefinition<Shape extends z.ZodRawShape> = {
  name: string;
  description: string;
  /** The tool's own arguments; `path` and `passphrase` are added by the registry. */
  inputSchema: Shape;
  run(
    args: z.infer<z.ZodObject<Shape>>,
    archive: ArchiveHandle,
    services: ArchiveToolServices
  ): Promise<ArchiveToolOutput>;
};

export type ArchiveTool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  invoke(
    args: Record<string, unknown>,
    archive: ArchiveHandle,
    services: ArchiveToolServices
  ): Promise<ArchiveToolOutput>;
};

export const archiveInputSchema = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives.")
};

export function defineArchiveTool<Shape extends z.ZodRawShape>(
  definition: ArchiveToolDefinition<Shape>
): ArchiveTool {
  const schema = z.object(definition.inputSchema);

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    invoke: (args, archive, services) => definition.run(schema.parse(args), archive, services)
  };
}

export type ArchiveToolRegistryContext = {
  guardPath(path: string): Promise<string>;
  services: ArchiveToolServices;
};

export function registerArchiveTools(
  server: McpServer,
  tools: readonly ArchiveTool[],
  context: ArchiveToolRegistryContext
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: { ...archiveInputSchema, ...tool.inputSchema },
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (args: Record<string, unknown>) => {
        const { path, passphrase, ...rest } = args;
        const guardedPath = await context.guardPath(String(path));
        const archive: ArchiveHandle = {
          path: guardedPath,
          open: (range) =>
            openArchivePlayer(
              guardedPath,
              typeof passphrase === "string" ? passphrase : undefined,
              range
            )
        };
        const output = await tool.invoke(rest, archive, context.services);

        return toUntrustedPayload(output.data, output.images);
      }
    );
  }
}
