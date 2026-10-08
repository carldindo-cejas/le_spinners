import { unprocessable } from './errors';
import type { ImageKind } from './images';

export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_PARTS = 4096;
export function malformedImage() {
  return unprocessable('MALFORMED_IMAGE', 'This image is damaged or incomplete. Save a new JPG, PNG or WEBP screenshot and try again.');
}
function check(ok: unknown): asserts ok { if (!ok) throw malformedImage(); }
function unsupported(): never {
  throw unprocessable('UNSUPPORTED_IMAGE_FORMAT', 'Upload a static JPG, PNG or WEBP screenshot. This image encoding is not supported.');
}
function dimensions(width: number, height: number) {
  check(width > 0 && height > 0);
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw unprocessable('IMAGE_DIMENSIONS_TOO_LARGE', 'Use a screenshot up to 8192 pixels per side and 16 million pixels.');
  }
}
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const ascii = (b: Uint8Array, at: number, size: number) => String.fromCharCode(...b.subarray(at, at + size));
const uint24 = (b: Uint8Array, at: number) => b[at]! | b[at + 1]! << 8 | b[at + 2]! << 16;

/** Read only bounded IFD0 orientation; all other TIFF data, including invalid metadata, is discarded. */
function orientation(data: Uint8Array): number | null {
  const b = ascii(data, 0, 6) === 'Exif\0\0' ? data.subarray(6) : data;
  if (b.length < 14) return null;
  const endian = ascii(b, 0, 2);
  if (endian !== 'II' && endian !== 'MM') return null;
  const little = endian === 'II', v = view(b);
  if (v.getUint16(2, little) !== 42) return null;
  const at = v.getUint32(4, little);
  if (at < 8 || at + 2 > b.length) return null;
  const count = v.getUint16(at, little);
  if (count > 256 || at + 2 + count * 12 + 4 > b.length) return null;
  for (let n = 0; n < count; n++) {
    const p = at + 2 + n * 12;
    if (v.getUint16(p, little) !== 0x0112) continue;
    if (v.getUint16(p + 2, little) !== 3 || v.getUint32(p + 4, little) !== 1) return null;
    const value = v.getUint16(p + 8, little);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}
export function orientationTiff(value: number) {
  const b = new Uint8Array(26), v = view(b);
  b.set([73,73]); v.setUint16(2,42,true); v.setUint32(4,8,true); v.setUint16(8,1,true);
  v.setUint16(10,0x0112,true); v.setUint16(12,3,true); v.setUint32(14,1,true); v.setUint16(18,value,true);
  return b;
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function imageCrc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) value = CRC_TABLE[(value ^ bytes[i]!) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function jpeg(b: Uint8Array) {
  const v = view(b), components = new Map<number,number>(), quant = new Set<number>(), huffman = new Set<number>(), icc = new Set<number>();
  let at = 2, parts = 0, frame = 0, scans = 0, width = 0, height = 0, restart = 0, iccCount = 0, orient: number | null = null;
  while (at < b.length) {
    check(++parts <= MAX_PARTS && b[at] === 255);
    while (b[at + 1] === 255) at++;
    check(at + 2 <= b.length);
    const marker = b[at + 1]!;
    if (marker === 217) { check(frame && scans && (!iccCount || icc.size === iccCount)); return { width,height,orientation:orient }; }
    check(marker !== 216 && marker !== 0 && !(marker >= 208 && marker <= 215) && at + 4 <= b.length);
    const length = v.getUint16(at + 2), end = at + 2 + length;
    check(length >= 2 && end <= b.length);
    const data = b.subarray(at + 4,end), d = view(data);
    if ([192,193,194].includes(marker)) {
      check(!frame && data.length >= 6 && data[0] === 8);
      width = d.getUint16(3); height = d.getUint16(1); dimensions(width,height);
      const count = data[5]!; check([1,3,4].includes(count) && data.length === 6 + 3 * count);
      let blocks = 0;
      for (let n = 0; n < count; n++) {
        const i = 6 + 3 * n, id = data[i]!, sampling = data[i + 1]!, q = data[i + 2]!;
        const x = sampling >> 4, y = sampling & 15;
        check(!components.has(id) && x >= 1 && x <= 4 && y >= 1 && y <= 4 && q <= 3);
        components.set(id,q); blocks += x * y;
      }
      check(blocks <= 10); frame = marker;
    } else if (marker === 219) {
      let i = 0;
      while (i < data.length) {
        const header = data[i++]!, precision = header >> 4, id = header & 15;
        check(precision <= 1 && id <= 3);
        const size = 64 * (precision + 1); check(i + size <= data.length);
        for (let j = i; j < i + size; j += precision + 1) check(precision ? d.getUint16(j) > 0 : data[j]! > 0);
        quant.add(id); i += size;
      }
      check(i > 0);
    } else if (marker === 196) {
      let i = 0;
      while (i < data.length) {
        check(i + 17 <= data.length); const header = data[i++]!; check((header >> 4) <= 1 && (header & 15) <= 3);
        let symbols = 0, available = 1;
        for (let n = 0; n < 16; n++) { const count = data[i++]!; symbols += count; available = available * 2 - count; check(available >= 0); }
        check(symbols > 0 && symbols <= 256 && i + symbols <= data.length); huffman.add(header); i += symbols;
      }
      check(i > 0);
    } else if (marker === 221) { check(data.length === 2); restart = d.getUint16(0);
    } else if (marker === 218) {
      check(frame && data.length >= 6); const count = data[0]!;
      check(count >= 1 && count <= components.size && data.length === 1 + 2 * count + 3);
      const start = data[data.length - 3]!, stop = data[data.length - 2]!, bits = data[data.length - 1]!;
      check(start <= stop && stop <= 63 && (bits >> 4) <= 13 && (bits & 15) <= 13);
      if (frame !== 194) check(start === 0 && stop === 63 && bits === 0);
      else check((start === 0 ? stop === 0 : count === 1) && ((bits >> 4) === 0 || (bits >> 4) === (bits & 15) + 1));
      const selected = new Set<number>();
      for (let n = 0; n < count; n++) {
        const id = data[1 + 2 * n]!, tables = data[2 + 2 * n]!;
        check(components.has(id) && !selected.has(id) && quant.has(components.get(id)!)); selected.add(id);
        check((tables >> 4) <= 3 && (tables & 15) <= 3);
        if (start === 0 && (bits >> 4) === 0) check(huffman.has(tables >> 4));
        if (stop > 0) check(huffman.has(16 | (tables & 15)));
      }
      let next = end;
      while (next < b.length) {
        if (b[next] !== 255) { next++; continue; }
        check(next + 1 < b.length); const m = b[next + 1]!;
        if (m === 0) { next += 2; continue; }
        if (m >= 208 && m <= 215) { check(restart > 0); next += 2; continue; }
        if (m === 255) { next++; continue; }
        break;
      }
      check(next > end && next < b.length); scans++; at = next; continue;
    } else if (marker >= 224 && marker <= 239) {
      if (marker === 224 && ascii(data,0,5) === 'JFIF\0') check(data.length >= 14 && data.length === 14 + 3 * data[12]! * data[13]!);
      if (marker === 225 && ascii(data,0,6) === 'Exif\0\0') { const value = orientation(data); check(!orient || !value || orient === value); orient ??= value; }
      if (marker === 226 && ascii(data,0,12) === 'ICC_PROFILE\0') {
        check(data.length > 14 && data[12]! >= 1 && data[13]! >= data[12]! && (!iccCount || iccCount === data[13]) && !icc.has(data[12]!));
        iccCount = data[13]!; icc.add(data[12]!);
      }
      if (marker === 238 && ascii(data,0,5) === 'Adobe') check(data.length === 12);
    } else if (marker !== 254) {
      if (marker >= 192 && marker <= 207) unsupported();
      throw malformedImage();
    }
    at = end;
  }
  throw malformedImage();
}

const PNG_COLOR = new Set(['gAMA','cHRM','sRGB','iCCP','sBIT','cICP','mDCV','cLLI']);
function png(b: Uint8Array) {
  const v = view(b), seen = new Set<string>();
  let at = 8, parts = 0, color = -1, depth = 0, palette = 0, dataBytes = 0, dataEnded = false, width = 0, height = 0, orient: number | null = null;
  const zlib: number[] = [];
  while (at < b.length) {
    check(++parts <= MAX_PARTS && at + 12 <= b.length);
    const size = v.getUint32(at), end = at + 12 + size, type = ascii(b,at + 4,4);
    check(end <= b.length && /^[A-Za-z]{4}$/.test(type) && /[A-Z]/.test(type[2]!) && imageCrc(b.subarray(at + 4,end - 4)) === v.getUint32(end - 4));
    const data = b.subarray(at + 8,end - 4), d = view(data);
    if (parts === 1) check(type === 'IHDR');
    const known = ['IHDR','PLTE','IDAT','IEND','tRNS','bKGD','pHYs','eXIf'].includes(type) || PNG_COLOR.has(type);
    if (known && type !== 'IDAT') check(!seen.has(type));
    if (['acTL','fcTL','fdAT'].includes(type)) unsupported();
    if (type === 'IHDR') {
      check(size === 13); width = d.getUint32(0); height = d.getUint32(4); dimensions(width,height); depth = data[8]!; color = data[9]!;
      const depths: Record<number,number[]> = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      check(depths[color]?.includes(depth) && data[10] === 0 && data[11] === 0 && data[12]! <= 1);
    } else if (type === 'PLTE') {
      check(!seen.has('IDAT') && ![0,4].includes(color) && size > 0 && size <= 768 && size % 3 === 0);
      palette = size / 3; if (color === 3) check(palette <= 2 ** depth);
    } else if (type === 'IDAT') {
      check(!dataEnded && (color !== 3 || palette > 0)); dataBytes += size;
      for (let i = 0; i < data.length && zlib.length < 2; i++) zlib.push(data[i]!);
    } else if (type === 'IEND') {
      check(size === 0 && seen.has('IDAT') && dataBytes >= 6 && zlib.length === 2
        && (zlib[0]! & 15) === 8 && (zlib[0]! >> 4) <= 7 && !(zlib[1]! & 32) && ((zlib[0]! << 8 | zlib[1]!) % 31) === 0);
      return {width,height,orientation:orient};
    } else {
      if (seen.has('IDAT')) dataEnded = true;
      if (!known && type[0] === type[0]!.toUpperCase()) unsupported();
      if (type === 'eXIf') orient = orientation(data);
      if (PNG_COLOR.has(type) || ['tRNS','bKGD','pHYs'].includes(type)) {
        check(!seen.has('IDAT')); if (PNG_COLOR.has(type)) check(!seen.has('PLTE'));
        if (type === 'gAMA') check(size === 4 && d.getUint32(0) > 0);
        if (type === 'cHRM') check(size === 32);
        if (type === 'sRGB') check(size === 1 && data[0]! <= 3 && !seen.has('iCCP'));
        if (type === 'iCCP') { const nul = data.indexOf(0); check(nul >= 1 && nul <= 79 && nul + 2 < size && data[nul + 1] === 0 && !seen.has('sRGB')); }
        if (type === 'pHYs') check(size === 9 && data[8]! <= 1);
        if (type === 'cICP') check(size === 4);
        if (type === 'mDCV') check(size === 24);
        if (type === 'cLLI') check(size === 8);
        if (type === 'tRNS') check((color === 0 && size === 2) || (color === 2 && size === 6) || (color === 3 && palette > 0 && size > 0 && size <= palette));
        if (type === 'bKGD') check((color === 3 && palette > 0 && size === 1 && data[0]! < palette) || ([0,4].includes(color) && size === 2) || ([2,6].includes(color) && size === 6));
        if (type === 'sBIT') { const sizes: Record<number,number> = {0:1,2:3,3:3,4:2,6:4}; check(size === sizes[color] && data.every(n => n > 0 && n <= (color === 3 ? 8 : depth))); }
      }
    }
    if (known) seen.add(type); at = end;
  }
  throw malformedImage();
}

function webp(b: Uint8Array) {
  const v = view(b), end = 8 + v.getUint32(4,true), seen = new Set<string>();
  check(end >= 20 && end <= b.length && !(end & 1));
  let at = 12, parts = 0, width = 0, height = 0, alpha = false, extended: Uint8Array | null = null, orient: number | null = null;
  while (at < end) {
    check(++parts <= MAX_PARTS && at + 8 <= end);
    const type = ascii(b,at,4), size = v.getUint32(at + 4,true), next = at + 8 + size + (size & 1);
    check(next <= end && (!(size & 1) || b[next - 1] === 0));
    const data = b.subarray(at + 8,at + 8 + size), d = view(data);
    if (['VP8X','VP8 ','VP8L','ALPH','ICCP','EXIF','XMP '].includes(type)) check(!seen.has(type));
    if (type === 'ANIM' || type === 'ANMF') unsupported();
    if (type === 'VP8X') {
      check(at === 12 && size === 10 && !(data[0]! & 0xc1) && data[1] === 0 && data[2] === 0 && data[3] === 0);
      if (data[0]! & 2) unsupported(); extended = data;
      dimensions(uint24(data,4) + 1,uint24(data,7) + 1);
    } else if (type === 'ICCP') check(extended && !width && !seen.has('ALPH') && size > 0);
    else if (type === 'ALPH') {
      check(extended && !width && size >= 2 && (data[0]! & 3) <= 1 && ((data[0]! >> 4) & 3) <= 1 && !(data[0]! & 0xc0)); alpha = true;
      if (!(data[0]! & 3)) check(size === 1 + (uint24(extended,4) + 1) * (uint24(extended,7) + 1));
    } else if (type === 'VP8 ' || type === 'VP8L') {
      check(!width);
      if (type === 'VP8 ') {
        check(size > 10 && !(data[0]! & 1) && ((data[0]! >> 1) & 7) <= 3 && (data[0]! & 16) && ascii(data,3,3) === '\x9d\x01\x2a');
        const partition = uint24(data,0) >>> 5; check(partition > 0 && partition <= size - 10);
        width = d.getUint16(6,true); height = d.getUint16(8,true); check(!(width & 0xc000) && !(height & 0xc000));
      } else {
        check(size > 5 && data[0] === 0x2f && !seen.has('ALPH')); const header = d.getUint32(1,true); check((header >>> 29) === 0);
        width = (header & 0x3fff) + 1; height = ((header >>> 14) & 0x3fff) + 1; alpha = Boolean(header & 0x10000000);
      }
      dimensions(width,height);
    } else if (type === 'EXIF') orient = orientation(data);
    seen.add(type); at = next;
  }
  check(at === end && width && height);
  if (extended) {
    check(uint24(extended,4) + 1 === width && uint24(extended,7) + 1 === height);
    const flags = extended[0]!;
    check(Boolean(flags & 32) === seen.has('ICCP') && Boolean(flags & 16) === alpha && Boolean(flags & 8) === seen.has('EXIF') && Boolean(flags & 4) === seen.has('XMP '));
  }
  return {width,height,orientation:orient,alpha};
}

/** Validates bounded container structure, not compressed pixels or the contents of retained ICC profiles. */
export function validateImageStructure(bytes: Uint8Array, kind: ImageKind) {
  if (kind.ext === 'jpg') return jpeg(bytes);
  if (kind.ext === 'png') return png(bytes);
  return webp(bytes);
}
