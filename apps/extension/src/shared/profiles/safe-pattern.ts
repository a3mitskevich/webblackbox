/**
 * Matchers for rule patterns that come from users, imports and managed policy. They run in the
 * service worker on every navigation, so they must never backtrack catastrophically.
 */

/** Longest page title a title regex is tested against. */
export const MAX_MATCHED_TITLE_LENGTH = 256;

/**
 * Upper bound on the backtracking paths of an accepted title regex: the product of what every
 * quantifier and alternation can try. Two unbounded quantifiers (e.g. `.*a.*b`) fit with a
 * small margin; a third does not.
 */
export const MAX_TITLE_REGEX_BACKTRACKING = 300_000;

type GlobToken = { kind: "literal"; char: string } | { kind: "star"; crossesSegments: boolean };
type RegexGroup = { quantified: boolean; alternated: boolean; branches: number };

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
 * Rejects regular expressions whose matching time can explode on a page title:
 * - a quantified group that contains a quantifier or an alternation, at any depth
 *   (`(a+)+`, `((a|aa))*`): exponential backtracking;
 * - backreferences;
 * - sequences of quantifiers and alternations whose combined backtracking (each unbounded
 *   quantifier counts as a title's length) exceeds {@link MAX_TITLE_REGEX_BACKTRACKING}:
 *   polynomial blow-ups such as `.*a.*b.*c` or `a{0,256}a{0,256}a{0,256}b`.
 * A trailing `.*` or `.+` never backtracks and is free, so `.*foo.*bar.*` is accepted.
 */
export function isSafeRegexSource(source: string): boolean {
  const groups: RegexGroup[] = [];
  let topLevelBranches = 1;
  let lastAtomGroup: RegexGroup | null = null;
  let backtracking = 1;
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
      groups.push({ quantified: false, alternated: false, branches: 1 });
      index += source[index + 1] === "?" ? groupPrefixLength(source, index) : 1;
    } else if (char === ")") {
      const group = groups.pop();

      if (!group) {
        return false;
      }

      const parent = groups[groups.length - 1];

      if (parent) {
        parent.quantified ||= group.quantified;
        parent.alternated ||= group.alternated;
      }

      backtracking *= group.branches;
      atomGroup = group;
      index += 1;
    } else if (char === "|") {
      const current = groups[groups.length - 1];

      if (current) {
        current.alternated = true;
        current.branches += 1;
      } else {
        topLevelBranches += 1;
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

      // A trailing `?` makes the quantifier lazy; it is not a second quantifier.
      const end = index + quantifier.length + (source[index + quantifier.length] === "?" ? 1 : 0);
      const isTrailing = end === source.length && groups.length === 0;

      backtracking *= isTrailing && quantifier.isUnbounded ? 1 : quantifier.choices;
      index = end;
    } else {
      index += 1;
    }

    if (backtracking * topLevelBranches > MAX_TITLE_REGEX_BACKTRACKING) {
      return false;
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

/** Length of the quantifier token and how many repetition counts it can try on a title. */
function readQuantifier(
  source: string,
  index: number
): { length: number; isUnbounded: boolean; choices: number } {
  const char = source[index];
  const unboundedChoices = MAX_MATCHED_TITLE_LENGTH + 1;

  if (char !== "{") {
    return char === "?"
      ? { length: 1, isUnbounded: false, choices: 2 }
      : { length: 1, isUnbounded: true, choices: unboundedChoices };
  }

  const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index));
  const min = Number(match?.[1] ?? 0);
  const isUnbounded = match?.[2] !== undefined && match[3] === "";
  const max = match?.[2] === undefined ? min : isUnbounded ? Infinity : Number(match[3]);
  const span = Math.min(max, MAX_MATCHED_TITLE_LENGTH) - Math.min(min, MAX_MATCHED_TITLE_LENGTH);

  return {
    length: match?.[0].length ?? 1,
    isUnbounded,
    choices: Math.max(1, span + 1)
  };
}
