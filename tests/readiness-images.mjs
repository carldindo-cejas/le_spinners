import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { app, fixture, seedBooking, NOW } from './helpers/readiness.mjs';
import { png, jpeg, webp, progressive, lossless, pngChunk, jpegSegment, riff, riffChunk,
  dirtyPng, dirtyJpeg, dirtyWebp, orientedJpeg } from './helpers/images.mjs';

function clean(bytes) { return app.stripMetadata(bytes, app.sniffImage(bytes)); }
function rejects(bytes) { assert.throws(() => clean(bytes), error => error.status === 422 && error.code === 'MALFORMED_IMAGE'); }

test('M10 regression: malformed later JPEG segment cannot return private original bytes', () => {
  rejects(Buffer.concat([Buffer.from([255,216]), jpegSegment(0xe1, 'Exif\0\0PrivateGPS'), Buffer.from([255,219,0,255,0])]));
});
test('M10 regression: JPEG magic alone is not an accepted image', () => rejects(Buffer.from([255,216,255])));
test('M10 regression: JPEG missing its end marker is rejected rather than closed', () => rejects(jpeg.subarray(0, -2)));
test('M10 regression: JPEG end marker without a frame and scan is rejected', () => rejects(Buffer.from([255,216,255,217])));
test('M10 regression: PNG signature alone is rejected rather than closed', () => rejects(png.subarray(0, 8)));
test('M10 regression: PNG missing image data is rejected', () => rejects(Buffer.concat([png.subarray(0,33), pngChunk('IEND', [])])));
test('M10 regression: PNG CRC corruption is rejected', () => { const b = Buffer.from(png); b[29] ^= 1; rejects(b); });
test('M10 regression: PNG truncated chunk cannot be rebuilt into an accepted file', () => rejects(png.subarray(0, png.length - 15)));
test('M10 regression: WebP declared length cannot exceed the supplied container', () => { const b=Buffer.from(webp); b.writeUInt32LE(b.length + 100,4); rejects(b); });
test('M10 regression: WebP metadata without an image is rejected', () => rejects(riff(riffChunk('EXIF', 'PrivateGPS'))));
test('M10 regression: WebP malformed later chunk cannot return the original metadata', () => {
  const b = riff(webp.subarray(12), riffChunk('EXIF','PrivateGPS'), Buffer.from('prVt\xff\xff\xff\x7f','latin1')); rejects(b);
});
test('M10 regression: oversized PNG dimensions are rejected', () => {
  const header=Buffer.from(png.subarray(16,29)); header.writeUInt32BE(9000,0);
  const b=Buffer.concat([png.subarray(0,8),pngChunk('IHDR',header),png.subarray(33)]);
  assert.throws(()=>clean(b),e=>e.status===422 && e.code==='IMAGE_DIMENSIONS_TOO_LARGE');
});
test('M10 regression: oversized JPEG dimensions are rejected', () => {
  const b=Buffer.from(jpeg), frame=b.indexOf(Buffer.from([255,192])); b.writeUInt16BE(9000,frame+7);
  assert.throws(()=>clean(b),e=>e.status===422 && e.code==='IMAGE_DIMENSIONS_TOO_LARGE');
});
test('M10 regression: oversized WebP canvas is rejected', () => {
  const b=Buffer.from(webp); b.writeUIntLE(8999,24,3);
  assert.throws(()=>clean(b),e=>e.status===422 && e.code==='IMAGE_DIMENSIONS_TOO_LARGE');
});
test('M10 regression: rejected malformed proof creates no object or database effects', async t => {
  const f=fixture(t); seedBooking(f.DB);
  const before=f.DB.one("SELECT * FROM bookings WHERE id='test_booking'");
  await assert.rejects(app.submitProof(f.env,await app.loadSettings(f.DB),f.player,'test_booking',
    new File([png.subarray(0,8)],'image.png'),{gcashRef:null,amount:null},NOW),e=>e.status===422 && e.code==='MALFORMED_IMAGE');
  assert.equal(f.objects.size,0); assert.equal(f.DB.count('payment_proofs'),0);
  assert.equal(f.DB.count('booking_events'),0); assert.equal(f.DB.count('outbox'),0);
  assert.deepEqual(f.DB.one("SELECT * FROM bookings WHERE id='test_booking'"),before);
});
test('M10 regression: rejected malformed QR creates no object or setting', async t => {
  const f=fixture(t), api=new Hono();
  const error=(e,c)=>c.json({code:e.code},e.status??500);
  api.onError(error); app.adminSettingsRoutes.onError(error);
  api.use('*',async(c,next)=>{c.set('user',f.admin);await next();}); api.route('/admin',app.adminSettingsRoutes);
  const body=new FormData();body.set('file',new File([png.subarray(0,8)],'qr.png'));
  const response=await api.fetch(new Request('http://localhost/admin/settings/gcash-qr',{method:'PUT',body}),f.env,f.c.executionCtx);
  assert.equal(response.status,422);assert.equal((await response.json()).code,'MALFORMED_IMAGE');
  assert.equal(f.objects.size,0);assert.equal(f.DB.count('settings',"key='gcash_qr_key'"),0);
});
test('M10 regression: orientation is preserved without retaining camera metadata', () => {
  const b=Buffer.from(clean(orientedJpeg()));
  assert.ok(b.includes(Buffer.from('Exif\0\0')));assert.equal(b.includes(Buffer.from('Cam')),false);
});
test('M10: valid static PNG drops private metadata and trailing bytes', () => {
  const result=Buffer.from(clean(dirtyPng()));
  for(const value of ['PrivateAuthor','PrivateManifest','PrivateUnknown','PrivateTrailer','Cam'])assert.equal(result.includes(Buffer.from(value)),false);
  assert.deepEqual(result,Buffer.from(clean(png)));
});
test('M10: valid JPEG keeps ICC and Adobe color data and removes private segments', () => {
  const result=Buffer.from(clean(dirtyJpeg()));
  for(const value of ['PrivateCamera','PrivateIPTC','PrivateXMP','PrivateComment','PrivateTrailer'])assert.equal(result.includes(Buffer.from(value)),false);
  assert.ok(result.includes(Buffer.from('KeepICC')));assert.ok(result.includes(Buffer.from('Adobe')));
  assert.deepEqual(result.subarray(-2),Buffer.from([255,217]));
});
test('M10: valid static WebP retains alpha and clears removed EXIF/XMP flags', () => {
  const result=Buffer.from(clean(dirtyWebp()));
  for(const value of ['PrivateXMP','PrivateManifest','PrivateUnknown','PrivateTrailer','Cam'])assert.equal(result.includes(Buffer.from(value)),false);
  assert.deepEqual(result,webp);
});
test('M10: baseline/progressive JPEG and lossless WebP remain accepted', () => {
  for(const bytes of [jpeg,progressive,lossless])assert.ok(clean(bytes).length>0);
});

