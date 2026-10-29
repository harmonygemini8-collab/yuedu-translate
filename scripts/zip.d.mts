export function crc32(buf: Uint8Array): number;
export function createZip(entries: { name: string; data: Buffer }[]): Buffer;
export function zipDirectory(dir: string): Promise<Buffer>;
