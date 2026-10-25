import { inflateSync } from 'node:zlib';
import { hsl, isBrandish, normHex } from './brand.ts';

// A store's colour from its logo, for a store whose theme names none (brand.ts finds no
// theme-color, no theme settings, no saturated colour in the CSS): the logo's dominant
// colour that is not white, black or grey. No image library: the three formats logos
// come in are read here, as far as a colour needs and no further.
//
//   SVG   the fill, stroke and stop-color values, each counted where it is used
//   PNG   inflated with node:zlib, the scanlines unfiltered, every colour type at 8 or
//         fewer bits (16-bit samples by their high byte); an interlaced PNG is skipped
//   JPEG  baseline only, and only each 8x8 block's DC coefficient: the block's average
//         colour, which is all a dominant colour needs, without the inverse DCT. A
//         progressive or CMYK JPEG is skipped
//
// WebP, GIF and ICO are skipped. The pixels are sampled (about 40,000 of them), the
// transparent ones and the neutral ones left out, and the rest counted in 4,096 bins;
// a bin holding at least 1.5% of the logo's opaque pixels is a colour. Up to two come
// back, not near-duplicates of each other, the most used first.

type Pixels = { width: number; height: number; at: (x: number, y: number) => [number, number, number, number] };

const SAMPLES = 40_000;
const MAX_PIXELS = 25_000_000;

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** The logo's dominant brand colours (up to two), from its bytes; [] when it has none or its format is not read here. */
export function logoColors(bytes: Uint8Array | null | undefined): string[] {
  if (!bytes || bytes.length < 8) return [];
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return fromPixels(readPng(bytes));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return fromSamples(jpegBlocks(bytes));
    const head = new TextDecoder().decode(bytes.subarray(0, 2048));
    if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && /<svg/i.test(new TextDecoder().decode(bytes)))) return svgColors(new TextDecoder().decode(bytes));
  } catch {
    /* a broken or unusual file: no colour from it */
  }
  return [];
}

// ---------------------------------------------------------------- counting

/** The brand colours among sampled [r, g, b] values, most used first. */
function fromSamples(samples: [number, number, number][] | null): string[] {
  if (!samples?.length) return [];
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const [r, g, b] of samples) {
    if (!isBrandish(hex(r, g, b))) continue;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(k, bin);
  }
  const floor = Math.max(4, samples.length * 0.015);
  const ranked = [...bins.values()].filter((b) => b.n >= floor).sort((a, b) => b.n - a.n).map((b) => hex(b.r / b.n, b.g / b.n, b.b / b.n));
  const out: string[] = [];
  for (const c of ranked) {
    if (out.length >= 2) break;
    if (out.every((o) => Math.abs(hsl(o).h - hsl(c).h) > 18 || Math.abs(hsl(o).l - hsl(c).l) > 0.2)) out.push(c);
  }
  return out;
}

/** Opaque pixels, sampled on a grid. */
function fromPixels(p: Pixels | null): string[] {
  if (!p) return [];
  const step = Math.max(1, Math.ceil(Math.sqrt((p.width * p.height) / SAMPLES)));
  const samples: [number, number, number][] = [];
  for (let y = 0; y < p.height; y += step) {
    for (let x = 0; x < p.width; x += step) {
      const [r, g, b, a] = p.at(x, y);
      if (a >= 128) samples.push([r, g, b]);
    }
  }
  return fromSamples(samples);
}

// ---------------------------------------------------------------- SVG

