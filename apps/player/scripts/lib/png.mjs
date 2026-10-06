// Tiny RGBA canvas + PNG encoder for synthetic screenshots (no dependencies, Node only).
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function parseColor(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** A width × height RGB canvas with rectangle and circle fills. */
export function createCanvas(width, height, background = "#ffffff") {
  const pixels = Buffer.alloc(width * height * 3);

  const fillRect = (x, y, w, h, color) => {
    const [r, g, b] = parseColor(color);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(width, Math.round(x + w));
    const y1 = Math.min(height, Math.round(y + h));

    for (let row = y0; row < y1; row += 1) {
      for (let column = x0; column < x1; column += 1) {
        const offset = (row * width + column) * 3;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
      }
    }
  };

  const fillCircle = (cx, cy, radius, color) => {
    const [r, g, b] = parseColor(color);

    for (let row = Math.max(0, cy - radius); row < Math.min(height, cy + radius); row += 1) {
      for (
        let column = Math.max(0, cx - radius);
        column < Math.min(width, cx + radius);
        column += 1
      ) {
        if ((column - cx) ** 2 + (row - cy) ** 2 <= radius ** 2) {
          const offset = (row * width + column) * 3;
          pixels[offset] = r;
          pixels[offset + 1] = g;
          pixels[offset + 2] = b;
        }
      }
    }
  };

  fillRect(0, 0, width, height, background);

  return {
    width,
    height,
    fillRect,
    fillCircle,
    toPng() {
      const raw = Buffer.alloc((width * 3 + 1) * height);

      for (let row = 0; row < height; row += 1) {
        raw[row * (width * 3 + 1)] = 0;
        pixels.copy(raw, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
      }

      const header = Buffer.alloc(13);
      header.writeUInt32BE(width, 0);
      header.writeUInt32BE(height, 4);
      header[8] = 8; // bit depth
      header[9] = 2; // colour type: RGB
      header[10] = 0;
      header[11] = 0;
      header[12] = 0;

      return new Uint8Array(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          chunk("IHDR", header),
          chunk("IDAT", deflateSync(raw, { level: 9 })),
          chunk("IEND", Buffer.alloc(0))
        ])
      );
    }
  };
}
