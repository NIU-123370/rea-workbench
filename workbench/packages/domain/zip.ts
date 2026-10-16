import type { Instant } from "./identity.ts";
import type { Result } from "./result.ts";

// A STORED-only ZIP writer and reader (DESIGN §10 exports / PRD F11, issue #22).
//
// Two deliberate choices shape this file. It compresses nothing: `stored` entries
// mean the expanded size is known before a byte is allocated, which is what §12
// asks for (先计量再分配), and it keeps `packages/domain` free of a compression
// dependency. And entry names are treated as the only path a package can carry, so
// they are validated on the way in *and* on the way out — a package that arrives
// with `../../.ssh/authorized_keys` is refused rather than written somewhere.
//
// Nothing here opens a file, a socket or a database.

export type ZipEntry = { name: string; bytes: Uint8Array };

export type ZipLimits = {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxArchiveBytes: number;
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_BYTES = 22;
const STORED_METHOD = 0;
const VERSION = 20;

const CRC_POLYNOMIAL = 0xedb88320;
const crcTable = buildCrcTable();

function buildCrcTable(): Int32Array {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (CRC_POLYNOMIAL ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[index] = value;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A name must be a plain relative POSIX path. Backslashes, drive letters, leading
// slashes, `.`/`..` segments, empty segments and trailing slashes are all refused:
// each one is a way for an archive to land outside the directory it was given.
export function entryNameDefects(name: string): string[] {
  const reasons: string[] = [];
  if (name.length === 0) reasons.push("entry-name-empty");
  if (name.startsWith("/")) reasons.push("entry-name-absolute");
  if (name.includes("\\")) reasons.push("entry-name-backslash");
  if (name.endsWith("/")) reasons.push("entry-name-is-directory");
  if (/^[a-zA-Z]:/.test(name)) reasons.push("entry-name-has-drive");
  if (name.includes("\0")) reasons.push("entry-name-has-nul");
  for (const segment of name.split("/")) {
    if (segment === "..") reasons.push("entry-name-parent-segment");
    else if (segment === "." || segment.length === 0) reasons.push("entry-name-not-a-plain-segment");
  }
  return reasons;
}

function dosDateTime(instant: Instant): { date: number; time: number } {
  const ms = Date.parse(instant);
  const safe = Number.isNaN(ms) ? Date.parse("1980-01-01T00:00:00.000Z") : Math.max(ms, Date.parse("1980-01-01T00:00:00.000Z"));
  const parts = new Date(safe);
  const year = Math.max(1980, parts.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((parts.getUTCMonth() + 1) << 5) | parts.getUTCDate(),
    time: (parts.getUTCHours() << 11) | (parts.getUTCMinutes() << 5) | (parts.getUTCSeconds() >> 1),
  };
}

function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

export function buildZipArchive(
  entries: readonly ZipEntry[],
  modifiedAt: Instant,
  limits: ZipLimits,
): Result<Uint8Array, string[]> {
  const defects: string[] = [];
  const seen = new Set<string>();
  let uncompressed = 0;
  for (const entry of entries) {
    for (const reason of entryNameDefects(entry.name)) defects.push(`${reason}:${entry.name}`);
    if (seen.has(entry.name)) defects.push(`duplicate-entry-name:${entry.name}`);
    seen.add(entry.name);
    uncompressed += entry.bytes.byteLength;
  }
  if (entries.length > limits.maxEntries) defects.push(`entry-count-over-limit:${String(entries.length)}>${String(limits.maxEntries)}`);
  if (uncompressed > limits.maxUncompressedBytes) {
    defects.push(`uncompressed-bytes-over-limit:${String(uncompressed)}>${String(limits.maxUncompressedBytes)}`);
  }
  // Measured before allocating, so an oversized package is a refusal rather than a
  // buffer that was already built.
  const archiveBytes = archiveSize(entries, uncompressed);
  if (archiveBytes > limits.maxArchiveBytes) defects.push(`archive-bytes-over-limit:${String(archiveBytes)}>${String(limits.maxArchiveBytes)}`);
  if (defects.length > 0) return { ok: false, error: defects };

  const stamp = dosDateTime(modifiedAt);
  const buffer = new Uint8Array(archiveBytes);
  const view = new DataView(buffer.buffer);
  const names = entries.map((entry) => encodeName(entry.name));
  // The layout is three passes and one rule: every local record first, then the whole
  // central directory, then the end record. Writing a central record next to the entry
  // it describes produces bytes no reader can walk.
  const localOffsets: number[] = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const name = names[index] as Uint8Array;
    localOffsets.push(offset);
    writeLocalHeader(view, offset, stamp, entry, name, crc32(entry.bytes));
    offset += LOCAL_HEADER_BYTES;
    buffer.set(name, offset);
    offset += name.byteLength;
    buffer.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  });

  const directoryOffset = offset;
  entries.forEach((entry, index) => {
    const name = names[index] as Uint8Array;
    writeCentralRecord(view, offset, stamp, entry, name, localOffsets[index] as number);
    offset += CENTRAL_HEADER_BYTES;
    buffer.set(name, offset);
    offset += name.byteLength;
  });
  const directoryBytes = offset - directoryOffset;

  view.setUint32(offset, END_OF_CENTRAL_SIGNATURE, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, directoryBytes, true);
  view.setUint32(offset + 16, directoryOffset, true);
  view.setUint16(offset + 20, 0, true);
  if (offset + END_OF_CENTRAL_BYTES !== buffer.byteLength) {
    // The size was measured before anything was allocated; landing here means the
    // measurement and the writing disagree, which is a defect rather than a surprise.
    return { ok: false, error: [`archive-size-miscalculated:${String(offset + END_OF_CENTRAL_BYTES)}!=${String(buffer.byteLength)}`] };
  }
  return { ok: true, value: buffer };
}

function archiveSize(entries: readonly ZipEntry[], uncompressed: number): number {
  const names = entries.reduce((total, entry) => total + encodeName(entry.name).byteLength, 0);
  return (
    entries.length * (LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES) +
    names * 2 +
    uncompressed +
    END_OF_CENTRAL_BYTES
  );
}

function writeLocalHeader(
  view: DataView,
  offset: number,
  stamp: { date: number; time: number },
  entry: ZipEntry,
  name: Uint8Array,
  crc: number,
): void {
  view.setUint32(offset, LOCAL_SIGNATURE, true);
  view.setUint16(offset + 4, VERSION, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, STORED_METHOD, true);
  view.setUint16(offset + 10, stamp.time, true);
  view.setUint16(offset + 12, stamp.date, true);
  view.setUint32(offset + 14, crc, true);
  view.setUint32(offset + 18, entry.bytes.byteLength, true);
  view.setUint32(offset + 22, entry.bytes.byteLength, true);
  view.setUint16(offset + 26, name.byteLength, true);
  view.setUint16(offset + 28, 0, true);
}

function writeCentralRecord(
  view: DataView,
  offset: number,
  stamp: { date: number; time: number },
  entry: ZipEntry,
  name: Uint8Array,
  localOffset: number,
): void {
  view.setUint32(offset, CENTRAL_SIGNATURE, true);
  view.setUint16(offset + 4, VERSION, true);
  view.setUint16(offset + 6, VERSION, true);
  view.setUint16(offset + 8, 0, true);
  view.setUint16(offset + 10, STORED_METHOD, true);
  view.setUint16(offset + 12, stamp.time, true);
  view.setUint16(offset + 14, stamp.date, true);
  view.setUint32(offset + 16, crc32(entry.bytes), true);
  view.setUint32(offset + 20, entry.bytes.byteLength, true);
  view.setUint32(offset + 24, entry.bytes.byteLength, true);
  view.setUint16(offset + 28, name.byteLength, true);
  view.setUint16(offset + 30, 0, true);
  view.setUint16(offset + 32, 0, true);
  view.setUint16(offset + 34, 0, true);
  view.setUint16(offset + 36, 0, true);
  view.setUint32(offset + 38, 0, true);
  view.setUint32(offset + 42, localOffset, true);
}

export function readZipArchive(bytes: Uint8Array, limits: ZipLimits): Result<ZipEntry[], string[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const defects: string[] = [];
  const end = findEndOfCentral(view);
  if (end === null) return { ok: false, error: ["archive-has-no-end-of-central-directory"] };
  const entries = view.getUint16(end + 8, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  // ZIP64 is out of scope: a count or offset spelled as 0xffff/0xffffffff means the
  // reader is being asked for a layout this writer never produces.
  if (entries === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    return { ok: false, error: ["archive-is-zip64"] };
  }
  if (entries > limits.maxEntries) defects.push(`entry-count-over-limit:${String(entries)}`);
  if (directoryOffset + directorySize > bytes.byteLength) defects.push("central-directory-out-of-range");
  if (view.getUint16(end + 20, true) !== 0) defects.push("archive-has-a-trailing-comment");
  if (defects.length > 0) return { ok: false, error: defects };

  const read: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    const parsed = readCentralRecord(view, cursor, bytes);
    if (!parsed.ok) return { ok: false, error: [parsed.error] };
    cursor = parsed.next;
    const record = parsed.value;
    if (names.has(record.name)) {
      return { ok: false, error: [...defects, `duplicate-entry-name:${record.name}`] };
    }
    names.add(record.name);
    for (const reason of entryNameDefects(record.name)) defects.push(`${reason}:${record.name}`);
    total += record.size;
    if (record.method !== STORED_METHOD) defects.push(`entry-is-compressed:${record.name}`);
    const data = readLocalData(view, record.localOffset, record.name, record.size);
    if (data === null) {
      defects.push(`entry-data-unreadable:${record.name}`);
      continue;
    }
    if (crc32(data) !== record.crc) defects.push(`entry-crc-mismatch:${record.name}`);
    read.push({ name: record.name, bytes: data });
  }
  if (total > limits.maxUncompressedBytes) defects.push(`uncompressed-bytes-over-limit:${String(total)}`);
  if (defects.length > 0) return { ok: false, error: defects };
  return { ok: true, value: read };
}

type CentralRecord = { name: string; size: number; crc: number; method: number; localOffset: number };

function readCentralRecord(
  view: DataView,
  offset: number,
  bytes: Uint8Array,
): { ok: true; value: CentralRecord; next: number } | { ok: false; error: string } {
  if (offset + CENTRAL_HEADER_BYTES > bytes.byteLength) return { ok: false, error: "central-record-out-of-range" };
  if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return { ok: false, error: "central-record-signature-missing" };
  const nameLength = view.getUint16(offset + 28, true);
  const extraLength = view.getUint16(offset + 30, true);
  const commentLength = view.getUint16(offset + 32, true);
  const nameEnd = offset + CENTRAL_HEADER_BYTES + nameLength;
  if (nameEnd > bytes.byteLength) return { ok: false, error: "central-record-name-out-of-range" };
  return {
    ok: true,
    value: {
      name: new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(offset + CENTRAL_HEADER_BYTES, nameEnd)),
      size: view.getUint32(offset + 24, true),
      crc: view.getUint32(offset + 16, true),
      method: view.getUint16(offset + 10, true),
      localOffset: view.getUint32(offset + 42, true),
    },
    next: nameEnd + extraLength + commentLength,
  };
}

function readLocalData(view: DataView, offset: number, name: string, size: number): Uint8Array | null {
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + LOCAL_HEADER_BYTES + nameLength + extraLength;
  if (view.getUint32(offset, true) !== LOCAL_SIGNATURE) return null;
  const localName = new TextDecoder("utf8", { fatal: true }).decode(
    new Uint8Array(view.buffer, view.byteOffset + offset + LOCAL_HEADER_BYTES, nameLength),
  );
  // The central record and its local header must agree on the name; a package that
  // says one thing in the directory and another beside the bytes is refused.
  if (localName !== name) return null;
  if (dataStart + size > view.byteLength + view.byteOffset) return null;
  return new Uint8Array(view.buffer, view.byteOffset + dataStart, size);
}

function findEndOfCentral(view: DataView): number | null {
  const lowest = Math.max(0, view.byteLength - END_OF_CENTRAL_BYTES - 0xffff);
  for (let offset = view.byteLength - END_OF_CENTRAL_BYTES; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_SIGNATURE) return offset;
  }
  return null;
}
