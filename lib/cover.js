const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { SUPPORTED_COVER_EXTS, getRandomUserAgent } = require('./config');

// 图片文件头特征
const MAGIC_SIGNATURES = [
  { ext: '.jpg', test: b => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: b => b.length > 7 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.gif', test: b => b.length > 3 && b.slice(0, 4).toString('ascii') === 'GIF8' },
  { ext: '.webp', test: b => b.length > 11 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { ext: '.bmp', test: b => b.length > 1 && b[0] === 0x42 && b[1] === 0x4d },
];

// 以文件头为准判断图片真实格式。
// 只信 URL 扩展名会出问题：自定义封面链接常常没有扩展名，
// 那样会被强行标成 .jpg，manifest 里的 media-type 就和真实字节对不上了。
function detectImageExt(buffer) {
  for (const { ext, test } of MAGIC_SIGNATURES) {
    try {
      if (test(buffer)) return ext;
    } catch {
      // 数据太短，忽略这条特征
    }
  }
  return null;
}

function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return SUPPORTED_COVER_EXTS.includes(ext) ? ext : null;
  } catch {
    return null;
  }
}

async function downloadCover(coverUrl) {
  try {
    const response = await axios.get(coverUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Referer': 'https://www.wenku8.net/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      },
      timeout: 15000
    });
    const data = Buffer.from(response.data);
    const ext = detectImageExt(data) || extFromUrl(coverUrl) || '.jpg';
    return { data, ext };
  } catch (err) {
    console.warn(`封面下载失败: ${err.message}`);
    return null;
  }
}

function readCoverFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`封面文件不存在: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_COVER_EXTS.includes(ext)) {
    console.warn(`不支持的封面格式: ${ext}，支持: ${SUPPORTED_COVER_EXTS.join(', ')}`);
    return null;
  }

  const data = fs.readFileSync(filePath);
  // 以真实字节为准，避免"把 png 改名成 jpg"导致 manifest 的 media-type 与内容不符
  return { data, ext: detectImageExt(data) || ext };
}

// ── 图片尺寸 ──
// 用于从章节插图里挑出分辨率最高的一张当封面：站点自带的封面只是 209x300 缩略图，
// 而书内插图往往有 2000px 级别，像素量差几十倍。

function jpegDimensions(buffer) {
  let i = 2;
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xff) { i++; continue; }
    const marker = buffer[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const size = buffer.readUInt16BE(i + 2);
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + size;
  }
  return null;
}

function webpDimensions(buffer) {
  const format = buffer.slice(12, 16).toString('ascii');

  if (format === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
      height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
    };
  }
  if (format === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// 解析图片像素尺寸；无法识别时返回 null（调用方按"未知"处理，不应因此报错）
function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;

  try {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegDimensions(buffer);
    if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.slice(0, 4).toString('ascii') === 'GIF8') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      return webpDimensions(buffer);
    }
  } catch {
    // 头部损坏就当未知
  }
  return null;
}

function pixelCount(dimensions) {
  return dimensions ? dimensions.width * dimensions.height : 0;
}

module.exports = { downloadCover, readCoverFromFile, detectImageExt, imageDimensions, pixelCount };
