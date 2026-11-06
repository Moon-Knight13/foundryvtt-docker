// Read the pixel dimensions of a raster image from its file header.
//
// Zero dependencies — PNG, WebP and JPEG carry their size in the first few
// hundred bytes, so a 26-byte read covers PNG and most WebP, and a short scan
// covers JPEG. Only the formats the vault actually stores scene backgrounds
// in need support; SVG sizing lives in svg-size.mjs.
import { open } from 'node:fs/promises';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buf) {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readWebP(buf) {
  if (buf.length < 20) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && buf.length >= 30) {
    // Lossy: width/height at bytes 26-29 as little-endian 16-bit.
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    // Lossless: signature byte 0x2f, then 14-bit width and height packed into
    // 4 bytes starting at offset 21.
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X' && buf.length >= 30) {
    // Extended: 24-bit width at 24, 24-bit height at 27.
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

function readJpeg(buf) {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    // SOFn markers (0xC0–0xCF except 0xC4 DHT, 0xC8 JPG, 0xCC DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
    }
    const segLen = buf.readUInt16BE(offset + 2);
    offset += 2 + segLen;
  }
  return null;
}

/**
 * Read the pixel dimensions of a PNG, WebP or JPEG file.
 * Returns `{ width, height }` or `null` when the format is unrecognised.
 */
export async function imageSize(filePath) {
  const fh = await open(filePath, 'r');
  try {
    // 512 bytes is enough for PNG (24), WebP (30), and the vast majority of
    // JPEGs (SOF usually sits within the first few hundred bytes).
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    const data = buf.subarray(0, bytesRead);
    return readPng(data) ?? readWebP(data) ?? readJpeg(data) ?? null;
  } finally {
    await fh.close();
  }
}

/**
 * Synchronous parse from a buffer already in memory.
 * Useful in tests where no file exists.
 */
export function imageSizeFromBuffer(buf) {
  return readPng(buf) ?? readWebP(buf) ?? readJpeg(buf) ?? null;
}
