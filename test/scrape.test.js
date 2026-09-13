const fs = require('fs');
const path = require('path');

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const { createRunContext } = require('../lib/runtime');
const { decodePage } = require('../lib/fetch');
const { getBookInfo, getChapList, extractChapterContent } = require('../lib/parse');

const FIXTURES = path.join(__dirname, 'fixtures');
const BOOK_URL = 'https://www.wenku8.net/book/3057.htm';
const INDEX_URL = 'https://www.wenku8.net/novel/3/3057/index.htm';

// 样本里记录的期望值。重新抓取后如果这些对不上，说明抓的不是同一本书，
// 或者站点结构变了 —— 两种情况都应该让测试红掉并人工确认。
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capture.json'), 'utf-8'));

const loadFixture = (name) => cheerio.load(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));

// 完全离线的 RunContext：只从磁盘读样本，不碰网络
function offlineRun() {
  return createRunContext({
    cache: { enabled: false },
    net: {
      loadBookPage: async (url) => loadFixture(/\/novel\//.test(url) ? 'chapter-index.html' : 'book-page.html'),
      loadChapterPage: async (url) => loadFixture(/125425/.test(url) ? 'chapter-images.html' : 'chapter-text.html'),
    },
  });
}

// ── 页面编码 ──

test('decodePage 按 GBK 解码站点页面', () => {
  // "轻小说文库" 的 GBK 字节；用 UTF-8 解会是乱码
  const gbkBytes = Buffer.from([0xc7, 0xe1, 0xd0, 0xa1, 0xcb, 0xb5, 0xce, 0xc4, 0xbf, 0xe2]);
  assert.equal(decodePage(gbkBytes), '轻小说文库');
  assert.notEqual(gbkBytes.toString('utf8'), '轻小说文库', 'UTF-8 解应当得到不同结果，否则这个测试没有意义');

  // 往返一致性
  assert.equal(decodePage(iconv.encode('败北女角太多了', 'GBK')), '败北女角太多了');
});

// ── 书籍主页解析 ──

test('getBookInfo 从真实页面样本解析出全部元数据', async () => {
  const json = {};
  await getBookInfo(BOOK_URL, json, offlineRun());

  assert.equal(json.titles, expected.titles);
  assert.equal(json.authors, expected.authors);
  assert.equal(json.publisher, expected.publisher);
  assert.equal(json.pubDate, expected.pubDate);
  assert.equal(json.status, '连载中');
  assert.deepEqual(json.subjects, expected.subjects);

  assert.ok(json.intro && json.intro.length > 20, '简介不应为空');
  assert.ok(json.intro.startsWith('平常担任班上背景人物的我'), `简介开头不符：${json.intro.slice(0, 20)}`);
});

test('getBookInfo 由书号推出封面 URL', async () => {
  const json = {};
  await getBookInfo(BOOK_URL, json, offlineRun());
  assert.equal(json.coverUrl, 'https://img.wenku8.com/image/3/3057/3057s.jpg');
});

test('getBookInfo 的 URL 里没有书号时回退到页面 DOM 找封面', async () => {
  const json = {};
  await getBookInfo('https://www.wenku8.net/book/unknown', json, offlineRun());

  // 回归：封面图在 #content 的第 3 个 table 里，曾经写死 eq(1) 导致这条路径永远失效
  assert.equal(json.coverUrl, 'http://img.wenku8.com/image/3/3057/3057s.jpg');
});

// ── 目录页解析 ──

test('getChapList 解析出完整的卷/章结构', async () => {
  const json = { content: {} };
  await getChapList(INDEX_URL, json, offlineRun());

  assert.equal(Object.keys(json.content).length, expected.volumes);

  let chapters = 0;
  for (const v in json.content) chapters += Object.keys(json.content[v].chapters).length;
  assert.equal(chapters, expected.chapters);
});

test('目录解析出的卷名与章节标题保持原文', async () => {
  const json = { content: {} };
  await getChapList(INDEX_URL, json, offlineRun());

  // 注意：这本的卷序不是「第 1..11 卷」——中间夹着短篇集与 8.5 卷，所以整表锁定
  const volumeNames = Object.keys(json.content).map(v => json.content[v].volume);
  assert.deepEqual(volumeNames, [
    '第一卷', '第二卷', '第三卷', '第四卷', '第五卷', '第六卷',
    '第七卷', 'SSS短篇集', '第八卷', '第8.5卷', '第九卷',
  ]);

  assert.equal(json.content[0].chapters[0].title, '序');
  assert.equal(json.content[0].chapters[1].title, expected.textChapter.title);
});

test('目录解析出的章节 href 是绝对地址，且目录页基址正确处理', async () => {
  const json = { content: {} };
  await getChapList(INDEX_URL, json, offlineRun());

  const first = json.content[0].chapters[1];
  assert.equal(first.href, expected.textChapter.href);
  assert.ok(first.href.startsWith('https://www.wenku8.net/novel/3/3057/'), `href 基址不对：${first.href}`);

  const all = Object.values(json.content).flatMap(v => Object.values(v.chapters));
  assert.ok(all.every(c => /^https?:\/\//.test(c.href)), '所有 href 都应为绝对地址');
});

test('目录页 URL 不以 index.htm 结尾时不会崩，基址退化为所在目录', async () => {
  const json = { content: {} };
  await getChapList('https://www.wenku8.net/novel/3/3057/', json, offlineRun());
  assert.ok(json.content[0].chapters[1].href.startsWith('https://www.wenku8.net/novel/3/3057/'));
});

test('目录里没有 vcss 卷行时会退化成单卷「正文」，不会抛异常', async () => {
  const html = `<table><tr><td class="ccss"><a href="1.htm">第一章</a></td></tr>
                        <tr><td class="ccss"><a href="2.htm">第二章</a></td></tr></table>`;
  const run = createRunContext({ cache: { enabled: false }, net: { loadBookPage: async () => cheerio.load(html) } });

  const json = { content: {} };
  await getChapList(INDEX_URL, json, run);

  assert.equal(Object.keys(json.content).length, 1);
  assert.equal(json.content[0].volume, '正文');
  assert.equal(Object.keys(json.content[0].chapters).length, 2);
});

// ── 章节正文 ──

test('正文页面能取到 #content 里的文本段落', async () => {
  const $ = loadFixture('chapter-text.html');
  const content = $('#content');
  assert.equal(content.length, 1, '站点结构变了：找不到 #content');

  const items = extractChapterContent($, content);
  const texts = items.filter(i => i.type === 'text');
  assert.ok(texts.length > 0, '应当解析出文本段落');
  assert.ok(texts[0].text.length > 0);

  // 样本把正文截断过，所以节点数有上限；这是样本裁剪的预期，不是解析问题
  assert.ok(texts.length <= 15, `样本裁剪后不应超过 15 段，实际 ${texts.length}`);
});

test('插图页面的图片按文档顺序取出，src 可解析为绝对地址', async () => {
  const $ = loadFixture('chapter-images.html');
  const content = $('#content');
  assert.equal(content.length, 1);

  const items = extractChapterContent($, content);
  const images = items.filter(i => i.type === 'img');
  assert.ok(images.length > 0, '插图章节应当解析出图片');

  const chapterUrl = expected.illustrationChapter.href;
  for (const img of images) {
    const src = $(img.el).attr('src');
    assert.ok(src, '图片应有 src');
    const abs = new URL(src, chapterUrl).href;
    // 插图托管在 CDN（pic.777743.xyz）上，与封面域名不同
    assert.match(abs, /^https:\/\/pic\.777743\.xyz\/3\/3057\/125425\//, `图片地址异常：${abs}`);
  }

  // 插图之间不应夹杂空文本节点造成的噪声
  assert.ok(items.every(i => i.type === 'img' || i.text.trim().length > 0));
});

test('章节页面缺少 #content 时返回空数组而不是抛异常', () => {
  const $ = cheerio.load('<html><body><div id="other">x</div></body></html>');
  assert.deepEqual(extractChapterContent($, $('#content')), []);
});

// ── 端到端（离线）──

test('离线跑通「书页 → 目录 → 章节结构」，全部来自样本', async () => {
  const json = {};
  const run = offlineRun();

  await getBookInfo(BOOK_URL, json, run);

  assert.equal(json.titles, expected.titles);
  assert.equal(Object.keys(json.content).length, expected.volumes);
  assert.equal(json.content[0].chapters[1].href, expected.textChapter.href);
  assert.equal(json.content[0].chapters[0].title, '序');
});
