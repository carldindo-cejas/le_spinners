import { readFileSync } from 'node:fs';
export const png = readFileSync(new URL('../../db/seed-proofs/juan.png', import.meta.url));
export const jpeg = readFileSync(new URL('../fixtures/static-baseline.jpg', import.meta.url));
export const progressive = readFileSync(new URL('../fixtures/static-progressive.jpg', import.meta.url));
export const lossless = readFileSync(new URL('../fixtures/static-lossless.webp', import.meta.url));
export const webp = Buffer.from('UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==', 'base64');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function pngChunk(type, payload) {
  const data = Buffer.from(payload);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4, 'latin1'); data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
export function jpegSegment(marker, payload) {
  const data = Buffer.from(payload);
  const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, data]);
}
export function riffChunk(type, payload) {
  const data = Buffer.from(payload), header = Buffer.alloc(8);
  header.write(type, 0, 'latin1'); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
}
export function riff(...chunks) {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]), head = Buffer.alloc(8);
  head.write('RIFF'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
export function exifOrientation(value = 6) {
  const tiff = Buffer.alloc(38);
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(value, 18);
  tiff.writeUInt16LE(0x010f, 22); tiff.writeUInt16LE(2, 24); tiff.writeUInt32LE(4, 26); tiff.write('Cam', 30);
  return tiff;
}
export const orientedJpeg = () => Buffer.concat([jpeg.subarray(0, 2), jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), exifOrientation()])), jpeg.subarray(2)]);
export function dirtyPng() {
  return Buffer.concat([png.subarray(0, 33), pngChunk('tEXt', 'Author\0PrivateAuthor'), pngChunk('eXIf', exifOrientation(1)),
    pngChunk('caBX', 'PrivateManifest'), pngChunk('prVt', 'PrivateUnknown'), png.subarray(33), Buffer.from('PrivateTrailer')]);
}
export function dirtyJpeg() {
  return Buffer.concat([jpeg.subarray(0, 2), jpegSegment(0xe1, 'Exif\0\0PrivateCamera'), jpegSegment(0xed, 'PhotoshopPrivateIPTC'),
    jpegSegment(0xe1, 'http://ns.adobe.com/xap/1.0/\0PrivateXMP'), jpegSegment(0xe2, 'ICC_PROFILE\0\x01\x01KeepICC'),
    jpegSegment(0xee, 'Adobe\0d\0\0\0\0\x01'), jpegSegment(0xfe, 'PrivateComment'), jpeg.subarray(2), Buffer.from('PrivateTrailer')]);
}
export function dirtyWebp() {
  const body = Buffer.from(webp.subarray(12)); body[8] |= 12;
  return Buffer.concat([riff(body, riffChunk('EXIF', exifOrientation(1)), riffChunk('XMP ', 'PrivateXMP'),
    riffChunk('C2PA', 'PrivateManifest'), riffChunk('prVt', 'PrivateUnknown')), Buffer.from('PrivateTrailer')]);
}
