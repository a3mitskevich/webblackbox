import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_FILES } from "../../src/shared/extension-files.ts";

export { EXTENSION_FILES };

const extensionAppRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** WXT's default output of `wxt build`, the unpacked extension the e2e scripts load. */
export const DEFAULT_EXTENSION_DIR = resolve(extensionAppRoot, ".output", "chrome-mv3");
