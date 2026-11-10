import test from "node:test";
import assert from "node:assert/strict";

import { createZipBuffer, crc32 } from "../server/utils/zip.js";

// Minimal ZIP reader (store method only) used to verify the writer output.
function readZip(buffer) {
  const entries = [];
  let offset = 0;

  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.push({ name, method, crc, compressedSize, uncompressedSize, data });
    offset = dataStart + compressedSize;
  }

  const centralOffset = offset;
  const centralEntries = [];
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    centralEntries.push({ name, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const endOffset = offset;
  const end = {
    signature: buffer.readUInt32LE(endOffset),
    count: buffer.readUInt16LE(endOffset + 10),
    centralSize: buffer.readUInt32LE(endOffset + 12),
    centralOffset: buffer.readUInt32LE(endOffset + 16),
  };

  return { entries, centralEntries, centralOffset, endOffset, end };
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("")), 0);
  assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

test("createZipBuffer writes a valid stored archive with central directory", () => {
  const first = Buffer.from("hello facebook");
  const second = Buffer.from("second image bytes");
  const date = new Date(2024, 5, 2, 8, 30, 0);
  const archive = createZipBuffer(
    [
      { name: "photo-01.jpg", data: first, date },
      { name: "photo-02.jpg", data: second, date },
    ],
    { date }
  );

  const zip = readZip(archive);
  assert.equal(zip.entries.length, 2);
  assert.deepEqual(zip.centralEntries.map((entry) => entry.name), ["photo-01.jpg", "photo-02.jpg"]);
  assert.equal(zip.end.signature, 0x06054b50);
  assert.equal(zip.end.count, 2);
  assert.equal(zip.end.centralOffset, zip.centralOffset);
  assert.equal(zip.end.centralOffset + zip.end.centralSize, zip.endOffset);
  assert.equal(archive.length, zip.endOffset + 22);

  for (const entry of zip.entries) {
    assert.equal(entry.method, 0, "images are stored without deflate");
    assert.equal(entry.compressedSize, entry.uncompressedSize);
  }

  assert.equal(zip.entries[0].crc, crc32(first));
  assert.deepEqual(zip.entries[0].data, first);
  assert.equal(zip.entries[1].crc, crc32(second));
  assert.deepEqual(zip.entries[1].data, second);
  assert.equal(zip.centralEntries[0].localOffset, 0);
  assert.equal(zip.centralEntries[1].localOffset, 30 + "photo-01.jpg".length + first.length);
});

test("createZipBuffer marks names as UTF-8 and keeps unicode filenames", () => {
  const archive = createZipBuffer([
    { name: "Café — photo 1.jpg", data: Buffer.from([1, 2, 3]) },
    { name: "日本語.png", data: Buffer.from([4, 5]) },
  ]);

  const flags = archive.readUInt16LE(6);
  assert.equal(flags & 0x0800, 0x0800);

  const zip = readZip(archive);
  assert.deepEqual(zip.entries.map((entry) => entry.name), ["Café — photo 1.jpg", "日本語.png"]);
  assert.deepEqual(zip.entries[0].data, Buffer.from([1, 2, 3]));
});

test("createZipBuffer renames duplicate names in order", () => {
  const archive = createZipBuffer([
    { name: "photo.jpg", data: "one" },
    { name: "photo.jpg", data: "two" },
    { name: "photo.jpg", data: "three" },
  ]);

  assert.deepEqual(
    readZip(archive).entries.map((entry) => entry.name),
    ["photo.jpg", "photo-2.jpg", "photo-3.jpg"]
  );
});

test("createZipBuffer strips path traversal and control characters", () => {
  const archive = createZipBuffer([
    { name: "../evil/../../photo.jpg", data: "a" },
    { name: "..\\windows\\photo.jpg", data: "b" },
    { name: "bad\u0000\u0007name.jpg", data: "c" },
    { name: "....", data: "d" },
  ]);

  assert.deepEqual(
    readZip(archive).entries.map((entry) => entry.name),
    ["evil/photo.jpg", "windows/photo.jpg", "badname.jpg", "file"]
  );
});

test("createZipBuffer truncates long names but preserves the extension", () => {
  const archive = createZipBuffer([{ name: `${"x".repeat(300)}.jpg`, data: "data" }]);
  const name = readZip(archive).entries[0].name;
  assert.ok(name.length <= 180);
  assert.ok(name.endsWith(".jpg"));
  assert.match(name, /^x+\.jpg$/);
});

test("createZipBuffer handles empty archives and rejects non-arrays", () => {
  const archive = createZipBuffer([]);
  assert.equal(archive.length, 22);
  assert.equal(archive.readUInt32LE(0), 0x06054b50);
  assert.equal(archive.readUInt16LE(10), 0);

  assert.throws(() => createZipBuffer(null), TypeError);
  assert.throws(() => createZipBuffer("nope"), TypeError);
});

test("createZipBuffer accepts Uint8Array and string entry data", () => {
  const archive = createZipBuffer([
    { name: "bytes.bin", data: new Uint8Array([9, 8, 7]) },
    { name: "text.txt", data: "plain text" },
  ]);

  const zip = readZip(archive);
  assert.deepEqual(zip.entries[0].data, Buffer.from([9, 8, 7]));
  assert.equal(zip.entries[1].data.toString("utf8"), "plain text");
});
