import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const sizes = [16, 32, 48, 128];
const outputDir = join(process.cwd(), "src/icons");

await mkdir(outputDir, { recursive: true });

for (const size of sizes) {
  await writeFile(join(outputDir, `icon-${size}.png`), createIconPng(size));
}

function createIconPng(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const rectMin = 0;
  const rectMax = size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = roundedRectContains(x + 0.5, y + 0.5, rectMin, rectMin, rectMax, rectMax, radius);
      if (!inside) {
        pixels[offset + 3] = 0;
        continue;
      }

      const t = clamp((x + y) / (size * 1.82), 0, 1);
      const color = gradient(t);
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }

  drawCircle(pixels, size, size * 0.68, size * 0.32, size * 0.09, [255, 255, 255, 255]);

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    scanlines[rowStart] = 0;
    pixels.copy(scanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function drawCircle(pixels, size, cx, cy, radius, color) {
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
        setPixel(pixels, size, x, y, color);
      }
    }
  }
}

function setPixel(pixels, size, x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  const cx = clamp(x, left + radius, right - radius);
  const cy = clamp(y, top + radius, bottom - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function gradient(t) {
  if (t < 0.62) {
    return mix([30, 107, 255], [0, 168, 132], t / 0.62);
  }
  return mix([0, 168, 132], [18, 20, 23], (t - 0.62) / 0.38);
}

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([u32(data.length), typeBuffer, data, u32(crc32(Buffer.concat([typeBuffer, data])))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
