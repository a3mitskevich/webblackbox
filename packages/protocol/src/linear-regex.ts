/**
 * Linear-time regular expressions for patterns that come from users, imported files and managed
 * policy (title rules, redaction value patterns). They must never backtrack: the pattern is
 * compiled to a Thompson NFA and run as a Pike VM, which takes O(program × text) whatever the
 * pattern. Single-character atoms (literals, escapes, `.`, classes) are tested by a native
 * one-character RegExp, so character semantics, including the `i` flag, are exactly
 * JavaScript's. Backreferences and lookarounds cannot be matched in linear time and are rejected.
 * Matching is always case-insensitive. Repeat counts above {@link REPETITION_LIMIT} behave like
 * the limit (or like no upper bound).
 */

/**
 * Most VM steps (threads advanced and states visited) one scan may take (about half a second). Linear time can still be long for a
 * large program on a large text; past the budget, the text is treated as matching whole (masked
 * by `replaceAll`, `true` for `test`): fail closed rather than stall the page or the worker.
 */
export const MAX_SCAN_STEPS = 10_000_000;

/** Largest repeat count compiled as written. */
export const REPETITION_LIMIT = 257;
/** Largest compiled program; bounds the work per text character. */
const MAX_PROGRAM_SIZE = 4_000;
/**
 * Most AST nodes visited while compiling. Repeats of empty groups (`((){99}){99}…`) emit no
 * instructions, so the program cap alone would not stop exponential compile time.
 */
const MAX_COMPILE_STEPS = MAX_PROGRAM_SIZE * 4;

export type LinearRegex = {
  /** Whether the pattern matches anywhere in `text`. */
  test(text: string): boolean;
  /** `text` with every non-empty match replaced by `replacement` (overlapping matches merged). */
  replaceAll(text: string, replacement: string): string;
};

type Span = { start: number; end: number };

type Assertion = "start" | "end" | "word-boundary" | "not-word-boundary";
type CharTest = (char: string) => boolean;

type RegexNode =
  | { kind: "char"; test: CharTest }
  | { kind: "sequence"; items: RegexNode[] }
  | { kind: "alternation"; options: RegexNode[] }
  | { kind: "repeat"; node: RegexNode; min: number; max: number }
  | { kind: "assert"; assertion: Assertion };

type Instruction =
  | { op: "char"; test: CharTest }
  | { op: "split"; next: number; alternative: number }
  | { op: "jump"; next: number }
  | { op: "assert"; assertion: Assertion }
  | { op: "match" };

class UnsupportedRegexError extends Error {}

const WORD_CHAR = /^\w$/;
const QUANTIFIER_BRACES = /^\{(\d+)(,(\d*))?\}/;

class RegexParser {
  private index = 0;

  public constructor(private readonly source: string) {}

  public parse(): RegexNode {
    const node = this.parseAlternation();

    if (this.index < this.source.length) {
      throw new UnsupportedRegexError(`unexpected ${this.source[this.index]}`);
    }

    return node;
  }

  private parseAlternation(): RegexNode {
    const options = [this.parseSequence()];

    while (this.source[this.index] === "|") {
      this.index += 1;
      options.push(this.parseSequence());
    }

    return options.length === 1 ? (options[0] as RegexNode) : { kind: "alternation", options };
  }

  private parseSequence(): RegexNode {
    const items: RegexNode[] = [];

    while (this.index < this.source.length) {
      const char = this.source[this.index];

      if (char === "|" || char === ")") {
        break;
      }

      items.push(this.parseQuantified());
    }

    return { kind: "sequence", items };
  }

  private parseQuantified(): RegexNode {
    const atom = this.parseAtom();
    const quantifier = this.readQuantifier();

    if (!quantifier) {
      return atom;
    }

    if (atom.kind === "assert") {
      throw new UnsupportedRegexError("nothing to repeat");
    }

    return { kind: "repeat", node: atom, ...quantifier };
  }

  private parseAtom(): RegexNode {
    const char = this.source[this.index] ?? "";

    switch (char) {
      case "(":
        return this.parseGroup();
      case "^":
        this.index += 1;
        return { kind: "assert", assertion: "start" };
      case "$":
        this.index += 1;
        return { kind: "assert", assertion: "end" };
      case "\\":
        return this.parseEscape();
      case "[":
        return this.charAtom(this.classEnd());
      case "*":
      case "+":
      case "?":
        throw new UnsupportedRegexError("nothing to repeat");
      default:
        if (char === "{" && QUANTIFIER_BRACES.test(this.source.slice(this.index))) {
          throw new UnsupportedRegexError("nothing to repeat");
        }

        return this.charAtom(this.index + 1);
    }
  }

