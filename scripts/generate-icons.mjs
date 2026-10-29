// Generates the extension icons (PNG) from simple vector shapes, with no image dependencies.
// Design: a gradient rounded square; a white bar (original text) and, below it, a yellow
// bar with a left accent line (the translation sitting next to the original).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 8;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const GRADIENT_FROM = hex('#14b8a6'); // teal, top-left
const GRADIENT_TO = hex('#2563eb'); // blue, bottom-right
const WHITE = hex('#ffffff');
const YELLOW = hex('#fcd34d');

/** Shapes on a 128×128 design grid: rounded rectangles [x0, y0, x1, y1, radius, color, alpha]. */
const SHAPES = [
  [24, 30, 104, 52, 11, WHITE, 1], // original text line
  [24, 60, 82, 74, 7, WHITE, 0.8], // second, shorter original line
  [24, 84, 34, 106, 5, YELLOW, 1], // accent line marking the translation
  [42, 84, 104, 106, 11, YELLOW, 1], // translation line
];
const BACKGROUND_RADIUS = 28;

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Colour of one sample point on the design grid, or null when outside the icon. */
function sample(x, y) {
  if (!insideRoundedRect(x, y, 0, 0, 128, 128, BACKGROUND_RADIUS)) return null;
  const t = Math.min(1, Math.max(0, (x + y) / 256));
  let color = GRADIENT_FROM.map((c, i) => c + (GRADIENT_TO[i] - c) * t);
  for (const [x0, y0, x1, y1, r, fill, alpha] of SHAPES) {
    if (insideRoundedRect(x, y, x0, y0, x1, y1, r)) color = color.map((c, i) => c + (fill[i] - c) * alpha);
  }
  return color;
}

/**
 * Chrome Web Store guideline: the 128×128 icon holds a 96×96 graphic with 16 px of transparent
 * padding per side. Toolbar sizes (16/32/48) use the full canvas so they stay legible.
 */
const paddingFor = (size) => (size === 128 ? 16 : 0);

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const pad = paddingFor(size);
  const scale = 128 / (size - 2 * pad);
  const n = SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = sample((px - pad + (sx + 0.5) / n) * scale, (py - pad + (sy + 0.5) / n) * scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; covered++;
        }
      }
      const o = (py * size + px) * 4;
      if (covered) {
        pixels[o] = Math.round(r / covered);
        pixels[o + 1] = Math.round(g / covered);
        pixels[o + 2] = Math.round(b / covered);
      }
      pixels[o + 3] = Math.round((covered / (n * n)) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  await writeFile(join(outDir, `icon-${size}.png`), png);
  console.log(`icon-${size}.png`);
  if (size === 128) {
    // Same file, kept next to the other store images for the dashboard's "Store icon" field.
    const storeIcon = join(outDir, '..', '..', 'release', 'assets', 'store-icon-128x128.png');
    await mkdir(dirname(storeIcon), { recursive: true });
    await writeFile(storeIcon, png);
    console.log('release/assets/store-icon-128x128.png');
  }
}
