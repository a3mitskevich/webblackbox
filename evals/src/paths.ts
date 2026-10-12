// Locations the recorder and the evaluation runner share.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVALS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(EVALS_ROOT, "..");
export const MCP_SERVER_CLI = resolve(REPO_ROOT, "apps/mcp-server/dist/cli.js");
export const ARCHIVES_DIR = resolve(EVALS_ROOT, "archives");
export const RUNS_DIR = resolve(EVALS_ROOT, "runs");
export const REPORTS_DIR = resolve(EVALS_ROOT, "reports");
export const PROMPTS_DIR = resolve(EVALS_ROOT, "prompts");
/** Written by the recorder next to the archives: what was recorded, how, and the passphrase. */
export const ARCHIVE_MANIFEST = "manifest.json";
