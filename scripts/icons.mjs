// Generates the toolbar icons as PNGs without any image dependencies:
// a rounded page with a folded corner and an accent bar.
import { deflateSync } from "node:zlib";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function iconPixel(u, v) {
  // Page body: x in [0.18, 0.82], y in [0.08, 0.92], folded top-right corner.
  const inPage = u > 0.18 && u < 0.82 && v > 0.08 && v < 0.92 && u - 0.82 + 0.2 < v - 0.08;
  const fold = u > 0.62 && u < 0.82 && v > 0.08 && v < 0.28 && u - 0.62 >= v - 0.08;
  if (fold) return [0, 0, 0, 0];
  if (!inPage) return [0, 0, 0, 0];
  const foldShade = u > 0.62 && v < 0.3 && u - 0.62 < v - 0.08 + 0.02;
  if (foldShade) return [175, 190, 214, 255];
  if (v > 0.62 && v < 0.78 && u > 0.28 && u < 0.72) return [232, 70, 52, 255]; // accent bar
  if ((v > 0.38 && v < 0.44) || (v > 0.5 && v < 0.56)) {
    if (u > 0.28 && u < 0.72) return [120, 134, 160, 255];
  }
  return [246, 248, 252, 255];
}

export function makeIcons() {
  const out = {};
  for (const s of [16, 32, 48, 128]) out[s] = png(s, iconPixel);
  return out;
}
