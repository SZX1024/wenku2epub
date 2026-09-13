const { default: pLimit } = require('p-limit');
const { createCacheStore, formatSize, DEFAULT_CACHE_ROOT } = require('./cache');
const { createRateLimiter, createNetClient, rateLimitFor } = require('./fetch');
const { DEFAULT_OUTPUT_DIR } = require('./config');

const MAX_CONCURRENCY = 8;

function clampConcurrency(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n)));
}

// 一次下载任务的全部可变配置。
//
// 以前这些东西是散落在各模块的模块级单例（config 的 outputDir、fetch 的限速、
// epub 的并发上限、cache 的开关），同一个进程里只能存在一套设置，无法并发跑
// 两个不同配置的任务。现在收拢成一个显式对象逐层传递。
//
// net 上的三个 load* 方法就是离线测试的注入点：传进来就能完全绕开网络。
function createRunContext({
  outDir = DEFAULT_OUTPUT_DIR,
  delay = true,
  rateLimitMs = null,
  chapterConcurrency = 1,
  imageConcurrency = 3,
  cache = {},
  net: netOverrides = null,
} = {}) {
  const cacheStore = createCacheStore(cache);
  const limiter = createRateLimiter({ minIntervalMs: rateLimitFor({ delay, rateLimitMs }) });

  const chapters = clampConcurrency(chapterConcurrency, 1);
  const images = clampConcurrency(imageConcurrency, 3);

  return {
    outDir,
    cache: cacheStore,
    limiter,
    net: {
      ...createNetClient({ cache: cacheStore, limiter }),
      ...(netOverrides || {}),
    },
    concurrency: { chapters, images },
    limits: {
      chapters: pLimit(chapters),
      images: pLimit(images),
    },
  };
}

module.exports = {
  createRunContext,
  clampConcurrency,
  formatSize,
  MAX_CONCURRENCY,
  DEFAULT_CACHE_ROOT,
};
