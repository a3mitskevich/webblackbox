import type JSZip from "jszip";

import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { extractRequestId } from "@webblackbox/protocol";

import { buildActionTimeline, buildReplayDiagnostics, deriveActionView } from "./actions.js";
import { readZipEntryBytes, type ArchiveLoadLimits } from "./archive-limits.js";
import {
  assertArchiveFileIntegrity,
  buildBlobIndex,
  decryptArchiveFile,
  openArchive,
  parseChunkEvents,
  resolveBlobByKey,
  type ArchiveEncryptedFileMeta,
  type BlobRef,
  type ChunkMonoBounds,
  type EventChunkSource
} from "./archive-reader.js";
import { buildBugReport, buildGitHubIssueTemplate, buildJiraIssueTemplate } from "./bug-report.js";
import {
  buildCaptureCompletenessReport,
  type CaptureCompletenessReport
} from "./capture-completeness.js";
import {
  buildCurlCommand,
  buildFetchSnippet,
  buildPlaywrightMockScript,
  buildPlaywrightScript
} from "./codegen.js";
import { comparePlayers, compareStorageTimelines } from "./compare.js";
import { buildDomDiff, buildDomDiffTimeline, loadDomPaths, toDomSnapshotRefs } from "./dom-diff.js";
import { mergeSortedEventLists } from "./event-order.js";
import {
  chunkSourceIntersectsRange,
  collectInvertedCandidateIds,
  computeTextScore,
  intersectCandidateIds,
  isRangeUnbounded,
  matchesText,
  sliceEventsByMonoRange,
  withinRange
} from "./event-query.js";
import { buildHarExport } from "./har.js";
import {
  buildNetworkWaterfall,
  buildRealtimeNetworkTimeline,
  buildRequestResponseDiff,
  readRealtimePayloadText
} from "./network.js";
import {
  buildPointerTimeline,
  detectPointerSignals,
  type PointerSignals,
  type PointerTimelineEntry
} from "./pointer-insights.js";
import {
  assembleScreenRecording,
  listScreenRecordings,
  type ScreenRecordingBlob,
  type ScreenRecordingBlobOptions,
  type ScreenRecordingSegment
} from "./screen-recordings.js";
import { buildPrivacyProtectionReport, buildSensitiveDataPreview } from "./privacy-report.js";
import { buildPerformanceArtifacts, buildStorageTimeline } from "./timelines.js";
import type {
  ActionTimelineEntry,
  BugReportOptions,
  DomDiffResult,
  DomDiffTimelineOptions,
  DomSnapshotRef,
  GitHubIssueTemplate,
  JiraIssueTemplate,
  NetworkWaterfallEntry,
  PerformanceArtifactEntry,
  PlayerArchive,
  PlayerComparison,
  PlayerDerivedView,
  PlayerOpenInput,
  PlayerOpenOptions,
  PlayerQuery,
  PlayerRange,
  PlayerSearchResult,
  PlayerStatus,
  PlaywrightMockScriptOptions,
  PlaywrightScriptOptions,
  PrivacyProtectionReport,
  RealtimeNetworkEntry,
  ReplayDiagnosticEntry,
  RequestResponseDiff,
  SensitiveDataPreview,
  StorageComparison,
  StorageTimelineEntry,
  TeamIssueTemplateOptions
} from "./types.js";

export * from "./types.js";

export { compareEventsForTimeline } from "./event-order.js";

export {
  buildCaptureCompletenessReport,
  formatCaptureCompletenessReport,
  MAX_MISSING_SAMPLES,
  type BodyCompleteness,
  type CaptureCompletenessReport,
  type MimeCompleteness
} from "./capture-completeness.js";

export {
  ArchiveLimitError,
  assertArchiveWithinLimits,
  DEFAULT_ARCHIVE_LOAD_LIMITS,
  readZipEntryBytes,
  resolveArchiveLoadLimits,
  type ArchiveLoadLimits
} from "./archive-limits.js";

