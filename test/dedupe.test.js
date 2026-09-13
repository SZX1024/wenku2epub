const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

// 必须在 require epub 之前打补丁：epub.js 在加载时就解构了 fetch 的导出
const fetchMod = require('../lib/fetch');

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

// a.jpg 与 a-copy.jpg 内容完全相同（不同 URL、不同文件名），用来触发内容级去重
const IMAGES = {
  'https://img.test/a.jpg': makeJpeg(600, 800, 1),
  'https://img.test/a-copy.jpg': makeJpeg(600, 800, 1),
  'https://img.test/b.jpg': makeJpeg(1200, 1600, 2),
};

const CHAPTER_HTML = `
  <div id="content">
    第一段
    <img src="https://img.test/a.jpg" />
    第二段
    <img src="https://img.test/a-copy.jpg" />
    第三段
    <img src="https://img.test/b.jpg" />
  </div>`;

// 用闭包读取的可变集合控制"哪些图片下载失败"。
// 注意：epub.js 在加载时就解构了 fetchImage，之后再替换模块导出是无效的，
// 所以失败注入必须走这个 stub 内部的可变状态。
let failingSrcs = new Set();

// 同理，章节 HTML 也要通过可变变量控制
let chapterHtml = CHAPTER_HTML;

fetchMod.askChapter = async () => cheerio.load(chapterHtml);
fetchMod.fetchImage = async (src) => (failingSrcs.has(src) ? null : IMAGES[src] || null);

const { creatEpub } = require('../lib/epub');

function makeJson() {
  return {
    titles: '测试书',
    authors: '作者',
    intro: '简介',
    content: {
      0: { volume: '第一卷', chapters: { 0: { title: '第一章', href: 'https://wenku.test/c.htm' } } },
    },
  };
}

async function build(options) {
  const json = makeJson();
  const book = await creatEpub(json, options);
  const names = Object.keys(book.files);
  return {
    json,
    book,
    imageFiles: names.filter(n => n.startsWith('OEBPS/Image/') && !n.endsWith('/') && !n.includes('cover')),
    chapterXhtml: await book.file('OEBPS/Text/0_0.xhtml').async('string'),
  };
}

test('内容相同的插图只保存一份，引用指向同一个文件', async () => {
  const { imageFiles, chapterXhtml } = await build({ dedupeImages: true });

  assert.equal(imageFiles.length, 2, `应当只保留 2 个不同的图片文件，实际：${imageFiles}`);

  const refs = [...chapterXhtml.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);
  assert.equal(refs.length, 3, '三个 <img> 标签都要保留');
  assert.equal(new Set(refs).size, 2, '其中两个应指向同一个文件');
  assert.equal(refs[0], refs[1], '重复的那张应当复用第一张的文件名');

  for (const ref of new Set(refs)) {
    assert.ok(imageFiles.includes(`OEBPS/Image/${ref}`), `引用指向了不存在的文件：${ref}`);
  }
});

test('关闭去重时三张图各存一份', async () => {
  const { imageFiles, chapterXhtml } = await build({ dedupeImages: false });

  assert.equal(imageFiles.length, 3);
  const refs = [...chapterXhtml.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(refs).size, 3);
});

test('记录每张插图的像素尺寸，供 best 封面对比', async () => {
  const { json } = await build({ dedupeImages: true });

  const entries = Object.values(json.imgInfo);
  assert.equal(entries.length, 2);
  for (const dims of entries) {
    assert.ok(dims && dims.width > 0 && dims.height > 0, `尺寸解析失败：${JSON.stringify(dims)}`);
  }
  const biggest = entries.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  assert.deepEqual(biggest, { width: 1200, height: 1600 }, '应当能识别出分辨率最高的那张');
});

test('图片下载失败时 <img> 标签被摘掉，且不登记进 manifest', async () => {
  failingSrcs = new Set(['https://img.test/b.jpg']);

  try {
    const { imageFiles, chapterXhtml, json } = await build({ dedupeImages: true });

    assert.equal(imageFiles.length, 1, '只剩 a.jpg 一份');
    const refs = [...chapterXhtml.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);
    assert.equal(refs.length, 2, '失败的 <img> 标签应当被移除');
    assert.equal(Object.keys(json.imgs).length, 1);
  } finally {
    failingSrcs = new Set();
  }
});

test('章节里没有插图时，不产生空的 OEBPS/Image 目录（epubcheck PKG-014）', async () => {
  chapterHtml = '<div id="content">只有文字，没有任何插图</div>';

  try {
    const book = await creatEpub(makeJson(), { dedupeImages: true });
    const files = book.files;
    const dirs = Object.entries(files).filter(([, f]) => f.dir).map(([name]) => name);
    const emptyDirs = dirs.filter(dir => !Object.keys(files).some(n => n.startsWith(dir) && n !== dir && !files[n].dir));

    assert.deepEqual(emptyDirs, [], `不应存在空目录条目：${emptyDirs}`);
    assert.ok(Object.keys(files).some(n => n.startsWith('OEBPS/Text/')), '章节文件仍应写入');
    const imageKeys = Object.keys(files).filter(n => n.startsWith('OEBPS/Image/'));
    assert.deepEqual(imageKeys, [], `不应有 Image 条目：${JSON.stringify(imageKeys)}`);
  } finally {
    chapterHtml = CHAPTER_HTML;
  }
});
