// Generates icons/icon{16,32,48,128}.png with a tiny PNG encoder (no image deps).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex("#4f46e5");
const PAGE = hex("#ffffff");
const INK = hex("#4338ca");
const ACCENT = hex("#22c55e");

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Renders one supersampled icon and returns RGBA at `size`.
function render(size) {
  const ss = 4;
  const n = size * ss;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x * ss + sx + 0.5) / n;
          const v = (y * ss + sy + 0.5) / n;
          let color = null;
          if (inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22)) {
            color = BG;
            // Page sheet.
            if (inRoundRect(u, v, 0.2, 0.15, 0.6, 0.85, 0.045)) {
              color = PAGE;
              // Body lines.
              for (let i = 0; i < 3; i++) {
                const top = 0.3 + i * 0.16;
                if (inRoundRect(u, v, 0.27, top, 0.53, top + 0.055, 0.027)) color = i === 0 ? INK : hex("#a5b4fc");
              }
            }
            // Play triangle (read aloud).
            if (inTriangle(u, v, [0.66, 0.42], [0.66, 0.7], [0.87, 0.56])) color = ACCENT;
          }
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const samples = ss * ss;
      const i = (y * size + x) * 4;
      const alpha = a / samples;
      out[i] = alpha ? Math.round(r / (a / 255)) : 0;
      out[i + 1] = alpha ? Math.round(g / (a / 255)) : 0;
      out[i + 2] = alpha ? Math.round(b / (a / 255)) : 0;
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

const dir = path.join(import.meta.dirname, "..", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), encodePng(size, size, render(size)));
}
console.log("wrote icons:", fs.readdirSync(dir).join(", "));