/** The colours an SVG paints with, counted where they are used (a fill on 30 paths counts 30). */
export function svgColors(svg: string): string[] {
  const counts = new Map<string, number>();
  const re = /(?:fill|stroke|stop-color|color)\s*(?:=\s*["']|:\s*)(#[0-9a-f]{3,6}\b|rgba?\([^)]*\))/gi;
  for (const m of svg.matchAll(re)) {
    const c = normHex(m[1]);
    if (c && isBrandish(c)) counts.set(c, (counts.get(c) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const out: string[] = [];
  for (const c of ranked) {
    if (out.length >= 2) break;
    if (out.every((o) => Math.abs(hsl(o).h - hsl(c).h) > 18 || Math.abs(hsl(o).l - hsl(c).l) > 0.2)) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- PNG

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** A PNG's pixels, or null for an interlaced or broken one. */
export function readPng(b: Uint8Array): Pixels | null {
  let i = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let alpha: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (i + 8 <= b.length) {
    const len = u32(b, i);
    const name = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    const data = b.subarray(i + 8, i + 8 + len);
    if (name === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') alpha = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    i += 12 + len;
  }
  if (!width || !height || interlace || width * height > MAX_PIXELS) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const up = y ? out[prev + x] : 0;
      const c = x >= bpp && y ? out[prev + x - bpp] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = up;
      else if (f === 3) p = (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[row + x] = (v + p) & 255;
    }
  }
  const sample = (x: number, y: number, ch: number): number => {
    if (depth === 8) return out[y * stride + x * channels + ch];
    if (depth === 16) return out[y * stride + (x * channels + ch) * 2];
    const bit = (x * channels + ch) * depth;
    const v = (out[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  return {
    width,
    height,
    at: (x, y) => {
      if (type === 3) {
        const k = sample(x, y, 0);
        return palette ? [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2], alpha && k < alpha.length ? alpha[k] : 255] : [0, 0, 0, 0];
      }
      if (type === 2) return [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), 255];
      if (type === 6) return [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), sample(x, y, 3)];
      const g = sample(x, y, 0);
      return [g, g, g, type === 4 ? sample(x, y, 1) : 255];
    },
  };
}

// ---------------------------------------------------------------- JPEG

type Huff = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array };
/** A colour component: its sampling factors, its quantization table, and each block's average (NaN until read). */
type Comp = { id: number; h: number; v: number; tq: number; grid: Float32Array; w: number; hgt: number };
type Frame = { X: number; Y: number; comps: Comp[]; hmax: number; vmax: number };
type ScanComp = { c: Comp; dc: Huff; ac: Huff; q0: number; pred: number };

function huffman(counts: Uint8Array, values: Uint8Array): Huff {
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    if (n) {
      valptr[l] = k;
      mincode[l] = code;
      code += n;
      k += n;
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

/**
 * Each 8x8 block's average colour in a baseline JPEG, from its DC coefficients alone (dequantized, /8, +128),
 * the luma blocks paired with their chroma. Null for a progressive, CMYK or grey JPEG.
 */
export function jpegBlocks(b: Uint8Array): [number, number, number][] | null {
  const qt: Int32Array[] = [];
  const dc: (Huff | undefined)[] = [];
  const ac: (Huff | undefined)[] = [];
  let frame: Frame | null = null;
  let restart = 0;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff || m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
      i++;
      continue;
    }
    if (m === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    const seg = b.subarray(i + 4, i + 2 + len);
    if (m === 0xdb) {
      for (let p = 0; p < seg.length; ) {
        const pq = seg[p] >> 4;
        const tq = seg[p] & 15;
        const t = new Int32Array(64);
        for (let k = 0; k < 64; k++) t[k] = pq ? (seg[p + 1 + k * 2] << 8) | seg[p + 2 + k * 2] : seg[p + 1 + k];
        qt[tq] = t;
        p += 1 + 64 * (pq ? 2 : 1);
      }
    } else if (m === 0xc4) {
      for (let p = 0; p < seg.length; ) {
        const tc = seg[p] >> 4;
        const th = seg[p] & 15;
        const counts = seg.subarray(p + 1, p + 17);
        const total = counts.reduce((s, n) => s + n, 0);
        const h = huffman(counts, seg.subarray(p + 17, p + 17 + total));
        (tc ? ac : dc)[th] = h;
        p += 17 + total;
      }
    } else if (m === 0xc0 || m === 0xc1) {
      const Y = (seg[1] << 8) | seg[2];
      const X = (seg[3] << 8) | seg[4];
      const n = seg[5];
      if (n !== 3 || X * Y > MAX_PIXELS) return null; // grey has no colour; CMYK is skipped
      const comps: Comp[] = [];
      for (let k = 0; k < n; k++) comps.push({ id: seg[6 + k * 3], h: seg[7 + k * 3] >> 4, v: seg[7 + k * 3] & 15, tq: seg[8 + k * 3], grid: new Float32Array(0), w: 0, hgt: 0 });
      const hmax = Math.max(...comps.map((c) => c.h));
      const vmax = Math.max(...comps.map((c) => c.v));
      const mcusX = Math.ceil(X / (8 * hmax));
      const mcusY = Math.ceil(Y / (8 * vmax));
      for (const c of comps) {
        c.w = mcusX * c.h;
        c.hgt = mcusY * c.v;
        c.grid = new Float32Array(c.w * c.hgt).fill(NaN);
      }
      frame = { X, Y, comps, hmax, vmax };
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return null; // progressive, lossless or arithmetic-coded
    } else if (m === 0xdd) {
      restart = (seg[0] << 8) | seg[1];
    } else if (m === 0xda) {
      if (!frame) return null;
      const ns = seg[0];
      const scan: ScanComp[] = [];
      for (let k = 0; k < ns; k++) {
        const c = frame.comps.find((x) => x.id === seg[1 + k * 2]);
        const d = dc[seg[2 + k * 2] >> 4];
        const a = ac[seg[2 + k * 2] & 15];
        if (!c || !d || !a || !qt[c.tq]) return null;
        scan.push({ c, dc: d, ac: a, q0: qt[c.tq][0], pred: 0 });
      }
      i = decodeScan(b, i + 2 + len, frame, scan, restart);
      continue;
    }
    i += 2 + len;
  }
  if (!frame) return null;
  const [yc, cb, cr] = frame.comps;
  const out: [number, number, number][] = [];
  const bw = Math.ceil(Math.ceil((frame.X * yc.h) / frame.hmax) / 8);
  const bh = Math.ceil(Math.ceil((frame.Y * yc.v) / frame.vmax) / 8);
  const at = (c: typeof yc, bx: number, by: number) => c.grid[Math.min(c.hgt - 1, Math.floor((by * c.v) / yc.v)) * c.w + Math.min(c.w - 1, Math.floor((bx * c.h) / yc.h))];
  const step = Math.max(1, Math.ceil(Math.sqrt((bw * bh) / SAMPLES)));
  for (let by = 0; by < bh; by += step) {
    for (let bx = 0; bx < bw; bx += step) {
      const Yv = yc.grid[by * yc.w + bx];
      const Cb = at(cb, bx, by) - 128;
      const Cr = at(cr, bx, by) - 128;
      if (![Yv, Cb, Cr].every(Number.isFinite)) continue;
      out.push([Yv + 1.402 * Cr, Yv - 0.344136 * Cb - 0.714136 * Cr, Yv + 1.772 * Cb].map((v) => Math.max(0, Math.min(255, v))) as [number, number, number]);
    }
  }
  return out;
}

/** One scan's entropy-coded data: every block's DC kept (its AC codes read past), until the next marker. Returns where the scan ended. */
function decodeScan(b: Uint8Array, start: number, frame: Frame, scan: ScanComp[], restart: number): number {
  let pos = start;
  let buf = 0;
  let bits = 0;
  let marker = false; // the reader stands on a marker: it reads zeros until a restart moves past it
  const bit = (): number => {
    if (!bits) {
      if (pos >= b.length) return 0;
      let v = b[pos];
      if (v === 0xff && b[pos + 1] !== 0) {
        marker = true;
        v = 0;
      } else pos += v === 0xff ? 2 : 1;
      buf = v;
      bits = 8;
    }
    bits--;
    return (buf >> bits) & 1;
  };
  const receive = (n: number) => {
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 1) | bit();
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | bit();
      if (h.maxcode[l] >= code && h.maxcode[l] !== -1) return h.values[h.valptr[l] + code - h.mincode[l]];
    }
    return 0;
  };
  const extend = (v: number, t: number) => (t && v < 1 << (t - 1) ? v - (1 << t) + 1 : v);
  const block = (s: ScanComp, bx: number, by: number) => {
    const t = decode(s.dc);
    s.pred += t ? extend(receive(t), t) : 0;
    for (let k = 1; k < 64; ) {
      const rs = decode(s.ac);
      const r = rs >> 4;
      const sz = rs & 15;
      if (!sz) {
        if (r !== 15) break;
        k += 16;
        continue;
      }
      k += r;
      receive(sz);
      k++;
    }
    const c = s.c;
    if (bx < c.w && by < c.hgt) c.grid[by * c.w + bx] = (s.pred * s.q0) / 8 + 128;
  };
  const single = scan.length === 1;
  const mcusX = single ? Math.ceil(Math.ceil((frame.X * scan[0].c.h) / frame.hmax) / 8) : Math.ceil(frame.X / (8 * frame.hmax));
  const mcusY = single ? Math.ceil(Math.ceil((frame.Y * scan[0].c.v) / frame.vmax) / 8) : Math.ceil(frame.Y / (8 * frame.vmax));
  const total = mcusX * mcusY;
  for (let n = 0; n < total; n++) {
    if (restart && n && n % restart === 0) {
      bits = 0;
      marker = false;
      while (pos + 1 < b.length && !(b[pos] === 0xff && b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const s of scan) s.pred = 0;
    } else if (marker) break;
    const mx = n % mcusX;
    const my = Math.floor(n / mcusX);
    if (single) block(scan[0], mx, my);
    else for (const s of scan) for (let v = 0; v < s.c.v; v++) for (let h = 0; h < s.c.h; h++) block(s, mx * s.c.h + h, my * s.c.v + v);
  }
  // The next marker: past any padding and restart markers.
  while (pos + 1 < b.length && !(b[pos] === 0xff && b[pos + 1] !== 0 && !(b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7))) pos++;
  return pos;
}
