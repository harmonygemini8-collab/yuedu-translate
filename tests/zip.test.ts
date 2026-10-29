// @vitest-environment node
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, createZip } from '../scripts/zip.mjs';

/** Read entries back via the central directory, the way unzip tools and the Chrome Web Store do. */
function readZip(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26);
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + size));
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data });
    pos += 46 + nameLen;
  }
  return entries;
}

describe('zip packager', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips files, including nested paths and non-ASCII names', () => {
    const files = [
      { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') },
      { name: '_locales/zh_CN/messages.json', data: Buffer.from('{"extName":{"message":"阅渡"}}') },
      { name: 'icons/icon-16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) },
    ];
    expect(readZip(createZip(files))).toEqual(files);
  });

  it('is deterministic', () => {
    const files = [{ name: 'a.txt', data: Buffer.from('same input') }];
    expect(createZip(files).equals(createZip(files))).toBe(true);
  });
});
