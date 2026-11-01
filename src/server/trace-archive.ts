import { crc32, inflateRawSync } from 'node:zlib';

export const archiveLimits = {
  compressedBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entries: 512,
} as const;

/** A bounded ZIP reader, never a filesystem extractor. ZIP64/encryption are unsupported. */
export function readTraceArchive(input: Uint8Array): Map<string, Uint8Array> {
  const fail = () => {
    throw new Error('Unsupported or invalid trace archive.');
  };
  if (input.length < 22 || input.length > archiveLimits.compressedBytes) fail();
  const bytes = Buffer.from(input);
  // Find the end record, accounting for a bounded ZIP comment.
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
    end--;
  }
  if (end < Math.max(0, bytes.length - 65557)) fail();
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    count === 0 ||
    count > archiveLimits.entries ||
    start + size !== end
  )
    fail();
  let cursor = start;
  let expanded = 0;
  const entries: {
    name: string;
    offset: number;
    length: number;
    size: number;
    crc: number;
    method: number;
    flags: number;
  }[] = [];
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const length = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      nameLength > 180 ||
      ![0, 8].includes(method) ||
      flags & ~0x808 ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      offset >= start
    )
      fail();
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) fail();
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !/^(?:[a-zA-Z0-9_-]+\.(?:trace|network|stacks)|resources\/[a-zA-Z0-9_.-]+|replay\.json)$/.test(
        name,
      ) ||
      name.includes('..') ||
      names.has(name)
    )
      fail();
    names.add(name);
    expanded += unpacked;
    if (expanded > archiveLimits.expandedBytes) fail();
    entries.push({
      name,
      offset,
      length,
      size: unpacked,
      crc: bytes.readUInt32LE(cursor + 16),
      method,
      flags,
    });
    cursor = next;
  }
  if (cursor !== end) fail();
  // Reject overlapping entries, prepended files, mismatched local headers and hidden records.
  entries.sort((a, b) => a.offset - b.offset);
  const files = new Map<string, Uint8Array>();
  let position = 0;
  for (const [i, entry] of entries.entries()) {
    const at = entry.offset;
    if (
      at !== position ||
      at + 30 > start ||
      bytes.readUInt32LE(at) !== 0x04034b50 ||
      bytes.readUInt16LE(at + 6) !== entry.flags ||
      bytes.readUInt16LE(at + 8) !== entry.method
    )
      fail();
    const nameLength = bytes.readUInt16LE(at + 26);
    const data = at + 30 + nameLength + bytes.readUInt16LE(at + 28);
    const dataEnd = data + entry.length;
    const next = entries[i + 1]?.offset ?? start;
    if (
      dataEnd > next ||
      bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8') !== entry.name
    )
      fail();
    if (entry.flags & 8) {
      let descriptor = dataEnd;
      if (descriptor + 4 <= next && bytes.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4;
      if (
        descriptor + 12 !== next ||
        bytes.readUInt32LE(descriptor) !== entry.crc ||
        bytes.readUInt32LE(descriptor + 4) !== entry.length ||
        bytes.readUInt32LE(descriptor + 8) !== entry.size
      )
        fail();
    } else if (
      dataEnd !== next ||
      bytes.readUInt32LE(at + 14) !== entry.crc ||
      bytes.readUInt32LE(at + 18) !== entry.length ||
      bytes.readUInt32LE(at + 22) !== entry.size
    )
      fail();
    const compressed = bytes.subarray(data, dataEnd);
    const content =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    if (content.length !== entry.size || crc32(content) !== entry.crc) fail();
    files.set(entry.name, content);
    position = next;
  }
  return files;
}
