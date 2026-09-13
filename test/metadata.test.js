const test = require('node:test');
const assert = require('node:assert/strict');
const JsZip = require('jszip');
const {
  parseVolumeNumber, parseIndexSpec, formatIndexLabel,
} = require('../lib/config');
const { creatOpf } = require('../lib/epub');

// ── 卷号解析（系列序号来源）──

test('parseVolumeNumber 从卷名里取卷号', () => {
  assert.equal(parseVolumeNumber('第一卷'), 1);
  assert.equal(parseVolumeNumber('第十二卷'), 12);
  assert.equal(parseVolumeNumber('第三册 特典'), 3);
  assert.equal(parseVolumeNumber('第2卷'), 2);
  assert.equal(parseVolumeNumber('第二部'), 2);
});

test('parseVolumeNumber 对没有卷号的名字返回 null', () => {
  assert.equal(parseVolumeNumber('序'), null);
  assert.equal(parseVolumeNumber('后记'), null);
  assert.equal(parseVolumeNumber('外传'), null);
  assert.equal(parseVolumeNumber(''), null);
  assert.equal(parseVolumeNumber(undefined), null);
});

// ── 下标表达式（分卷与章节共用）──

test('parseIndexSpec 支持 all / 列表 / 区间并转成 0 基', () => {
  assert.equal(parseIndexSpec('all', 10), null);
  assert.equal(parseIndexSpec('*', 10), null);
  assert.deepEqual(parseIndexSpec('1', 10), [0]);
  assert.deepEqual(parseIndexSpec('1,3-5', 10), [0, 2, 3, 4]);
  assert.deepEqual(parseIndexSpec('5-3', 10), [2, 3, 4], '倒序区间视为同一范围');
});

test('parseIndexSpec 忽略越界项，全越界时报错', () => {
  assert.deepEqual(parseIndexSpec('2,99', 3), [1]);
  assert.throws(() => parseIndexSpec('99', 3), /没有匹配到任何条目/);
  assert.throws(() => parseIndexSpec('abc', 3), /无法识别/);
});

test('formatIndexLabel 把下标压成紧凑标签', () => {
  assert.equal(formatIndexLabel([0, 1, 2, 6]), '1-3,7');
  assert.equal(formatIndexLabel([4]), '5');
  assert.equal(formatIndexLabel([]), '');
});

// ── 系列元数据 ──

function makeJson(overrides = {}) {
  return {
    titles: '败北女角太多了！',
    authors: '雨森焚火',
    intro: '简介',
    content: { 0: { volume: '第一卷', chapters: {} } },
    imgs: {},
    _written: { 0: [] },
    ...overrides,
  };
}

test('EPUB3 写入 belongs-to-collection 系列信息', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson(), {
    uuid: 'urn:uuid:t',
    series: { name: '败北女角太多了！', index: 3 },
  });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.match(opf, /property="belongs-to-collection" id="series-id"/);
  assert.match(opf, /property="collection-type" refines="#series-id"/);
  assert.match(opf, /property="group-position" refines="#series-id"/);
  assert.match(opf, />\s*series\s*</);
  assert.match(opf, />\s*3\s*</);
});

test('EPUB2 改用 calibre:series 系列信息', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson(), {
    uuid: 'urn:uuid:t',
    epubVersion: 2,
    series: { name: '某系列', index: 2 },
  });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.match(opf, /name="calibre:series" content="某系列"/);
  assert.match(opf, /name="calibre:series_index" content="2"/);
  assert.doesNotMatch(opf, /belongs-to-collection/);
});

test('没有系列信息时不写任何系列元数据', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson(), { uuid: 'urn:uuid:t' });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.doesNotMatch(opf, /belongs-to-collection/);
  assert.doesNotMatch(opf, /calibre:series/);
});

test('写入 dc:date / dc:publisher / dc:subject，并保持书名原样', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson({ titles: '三体' }), {
    uuid: 'urn:uuid:t',
    pubDate: '2024-05-06',
    publisher: '重庆出版社',
    subjects: ['科幻', '悬疑'],
  });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.match(opf, /<dc:date>\s*2024-05-06\s*<\/dc:date>/);
  assert.match(opf, /<dc:publisher>\s*重庆出版社\s*<\/dc:publisher>/);
  assert.equal((opf.match(/<dc:subject>/g) || []).length, 2);
  assert.match(opf, /<dc:title>\s*三体\s*<\/dc:title>/);
  assert.doesNotMatch(opf, /3体/);
});

test('缺少可选元数据时不会写出空元素', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson({
    pubDate: null, publisher: null, subjects: [],
  }), { uuid: 'urn:uuid:t' });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.doesNotMatch(opf, /<dc:date>/);
  assert.doesNotMatch(opf, /<dc:publisher>/);
  assert.doesNotMatch(opf, /<dc:subject>/);
});
