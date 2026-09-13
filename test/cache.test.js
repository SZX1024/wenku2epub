const os = require('os');
const path = require('path');

// 必须在 require cache 之前指定，CACHE_ROOT 是模块加载时计算的
process.env.WENKU2EPUB_CACHE_DIR = path.join(os.tmpdir(), `wenku2epub-cache-test-${process.pid}`);

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../lib/cache');

after(() => cache.clear());

test('写入后可以命中，未写过的 key 不命中', () => {
  cache.configure({ enabled: true, refresh: false });
  cache.clear();

  const payload = Buffer.from('章节正文');
  assert.equal(cache.read('html', 'https://example.com/1.htm'), null);

  cache.write('html', 'https://example.com/1.htm', payload);
  const hit = cache.read('html', 'https://example.com/1.htm');
  assert.ok(hit);
  assert.equal(hit.toString(), '章节正文');
});

test('不同 kind 之间互不串味', () => {
  cache.configure({ enabled: true, refresh: false });
  cache.clear();

  cache.write('html', 'same-key', Buffer.from('html'));
  cache.write('img', 'same-key', Buffer.from('img'));

  assert.equal(cache.read('html', 'same-key').toString(), 'html');
  assert.equal(cache.read('img', 'same-key').toString(), 'img');
  assert.equal(cache.read('other', 'same-key'), null);
});

test('refresh 模式跳过已有缓存，但仍会写入新内容', () => {
  cache.configure({ enabled: true, refresh: false });
  cache.clear();
  cache.write('html', 'k', Buffer.from('old'));

  cache.configure({ refresh: true });
  assert.equal(cache.read('html', 'k'), null, 'refresh 模式不应命中旧缓存');

  cache.write('html', 'k', Buffer.from('new'));
  cache.configure({ refresh: false });
  assert.equal(cache.read('html', 'k').toString(), 'new');
});

test('关闭缓存后既不读也不写', () => {
  cache.configure({ enabled: true, refresh: false });
  cache.clear();
  cache.write('html', 'k', Buffer.from('v'));

  cache.configure({ enabled: false });
  assert.equal(cache.read('html', 'k'), null);
  cache.write('html', 'k2', Buffer.from('v2'));
  assert.equal(cache.size().files, 1, '关闭后不应新增文件');

  cache.configure({ enabled: true });
});

test('size 统计与 clear 清理', () => {
  cache.configure({ enabled: true, refresh: false });
  cache.clear();
  assert.deepEqual({ files: cache.size().files, bytes: cache.size().bytes }, { files: 0, bytes: 0 });

  cache.write('html', 'a', Buffer.alloc(100, 1));
  cache.write('img', 'b', Buffer.alloc(200, 2));

  const info = cache.size();
  assert.equal(info.files, 2);
  assert.ok(info.bytes >= 300);

  cache.clear();
  assert.equal(cache.size().files, 0);
});

test('命中与未命中会被计入统计', () => {
  cache.configure({ enabled: true, refresh: false });
  cache.clear();
  cache.resetStats();

  cache.read('html', 'missing');
  cache.write('html', 'present', Buffer.from('x'));
  cache.read('html', 'present');

  const stats = cache.getStats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.writes, 1);
  assert.equal(stats.hits, 1);
});

test('formatSize 输出可读单位', () => {
  assert.equal(cache.formatSize(512), '512 B');
  assert.equal(cache.formatSize(2048), '2.0 KB');
  assert.equal(cache.formatSize(5 * 1024 * 1024), '5.0 MB');
});
