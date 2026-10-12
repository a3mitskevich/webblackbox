import { actionDetailTool } from "./action-detail.js";
import { frameAtTool } from "./frame-at.js";
import { findOnPageTool, pageStateAtTool } from "./page-state.js";
import type { ArchiveTool } from "./registry.js";
import { requestDetailTool } from "./request-detail.js";
import { timelineTool } from "./timeline.js";

export { registerArchiveTools, type ArchiveTool } from "./registry.js";
export {
  createFfmpegDecoderProvider,
  FFMPEG_ENV,
  type FrameDecoder,
  type FrameDecoderProvider
} from "./frame-decoder.js";

/**
 * The drill-down tools, registered through `registerArchiveTools`. A new tool lives in its own
 * module (`defineArchiveTool`) and adds one entry here.
 */
export const ARCHIVE_TOOLS: readonly ArchiveTool[] = [
  timelineTool,
  actionDetailTool,
  requestDetailTool,
  frameAtTool,
  pageStateAtTool,
  findOnPageTool
];
