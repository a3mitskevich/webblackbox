import "./zod-config.js";

import { mountNextPlayer } from "./next/index.js";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Missing #app root for player.");
}

mountNextPlayer(root);
