const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { SUPPORTED_COVER_EXTS, getRandomUserAgent } = require('./config');

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
    const ext = path.extname(new URL(coverUrl).pathname).toLowerCase();
    const validExt = SUPPORTED_COVER_EXTS.includes(ext) ? ext : '.jpg';
    return { data: Buffer.from(response.data), ext: validExt };
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
  return { data: fs.readFileSync(filePath), ext };
}

module.exports = { downloadCover, readCoverFromFile };
