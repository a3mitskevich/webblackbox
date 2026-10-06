/** Bytes per hex dump row (offset · 16 hex bytes · ASCII). */
export const HEX_ROW_BYTES = 16;

export type HexRow = {
  offset: string;
  hex: string;
  ascii: string;
};

export function hexRowCount(byteLength: number): number {
  return Math.ceil(byteLength / HEX_ROW_BYTES);
}

/** One row of a hex dump: `00000010`, `48 65 6c …`, `Hel…` (non-printable bytes as dots). */
export function hexRow(bytes: Uint8Array, rowIndex: number): HexRow {
  const start = rowIndex * HEX_ROW_BYTES;
  const slice = bytes.subarray(start, start + HEX_ROW_BYTES);
  const hex: string[] = [];
  let ascii = "";

  for (const byte of slice) {
    hex.push(byte.toString(16).padStart(2, "0"));
    ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
  }

  return { offset: start.toString(16).padStart(8, "0"), hex: hex.join(" "), ascii };
}

/** Base64 (how a binary frame preview is kept) to bytes; `null` when it is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  const compact = text.replace(/\s+/g, "");

  if (compact.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return null;
  }

  try {
    const binary = atob(compact);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const INDENT = "  ";

/**
 * Re-indents a JSON text that may stop mid-way (a frame the recorder cut): brackets open and close
 * lines, commas break them, strings are copied as they are. Nothing is parsed, so the output stops
 * exactly where the recording stopped.
 */
export function formatPartialJson(text: string): string {
  let output = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => `\n${INDENT.repeat(Math.max(0, depth))}`;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;

    if (inString) {
      output += char;

      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "{" || char === "[") {
      const close = char === "{" ? "}" : "]";
      const next = nextSignificant(text, index + 1);

      if (next?.char === close) {
        output += `${char}${close}`;
        index = next.index;
        continue;
      }

      depth += 1;
      output += next ? `${char}${newline()}` : char;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      output += `${newline()}${char}`;
    } else if (char === ",") {
      output += `,${newline()}`;
    } else if (char === ":") {
      output += ": ";
    } else if (!/\s/.test(char)) {
      output += char;
    }
  }

  return output;
}

function nextSignificant(text: string, from: number): { char: string; index: number } | null {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] as string;

    if (!/\s/.test(char)) {
      return { char, index };
    }
  }

  return null;
}
