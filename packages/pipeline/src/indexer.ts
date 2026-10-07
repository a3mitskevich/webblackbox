import type {
  ChunkTimeIndexEntry,
  InvertedIndexEntry,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";
import { extractRequestId } from "@webblackbox/protocol";

type MutableIndexes = {
  time: ChunkTimeIndexEntry[];
  request: Map<string, Set<string>>;
  inverted: Map<string, Set<string>>;
};

const MIN_INDEX_TERM_LENGTH = 2;
const MAX_INDEX_TERM_LENGTH = 64;
const MAX_TERMS_PER_EVENT = 256;
const HASH_HEX_PATTERN = /^[a-f0-9]{32,}$/i;
const BASE64ISH_PATTERN = /^[a-z0-9+/_=-]{80,}$/i;
/**
 * Inverted index size limits. A term found in more than half the events narrows nothing down,
 * so once a session is large enough such stop-word terms are left out; the total number of
 * postings is capped as well, dropping the most frequent terms first. Readers treat a term
 * missing from the index as "scan every event", so search results stay complete.
 */
export type InvertedIndexLimits = {
  maxDocumentRatio: number;
  minEventsForDocumentCutoff: number;
  maxTotalPostings: number;
};

export const INVERTED_INDEX_LIMITS: InvertedIndexLimits = {
  maxDocumentRatio: 0.5,
  minEventsForDocumentCutoff: 2_000,
  maxTotalPostings: 1_000_000
};

export class EventIndexer {
  private readonly indexes: MutableIndexes = {
    time: [],
    request: new Map(),
    inverted: new Map()
  };

  private indexedEvents = 0;

  public constructor(private readonly limits: InvertedIndexLimits = INVERTED_INDEX_LIMITS) {}

  public addChunk(meta: ChunkTimeIndexEntry): void {
    this.indexes.time.push(meta);
  }

  public addEvents(events: WebBlackboxEvent[]): void {
    for (const event of events) {
      this.indexedEvents += 1;
      this.addRequestMapping(event);
      this.addInvertedTerms(event);
    }
  }

  public snapshot(): {
    time: ChunkTimeIndexEntry[];
    request: RequestIndexEntry[];
    inverted: InvertedIndexEntry[];
  } {
    return {
      time: [...this.indexes.time].sort((left, right) => left.seq - right.seq),
      request: [...this.indexes.request.entries()].map(([reqId, eventIds]) => ({
        reqId,
        eventIds: [...eventIds]
      })),
      inverted: limitInvertedTerms(this.indexes.inverted, this.indexedEvents, this.limits).map(
        ([term, eventIds]) => ({
          term,
          eventIds: [...eventIds]
        })
      )
    };
  }

  private addRequestMapping(event: WebBlackboxEvent): void {
    const reqId = extractRequestId(event);

    if (!reqId) {
      return;
    }

    const eventIds = this.indexes.request.get(reqId) ?? new Set<string>();
    eventIds.add(event.id);
    this.indexes.request.set(reqId, eventIds);
  }

  private addInvertedTerms(event: WebBlackboxEvent): void {
    const terms = collectTerms(event, MAX_TERMS_PER_EVENT);

    for (const term of terms) {
      const normalized = term.toLowerCase();

      if (!shouldIndexTerm(normalized)) {
        continue;
      }

      const eventIds = this.indexes.inverted.get(normalized) ?? new Set<string>();
      eventIds.add(event.id);
      this.indexes.inverted.set(normalized, eventIds);
    }
  }
}

function limitInvertedTerms(
  inverted: Map<string, Set<string>>,
  indexedEvents: number,
  limits: InvertedIndexLimits
): Array<[string, Set<string>]> {
  const { maxDocumentRatio, minEventsForDocumentCutoff, maxTotalPostings } = limits;
  const maxDocuments =
    indexedEvents >= minEventsForDocumentCutoff
      ? Math.floor(indexedEvents * maxDocumentRatio)
      : Number.POSITIVE_INFINITY;
  const kept = [...inverted.entries()].filter(([, eventIds]) => eventIds.size <= maxDocuments);
  let totalPostings = kept.reduce((sum, [, eventIds]) => sum + eventIds.size, 0);

  if (totalPostings <= maxTotalPostings) {
    return kept;
  }

  const dropped = new Set<string>();
  const byFrequency = [...kept].sort((left, right) => right[1].size - left[1].size);

  for (const [term, eventIds] of byFrequency) {
    if (totalPostings <= maxTotalPostings) {
      break;
    }

    dropped.add(term);
    totalPostings -= eventIds.size;
  }

  return kept.filter(([term]) => !dropped.has(term));
}

function collectTerms(event: WebBlackboxEvent, maxTerms: number): string[] {
  const terms = new Set<string>();
  terms.add(event.type);

  collectFromValue(event.data, terms, maxTerms);

  return [...terms].slice(0, maxTerms);
}

function collectFromValue(value: unknown, terms: Set<string>, maxTerms: number): void {
  if (terms.size >= maxTerms) {
    return;
  }

  if (typeof value === "string") {
    tokenize(value, terms, maxTerms);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (terms.size >= maxTerms) {
        return;
      }

      collectFromValue(entry, terms, maxTerms);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (terms.size >= maxTerms) {
        return;
      }

      tokenize(key, terms, maxTerms);
      collectFromValue(nested, terms, maxTerms);
    }
  }
}

function tokenize(value: string, terms: Set<string>, maxTerms: number): void {
  const parts = value.split(/[^a-zA-Z0-9_:.\-/]+/g).filter(Boolean);

  for (const part of parts) {
    if (terms.size >= maxTerms) {
      return;
    }

    terms.add(part);
  }
}

function shouldIndexTerm(term: string): boolean {
  if (term.length < MIN_INDEX_TERM_LENGTH || term.length > MAX_INDEX_TERM_LENGTH) {
    return false;
  }

  if (HASH_HEX_PATTERN.test(term)) {
    return false;
  }

  if (BASE64ISH_PATTERN.test(term)) {
    return false;
  }

  return true;
}
