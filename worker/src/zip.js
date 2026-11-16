// Per-copy fingerprint: append one small file to the track zip stored in R2,
// without decompressing or rewriting the rest. A zip's central directory sits at
// the end, so we stream the original bytes up to the directory, add a new local
// entry, then write the old directory plus one new record and a new end record.

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

let CRC_TABLE;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

export function findEndRecord(tail) {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLength = v.getUint16(i + 20, true);
    if (i + 22 + commentLength !== tail.length) continue; // a stray signature inside data
    return {
      index: i,
      entries: v.getUint16(i + 10, true),
      cdSize: v.getUint32(i + 12, true),
      cdOffset: v.getUint32(i + 16, true),
      zip64: (i >= 20 && v.getUint32(i - 20, true) === SIG_ZIP64_LOCATOR),
    };
  }
  return null;
}

export function buildAppendix({ name, data, cdOffset, cdBytes, entries, date = new Date() }) {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(data);
  const { time, day } = dosDateTime(date);

  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true); // version needed
  lv.setUint16(6, 0x0800, true); // UTF-8 names
  lv.setUint16(8, 0, true); // stored
  lv.setUint16(10, time, true);
  lv.setUint16(12, day, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  lv.setUint16(28, 0, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true); // made by
  cv.setUint16(6, 20, true); // needed
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, 0, true);
  cv.setUint16(12, time, true);
  cv.setUint16(14, day, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  // extra, comment, disk, internal attrs, external attrs stay 0
  cv.setUint32(42, cdOffset, true); // local header offset
  central.set(nameBytes, 46);

  const newCdOffset = cdOffset + local.length;
  const newCdSize = cdBytes.length + central.length;
  if (newCdOffset + newCdSize > 0xfffffffe || entries + 1 > 0xfffe) throw new Error('zip64_required');

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, entries + 1, true);
  ev.setUint16(10, entries + 1, true);
  ev.setUint32(12, newCdSize, true);
  ev.setUint32(16, newCdOffset, true);

  const tail = new Uint8Array(local.length + cdBytes.length + central.length + end.length);
  tail.set(local, 0);
  tail.set(cdBytes, local.length);
  tail.set(central, local.length + cdBytes.length);
  tail.set(end, local.length + cdBytes.length + central.length);
  return tail;
}

async function readRange(bucket, key, offset, length) {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new Error('missing_object');
  return new Uint8Array(await obj.arrayBuffer());
}

// Returns { stream, length } for the fingerprinted zip.
export async function fingerprintedZip(bucket, key, { name, data }) {
  const head = await bucket.head(key);
  if (!head) throw new Error('missing_object');
  const size = head.size;
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await readRange(bucket, key, size - tailLength, tailLength);
  const end = findEndRecord(tail);
  if (!end) throw new Error('not_a_zip');
  if (end.zip64 || end.entries === 0xffff || end.cdOffset === 0xffffffff) throw new Error('zip64_not_supported');
  if (end.cdOffset + end.cdSize > size) throw new Error('not_a_zip');

  const cdBytes = await readRange(bucket, key, end.cdOffset, end.cdSize);
  const appendix = buildAppendix({ name, data, cdOffset: end.cdOffset, cdBytes, entries: end.entries });

  const body = end.cdOffset > 0 ? (await bucket.get(key, { range: { offset: 0, length: end.cdOffset } })).body : null;
  // Pull-based so a slow client never makes the Worker buffer a large file.
  let reader = body ? body.getReader() : null;
  let finished = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (reader) {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        reader = null;
      }
      if (!finished) {
        finished = true;
        controller.enqueue(appendix);
        controller.close();
      }
    },
    cancel(why) {
      if (reader) reader.cancel(why);
    },
  });
  return { stream, length: end.cdOffset + appendix.length };
}
