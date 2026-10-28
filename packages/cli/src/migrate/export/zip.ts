import { inflateRawSync } from 'node:zlib';

/**
 * Read the files of a ZIP archive held in memory (stored or deflated entries,
 * via the central directory). Enough for a vendor's data-export archive; no
 * dependency. Refuses ZIP64, encryption and sizes past `maxBytes` per entry.
 */
export function readZip(buf: Buffer, maxBytes = 2 * 1024 ** 3): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('ZIP64 archives are not supported; extract the files and pass them directly.');
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error(`ZIP entry ${name} is encrypted.`);
    if (size > maxBytes) throw new Error(`ZIP entry ${name} is too large.`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt ZIP local header.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: Math.max(size, 1) }));
    else throw new Error(`ZIP entry ${name} uses compression method ${method}, which is not supported.`);
  }
  return out;
}

/** A file in the archive by its base name (exports often nest files in a folder). */
export function zipFile(files: Map<string, Buffer>, baseName: string): Buffer | undefined {
  for (const [name, data] of files) if (name === baseName || name.endsWith(`/${baseName}`)) return data;
  return undefined;
}
