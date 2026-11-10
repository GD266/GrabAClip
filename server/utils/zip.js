/**
 * Tiny dependency-free ZIP writer.
 *
 * Facebook galleries are a handful of JPEGs; pulling in an archive library
 * just for "download all" would add supply-chain weight for no benefit. This
 * writes a valid ZIP using the `store` method (no compression), which every
 * operating system opens. Images are already compressed, so deflating them
 * would mostly waste CPU.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();
  return {
    time: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (Math.floor(seconds / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

function safeZipName(name, fallback = "file") {
  let value = String(name || fallback)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!value) value = fallback;
  if (value.length > 180) {
    const dot = value.lastIndexOf(".");
    if (dot > 0) {
      const ext = value.slice(dot);
      value = value.slice(0, Math.max(1, 180 - ext.length)) + ext;
    } else {
      value = value.slice(0, 180);
    }
  }
  return value;
}

/**
 * Create a ZIP archive containing the given entries.
 * @param {Array<{name: string, data: Buffer|Uint8Array|string, date?: Date}>} entries
 * @param {{date?: Date}} [options]
 * @returns {Buffer}
 */
export function createZipBuffer(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError("ZIP entries must be an array");
  const defaultDate = options.date instanceof Date ? options.date : new Date();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const usedNames = new Set();

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry?.data)
      ? entry.data
      : entry?.data instanceof Uint8Array
        ? Buffer.from(entry.data)
        : Buffer.from(String(entry?.data ?? ""), "utf8");
    let name = safeZipName(entry?.name);
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let counter = 2;
      while (usedNames.has(`${base}-${counter}${ext}`)) counter += 1;
      name = `${base}-${counter}${ext}`;
    }
    usedNames.add(name);

    const nameBuffer = Buffer.from(name, "utf8");
    const { time, date } = dosDateTime(entry?.date || defaultDate);
    const checksum = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, end]);
}

export { crc32 };
