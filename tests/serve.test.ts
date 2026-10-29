import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
let child: ChildProcess;
let url: string;
let body: Buffer;

beforeAll(async () => {
  body = await readFile(join(root, 'demo', 'index.html'));
  child = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs'), 'demo', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  url = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Preview server did not start: ${output}`)), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Preview server exited: ${code}`)); });
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk; });
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(`${match[0]}/index.html`); }
    });
  });
});

afterAll(() => { child?.kill(); });

describe('local preview byte ranges', () => {
  it('serves full files and HEAD metadata', async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe(String(body.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(body.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=100-', 100, -1],
    ['bytes=-80', -80, -1],
    ['bytes=10-99999999', 10, -1],
  ])('serves %s for media seeking', async (range, start, end) => {
    const first = start < 0 ? body.length + start : start;
    const last = end < 0 ? body.length - 1 : end;
    const response = await fetch(url, { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes ${first}-${last}/${body.length}`);
    expect(response.headers.get('content-length')).toBe(String(last - first + 1));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body.subarray(first, last + 1));
  });

  it.each(['bytes=-', 'bytes=-0', 'bytes=99999999-', 'bytes=20-10', 'bytes=0-1,5-9', 'invalid'])('rejects invalid or unsupported range %s', async (range) => {
    const response = await fetch(url, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${body.length}`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });
});
