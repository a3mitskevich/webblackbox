/** `type/subtype` built from RFC 9110 token characters. */
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

/**
 * Reduces a Content-Type value (or a MIME type) to a bare lower-case `type/subtype`. A header sent
 * more than once arrives joined with ", " (`application/json, application/json`): the first
 * well-formed member wins. Parameters are dropped. Missing, empty or malformed values give
 * `undefined`.
 */
export function normalizeMimeType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const member of value.split(",")) {
    const mime = member.split(";")[0]?.trim().toLowerCase();

    if (mime && MEDIA_TYPE.test(mime)) {
      return mime;
    }
  }

  return undefined;
}
