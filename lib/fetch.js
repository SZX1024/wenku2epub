const axios = require('axios');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');
const { getRandomUserAgent } = require('./config');

let delayOrNot = false;

function setDelayMode(enabled) {
  delayOrNot = enabled;
}

async function delay() {
  const baseDelay = 500;
  const randomDelay = Math.floor(Math.random() * 500);
  const totalDelay = baseDelay + randomDelay;
  return new Promise(resolve => setTimeout(resolve, totalDelay));
}

async function fetchWithRetry(url, maxRetries = 3) {
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      if (delayOrNot) await delay();
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
          'Connection': 'keep-alive',
          'Referer': 'https://www.wenku8.net/',
          'DNT': '1',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1'
        },
        timeout: 15000
      });

      const decodedData = iconv.decode(Buffer.from(response.data), 'GBK');
      return cheerio.load(decodedData);
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after']) || 5;
        console.warn(`\n请求 ${url} 被限流（429），将在 ${retryAfter} 秒后重试（第 ${retry+1}/${maxRetries} 次）`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        console.error(`\n请求 ${url} 失败（非429）：`, error.message);
        break;
      }
    }
  }
  console.error(`\n请求 ${url} 重试 ${maxRetries} 次后仍失败`);
  return null;
}

async function ask(url) {
  return fetchWithRetry(url);
}

async function getImgWithRetry(src, volume, chapter, j, book, maxRetries = 3) {
  const imgname = `${volume}_${chapter}_${j}.jpg`;
  const imgpath = `OEBPS/Image/${imgname}`;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const response = await axios.get(src, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Referer': 'https://www.wenku8.net/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
        },
        timeout: 15000
      });
      book.file(imgpath, response.data);
      return;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after']) || 5;
        console.warn(`\n图片 ${src} 被限流（429），将在 ${retryAfter} 秒后重试（第 ${retry+1}/${maxRetries} 次）`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        console.error(`\n图片 ${src} 下载失败（非429）：`, error.message);
        break;
      }
    }
  }
  console.error(`\n图片 ${src} 重试 ${maxRetries} 次后仍失败`);
}

async function downloadImageToFs(src, filepath, maxRetries = 3) {
  const fs = require('fs');
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const response = await axios.get(src, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Referer': new URL(src).origin + '/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
        },
        timeout: 15000
      });
      fs.writeFileSync(filepath, Buffer.from(response.data));
      return;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after']) || 5;
        console.warn(`\n图片 ${src} 被限流（429），将在 ${retryAfter} 秒后重试（第 ${retry+1}/${maxRetries} 次）`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        console.error(`\n图片 ${src} 下载失败（非429）：`, error.message);
        break;
      }
    }
  }
  console.error(`\n图片 ${src} 重试 ${maxRetries} 次后仍失败`);
}

module.exports = { setDelayMode, fetchWithRetry, ask, getImgWithRetry, downloadImageToFs };
