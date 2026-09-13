const os = require('os');
const path = require('path');
const fs = require('fs');

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCacheStore, formatSize } = require('../lib/cache');

// 每个用例一个独立目录，互不干扰；也顺便验证缓存句柄是可并存的
let seq = 0;
function tempStore(options = {}) {
  const root = path.join(os.tmpdir(), `wenku2epub-cache-test-${process.pid}-${seq++}`);
  const store = createCacheStore({ root, ...options });
  return { store, root };
}

test('写入后可以命中，未写过的 key 不命中', () => {
  const { store, root } = tempStore();
  try {
    assert.equal(store.read('html', 'https://example.com/1.htm'), null);

    store.write('html', 'https://example.com/1.htm', Buffer.from('章节正文'));
    const hit = store.read('html', 'https://example.com/1.htm');
    assert.ok(hit);
    assert.equal(hit.toString(), '章节正文');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('不同 kind 之间互不串味', () => {
  const { store, root } = tempStore();
  try {
    store.write('html', 'same-key', Buffer.from('html'));
    store.write('img', 'same-key', Buffer.from('img'));

    assert.equal(store.read('html', 'same-key').toString(), 'html');
    assert.equal(store.read('img', 'same-key').toString(), 'img');
    assert.equal(store.read('other', 'same-key'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refresh 模式跳过已有缓存，但仍会写入新内容', () => {
  const { store, root } = tempStore();
  try {
    store.write('html', 'k', Buffer.from('old'));

    store.configure({ refresh: true });
    assert.equal(store.read('html', 'k'), null, 'refresh 模式不应命中旧缓存');

    store.write('html', 'k', Buffer.from('new'));
    store.configure({ refresh: false });
    assert.equal(store.read('html', 'k').toString(), 'new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('关闭缓存后既不读也不写', () => {
  const { store, root } = tempStore({ enabled: false });
  try {
    assert.equal(store.isEnabled(), false);
    store.write('html', 'k', Buffer.from('v'));
    assert.equal(store.read('html', 'k'), null);
    assert.equal(store.size().files, 0, '关闭后不应产生文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('size 统计与 clear 清理', () => {
  const { store, root } = tempStore();
  try {
    assert.deepEqual({ files: store.size().files, bytes: store.size().bytes }, { files: 0, bytes: 0 });

    store.write('html', 'a', Buffer.alloc(100, 1));
    store.write('img', 'b', Buffer.alloc(200, 2));

    const info = store.size();
    assert.equal(info.files, 2);
    assert.ok(info.bytes >= 300);

    store.clear();
    assert.equal(store.size().files, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('命中与未命中会被计入统计，且统计是每个句柄独立的', () => {
  const { store, root } = tempStore();
  try {
    store.read('html', 'missing');
    store.write('html', 'present', Buffer.from('x'));
    store.read('html', 'present');

    const stats = store.getStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.writes, 1);
    assert.equal(stats.hits, 1);

    store.resetStats();
    assert.deepEqual(store.getStats(), { hits: 0, misses: 0, writes: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('两个缓存句柄指向不同目录时互相看不见（并发任务隔离）', () => {
  const a = tempStore();
  const b = tempStore();
  try {
    a.store.write('html', 'k', Buffer.from('from-a'));
    assert.equal(a.store.read('html', 'k').toString(), 'from-a');
    assert.equal(b.store.read('html', 'k'), null, 'B 不应看到 A 的缓存');
    assert.equal(b.store.getStats().misses, 1);
    assert.equal(a.store.getStats().misses, 0);
  } finally {
    fs.rmSync(a.root, { recursive: true, force: true });
    fs.rmSync(b.root, { recursive: true, force: true });
  }
});

test('formatSize 输出可读单位', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});