  private parseGroup(): RegexNode {
    let start = this.index + 1;

    if (this.source[start] === "?") {
      const next = this.source[start + 1];
      const isNamed = next === "<" && !["=", "!"].includes(this.source[start + 2] ?? "");

      if (next === ":") {
        start += 2;
      } else if (isNamed) {
        start = this.source.indexOf(">", start) + 1;
      } else {
        throw new UnsupportedRegexError("lookarounds are not supported");
      }
    }

    this.index = start;
    const node = this.parseAlternation();

    if (this.source[this.index] !== ")") {
      throw new UnsupportedRegexError("unterminated group");
    }

    this.index += 1;
    return node;
  }

  private parseEscape(): RegexNode {
    const next = this.source[this.index + 1] ?? "";

    if (next === "b" || next === "B") {
      this.index += 2;
      return { kind: "assert", assertion: next === "b" ? "word-boundary" : "not-word-boundary" };
    }

    const isLegacyOctal = next === "0" && /\d/.test(this.source[this.index + 2] ?? "");

    if (/[1-9k]/.test(next) || next === "c" || isLegacyOctal) {
      throw new UnsupportedRegexError("backreferences and legacy escapes are not supported");
    }

    const hexLength = next === "x" ? 2 : next === "u" ? 4 : 0;
    const hex = this.source.slice(this.index + 2, this.index + 2 + hexLength);
    const isHexEscape = hexLength > 0 && new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(hex);

    return this.charAtom(this.index + 2 + (isHexEscape ? hexLength : 0));
  }

  /** Index just past the `]` closing the class that starts at the current index. */
  private classEnd(): number {
    let index = this.index + 1;

    while (index < this.source.length && this.source[index] !== "]") {
      index += this.source[index] === "\\" ? 2 : 1;
    }

    if (index >= this.source.length) {
      throw new UnsupportedRegexError("unterminated class");
    }

    return index + 1;
  }

  /** One character matched like JavaScript would, using a native regex on that character. */
  private charAtom(end: number): RegexNode {
    const native = new RegExp(`^(?:${this.source.slice(this.index, end)})$`, "i");

    this.index = end;
    return { kind: "char", test: (char) => native.test(char) };
  }

  private readQuantifier(): { min: number; max: number } | null {
    const char = this.source[this.index];
    let bounds: { min: number; max: number } | null = null;

    if (char === "*" || char === "+" || char === "?") {
      bounds = { min: char === "+" ? 1 : 0, max: char === "?" ? 1 : Infinity };
      this.index += 1;
    } else if (char === "{") {
      const match = QUANTIFIER_BRACES.exec(this.source.slice(this.index));

      if (!match) {
        return null;
      }

      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);

      if (max < min) {
        throw new UnsupportedRegexError("numbers out of order");
      }

      bounds = { min, max };
      this.index += match[0].length;
    }

    // A lazy `?` changes which match is found, never whether one exists.
    if (bounds && this.source[this.index] === "?") {
      this.index += 1;
    }

    return bounds;
  }
}

function emitProgram(root: RegexNode): Instruction[] {
  const program: Instruction[] = [];
  const push = (instruction: Instruction): number => {
    if (program.length >= MAX_PROGRAM_SIZE) {
      throw new UnsupportedRegexError("pattern is too large");
    }

    program.push(instruction);
    return program.length - 1;
  };
  // Counts beyond the limit behave like the limit (or like no upper bound): the program stays small.
  const repetitionLimit = REPETITION_LIMIT;
  let compileSteps = 0;

  const emit = (node: RegexNode): void => {
    compileSteps += 1;

    if (compileSteps > MAX_COMPILE_STEPS) {
      throw new UnsupportedRegexError("pattern is too complex");
    }

    switch (node.kind) {
      case "char":
        push({ op: "char", test: node.test });
        return;
      case "assert":
        push({ op: "assert", assertion: node.assertion });
        return;
      case "sequence":
        node.items.forEach(emit);
        return;
      case "alternation": {
        const jumps: number[] = [];

        node.options.forEach((option, index) => {
          const isLast = index === node.options.length - 1;
          const split = isLast ? -1 : push({ op: "split", next: -1, alternative: -1 });

          emit(option);

          if (!isLast) {
            jumps.push(push({ op: "jump", next: -1 }));
            program[split] = { op: "split", next: split + 1, alternative: program.length };
          }
        });
        jumps.forEach((jump) => {
          program[jump] = { op: "jump", next: program.length };
        });
        return;
      }
      case "repeat": {
        const min = Math.min(node.min, repetitionLimit);
        const max = node.max > repetitionLimit ? Infinity : node.max;

        for (let count = 0; count < min; count += 1) {
          emit(node.node);
        }

        if (max === Infinity) {
          const loop = push({ op: "split", next: -1, alternative: -1 });
          emit(node.node);
          push({ op: "jump", next: loop });
          program[loop] = { op: "split", next: loop + 1, alternative: program.length };
          return;
        }

        const optionalSplits: number[] = [];

        for (let count = min; count < max; count += 1) {
          optionalSplits.push(push({ op: "split", next: -1, alternative: -1 }));
          emit(node.node);
        }

        optionalSplits.forEach((split) => {
          program[split] = { op: "split", next: split + 1, alternative: program.length };
        });
      }
    }
  };

  emit(root);
  push({ op: "match" });
  return program;
}

