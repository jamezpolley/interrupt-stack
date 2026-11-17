// Generates the PWA icons: a stack of three bars, top bar solid. Run: bun scripts/make-icons.ts
import { deflateSync } from "node:zlib";

const BG: [number, number, number] = [0x1c, 0x6b, 0x58]; // --accent
const FG: [number, number, number] = [0xff, 0xff, 0xff];
const SS = 4; // supersampling per axis

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

// Rounded-rect coverage test in unit coordinates.
const inRoundRect = (x: number, y: number, x0: number, y0: number, w: number, h: number, r: number) => {
  if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// `scale` shrinks the artwork toward the centre (maskable icons keep it inside the safe zone);
// `rounded` rounds the canvas corners (regular icons) or fills the whole square (maskable and Apple).
function render(size: number, scale: number, rounded: boolean) {
  const bars = [
    { y: 0.3, w: 0.46, a: 1 },
    { y: 0.46, w: 0.58, a: 0.6 },
    { y: 0.62, w: 0.7, a: 0.35 },
  ];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (rounded && !inRoundRect(x, y, 0, 0, 1, 1, 0.22)) continue;
          let col = BG;
          const ux = 0.5 + (x - 0.5) / scale;
          const uy = 0.5 + (y - 0.5) / scale;
          for (const b of bars) {
            if (inRoundRect(ux, uy, 0.5 - b.w / 2, b.y, b.w, 0.1, 0.05)) {
              col = [0, 1, 2].map((i) => Math.round(BG[i] + (FG[i] - BG[i]) * b.a)) as [number, number, number];
            }
          }
          rr += col[0]; gg += col[1]; bb += col[2]; aa += 255;
        }
      }
      const n = SS * SS;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const covered = aa / 255;
      raw[o] = covered ? Math.round(rr / covered) : 0;
      raw[o + 1] = covered ? Math.round(gg / covered) : 0;
      raw[o + 2] = covered ? Math.round(bb / covered) : 0;
      raw[o + 3] = Math.round(aa / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

const out = new URL("../web/icons/", import.meta.url).pathname;
await Bun.write(out + "icon-192.png", render(192, 1, true));
await Bun.write(out + "icon-512.png", render(512, 1, true));
await Bun.write(out + "icon-maskable-512.png", render(512, 0.72, false));
await Bun.write(out + "apple-touch-icon.png", render(180, 1, false)); // iOS applies its own corner mask
console.log("icons written to", out);