test('M10: incomplete files at many internal offsets never return the original bytes', () => {
  for(const b of [jpeg,progressive,png,webp,lossless]) {
    for(let n=0;n<b.length-12;n+=Math.max(1,Math.floor(b.length/40))) assert.throws(()=>clean(b.subarray(0,n)),e=>e.status===422);
  }
});
test('M10: PNG ordering, duplicate headers, critical chunks and zlib header fail closed', () => {
  const start=png.subarray(0,33), tail=png.subarray(33);
  rejects(Buffer.concat([start,png.subarray(8,33),tail]));
  assert.throws(()=>clean(Buffer.concat([start,pngChunk('ABCD',[]),tail])),e=>e.code==='UNSUPPORTED_IMAGE_FORMAT');
  rejects(Buffer.concat([start,pngChunk('IDAT',[0,0,0,0,0,0]),pngChunk('IEND',[])]));
});
test('M10: animation and excessive pixel count are explicitly unsupported', () => {
  assert.throws(()=>clean(Buffer.concat([png.subarray(0,33),pngChunk('acTL',Buffer.alloc(8)),png.subarray(33)])),e=>e.code==='UNSUPPORTED_IMAGE_FORMAT');
  const animated=Buffer.from(webp);animated[20]|=2;
  assert.throws(()=>clean(animated),e=>e.code==='UNSUPPORTED_IMAGE_FORMAT');
  const header=Buffer.from(png.subarray(16,29));header.writeUInt32BE(5000,0);header.writeUInt32BE(4000,4);
  assert.throws(()=>clean(Buffer.concat([png.subarray(0,8),pngChunk('IHDR',header),png.subarray(33)])),e=>e.code==='IMAGE_DIMENSIONS_TOO_LARGE');
});
test('M10: WebP canvas/bitstream mismatch and incomplete RIFF padding are rejected', () => {
  const mismatch=Buffer.from(webp);mismatch[24]=1;rejects(mismatch);
  const b=riff(webp.subarray(12),riffChunk('prVt',[1]));b[b.length-1]=255;rejects(b);
});
