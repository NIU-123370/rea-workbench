import { describe, expect, it } from "vitest";

import type { Instant } from "../../packages/domain/identity.ts";
import {
  buildZipArchive,
  crc32,
  entryNameDefects,
  MAX_ENTRY_NAME_BYTES,
  readZipArchive,
  type ZipEntry,
  type ZipLimits,
} from "../../packages/domain/zip.ts";

// The export package is the one artifact of this workbench that leaves the machine as
// bytes another program opens (DESIGN §10 / PRD F11, issue #22). So the checks here are
// the ones a hostile or merely damaged archive would trip: names that escape the target
// directory, sizes that were never measured, and a directory that disagrees with the
// bytes next to it.

const LIMITS: ZipLimits = { maxEntries: 16, maxUncompressedBytes: 1_000_000, maxArchiveBytes: 2_000_000 };
const STAMP = "2026-10-16T12:34:56.000Z" as Instant;

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function entries(): ZipEntry[] {
  return [
    { name: "adapter.ts", bytes: text("export async function invoke() {}\n") },
    { name: "openapi.json", bytes: text('{"openapi":"3.1.1"}') },
    { name: "reports/verification.json", bytes: text('{"result":"PASS"}') },
  ];
}

describe("the STORED archive is the layout it claims", () => {
  it("computes the CRC-32 an external reader expects", () => {
    // The published check vector for the CRC-32/ISO-HDLC definition. If this number is
    // wrong, every archive this builds is silently corrupt to everything else.
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("round-trips names and bytes and keeps the archive self-describing", () => {
    const built = buildZipArchive(entries(), STAMP, LIMITS);
    if (!built.ok) throw new Error(built.error.join(","));
    const bytes = built.value;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // stored, never compressed
    expect(view.getUint32(bytes.byteLength - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.byteLength - 14, true)).toBe(3);
    const read = readZipArchive(bytes, LIMITS);
    if (!read.ok) throw new Error(read.error.join(","));
    expect(read.value.map((entry) => entry.name)).toEqual(["adapter.ts", "openapi.json", "reports/verification.json"]);
    for (const original of entries()) {
      const found = read.value.find((entry) => entry.name === original.name);
      expect(found?.bytes && new TextDecoder().decode(found.bytes)).toEqual(new TextDecoder().decode(original.bytes));
    }
  });

  it("is deterministic for the same entries and timestamp", () => {
    const first = buildZipArchive(entries(), STAMP, LIMITS);
    const second = buildZipArchive(entries(), STAMP, LIMITS);
    if (!first.ok || !second.ok) throw new Error("baseline build failed");
    expect(first.value).toEqual(second.value);
    // ZIP's DOS timestamp has two-second granularity, so a moved instant is only a
    // different byte string once it crosses that boundary. The export's own digest is
    // bound to its recorded `createdAt` instant, not to this coarser field.
    const oneSecondLater = buildZipArchive(entries(), "2026-10-16T12:34:57.000Z" as Instant, LIMITS);
    if (!oneSecondLater.ok) throw new Error("later build failed");
    expect(oneSecondLater.value).toEqual(first.value);
    const twoSecondsLater = buildZipArchive(entries(), "2026-10-16T12:34:58.000Z" as Instant, LIMITS);
    if (!twoSecondsLater.ok) throw new Error("second build failed");
    expect(twoSecondsLater.value).not.toEqual(first.value);
  });

  it("clamps a pre-DOS timestamp instead of writing a negative date", () => {
    const epoch = buildZipArchive(entries(), "1970-01-01T00:00:00.000Z" as Instant, LIMITS);
    const dos = buildZipArchive(entries(), "1980-01-01T00:00:00.000Z" as Instant, LIMITS);
    if (!epoch.ok || !dos.ok) throw new Error("clamp build failed");
    expect(epoch.value).toEqual(dos.value);
  });

  it("writes nothing when the measured size exceeds a limit", () => {
    const tooMany = buildZipArchive(entries(), STAMP, { ...LIMITS, maxEntries: 2 });
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.error).toContain("entry-count-over-limit:3>2");

    const tooBig = buildZipArchive([{ name: "a.bin", bytes: new Uint8Array(64) }], STAMP, {
      ...LIMITS,
      maxUncompressedBytes: 32,
    });
    expect(!tooBig.ok && tooBig.error).toContain("uncompressed-bytes-over-limit:64>32");

    const tooHeavy = buildZipArchive([{ name: "a.bin", bytes: new Uint8Array(4) }], STAMP, {
      maxEntries: 16,
      maxUncompressedBytes: 1_000_000,
      maxArchiveBytes: 32,
    });
    expect(!tooHeavy.ok && tooHeavy.error.join(",")).toContain("archive-bytes-over-limit");
  });
});

describe("entry names are the only path a package can carry", () => {
  const hostile: [string, string][] = [
    ["/etc/passwd", "entry-name-absolute"],
    ["../escape.txt", "entry-name-parent-segment"],
    ["reports/../../escape.txt", "entry-name-parent-segment"],
    ["./same-dir.txt", "entry-name-not-a-plain-segment"],
    ["dir/", "entry-name-is-directory"],
    ["nested//double.txt", "entry-name-not-a-plain-segment"],
    ["windows\\escape.txt", "entry-name-backslash"],
    ["C:/drive.txt", "entry-name-has-drive"],
    ["", "entry-name-empty"],
  ];

  it("refuses each spelling of an escape, both alone and inside a package", () => {
    for (const [name, reason] of hostile) {
      expect(entryNameDefects(name), name).toContain(reason);
      const built = buildZipArchive([{ name, bytes: text("x") }], STAMP, LIMITS);
      expect(!built.ok && (built.error as string[]).join(",")).toContain(reason);
    }
  });

  it("refuses the same name twice rather than keeping the last one", () => {
    const built = buildZipArchive(
      [
        { name: "openapi.json", bytes: text("first") },
        { name: "openapi.json", bytes: text("second") },
      ],
      STAMP,
      LIMITS,
    );
    expect(!built.ok && (built.error as string[]).join(",")).toContain("duplicate-entry-name:openapi.json");
  });

  it("accepts the plain relative names a package actually uses", () => {
    for (const name of ["adapter.ts", "reports/verification.json", "v1/openapi.json", "a-b_c.1"]) {
      expect(entryNameDefects(name), name).toEqual([]);
    }
  });
});

describe("a damaged archive is refused rather than trusted", () => {
  async function built(list: ZipEntry[] = entries()): Promise<Uint8Array> {
    const result = buildZipArchive(list, STAMP, LIMITS);
    if (!result.ok) throw new Error(result.error.join(","));
    return result.value;
  }

  // The stored layout is arithmetic, so the offsets a damaged archive is written at are
  // computed here rather than guessed: 30 header bytes + name + data per entry, then the
  // central records at 46 bytes + name each.
  function offsets(list: ZipEntry[]): { locals: number[]; central: number } {
    const locals: number[] = [];
    let cursor = 0;
    for (const entry of list) {
      const nameLength = new TextEncoder().encode(entry.name).byteLength;
      locals.push(cursor);
      cursor += 30 + nameLength + entry.bytes.byteLength;
    }
    return { locals, central: cursor };
  }

  it("catches a flipped data byte through the recorded CRC", async () => {
    const bytes = await built();
    const adapterAt = 30 + "adapter.ts".length;
    bytes[adapterAt] = (bytes[adapterAt] ?? 0) ^ 0x01;
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && (read.error as string[]).join(",")).toContain("entry-crc-mismatch:adapter.ts");
  });

  it("catches a central directory that moved off the end of the buffer", async () => {
    const bytes = await built();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(bytes.byteLength - 6, 0x7fff, true); // central directory size
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && (read.error as string[]).join(",")).toContain("central-directory-out-of-range");
  });

  it("refuses a ZIP64 marker instead of guessing the layout", async () => {
    const bytes = await built();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(bytes.byteLength - 14, 0xffff, true);
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && read.error).toEqual(["archive-is-zip64"]);
  });

  it("refuses a compressed entry it did not write", async () => {
    const list = entries();
    const bytes = await built(list);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(offsets(list).central + 10, 8, true); // deflate
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && (read.error as string[]).join(",")).toContain("entry-is-compressed:adapter.ts");
  });

  it("refuses a local header whose name disagrees with the directory", async () => {
    const list = entries();
    const bytes = await built(list);
    const localNameEnd = offsets(list).locals[0] as number + 30 + "adapter.ts".length;
    bytes[localNameEnd - 1] = 0x78; // 's' -> 'x' in the local name
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && (read.error as string[]).join(",")).toContain("entry-data-unreadable:adapter.ts");
  });

  it("refuses an archive with more entries than the reader allows", async () => {
    const bytes = await built();
    const read = readZipArchive(bytes, { ...LIMITS, maxEntries: 2 });
    expect(!read.ok && (read.error as string[]).join(",")).toContain("entry-count-over-limit:3");
  });

  it("refuses an archive carrying a trailing comment", async () => {
    const bytes = await built();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(bytes.byteLength - 2, 1, true); // comment length
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && (read.error as string[]).join(",")).toContain("archive-has-a-trailing-comment");
  });

  it("refuses a truncated archive and an entry name that escapes", async () => {
    const bytes = (await built()).slice(0, 40);
    const read = readZipArchive(bytes, LIMITS);
    expect(!read.ok && read.error).toEqual(["archive-has-no-end-of-central-directory"]);

    // Same-length rewrite of one directory entry's name: the nameLength field still
    // matches, so only the traversal check can stop it.
    const list: ZipEntry[] = [{ name: "aa/escape.txt", bytes: text("x") }, { name: "openapi.json", bytes: text("{}") }];
    const whole = await built(list);
    const central = offsets(list).central;
    whole.set(text("../escape.txt"), central + 46);
    const escaped = readZipArchive(whole, LIMITS);
    expect(!escaped.ok && (escaped.error as string[]).join(",")).toContain("entry-name-parent-segment:../escape.txt");
  });
});

