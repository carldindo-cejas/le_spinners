// Decoder verification of sanitized valid fixtures, using the actual browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app } from './helpers/readiness.mjs';
import { jpeg, progressive, png, webp, lossless, orientedJpeg, dirtyJpeg, dirtyPng, dirtyWebp,
  exifOrientation, pngChunk, riff, riffChunk } from './helpers/images.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extended=Buffer.alloc(10);extended[0]=8;extended[4]=2;extended[7]=1;
const orientedWebp=riff(riffChunk('VP8X',extended),lossless.subarray(12),riffChunk('EXIF',exifOrientation()));
const orientedPng=Buffer.concat([png.subarray(0,33),pngChunk('eXIf',exifOrientation()),png.subarray(33)]);
const fixtures=[['jpeg',jpeg],['progressive',progressive],['png',png],['webp',webp],['lossless',lossless],
  ['private-jpeg',dirtyJpeg()],['private-png',dirtyPng()],['private-webp',dirtyWebp()],['oriented-jpeg',orientedJpeg()],
  ['oriented-png',orientedPng],['oriented-webp',orientedWebp],['camera-jpeg',readFileSync(new URL('./fixtures/exif-sample.jpg',import.meta.url))]];
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined});
try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const [name,bytes] of fixtures) {
    const kind=app.sniffImage(bytes),clean=app.stripMetadata(bytes,kind);
    const result=await page.evaluate(async({before,after})=>{
      async function decode(src) {
        const image=new Image();image.src=src;await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
        let hash=2166136261, sum=0;
        for(const value of pixels){hash=Math.imul(hash^value,16777619)>>>0;sum=(sum+value)>>>0;}
        return {width:canvas.width,height:canvas.height,hash,sum};
      }
      return {before:await decode(before),after:await decode(after)};
    },{before:`data:${kind.type};base64,${Buffer.from(bytes).toString('base64')}`,after:`data:${kind.type};base64,${Buffer.from(clean).toString('base64')}`});
    assert.deepEqual(result.after,result.before,`${name}: sanitizer changed decoded orientation/color/pixels`);
    if(name==='oriented-jpeg')assert.deepEqual([result.after.width,result.after.height],[2,3]);
    console.log(`Browser image round-trip passed: ${name}`);
  }
  assert.deepEqual(errors,[]);
  console.log(`${fixtures.length} image decode/orientation/color round-trips passed.`);
} finally {await browser.close();}
