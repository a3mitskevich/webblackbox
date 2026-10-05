#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { SERVER_NAME, SERVER_VERSION, startServer } from "./index.js";

export type CliCommand =
  | {
      kind: "start";
      allowedDirs: string[];
    }
  | {
      kind: "help";
    }
  | {
      kind: "version";
    };

const ALLOW_DIR_FLAG = "--allow-dir";

export function parseCliArgs(argv: string[]): CliCommand {
  const allowedDirs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === ALLOW_DIR_FLAG || arg.startsWith(`${ALLOW_DIR_FLAG}=`)) {
      const value = arg === ALLOW_DIR_FLAG ? argv[++index] : arg.slice(ALLOW_DIR_FLAG.length + 1);

      if (!value) {
        throw new Error(`${ALLOW_DIR_FLAG} requires a directory path`);
      }

      allowedDirs.push(value);
      continue;
    }

    if (arg === "--help" || arg === "-h" || arg === "help") {
      return {
        kind: "help"
      };
    }

    if (arg === "--version" || arg === "-v") {
      return {
        kind: "version"
      };
    }

    if (arg === "--stdio" || arg === "stdio") {
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    kind: "start",
    allowedDirs
  };
}

export function formatCliHelp(): string {
  return [
    `${SERVER_NAME} v${SERVER_VERSION}`,
    "",
    "Usage:",
    `  ${SERVER_NAME} [--stdio] [${ALLOW_DIR_FLAG} <dir>]...`,
    `  ${SERVER_NAME} --help`,
    `  ${SERVER_NAME} --version`,
    "",
    "Starts the WebBlackbox MCP server over stdio.",
    "",
    "Options:",
    `  ${ALLOW_DIR_FLAG} <dir>  Only allow archive and directory access inside <dir>.`,
    "                     Repeat for several directories. Default: unrestricted."
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let command: CliCommand;

  try {
    command = parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(formatCliHelp());
    return 1;
  }

  if (command.kind === "help") {
    console.log(formatCliHelp());
    return 0;
  }

  if (command.kind === "version") {
    console.log(SERVER_VERSION);
    return 0;
  }

  await startServer({ allowedDirs: command.allowedDirs });
  return 0;
}

export function isDirectCliInvocation(entryPath: string | undefined, moduleUrl: string): boolean {
  if (!entryPath) {
    return false;
  }

  try {
    const resolvedEntryUrl = pathToFileURL(realpathSync(entryPath)).href;
    const resolvedModuleUrl = pathToFileURL(realpathSync(new URL(moduleUrl))).href;
    return resolvedEntryUrl === resolvedModuleUrl;
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(process.argv[1], import.meta.url)) {
  runCli().then(
    (code) => {
      if (code !== 0) {
        process.exit(code);
      }
    },
    (error: unknown) => {
      console.error("Failed to start MCP server:", error);
      process.exit(1);
    }
  );
}
