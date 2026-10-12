// Points the recorded page's stylesheets, images and fonts at response bodies from the archive
// (spike, task 56). The replay frame's CSP lets it load only blob: and data: URLs, so a resource
// the archive does not have stays unloaded instead of reaching the live site.
import {
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  type RrwebRecordedEvent
} from "@webblackbox/protocol";

/** Maps a recorded URL to a local one, or null when the archive has no body for it. */
export type ResourceResolver = (url: string) => string | null;

type Attributes = Record<string, unknown>;

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const SRC_ATTRIBUTES = new Set(["src", "poster", "xlink:href"]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);
/** `<link>` relations that load a resource (an `<a href>` is navigation, not a load). */
const LOADING_LINK_RELS = /\b(stylesheet|icon|preload|apple-touch-icon)\b/i;

export type ResourceRewrite = {
  events: RrwebRecordedEvent[];
  /** Remote URLs the page would load that the archive has no body for. */
  unresolved: Set<string>;
};

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function asRecord(value: unknown): Attributes | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Attributes)
    : null;
}

/** Rewrites every remote URL of a list; collects what it cannot resolve. */
class Rewriter {
  public readonly unresolved = new Set<string>();

  public constructor(private readonly resolve: ResourceResolver) {}

  public url(url: string): string {
    if (!isRemote(url)) {
      return url;
    }

    const local = this.resolve(url.trim());

    if (local === null) {
      this.unresolved.add(url.trim());
      return url;
    }

    return local;
  }

  public css(text: string): string {
    return text.replace(CSS_URL_PATTERN, (match, quote: string, url: string) => {
      const local = this.url(url);
      return local === url ? match : `url(${quote}${local}${quote})`;
    });
  }

  public srcset(value: string): string {
    return value
      .split(",")
      .map((candidate) => {
        const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
        return [this.url(url), ...descriptor].join(" ");
      })
      .join(", ");
  }

  public attributes(tagName: string, attributes: Attributes): Attributes {
    const isLoadingLink =
      tagName === "link" &&
      typeof attributes.rel === "string" &&
      LOADING_LINK_RELS.test(attributes.rel);

    return Object.fromEntries(
      Object.entries(attributes).map(([name, value]) => {
        if (typeof value !== "string") {
          return [name, value];
        }

        const key = name.toLowerCase();

        if (key === "_csstext" || key === "style") {
          return [name, this.css(value)];
        }

        if (SRCSET_ATTRIBUTES.has(key)) {
          return [name, this.srcset(value)];
        }

        if (SRC_ATTRIBUTES.has(key) || (key === "href" && isLoadingLink)) {
          return [name, this.url(value)];
        }

        return [name, value];
      })
    );
  }

  public node(node: unknown, parentTag = ""): unknown {
    const record = asRecord(node);

    if (!record) {
      return node;
    }

    const tagName = typeof record.tagName === "string" ? record.tagName.toLowerCase() : "";
    const attributes = asRecord(record.attributes);
    const isStyleText = parentTag === "style" && typeof record.textContent === "string";

    return {
      ...record,
      ...(attributes ? { attributes: this.attributes(tagName, attributes) } : {}),
      ...(isStyleText ? { textContent: this.css(record.textContent as string) } : {}),
      ...(Array.isArray(record.childNodes)
        ? { childNodes: record.childNodes.map((child) => this.node(child, tagName)) }
        : {})
    };
  }
}

function rewriteMutation(data: Attributes, rewriter: Rewriter): Attributes {
  const adds = Array.isArray(data.adds)
    ? data.adds.map((add) => {
        const record = asRecord(add);
        return record ? { ...record, node: rewriter.node(record.node) } : add;
      })
    : data.adds;
  const attributes = Array.isArray(data.attributes)
    ? data.attributes.map((change) => {
        const record = asRecord(change);
        const values = record ? asRecord(record.attributes) : null;
        return record && values
          ? { ...record, attributes: rewriter.attributes("", values) }
          : change;
      })
    : data.attributes;

  return { ...data, adds, attributes };
}

/** The events with remote resource URLs pointed at local copies where the archive has them. */
export function rewriteReplayResources(
  events: readonly RrwebRecordedEvent[],
  resolve: ResourceResolver
): ResourceRewrite {
  const rewriter = new Rewriter(resolve);
  const rewritten = events.map((event) => {
    const data = asRecord(event.data);

    if (data && event.type === RRWEB_EVENT_TYPES.fullSnapshot) {
      return { ...event, data: { ...data, node: rewriter.node(data.node) } };
    }

    if (
      data &&
      event.type === RRWEB_EVENT_TYPES.incrementalSnapshot &&
      data.source === RRWEB_INCREMENTAL_SOURCES.mutation
    ) {
      return { ...event, data: rewriteMutation(data, rewriter) };
    }

    return event;
  });

  return { events: rewritten, unresolved: rewriter.unresolved };
}