export * from "./activity-feed.js";
export * from "./compare-endpoints.js";
export * from "./console-entries.js";
export * from "./event-inspection.js";
export * from "./perf-series.js";
export * from "./playwright-actions.js";
export * from "./problems.js";
export * from "./pointer-insights.js";
export * from "./realtime-messages.js";
export * from "./realtime-streams.js";
export * from "./recording-profile.js";
export * from "./request-details.js";
export * from "./route-chapters.js";
export * from "./screen-recordings.js";
export * from "./source-map.js";
export * from "./stack-trace.js";
export * from "./storage-state.js";
export * from "./symbolicate.js";
export * from "./tabs-context.js";
export * from "./third-party.js";
export * from "./webm-seekable.js";

const DEFAULT_DECODED_CHUNK_CACHE_SIZE = 12;

/**
 * Main SDK entry for loading, querying, and exporting insights from `.webblackbox` archives.
 */
export class WebBlackboxPlayer {
  /** Current player status (always `loaded` for opened instances). */
  public readonly status: PlayerStatus = "loaded";

  /** Parsed archive metadata and indexes. */
  public readonly archive: PlayerArchive;

  private readonly zip: JSZip;

  private readonly eventChunks: EventChunkSource[];

  private readonly decodedChunkCache = new Map<string, WebBlackboxEvent[]>();

  /** True mono bounds of chunks parsed so far; index bounds of older archives are first/last only. */
  private readonly parsedChunkBounds = new Map<string, ChunkMonoBounds>();

  private allEventsCache: WebBlackboxEvent[] | null = null;

  private allDerivedCache: PlayerDerivedView | null = null;

  private allNetworkWaterfallCache: NetworkWaterfallEntry[] | null = null;

  private allStorageTimelineCache: StorageTimelineEntry[] | null = null;

  private allPerformanceArtifactsCache: PerformanceArtifactEntry[] | null = null;

  private screenRecordingsCache: ScreenRecordingSegment[] | null = null;

  private readonly requestToEventIds = new Map<string, string[]>();

  private readonly inverted = new Map<string, string[]>();

  private readonly blobsByHash: Map<string, BlobRef>;

  private readonly archiveKey: CryptoKey | null;

  private readonly encryptedFiles: Record<string, ArchiveEncryptedFileMeta>;

  private readonly limits: ArchiveLoadLimits;

  private constructor(
    zip: JSZip,
    archive: PlayerArchive,
    eventChunks: EventChunkSource[],
    archiveKey: CryptoKey | null,
    encryptedFiles: Record<string, ArchiveEncryptedFileMeta>,
    limits: ArchiveLoadLimits
  ) {
    this.zip = zip;
    this.limits = limits;
    this.archive = archive;
    this.archiveKey = archiveKey;
    this.encryptedFiles = encryptedFiles;
    this.eventChunks = [...eventChunks].sort((left, right) => left.seq - right.seq);

    for (const entry of archive.requestIndex) {
      this.requestToEventIds.set(entry.reqId, [...entry.eventIds]);
    }

    for (const entry of archive.invertedIndex) {
      this.inverted.set(entry.term.toLowerCase(), [...entry.eventIds]);
    }

    this.blobsByHash = buildBlobIndex(zip);
  }

  /** Returns all events in the current loaded range. */
  public get events(): WebBlackboxEvent[] {
    return this.query();
  }

  /** Opens a WebBlackbox archive from bytes, buffer, or Blob input. */
  public static async open(
    input: PlayerOpenInput,
    options: PlayerOpenOptions = {}
  ): Promise<WebBlackboxPlayer> {
    const opened = await openArchive(input, options);

    return new WebBlackboxPlayer(
      opened.zip,
      opened.archive,
      opened.eventChunks,
      opened.archiveKey,
      opened.encryptedFiles,
      opened.limits
    );
  }

  /** Queries events using range/type/level/text/request filters. */
  public query(query: PlayerQuery = {}): WebBlackboxEvent[] {
    if (
      query.range?.monoStart !== undefined &&
      query.range?.monoEnd !== undefined &&
      query.range.monoStart > query.range.monoEnd
    ) {
      return [];
    }

    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, query.limit ?? Number.POSITIVE_INFINITY);
    const types = query.types ? new Set(query.types) : null;
    const levels = query.levels ? new Set(query.levels) : null;
    const text = query.text?.trim().toLowerCase();
    const indexedRequestIds = query.requestId ? this.requestToEventIds.get(query.requestId) : null;
    const requestedIds = query.requestId && indexedRequestIds ? new Set(indexedRequestIds) : null;
    const textCandidateIds = text ? collectInvertedCandidateIds(this.inverted, text) : null;
    const candidateIds = intersectCandidateIds(requestedIds, textCandidateIds);
    const sourceEvents = isRangeUnbounded(query.range) ? this.getAllEvents() : null;
    const isUnfilteredFullQuery =
      sourceEvents !== null &&
      offset === 0 &&
      !Number.isFinite(limit) &&
      !query.requestId &&
      !types &&
      !levels &&
      !text;