/** The compiled pattern (case-insensitive), or null when it is invalid or unsupported. */
export function compileLinearRegex(
  source: string,
  options: { maxProgramSize?: number } = {}
): LinearRegex | null {
  try {
    new RegExp(source, "i");
    const program = emitProgram(new RegexParser(source).parse());

    if (program.length > (options.maxProgramSize ?? MAX_PROGRAM_SIZE)) {
      return null;
    }

    return {
      test: (text) => scan(program, text, true) !== null,
      replaceAll: (text, replacement) => {
        const spans = scan(program, text, false);

        if (spans === OVER_BUDGET) {
          return text.length > 0 ? replacement : text;
        }

        return replaceSpans(text, spans ?? [], replacement);
      }
    };
  } catch {
    return null;
  }
}

function replaceSpans(text: string, spans: readonly Span[], replacement: string): string {
  if (spans.length === 0) {
    return text;
  }

  const chunks: string[] = [];
  let copiedUpTo = 0;

  for (const span of spans) {
    chunks.push(text.slice(copiedUpTo, span.start), replacement);
    copiedUpTo = span.end;
  }

  chunks.push(text.slice(copiedUpTo));
  return chunks.join("");
}

/**
 * One Pike VM pass over the text: every thread advances one character at a time, so no work is
 * ever repeated, whatever the pattern or the number of matches. Threads carry the position their
 * attempt started at; when two reach the same state, the earlier start wins (their futures are
 * identical). The longest end is kept for every start, and the result is the union of all
 * non-empty matches: a superset of the leftmost-longest matches, the right bias for masking.
 * `firstOnly` stops at the first match (enough for `test`) and returns an empty list.
 */
/** A scan that ran out of {@link MAX_SCAN_STEPS}. */
const OVER_BUDGET = "over-budget";

function scan(
  program: readonly Instruction[],
  input: string,
  firstOnly: boolean
): Span[] | typeof OVER_BUDGET | null {
  const visited = new Int32Array(program.length).fill(-1);
  const longestEnd = new Int32Array(input.length + 1).fill(-1);
  let generation = 0;
  let matched = false;
  let steps = 0;

  type Thread = { pc: number; start: number };

  const addThread = (threads: Thread[], startPc: number, start: number, position: number): void => {
    const stack = [startPc];

    while (stack.length > 0) {
      const pc = stack.pop() as number;
      // Closure work counts too: alternatives that die on an assertion leave few threads.
      steps += 1;

      if (visited[pc] === generation) {
        continue;
      }

      visited[pc] = generation;
      const instruction = program[pc] as Instruction;

      switch (instruction.op) {
        case "match":
          matched = true;
          longestEnd[start] = Math.max(longestEnd[start] ?? -1, position);
          break;
        case "jump":
          stack.push(instruction.next);
          break;
        case "split":
          stack.push(instruction.alternative, instruction.next);
          break;
        case "assert":
          if (holds(instruction.assertion, input, position)) {
            stack.push(pc + 1);
          }
          break;
        case "char":
          threads.push({ pc, start });
          break;
      }
    }
  };

  let threads: Thread[] = [];
  addThread(threads, 0, 0, 0);

  for (let position = 0; position < input.length; position += 1) {
    if (firstOnly && matched) {
      return [];
    }

    const char = input[position] ?? "";
    steps += threads.length;

    if (steps > MAX_SCAN_STEPS) {
      return OVER_BUDGET;
    }

    const next: Thread[] = [];
    generation += 1;

    for (const thread of threads) {
      const instruction = program[thread.pc];

      if (instruction?.op === "char" && instruction.test(char)) {
        addThread(next, thread.pc + 1, thread.start, position + 1);
      }
    }

    // Unanchored: a new attempt starts at every position.
    addThread(next, 0, position + 1, position + 1);
    threads = next;
  }

  if (firstOnly) {
    return matched ? [] : null;
  }

  return mergeMatches(longestEnd);
}

/** Non-empty `[start, end)` matches merged into disjoint spans, in order. */
function mergeMatches(longestEnd: Int32Array): Span[] {
  const spans: Span[] = [];
  let current: Span | null = null;

  for (let start = 0; start < longestEnd.length; start += 1) {
    const end = longestEnd[start] ?? -1;

    if (end <= start) {
      continue;
    }

    if (current && start <= current.end) {
      current.end = Math.max(current.end, end);
    } else {
      current = { start, end };
      spans.push(current);
    }
  }

  return spans;
}

function holds(assertion: Assertion, input: string, position: number): boolean {
  switch (assertion) {
    case "start":
      return position === 0;
    case "end":
      return position === input.length;
    default: {
      const before = position > 0 && WORD_CHAR.test(input[position - 1] ?? "");
      const after = position < input.length && WORD_CHAR.test(input[position] ?? "");
      return (before !== after) === (assertion === "word-boundary");
    }
  }
}
