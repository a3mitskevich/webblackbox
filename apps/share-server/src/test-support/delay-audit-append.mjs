// Test-only preload (loaded via NODE_OPTIONS=--import): delays appends to the share audit log so
// a handler that responds before awaiting its audit write is caught deterministically.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const AUDIT_LOG_FILE_NAME = "share-access.jsonl";
const AUDIT_APPEND_DELAY_MS = 300;
const originalAppendFile = fs.promises.appendFile;

fs.promises.appendFile = async (path, ...rest) => {
  if (String(path).endsWith(AUDIT_LOG_FILE_NAME)) {
    await delay(AUDIT_APPEND_DELAY_MS);
  }

  return originalAppendFile(path, ...rest);
};

syncBuiltinESMExports();
