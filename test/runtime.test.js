const os = require('os');
const path = require('path');
const fs = require('fs');

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { createRunContext, clampConcurrency, MAX_CONCURRENCY } = require('../lib/runtime');
const { createRateLimiter, rateLimitFor, BASE_DELAY_MS } = require('../lib/fetch');
const { creatEpub } = require('../lib/epub');

function makeJpeg(width, height, payload) {
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
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), app0, sof0,
    Buffer.from([payload, payload, payload]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const IMAGE_X = makeJpeg(600, 800, 7);
const IMAGE_Y = makeJpeg(600, 800, 7);   // 与 X 内容完全一致
const IMAGE_Z = makeJpeg(1200, 1600, 9);

const HTML = `
  <div id="content">甲<img src="https://i.test/x.jpg"/>乙<img src="https://i.test/y.jpg"/>丙<img src="https://i.test/z.jpg"/></div>`;

function stubNet() {
  return {
    loadChapterPage: async () => cheerio.load(HTML),
    loadImage: async (src) => ({
      'https://i.test/x.jpg': IMAGE_X,
      'https://i.test/y.jpg': IMAGE_Y,
      'https://i.test/z.jpg': IMAGE_Z,
    }[src] ?? null),
  };
}

function makeJson() {
  return {
    titles: '并发测试',
    authors: '作者',
    intro: '简介',
    content: { 0: { volume: '第一卷', chapters: { 0: { title: '第一章', href: 'https://wenku.test/c.htm' } } } },
  };
}

// ── 上下文隔离 ──

test('每个 RunContext 持有独立的缓存/限速/并发句柄', () => {
  const a = createRunContext({ outDir: 'out-a' });
  const b = createRunContext({ outDir: 'out-b' });

  assert.equal(a.outDir, 'out-a');
  assert.equal(b.outDir, 'out-b');

  assert.notEqual(a.cache, b.cache);
  assert.notEqual(a.limiter, b.limiter);
  assert.notEqual(a.limits.chapters, b.limits.chapters);
  assert.notEqual(a.limits.images, b.limits.images);
});

test('缓存开关是按上下文生效的，不会互相污染', () => {
  const root = path.join(os.tmpdir(), `wenku2epub-ctx-${process.pid}`);
  try {
    const withCache = createRunContext({ cache: { enabled: true, root } });
    const withoutCache = createRunContext({ cache: { enabled: false, root } });

    withCache.cache.write('html', 'k', Buffer.from('v'));
    assert.equal(withCache.cache.read('html', 'k').toString(), 'v');
    assert.equal(withoutCache.cache.read('html', 'k'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 限速配置推导 ──

test('rateLimitFor：延迟开关与显式 rate 的优先级', () => {
  assert.equal(rateLimitFor({ delay: true }), BASE_DELAY_MS);
  assert.equal(rateLimitFor({ delay: false }), 0);
  assert.equal(rateLimitFor({ delay: false, rateLimitMs: 300 }), 300, '显式 rate 覆盖 delay=false');
  assert.equal(rateLimitFor({ delay: true, rateLimitMs: 0 }), 0, 'rate=0 表示显式关闭');
  assert.equal(rateLimitFor({ delay: true, rateLimitMs: 'abc' }), 0, '非法值按关闭处理');
});

test('限速器只约束自己所属的上下文', async () => {
  const limited = createRateLimiter({ minIntervalMs: 60, jitterMs: 0 });
  const free = createRateLimiter({ minIntervalMs: 0 });

  const start = Date.now();
  await Promise.all([limited.acquire(), limited.acquire(), limited.acquire()]);
  const limitedMs = Date.now() - start;
  assert.ok(limitedMs >= 100, `受限闸门应当串行排队（实际 ${limitedMs}ms）`);

  const freeStart = Date.now();
  await Promise.all([free.acquire(), free.acquire(), free.acquire()]);
  assert.ok(Date.now() - freeStart < 30, '不限速的闸门不应产生等待');
});

test('clampConcurrency 把并发限制在 1..MAX 之间', () => {
  assert.equal(clampConcurrency(0, 3), 1);
  assert.equal(clampConcurrency(-5, 3), 1);
  assert.equal(clampConcurrency(4, 1), 4);
  assert.equal(clampConcurrency(999, 1), MAX_CONCURRENCY);
  assert.equal(clampConcurrency('abc', 3), 3);
  assert.equal(clampConcurrency(2.7, 1), 2);
});

// ── 真正的并发隔离：两个不同配置的任务同时跑 ──

test('两个不同配置的任务并发执行时互不干扰', async () => {
  const outA = path.join(os.tmpdir(), `wenku2epub-jobA-${process.pid}`);
  const outB = path.join(os.tmpdir(), `wenku2epub-jobB-${process.pid}`);

  const runA = createRunContext({
    outDir: outA,
    delay: false,
    chapterConcurrency: 3,
    cache: { enabled: false },
    net: stubNet(),
  });
  const runB = createRunContext({
    outDir: outB,
    delay: true,
    rateLimitMs: 1,
    chapterConcurrency: 1,
    cache: { enabled: false },
    net: stubNet(),
  });

  try {
    const jsonA = makeJson();
    const jsonB = makeJson();

    // 关键：两个任务同时在飞，配置不同
    const [bookA, bookB] = await Promise.all([
      creatEpub(jsonA, { run: runA, dedupeImages: true }),
      creatEpub(jsonB, { run: runB, dedupeImages: false }),
    ]);

    const imagesA = Object.keys(bookA.files).filter(n => n.startsWith('OEBPS/Image/') && !n.endsWith('/') && !n.includes('cover'));
    const imagesB = Object.keys(bookB.files).filter(n => n.startsWith('OEBPS/Image/') && !n.endsWith('/') && !n.includes('cover'));

    assert.equal(imagesA.length, 2, 'A 开了去重：x 与 y 相同，应只剩 2 份');
    assert.equal(imagesB.length, 3, 'B 关了去重：三张各存一份');

    // 各自的产物互不掺和
    assert.equal(runA.outDir, outA);
    assert.equal(runB.outDir, outB);
    assert.equal(runA.concurrency.chapters, 3);
    assert.equal(runB.concurrency.chapters, 1);

    const xhtmlA = await bookA.file('OEBPS/Text/0_0.xhtml').async('string');
    const refsA = [...xhtmlA.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(refsA).size, 2, 'A 的引用应当被去重');

    const xhtmlB = await bookB.file('OEBPS/Text/0_0.xhtml').async('string');
    const refsB = [...xhtmlB.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(refsB).size, 3, 'B 的引用不应被去重');
  } finally {
    fs.rmSync(outA, { recursive: true, force: true });
    fs.rmSync(outB, { recursive: true, force: true });
  }
});
