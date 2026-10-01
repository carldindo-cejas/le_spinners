/**
 * Upload hygiene for payment screenshots: detect the real type from magic bytes
 * (never trust the file name or the browser's MIME type), then rebuild the file
 * from an allowlist of the parts needed to draw it. Everything else is dropped:
 * EXIF (GPS location, device info), XMP, IPTC, C2PA content credentials, maker
 * data, comments, embedded thumbnails, and any bytes after the image ends
 * (phones append secondary images and HDR gain maps there).
 */

export type ImageKind = { type: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { type: 'image/png', ext: 'png' };
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

export function stripMetadata(bytes: Uint8Array, kind: ImageKind): Uint8Array {
  try {
    if (kind.ext === 'jpg') return stripJpeg(bytes);
    if (kind.ext === 'png') return stripPng(bytes);
    return stripWebp(bytes);
  } catch {
    return bytes; // malformed but still an image the browser may render; keep as-is
  }
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

function startsWith(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let k = 0; k < text.length; k++) if (b[at + k] !== text.charCodeAt(k)) return false;
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── JPEG ────────────────────────────────────────────────────────────────────

const EOI = new Uint8Array([0xff, 0xd9]);

/**
 * Keeps the frame, tables and scans, plus the three header segments that change
 * how the picture looks: JFIF (minus its thumbnail), the ICC colour profile and
 * the Adobe colour-transform flag. Drops every other APPn segment (EXIF/XMP,
 * MPF, C2PA/JUMBF, IPTC, maker and editor data), comments, and everything after
 * the end-of-image marker.
 */
function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      // Stray bytes between segments: skip to the next marker, as decoders do.
      const next = b.indexOf(0xff, i);
      if (next < 0) return b;
      i = next;
      continue;
    }
    if (i + 1 >= b.length) return b;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      out.push(EOI);
      return concat(out);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker !== 0xd8) out.push(b.subarray(i, i + 2)); // a repeated start-of-image is dropped
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return b;
    const end = i + 2 + ((b[i + 2]! << 8) | b[i + 3]!);
    if (end < i + 4 || end > b.length) return b;
    const kept = keepJpegSegment(b.subarray(i, end), marker);
    if (kept) out.push(kept);
    i = end;
    if (marker === 0xda) {
      const stop = endOfScan(b, i);
      out.push(b.subarray(i, stop));
      if (stop >= b.length) {
        out.push(EOI); // truncated file: close it so decoders show what is there
        return concat(out);
      }
      i = stop;
    }
  }
  return b;
}

function keepJpegSegment(seg: Uint8Array, marker: number): Uint8Array | null {
  if (marker === 0xfe) return null; // comment
  if (marker < 0xe0 || marker > 0xef) return seg; // tables, frame and scan headers, restart interval…
  if (marker === 0xe0 && startsWith(seg, 4, 'JFIF\0') && seg.length >= 18) {
    if (seg.length === 18) return seg;
    const trimmed = seg.slice(0, 18); // drop the embedded thumbnail
    trimmed[2] = 0;
    trimmed[3] = 16;
    trimmed[16] = 0;
    trimmed[17] = 0;
    return trimmed;
  }
  if (marker === 0xe2 && startsWith(seg, 4, 'ICC_PROFILE\0')) return seg;
  if (marker === 0xee && startsWith(seg, 4, 'Adobe')) return seg;
  return null;
}

/** Entropy-coded data runs until a marker other than a stuffed 0xFF00 or a restart marker. */
function endOfScan(b: Uint8Array, from: number): number {
  let j = from;
  for (;;) {
    j = b.indexOf(0xff, j);
    if (j < 0 || j + 1 >= b.length) return b.length;
    const next = b[j + 1]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) j += 2;
    else if (next === 0xff) j += 1;
    else return j;
  }
}

// ── PNG ─────────────────────────────────────────────────────────────────────

/** Chunks that affect how the picture is drawn. Text, EXIF, C2PA (caBX), timestamps and private chunks are dropped. */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs',
  'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
]);
const IEND = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function stripPng(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const total = 12 + view.getUint32(i);
    if (i + total > b.length) break;
    const type = ascii(b, i + 4, 4);
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, i + total));
    i += total;
    if (type === 'IEND') return concat(out); // bytes after IEND are dropped
  }
  out.push(IEND); // truncated file: keep the complete chunks and close it
  return concat(out);
}

// ── WebP ────────────────────────────────────────────────────────────────────

/** Image data, alpha, animation and the ICC profile. EXIF, XMP and anything else (C2PA, …) are dropped. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function stripWebp(b: Uint8Array): Uint8Array {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = Math.min(b.length, 8 + view.getUint32(4, true)); // bytes after the RIFF container are dropped
  const chunks: Uint8Array[] = [];
  let vp8x: Uint8Array | null = null;
  let i = 12;
  while (i + 8 <= end) {
    const fourcc = ascii(b, i, 4);
    const size = view.getUint32(i + 4, true);
    if (i + 8 + size > end) return b;
    const next = Math.min(end, i + 8 + size + (size & 1));
    if (WEBP_KEEP.has(fourcc)) {
      const chunk = b.slice(i, next);
      if (fourcc === 'VP8X') vp8x = chunk;
      chunks.push(chunk);
    }
    i = next;
  }
  if (vp8x && vp8x.length > 8) vp8x[8] = vp8x[8]! & ~0x0c; // clear the EXIF and XMP flags
  const body = concat(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return out;
}
