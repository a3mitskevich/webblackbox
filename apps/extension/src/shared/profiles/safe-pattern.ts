/**
 * Path globs for rules that come from users, imports and managed policy. They run in the
 * service worker on every navigation, so they must never backtrack catastrophically.
 */

type GlobToken = { kind: "literal"; char: string } | { kind: "star"; crossesSegments: boolean };

/**
 * Glob match in O(pattern × text): `*` matches within one `/` segment, `**` across segments,
 * everything else is literal.
 */
export function matchesGlob(text: string, pattern: string): boolean {
  let reachable = Array.from({ length: text.length + 1 }, (_, index) => index === 0);

  for (const token of tokenizeGlob(pattern)) {
    const next = Array.from({ length: text.length + 1 }, () => false);

    for (let index = 0; index <= text.length; index += 1) {
      if (token.kind === "literal") {
        next[index] = index > 0 && reachable[index - 1] === true && text[index - 1] === token.char;
        continue;
      }

      next[index] =
        reachable[index] === true ||
        (index > 0 &&
          next[index - 1] === true &&
          (token.crossesSegments || text[index - 1] !== "/"));
    }

    reachable = next;
  }

  return reachable[text.length] === true;
}

function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let index = 0;

  while (index < pattern.length) {
    if (pattern.startsWith("**", index)) {
      tokens.push({ kind: "star", crossesSegments: true });
      index += 2;
    } else if (pattern[index] === "*") {
      tokens.push({ kind: "star", crossesSegments: false });
      index += 1;
    } else {
      tokens.push({ kind: "literal", char: pattern[index] ?? "" });
      index += 1;
    }
  }

  return tokens;
}
