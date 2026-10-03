/**
 * Matchers for rule patterns that come from users, imports and managed policy. They run in the
 * service worker on every navigation, so they must never backtrack catastrophically.
 */

/** Most unbounded quantifiers (`*`, `+`, `{n,}`) a title regex may use. */
export const MAX_TITLE_REGEX_UNBOUNDED_QUANTIFIERS = 2;

type GlobToken = { kind: "literal"; char: string } | { kind: "star"; crossesSegments: boolean };
type RegexGroup = { quantified: boolean; alternated: boolean };

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

/**
 * Rejects regular expressions whose matching time can explode: quantified groups that contain
 * a quantifier or an alternation (`(a+)+`, `(a|aa)*`), backreferences, and more than
 * {@link MAX_TITLE_REGEX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers.
 */
export function isSafeRegexSource(source: string): boolean {
  const groups: RegexGroup[] = [];
  let lastAtomGroup: RegexGroup | null = null;
  let unbounded = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";
    let atomGroup: RegexGroup | null = null;

    if (char === "\\") {
      if (/[1-9k]/.test(source[index + 1] ?? "")) {
        return false;
      }

      index += 2;
    } else if (char === "[") {
      index = skipCharacterClass(source, index);
    } else if (char === "(") {
      groups.push({ quantified: false, alternated: false });
      index += source[index + 1] === "?" ? groupPrefixLength(source, index) : 1;
    } else if (char === ")") {
      const group = groups.pop();

      if (!group) {
        return false;
      }

      const parent = groups[groups.length - 1];

      if (parent) {
        parent.quantified ||= group.quantified;
      }

      atomGroup = group;
      index += 1;
    } else if (char === "|") {
      const current = groups[groups.length - 1];

      if (current) {
        current.alternated = true;
      }

      index += 1;
    } else if (isQuantifierStart(source, index)) {
      const quantifier = readQuantifier(source, index);

      if (lastAtomGroup && (lastAtomGroup.quantified || lastAtomGroup.alternated)) {
        return false;
      }

      const current = groups[groups.length - 1];

      if (current) {
        current.quantified = true;
      }

      unbounded += quantifier.isUnbounded ? 1 : 0;

      if (unbounded > MAX_TITLE_REGEX_UNBOUNDED_QUANTIFIERS) {
        return false;
      }

      // A trailing `?` makes the quantifier lazy; it is not a second quantifier.
      index += quantifier.length + (source[index + quantifier.length] === "?" ? 1 : 0);
    } else {
      index += 1;
    }

    lastAtomGroup = atomGroup;
  }

  return groups.length === 0;
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

function skipCharacterClass(source: string, start: number): number {
  let index = start + 1;

  while (index < source.length && source[index] !== "]") {
    index += source[index] === "\\" ? 2 : 1;
  }

  return index + 1;
}

/** Length of `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` or `(?<name>`. */
function groupPrefixLength(source: string, start: number): number {
  const isLookbehind = source[start + 3] === "=" || source[start + 3] === "!";

  if (source[start + 2] === "<" && !isLookbehind) {
    const end = source.indexOf(">", start);
    return end === -1 ? source.length - start : end - start + 1;
  }

  return source[start + 2] === "<" ? 4 : 3;
}

function isQuantifierStart(source: string, index: number): boolean {
  const char = source[index];
  return (
    char === "*" ||
    char === "+" ||
    char === "?" ||
    (char === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(index)))
  );
}

function readQuantifier(source: string, index: number): { length: number; isUnbounded: boolean } {
  const char = source[index];

  if (char !== "{") {
    return { length: 1, isUnbounded: char !== "?" };
  }

  const match = /^\{\d+(,(\d*))?\}/.exec(source.slice(index));
  return {
    length: match?.[0].length ?? 1,
    isUnbounded: match?.[1] !== undefined && match[2] === ""
  };
}
