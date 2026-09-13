const axios = require('axios');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');
const { getRandomUserAgent } = require('./config');

const BASE_DELAY_MS = 500;
const JITTER_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 全局限速闸门 ──
// 所有请求（正文 + 插图）统一排队领取"发车时刻"，控制的是整体请求速率，
// 而不是"正文 sleep、图片不限速"——后者正是触发 429 的主要原因。
//
// 以前这里的闸门状态是模块级变量，一个进程只能有一套限速；
// 现在每个 RunContext 创建自己的 limiter，多个任务互不影响。
function createRateLimiter({ minIntervalMs = 0, jitterMs = JITTER_MS } = {}) {
  let gate = Promise.resolve();
  let nextSlotAt = 0;

  return {
    minIntervalMs,

    acquire() {
      if (minIntervalMs <= 0) return Promise.resolve();

      const wait = gate.then(async () => {
        const now = Date.now();
        const readyAt = Math.max(now, nextSlotAt + minIntervalMs + Math.floor(Math.random() * jitterMs));
        nextSlotAt = readyAt;
        if (readyAt > now) await sleep(readyAt - now);
      });

      // 闸门不能因为某次请求失败而断链
      gate = wait.then(() => undefined, () => undefined);
      return wait;
    },
  };
}

// 由「是否启用延迟」推出限速间隔；显式 rateLimitMs 优先
function rateLimitFor({ delay = true, rateLimitMs = null } = {}) {
  if (rateLimitMs !== null && rateLimitMs !== undefined) {
    const value = Number(rateLimitMs);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  return delay ? BASE_DELAY_MS : 0;
}

// ── 重试策略 ──
// 服务端给的 Retry-After 可能非常离谱，必须封顶，否则会长时间静默挂起
const MAX_RETRY_AFTER_MS = 60000;
const MAX_BACKOFF_MS = 30000;

// 429、5xx、以及没有 response 的网络层错误（超时/连接重置）都值得重试；
// 其余 4xx（404/403 等）重试没有意义，直接放弃。
function isRetryable(error) {
  const status = error.response?.status;
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

function describeError(error) {
  if (!error) return '未知错误';
  const status = error.response?.status;
  if (status === 429) return '被限流（429）';
  if (status !== undefined) return `HTTP ${status}`;
  return error.code || error.message;
}

function retryDelayMs(error, attempt) {
  const retryAfter = Number.parseInt(error.response?.headers?.['retry-after'], 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
  }
  // 指数退避：1s, 2s, 4s ...
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

function htmlHeaders() {
  return {
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
  };
}

function imageHeaders(referer = 'https://www.wenku8.net/') {
  return {
    'User-Agent': getRandomUserAgent(),
    'Referer': referer,
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
  };
}

// 站点页面是 GBK。单独抽出来是为了能被离线测试直接断言
// （否则这段编码假设只有联网跑一次才会被覆盖）。
function decodePage(buffer) {
  return iconv.decode(buffer, 'GBK');
}

// 一个 RunContext 对应一个网络客户端：缓存、限速、并发去重都封装在这里，
// 没有任何模块级可变状态。三个 load* 方法就是离线测试的注入点。
function createNetClient({ cache, limiter }) {
  // 同一 URL 的并发请求合并成一次，避免同一张插图被重复下载
  const inflight = new Map();

  async function fetchFresh(url, headers, maxRetries) {
    let lastError = null;
    let attempts = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      attempts++;
      try {
        await limiter.acquire();
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          headers,
          timeout: 15000
        });
        return Buffer.from(response.data);
      } catch (error) {
        lastError = error;
        const canRetry = isRetryable(error) && attempt < maxRetries - 1;
        if (!canRetry) break;

        const waitMs = retryDelayMs(error, attempt);
        console.warn(`\n请求 ${url} ${describeError(error)}，${(waitMs / 1000).toFixed(1)}s 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
        await sleep(waitMs);
      }
    }

    console.error(`\n请求 ${url} 失败（${describeError(lastError)}，已尝试 ${attempts} 次）`);
    return null;
  }

  // 统一入口：缓存 → 并发去重 → 限速 → 重试。
  // 成功返回 Buffer，失败返回 null（调用方据此决定是否登记产物）。
  async function requestBuffer(url, headers, { maxRetries = 3, cacheKind = null } = {}) {
    if (!cacheKind) return fetchFresh(url, headers, maxRetries);

    const cached = cache.read(cacheKind, url);
    if (cached) return cached;

    const key = `${cacheKind}:${url}`;
    const running = inflight.get(key);
    if (running) return running;

    const task = fetchFresh(url, headers, maxRetries)
      .then((data) => {
        if (data) cache.write(cacheKind, url, data);
        return data;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  async function loadHtml(url, { cacheKind = null } = {}) {
    const data = await requestBuffer(url, htmlHeaders(), { cacheKind });
    if (!data) return null;
    return cheerio.load(decodePage(data));
  }

  return {
    // 书籍主页与目录页永远不走缓存 —— 连载会有新增章节，必须每次重新拉取
    loadBookPage: (url) => loadHtml(url),
    // 章节正文可以缓存：内容发布后不再变化，重跑时只会真正下载新增/失败的章节
    loadChapterPage: (url) => loadHtml(url, { cacheKind: 'html' }),
    // 插图，返回 Buffer（失败返回 null）。命名/去重/压缩由调用方决定
    loadImage: (src) => requestBuffer(src, imageHeaders(new URL(src).origin + '/'), { cacheKind: 'img' }),

    requestBuffer,
    fetchFresh,
  };
}

module.exports = {
  BASE_DELAY_MS,
  rateLimitFor,
  createRateLimiter,
  createNetClient,
  decodePage,
  isRetryable,
  retryDelayMs,
  describeError,
};