    if (isUnfilteredFullQuery) {
      return sourceEvents;
    }

    if (candidateIds && candidateIds.size === 0) {
      return [];
    }

    const matched: WebBlackboxEvent[] = [];
    let skipped = 0;

    const collectMatch = (event: WebBlackboxEvent): boolean => {
      if (candidateIds && !candidateIds.has(event.id)) {
        return false;
      }

      if (query.requestId && extractRequestId(event) !== query.requestId) {
        return false;
      }

      if (!withinRange(event, query.range)) {
        return false;
      }

      if (types && !types.has(event.type)) {
        return false;
      }

      if (levels && (!event.lvl || !levels.has(event.lvl))) {
        return false;
      }

      if (text && !matchesText(event, text)) {
        return false;
      }

      if (skipped < offset) {
        skipped += 1;
        return false;
      }

      matched.push(event);
      return matched.length >= limit;
    };

    for (const event of sourceEvents ?? this.getRangeEvents(query.range)) {
      if (collectMatch(event)) {
        return matched;
      }
    }

    return matched;
  }

  /** Full-text search over indexed terms and event payloads. */
  public search(term: string, limit = 100): PlayerSearchResult[] {
    const normalizedTerm = term.trim().toLowerCase();

    if (!normalizedTerm) {
      return [];
    }

    const eventIds = this.inverted.get(normalizedTerm);
    const ranked = new Map<string, number>();
    const candidateIds = collectInvertedCandidateIds(this.inverted, normalizedTerm);
    const eventsById = new Map<string, WebBlackboxEvent>();

    if (eventIds) {
      for (const eventId of eventIds) {
        ranked.set(eventId, 10);
      }
    }

    for (const event of this.getAllEvents()) {
      if (candidateIds && !candidateIds.has(event.id)) {
        continue;
      }

      const score = computeTextScore(event, normalizedTerm);

      if (score <= 0 && !ranked.has(event.id)) {
        continue;
      }

      const previous = ranked.get(event.id) ?? 0;
      ranked.set(event.id, Math.max(previous, score));
      eventsById.set(event.id, event);
    }

    return [...ranked.entries()]
      .map(([eventId, score]) => ({ eventId, score, event: eventsById.get(eventId) }))
      .filter((entry): entry is { eventId: string; score: number; event: WebBlackboxEvent } =>
        Boolean(entry.event)
      )
      .sort((left, right) => right.score - left.score || left.event.mono - right.event.mono)
      .slice(0, Math.max(1, limit));
  }

  /**
   * Events of a mono range in timeline order. Uses the fully loaded list when available (exact);
   * otherwise merges the per-chunk ordered lists of the chunks that may hold the range, because
   * chunks overlap in time when events arrive late.
   */
  private getRangeEvents(range?: PlayerRange): WebBlackboxEvent[] {
    if (this.allEventsCache) {
      return sliceEventsByMonoRange(this.allEventsCache, range);
    }

    return mergeSortedEventLists(
      this.getChunksForRange(range).map((chunk) => this.getChunkEvents(chunk))
    );
  }

  private getChunksForRange(range?: PlayerRange): EventChunkSource[] {
    if (!range) {
      return this.eventChunks;
    }

    return this.eventChunks.filter((chunk) =>
      chunkSourceIntersectsRange(this.resolveChunkBounds(chunk), range)
    );
  }

  private resolveChunkBounds(chunk: EventChunkSource): ChunkMonoBounds {
    const parsed = this.parsedChunkBounds.get(chunk.chunkId);

    if (!parsed) {
      return chunk;
    }

    return {
      monoStart: Math.min(chunk.monoStart, parsed.monoStart),
      monoEnd: Math.max(chunk.monoEnd, parsed.monoEnd)
    };
  }

  private getAllEvents(): WebBlackboxEvent[] {
    if (this.allEventsCache) {
      return this.allEventsCache;
    }

    const events = mergeSortedEventLists(
      this.eventChunks.map((chunk) => this.getChunkEvents(chunk))
    );

    this.allEventsCache = events;
    return events;
  }

  private getChunkEvents(chunk: EventChunkSource): WebBlackboxEvent[] {
    const cached = this.decodedChunkCache.get(chunk.chunkId);

    if (cached) {
      this.decodedChunkCache.delete(chunk.chunkId);
      this.decodedChunkCache.set(chunk.chunkId, cached);
      return cached;
    }

    const parsed = parseChunkEvents(chunk);
    this.decodedChunkCache.set(chunk.chunkId, parsed);
    this.rememberParsedChunkBounds(chunk.chunkId, parsed);

    while (this.decodedChunkCache.size > DEFAULT_DECODED_CHUNK_CACHE_SIZE) {
      const oldest = this.decodedChunkCache.keys().next().value;

      if (!oldest) {
        break;
      }

      this.decodedChunkCache.delete(oldest);
    }

    return parsed;
  }

  private rememberParsedChunkBounds(chunkId: string, events: WebBlackboxEvent[]): void {
    const first = events[0];
    const last = events[events.length - 1];

    if (first && last && !this.parsedChunkBounds.has(chunkId)) {
      this.parsedChunkBounds.set(chunkId, { monoStart: first.mono, monoEnd: last.mono });
    }
  }

  private findEventById(eventId: string): WebBlackboxEvent | null {
    if (!eventId.trim()) {
      return null;
    }

    if (this.allEventsCache) {
      return this.allEventsCache.find((entry) => entry.id === eventId) ?? null;
    }

    for (const chunk of this.eventChunks) {
      const event = this.getChunkEvents(chunk).find((entry) => entry.id === eventId);

      if (event) {
        return event;
      }
    }

    return null;
  }

  /** Resolves a stored blob by hash or blob path alias. */
  public async getBlob(hash: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
    const blob = resolveBlobByKey(this.blobsByHash, hash);

    if (!blob) {
      return null;
    }

    const file = this.zip.file(blob.path);

    if (!file) {
      return null;
    }

    const rawBytes = await readZipEntryBytes(file, this.limits);
    await assertArchiveFileIntegrity(this.archive.integrity, blob.path, rawBytes);
    const bytes = await decryptArchiveFile(
      blob.path,
      rawBytes,
      this.archiveKey,
      this.encryptedFiles
    );

    return {
      mime: blob.mime,
      bytes
    };
  }

  /**
   * The tab video segments (one per `recordingId`, in start order) with their duration, size,
   * chunk count and the chunks the archive lacks.
   */
  public getScreenRecordings(): ScreenRecordingSegment[] {
    this.screenRecordingsCache ??= listScreenRecordings(this.query());
    return this.screenRecordingsCache.map((segment) => ({ ...segment }));
  }

  /**
   * The video of one segment: its chunks joined in recording order; a WebM also gets a Duration
   * and Cues so that players show its length and seek (`raw: true` skips that). Throws
   * {@link ScreenRecordingIncompleteError} naming the missing chunks.
   */
  public async getScreenRecordingBlob(
    recordingId: string,
    options: ScreenRecordingBlobOptions = {}
  ): Promise<ScreenRecordingBlob> {
    const segment = this.getScreenRecordings().find((entry) => entry.recordingId === recordingId);

    if (!segment) {
      throw new Error(`Unknown screen recording: ${recordingId}`);
    }

    return assembleScreenRecording(segment, (chunkId) => this.getBlob(chunkId), options);
  }

  /** Builds action-span aggregates and total counters for the selected range. */
  public buildDerived(range?: PlayerRange): PlayerDerivedView {
    if (isRangeUnbounded(range) && this.allDerivedCache) {
      return this.allDerivedCache;
    }

    const derived = deriveActionView(this.query({ range }));

    if (isRangeUnbounded(range)) {
      this.allDerivedCache = derived;
    }

    return derived;
  }

  /** Builds a privacy/export preflight report that explains configured redaction and detected evidence. */
  public getPrivacyProtectionReport(range?: PlayerRange): PrivacyProtectionReport {
    return buildPrivacyProtectionReport(this, range);
  }

  /** Returns bounded redaction evidence samples so users can review sensitive data before export/share. */
  public getSensitiveDataPreview(
    options: {
      range?: PlayerRange;
      limit?: number;
    } = {}
  ): SensitiveDataPreview {
    return buildSensitiveDataPreview(this, options);
  }

  /** Builds per-action timeline rows with related requests/errors/screenshots. */
  public getActionTimeline(
    options: {
      range?: PlayerRange;
      limit?: number;
      screenshotLookaheadMs?: number;
      requestLimit?: number;
      errorLimit?: number;
      derived?: PlayerDerivedView;
    } = {}
  ): ActionTimelineEntry[] {
    return buildActionTimeline(this, options);
  }

  /** Builds trusted-replay diagnostics by joining actions with network, errors, and screenshot evidence. */
  public getReplayDiagnostics(
    options: {
      range?: PlayerRange;
      limit?: number;
      actions?: ActionTimelineEntry[];
      waterfall?: NetworkWaterfallEntry[];
    } = {}
  ): ReplayDiagnosticEntry[] {
    return buildReplayDiagnostics(this, options);
  }

  /** Returns normalized network waterfall entries sorted by start time. */
  public getNetworkWaterfall(range?: PlayerRange): NetworkWaterfallEntry[] {
    if (isRangeUnbounded(range) && this.allNetworkWaterfallCache) {
      return this.allNetworkWaterfallCache;
    }

    const waterfall = buildNetworkWaterfall(this.query({ range }));

    if (isRangeUnbounded(range)) {
      this.allNetworkWaterfallCache = waterfall;
    }

    return waterfall;
  }

  /** Returns all events that reference a specific request id. */
  public getRequestEvents(reqId: string): WebBlackboxEvent[] {
    return this.query({ requestId: reqId });
  }

  /** Builds a concrete request/response diff including body sizes and missing replay inputs. */
  public async getRequestResponseDiff(reqId: string): Promise<RequestResponseDiff | null> {
    return buildRequestResponseDiff(this, reqId);
  }

  /**
   * What the archive holds against what its capture policy asked for: body ratios by MIME type
   * (with every loss explained or counted as missing), DOM changes, WebSocket frames, console,
   * storage values and perf signals.
   */
  public getCaptureCompleteness(range?: PlayerRange): CaptureCompletenessReport {
    return buildCaptureCompletenessReport({
      events: this.query({ range }),
      waterfall: this.getNetworkWaterfall(range),
      realtime: this.getRealtimeNetworkTimeline(range)
    });
  }

  /** Returns realtime network stream entries (WebSocket/SSE). */
  public getRealtimeNetworkTimeline(range?: PlayerRange): RealtimeNetworkEntry[] {
    return buildRealtimeNetworkTimeline(this.query({ range }));
  }

  /**
   * Full text of a WebSocket frame or SSE message: the inline payload, or the blob the pipeline moved
   * a large one into. Null for unknown events and events without a payload. Rejects when the event
   * references a blob the archive does not hold, rather than returning the inline head as the frame.
   */
  public async getRealtimePayloadText(eventId: string): Promise<string | null> {
    return readRealtimePayloadText(this, eventId);
  }

  /** Returns storage timeline entries (cookie/local/session/idb/cache/sw). */
  public getStorageTimeline(range?: PlayerRange): StorageTimelineEntry[] {
    if (isRangeUnbounded(range) && this.allStorageTimelineCache) {
      return this.allStorageTimelineCache;
    }

    const timeline = buildStorageTimeline(this.query({ range }));

    if (isRangeUnbounded(range)) {
      this.allStorageTimelineCache = timeline;
    }

    return timeline;
  }

  /** Returns collected performance artifacts (trace/cpu/heap/vitals/longtask). */
  public getPerformanceArtifacts(range?: PlayerRange): PerformanceArtifactEntry[] {
    if (isRangeUnbounded(range) && this.allPerformanceArtifactsCache) {
      return this.allPerformanceArtifactsCache;
    }

    const artifacts = buildPerformanceArtifacts(this.query({ range }));

    if (isRangeUnbounded(range)) {
      this.allPerformanceArtifactsCache = artifacts;
    }

    return artifacts;
  }

  /** Returns DOM snapshot references ordered by monotonic time. */
  public getDomSnapshots(range?: PlayerRange): DomSnapshotRef[] {
    return toDomSnapshotRefs(this.query({ range }));
  }

  /** Computes sequential diffs across the DOM snapshot timeline. */
  public async getDomDiffTimeline(options: DomDiffTimelineOptions = {}): Promise<DomDiffResult[]> {
    return buildDomDiffTimeline(this, options);
  }

  /** Compares two snapshots from this player by event id. */
  public async compareDomSnapshots(
    previousEventId: string,
    currentEventId: string
  ): Promise<DomDiffResult | null> {
    const previous = this.getDomSnapshots().find((entry) => entry.eventId === previousEventId);
    const current = this.getDomSnapshots().find((entry) => entry.eventId === currentEventId);

    if (!previous || !current) {
      return null;
    }

    const previousPaths = await this.loadDomPaths(previous);
    const currentPaths = await this.loadDomPaths(current);

    return buildDomDiff(previous, current, previousPaths, currentPaths);
  }

  /** Compares latest DOM snapshots across two players. */
  public async compareLatestDomSnapshotWith(
    other: WebBlackboxPlayer
  ): Promise<DomDiffResult | null> {
    const left = this.getDomSnapshots();
    const right = other.getDomSnapshots();
    const previous = left[left.length - 1];
    const current = right[right.length - 1];

    if (!previous || !current) {
      return null;
    }

    const previousPaths = await this.loadDomPaths(previous);
    const currentPaths = await other.loadDomPaths(current);

    return buildDomDiff(previous, current, previousPaths, currentPaths);
  }

  /** Compares two sessions by event/request/error deltas and endpoint regressions. */
  public compareWith(other: WebBlackboxPlayer): PlayerComparison {
    return comparePlayers(this, other);
  }

  /** Compares storage timelines across two sessions. */
  public compareStorageWith(other: WebBlackboxPlayer): StorageComparison {
    return compareStorageTimelines(this, other);
  }

  /** Generates a curl replay command for a recorded network request. */
  public generateCurl(reqId: string): string | null {
    return buildCurlCommand(this, reqId);
  }

  /** Generates a fetch replay snippet for a recorded network request. */
  public generateFetch(reqId: string): string | null {
    return buildFetchSnippet(this, reqId);
  }

  /** Exports a HAR 1.2 document from network events. */
  public exportHar(range?: PlayerRange): string {
    return buildHarExport(this, range);
  }

  /** Pointer actions for the pointer lane: clicks, right/middle clicks, holds, drags, wheel, hover. */
  public getPointerTimeline(range?: PlayerRange): PointerTimelineEntry[] {
    return buildPointerTimeline(this.query({ range }));
  }

  /** Rage clicks and dead clicks in the range (see `detectRageClicks` / `detectDeadClicks`). */
  public getPointerSignals(range?: PlayerRange): PointerSignals {
    return detectPointerSignals(this.query({ range }));
  }

  /** Generates a Markdown bug report for the selected range. */
  public generateBugReport(options: BugReportOptions = {}): string {
    return buildBugReport(this, options);
  }

  /** Generates a GitHub issue template payload from session evidence. */
  public generateGitHubIssueTemplate(options: TeamIssueTemplateOptions = {}): GitHubIssueTemplate {
    return buildGitHubIssueTemplate(this, options);
  }

  /** Generates a Jira issue payload from session evidence. */
  public generateJiraIssueTemplate(options: TeamIssueTemplateOptions = {}): JiraIssueTemplate {
    return buildJiraIssueTemplate(this, options);
  }

  /** Generates a Playwright script from captured navigation and user actions. */
  public generatePlaywrightScript(options: PlaywrightScriptOptions = {}): string {
    return buildPlaywrightScript(this, options);
  }

  /** Generates a Playwright script with mocked network responses. */
  public async generatePlaywrightMockScript(
    options: PlaywrightMockScriptOptions = {}
  ): Promise<string> {
    return buildPlaywrightMockScript(this, options);
  }

  private async loadDomPaths(snapshot: DomSnapshotRef): Promise<Set<string>> {
    return loadDomPaths(snapshot, {
      getBlob: (hash) => this.getBlob(hash),
      findEventById: (eventId) => this.findEventById(eventId)
    });
  }
}

/** Returns the default pre-open player status. */
export function getDefaultPlayerStatus(): PlayerStatus {
  return "idle";
}
