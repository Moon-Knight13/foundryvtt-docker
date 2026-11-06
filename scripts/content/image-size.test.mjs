import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageSize, imageSizeFromBuffer } from './image-size.mjs';

// Minimal valid PNG: 1×1 pixel, RGBA, one IDAT chunk, IEND.
function minimalPng(width, height) {
  const buf = Buffer.alloc(33);
  // Signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR chunk length (13 bytes)
  buf.writeUInt32BE(13, 8);
  // IHDR tag
  buf.write('IHDR', 12, 'ascii');
  // Width and height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // Bit depth, color type, compression, filter, interlace
  buf[24] = 8;
  buf[25] = 6;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  // CRC (not validated by our reader, but fill the space)
  buf.writeUInt32BE(0, 29);
  return buf;
}

test('imageSizeFromBuffer reads PNG dimensions', () => {
  const dim = imageSizeFromBuffer(minimalPng(2621, 1904));
  assert.deepEqual(dim, { width: 2621, height: 1904 });
});

test('imageSizeFromBuffer reads a 1×1 PNG', () => {
  assert.deepEqual(imageSizeFromBuffer(minimalPng(1, 1)), { width: 1, height: 1 });
});

test('imageSizeFromBuffer returns null for too-short buffer', () => {
  assert.equal(imageSizeFromBuffer(Buffer.alloc(10)), null);
});

test('imageSizeFromBuffer returns null for unknown format', () => {
  assert.equal(imageSizeFromBuffer(Buffer.from('not an image')), null);
});

// Minimal lossy WebP header.
function minimalWebPLossy(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // VP8 bitstream: 3-byte frame tag + sync code (0x9d 0x01 0x2a)
  buf[20] = 0x00;
  buf[21] = 0x00;
  buf[22] = 0x00;
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

test('imageSizeFromBuffer reads lossy WebP dimensions', () => {
  assert.deepEqual(imageSizeFromBuffer(minimalWebPLossy(800, 600)), { width: 800, height: 600 });
});

// Minimal lossless WebP header.
function minimalWebPLossless(width, height) {
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(17, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(5, 16);
  buf[20] = 0x2f; // signature byte
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(bits, 21);
  return buf;
}

test('imageSizeFromBuffer reads lossless WebP dimensions', () => {
  assert.deepEqual(imageSizeFromBuffer(minimalWebPLossless(1024, 768)), {
    width: 1024,
    height: 768,
  });
});

// Minimal extended WebP header.
function minimalWebPExtended(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0; // flags
  buf[21] = 0;
  buf[22] = 0;
  buf[23] = 0;
  const w = width - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  const h = height - 1;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

test('imageSizeFromBuffer reads extended WebP dimensions', () => {
  assert.deepEqual(imageSizeFromBuffer(minimalWebPExtended(3840, 2160)), {
    width: 3840,
    height: 2160,
  });
});

// Minimal JPEG with a SOF0 marker.
function minimalJpeg(width, height) {
  const buf = Buffer.alloc(20);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4); // segment length
  buf[6] = 8; // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

test('imageSizeFromBuffer reads JPEG dimensions', () => {
  assert.deepEqual(imageSizeFromBuffer(minimalJpeg(1920, 1080)), { width: 1920, height: 1080 });
});

test('imageSize reads a PNG file on disk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'img-size-'));
  const file = path.join(dir, 'test.png');
  await writeFile(file, minimalPng(640, 480));
  assert.deepEqual(await imageSize(file), { width: 640, height: 480 });
});
