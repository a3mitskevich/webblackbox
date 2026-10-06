/**
 * Minimal streaming ZIP writer: STORE only (archive files are ciphertext, which does not
 * compress), no data descriptors, no ZIP64. Each entry is written as soon as it is added, so the
 * archive never has to sit in memory as a whole; its exact size is known from the entry sizes
 * up front (`storeZipEntryBytes` + `STORE_ZIP_END_BYTES`).
 */

/** Receives the archive bytes in order. Parts are handed over and must not be mutated. */
export type ArchiveSink = (part: Uint8Array) => void | Promise<void>;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const UTF8_NAME_FLAG = 0x0800;
const STORE_METHOD = 0;
const MAX_ZIP32_VALUE = 0xffffffff;
const MAX_ZIP32_ENTRIES = 0xffff;
const DOS_EPOCH_YEAR = 1980;

/** Bytes the end-of-central-directory record adds to an archive. */
export const STORE_ZIP_END_BYTES = END_OF_CENTRAL_DIRECTORY_BYTES;

/** Bytes one entry adds to an archive: local header, data and central directory record. */
export function storeZipEntryBytes(path: string, dataBytes: number): number {
  const nameBytes = encodeUtf8(path).byteLength;
  return LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * nameBytes + dataBytes;
}

type CentralEntry = {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
};

export class StoreZipWriter {
  private readonly entries: CentralEntry[] = [];
  private readonly dosTime: number;
  private readonly dosDate: number;
  private offset = 0;
  private finished = false;

  public constructor(
    private readonly sink: ArchiveSink,
    modifiedAt: Date = new Date()
  ) {
    [this.dosTime, this.dosDate] = toDosDateTime(modifiedAt);
  }

  /** Bytes handed to the sink so far. */
  public get bytesWritten(): number {
    return this.offset;
  }

  public async addFile(path: string, data: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new Error("ZIP archive is already finished.");
    }

    const name = encodeUtf8(path);
    const entry: CentralEntry = {
      name,
      crc: crc32(data),
      size: data.byteLength,
      offset: this.offset
    };
    const header = new Uint8Array(LOCAL_HEADER_BYTES + name.byteLength);
    const view = new DataView(header.buffer);

    assertZip32(entry.offset + header.byteLength + data.byteLength, "archive size");
    view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    view.setUint16(4, ZIP_VERSION, true);
    this.writeEntryFields(view, 6, entry);
    view.setUint16(26, name.byteLength, true);
    view.setUint16(28, 0, true);
    header.set(name, LOCAL_HEADER_BYTES);

    this.entries.push(entry);
    await this.emit(header);
    await this.emit(data);
  }

  /** Writes the central directory; returns the archive size in bytes. */
  public async finish(): Promise<number> {
    if (this.finished) {
      throw new Error("ZIP archive is already finished.");
    }

    this.finished = true;
    assertZip32(this.entries.length, "entry count", MAX_ZIP32_ENTRIES);

    const directoryOffset = this.offset;
    const directorySize = this.entries.reduce(
      (sum, entry) => sum + CENTRAL_HEADER_BYTES + entry.name.byteLength,
      0
    );
    const directory = new Uint8Array(directorySize + END_OF_CENTRAL_DIRECTORY_BYTES);
    const view = new DataView(directory.buffer);
    let cursor = 0;

    for (const entry of this.entries) {
      view.setUint32(cursor, CENTRAL_HEADER_SIGNATURE, true);
      view.setUint16(cursor + 4, ZIP_VERSION, true);
      view.setUint16(cursor + 6, ZIP_VERSION, true);
      this.writeEntryFields(view, cursor + 8, entry);
      view.setUint16(cursor + 28, entry.name.byteLength, true);
      // Extra field, comment, disk number, internal and external attributes stay zero.
      view.setUint32(cursor + 42, entry.offset, true);
      directory.set(entry.name, cursor + CENTRAL_HEADER_BYTES);
      cursor += CENTRAL_HEADER_BYTES + entry.name.byteLength;
    }

    assertZip32(directoryOffset + directory.byteLength, "archive size");
    view.setUint32(cursor, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
    view.setUint16(cursor + 8, this.entries.length, true);
    view.setUint16(cursor + 10, this.entries.length, true);
    view.setUint32(cursor + 12, directorySize, true);
    view.setUint32(cursor + 16, directoryOffset, true);

    await this.emit(directory);
    return this.offset;
  }

  /** Flags, method, time, date, CRC and sizes: shared by local and central headers. */
  private writeEntryFields(view: DataView, at: number, entry: CentralEntry): void {
    view.setUint16(at, UTF8_NAME_FLAG, true);
    view.setUint16(at + 2, STORE_METHOD, true);
    view.setUint16(at + 4, this.dosTime, true);
    view.setUint16(at + 6, this.dosDate, true);
    view.setUint32(at + 8, entry.crc, true);
    view.setUint32(at + 12, entry.size, true);
    view.setUint32(at + 16, entry.size, true);
  }

  private async emit(part: Uint8Array): Promise<void> {
    this.offset += part.byteLength;
    await this.sink(part);
  }
}

const CRC32_TABLE = createCrc32Table();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC32_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

function toDosDateTime(date: Date): [number, number] {
  const year = Math.max(DOS_EPOCH_YEAR, date.getFullYear());
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time, day];
}

function assertZip32(value: number, label: string, max = MAX_ZIP32_VALUE): void {
  if (value > max) {
    throw new Error(`ZIP ${label} exceeds the format limit (${max}); ZIP64 is not supported.`);
  }
}

const utf8 = new TextEncoder();

function encodeUtf8(value: string): Uint8Array {
  return utf8.encode(value);
}
