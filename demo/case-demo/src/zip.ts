/**
 * 极简 ZIP 读写 —— 不依赖任何第三方库。
 * 读：支持 STORE (0) 和 DEFLATE (8) 两种压缩。
 * 写：统一用 DEFLATE 压缩。
 *
 * 仅用于本 demo 的 .docx / .xlsx 读取和 .xmind 写出，不处理 ZIP64、加密、分卷等高级特性。
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// ── CRC32 ─────────────────────────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── 读 ────────────────────────────────────────────────────────────────

export function unzipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  if (buffer.length < 22) throw new Error("不是合法的 ZIP 文件（过短）");

  // End of Central Directory record 签名 0x06054b50
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("找不到 ZIP End of Central Directory 记录");
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdSize = buffer.readUInt16LE(eocd + 12);
  if (cdOffset + cdSize > buffer.length) throw new Error("ZIP 中央目录损坏");

  let p = cdOffset;
  while (p < cdOffset + cdSize) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break; // Central directory file header
    const compMethod = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localHeaderOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // 跳到 local header 取数据
    const lh = localHeaderOffset;
    if (buffer.readUInt32LE(lh) !== 0x04034b50) {
      p += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    const lhNameLen = buffer.readUInt16LE(lh + 26);
    const lhExtraLen = buffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (compMethod === 0) {
      data = Buffer.from(raw);
    } else if (compMethod === 8) {
      data = inflateRawSync(raw);
    } else {
      p += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    if (data.length !== uncompSize && uncompSize > 0) {
      // 大小不匹配但已解出数据，宽容处理
    }
    entries.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ── 写 ────────────────────────────────────────────────────────────────

export function zipFiles(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const crc = crc32(entry.data);
    const compSize = compressed.length;
    const uncompSize = entry.data.length;

    // Local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // method = deflate
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0, 12); // mod date
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(compSize, 18);
    lh.writeUInt32LE(uncompSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len

    chunks.push(lh, nameBuf, compressed);

    // Central directory record
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + compSize;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(central);
  const cdSize = cdBuf.length;

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, cdBuf, eocd]);
}
