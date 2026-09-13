const test = require('node:test');
const assert = require('node:assert/strict');
const { imageDimensions, pixelCount, detectImageExt } = require('../lib/cover');

// 构造最小可解析的图片头
function pngHeader(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegHeader(width, height) {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.alloc(9),
  ]);
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

function gifHeader(width, height) {
  const buf = Buffer.alloc(16);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function webpVp8x(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

test('imageDimensions 解析各格式尺寸', () => {
  assert.deepEqual(imageDimensions(pngHeader(2196, 1600)), { width: 2196, height: 1600 });
  assert.deepEqual(imageDimensions(jpegHeader(1120, 1600)), { width: 1120, height: 1600 });
  assert.deepEqual(imageDimensions(gifHeader(209, 300)), { width: 209, height: 300 });
  assert.deepEqual(imageDimensions(webpVp8x(800, 600)), { width: 800, height: 600 });
});

test('imageDimensions 对无法识别的数据返回 null 而不是抛错', () => {
  assert.equal(imageDimensions(Buffer.alloc(0)), null);
  assert.equal(imageDimensions(Buffer.from('not an image at all')), null);
  assert.equal(imageDimensions(Buffer.alloc(64, 7)), null);
  assert.equal(imageDimensions(null), null);
});

test('pixelCount 用于比较封面清晰度', () => {
  // 站点封面缩略图 209x300 vs 书内插图 2196x1600
  const siteCover = pixelCount({ width: 209, height: 300 });
  const illustration = pixelCount(imageDimensions(pngHeader(2196, 1600)));
  assert.ok(illustration > siteCover * 50, '插图像素量应当远大于站点缩略图');
  assert.equal(pixelCount(null), 0);
});

test('detectImageExt 以文件头为准', () => {
  assert.equal(detectImageExt(pngHeader(10, 10)), '.png');
  assert.equal(detectImageExt(jpegHeader(10, 10)), '.jpg');
  assert.equal(detectImageExt(gifHeader(10, 10)), '.gif');
  assert.equal(detectImageExt(webpVp8x(10, 10)), '.webp');
  assert.equal(detectImageExt(Buffer.from('xxxx')), null);
});
