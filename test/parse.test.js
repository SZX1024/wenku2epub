const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { parseTitle, extractChapterContent } = require('../lib/parse');

test('parseTitle 解析标准站点标题', () => {
  const parsed = parseTitle('败北女角太多了！(败犬女主太多了！) - 雨森焚火 - 轻小说文库 - wenku8.net');
  assert.equal(parsed.titles, '败北女角太多了！(败犬女主太多了！)');
  assert.equal(parsed.authors, '雨森焚火');
});

test('parseTitle 在格式不符时回退，而不是返回 undefined', () => {
  const fewer = parseTitle('某本书 - 某作者');
  assert.equal(fewer.titles, '某本书');
  assert.equal(fewer.authors, '某作者');

  const single = parseTitle('孤零零的标题');
  assert.equal(single.titles, '孤零零的标题');
  assert.equal(single.authors, undefined);

  assert.deepEqual(parseTitle(''), { titles: undefined, authors: undefined });
});

test('extractChapterContent 保持段落与插图的原始先后顺序', () => {
  const $ = cheerio.load('<div id="content">第一段<img src="a.jpg"/>第二段<img src="b.jpg"/>第三段</div>');
  const items = extractChapterContent($, $('#content'));

  assert.deepEqual(items.map(i => i.type), ['text', 'img', 'text', 'img', 'text']);
  assert.deepEqual(
    items.filter(i => i.type === 'text').map(i => i.text),
    ['第一段', '第二段', '第三段']
  );
  assert.equal($(items[1].el).attr('src'), 'a.jpg');
  assert.equal($(items[3].el).attr('src'), 'b.jpg');
});

test('extractChapterContent 递归取到嵌套元素里的正文，避免整段丢失', () => {
  const $ = cheerio.load('<div id="content"><p>甲</p><p>乙</p><div><span>丙</span></div></div>');
  const items = extractChapterContent($, $('#content'));

  assert.deepEqual(items.map(i => i.type), ['text', 'text', 'text']);
  assert.deepEqual(items.map(i => i.text), ['甲', '乙', '丙']);
});

test('extractChapterContent 忽略 br/hr 与空白文本', () => {
  const $ = cheerio.load('<div id="content">甲<br/><br/>  <hr/>乙</div>');
  const items = extractChapterContent($, $('#content'));

  assert.deepEqual(items.map(i => i.type), ['text', 'text']);
  assert.deepEqual(items.map(i => i.text), ['甲', '乙']);
});