// A reader that is not this file's author. The archive above already walks bytes by hand for hostile
// cases; this block does it for the one thing our own `readZipArchive` cannot check: whether the
// archive *says* its names are UTF-8. APPNOTE 4.4.5 makes general-purpose bit 11 that statement, and
// `encodeName` has always written UTF-8 - so before the bit was set, every third-party reader decoded
// a non-ASCII name as CP437 while this repository's own reader round-tripped it. An archive only its
// own reader understands is broken, whatever the reader asserts.
describe("what a standards-following reader can learn about the names", () => {
  const UTF8_BIT = 0x0800;

  function centralRecords(archive: Uint8Array): { flags: number; name: string; nameLengthField: number; crc: number; localCrc: number; localFlags: number }[] {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const records: { flags: number; name: string; nameLengthField: number; crc: number; localCrc: number; localFlags: number }[] = [];
    // Find the end-of-central-directory record rather than assuming a fixed layout: the record says
    // where the directory starts, which is exactly what an outside reader does.
    let end = -1;
    for (let offset = archive.byteLength - 22; offset >= 0 && end < 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) end = offset;
    }
    if (end < 0) throw new Error("no end-of-central-directory record");
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error(`central record ${String(index)} has no signature`);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(archive.slice(offset + 46, offset + 46 + nameLength));
      // The local header must agree with the directory entry: same name bytes, same flags, same crc.
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("local header signature lost");
      records.push({
        flags: view.getUint16(offset + 8, true),
        name,
        nameLengthField: nameLength,
        crc: view.getUint32(offset + 16, true),
        localCrc: view.getUint32(localOffset + 14, true),
        localFlags: view.getUint16(localOffset + 6, true),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return records;
  }

  it("labels UTF-8 names as UTF-8, and leaves plain ASCII unlabelled", () => {
    const built = buildZipArchive(
      [...entries(), { name: "报告/验证结果.txt", bytes: text("PASS\n") }],
      STAMP,
      LIMITS,
    );
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const records = centralRecords(built.value);
    expect(records.map((record) => record.name)).toEqual(["adapter.ts", "openapi.json", "reports/verification.json", "报告/验证结果.txt"]);
    for (const record of records) {
      // An ASCII name keeps the bit clear: setting it there would claim an encoding no reader needs,
      // and older readers that ignore the bit would then be told a name is UTF-8 when it is the same
      // bytes either way. So the flag is exactly "this archive has something to say".
      const asciiOnly = [...record.name].every((char) => (char.codePointAt(0) ?? 0xffffffff) <= 0x7f);
      expect(record.flags & UTF8_BIT).toBe(asciiOnly ? 0 : UTF8_BIT);
      expect(record.localFlags).toBe(record.flags);
      expect(record.localCrc).toBe(record.crc);
    }
    // Read back the way a stranger would: bit set ⇒ UTF-8, bit clear ⇒ CP437. Only the flagged entry
    // survives that rule, which is the whole point of the bit.
    const flagged = records.find((record) => (record.flags & UTF8_BIT) === UTF8_BIT);
    expect(flagged?.name).toBe("报告/验证结果.txt");
    expect(records.filter((record) => (record.flags & UTF8_BIT) === UTF8_BIT)).toHaveLength(1);
  });

  it("refuses a name the 16-bit length field cannot hold, instead of truncating it", () => {
    const tooLong = `${"a".repeat(65536)}.txt`;
    expect(entryNameDefects(tooLong)).toContain(`entry-name-over-length:${String(MAX_ENTRY_NAME_BYTES)}`);
    const refused = buildZipArchive([{ name: tooLong, bytes: text("x") }], STAMP, { ...LIMITS, maxArchiveBytes: 10_000_000, maxUncompressedBytes: 10_000_000 });
    expect(!refused.ok).toBe(true);
    if (refused.ok) return;
    expect(refused.error.join(",")).toContain("entry-name-over-length");
    // The boundary itself still fits, and the field carries the real length rather than length mod 65536.
    const fits = "a".repeat(MAX_ENTRY_NAME_BYTES - 4);
    const built = buildZipArchive([{ name: `${fits}.txt`, bytes: text("x") }], STAMP, { maxEntries: 16, maxUncompressedBytes: 1_000_000, maxArchiveBytes: 4_000_000 });
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const [record] = centralRecords(built.value);
    expect(record?.nameLengthField).toBe(text(`${fits}.txt`).byteLength);
    expect(record?.name).toBe(`${fits}.txt`);
  });
});
