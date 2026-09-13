const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { createRunContext } = require('../lib/runtime');
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

const IMAGES = {};
for (let i = 0; i < 8; i++) {
  IMAGES[`https://i.test/${i}.jpg`] = makeJpeg(600 + i, 800, i + 1);
}

// 第 0 章带标记，第 1 章是插图章（8 张图）
const CHAPTER_0 = '<div id="content">前文甲（插图006）后文乙</div>';
const CHAPTER_1 = `<div id="content">${Array.from({ length: 8 }, (_, i) => `<img src="https://i.test/${i}.jpg"/>`).join('')}</div>`;

let chapterHtml = { 'https://wenku.test/0.htm': CHAPTER_0, 'https://wenku.test/1.htm': CHAPTER_1 };
let failingSrcs = new Set();

function makeRun() {
  return createRunContext({
    cache: { enabled: false },
    net: {
      loadChapterPage: async (href) => cheerio.load(chapterHtml[href] ?? '<div id="content"></div>'),
      loadImage: async (src) => (failingSrcs.has(src) ? null : IMAGES[src] || null),
    },
  });
}

function makeJson(markerChapter = '前文甲（插图006）后文乙') {
  return {
    titles: '测试书',
    authors: '作者',
    intro: '简介',
    content: {
      0: {
        volume: '第一卷',
        chapters: {
          0: { title: '第1话', href: 'https://wenku.test/0.htm' },
          1: { title: '插图', href: 'https://wenku.test/1.htm' },
        },
      },
    },
    ...(markerChapter === null ? {} : {}),
  };
}

async function build(options = {}) {
  const json = makeJson();
  const book = await creatEpub(json, { run: makeRun(), dedupeImages: true, ...options });

  const text = {};
  for (const name of Object.keys(book.files)) {
    if (name.startsWith('OEBPS/Text/') && name.endsWith('.xhtml')) {
      text[name.split('/').pop()] = await book.file(name).async('string');
    }
  }
  const opf = await book.file('OEBPS/content.opf').async('string');
  return { json, book, text, opf, files: Object.keys(book.files) };
}

function refs(html) {
  return [...html.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);
}

test('有标记的卷：标记处插入对应图片，编号更小的图成为卷首彩插', async () => {
  const { json, text, files } = await build();

  // 第 1 章的 8 张图，物理顺序即 0_1_0 … 0_1_7
  const plan = json._slots[0][1];
  assert.equal(plan.length, 8);

  // 标记 006 → 卷内第 6 张
  const chapterRefs = refs(text['0_0.xhtml']);
  assert.deepEqual(chapterRefs, [plan[5]], '标记处应插入第 6 张图');

  // 编号 1~5 成为彩插
  assert.deepEqual(json._colorPages[0], plan.slice(0, 5));
  assert.ok(files.includes('OEBPS/Text/color_0.xhtml'));
  assert.deepEqual(refs(text['color_0.xhtml']), plan.slice(0, 5));

  // 插图章保持全部 8 张不变
  assert.deepEqual(refs(text['0_1.xhtml']), plan);
});

test('标记处的图片与插图章里的那一张是同一个文件（不重复存储）', async () => {
  const { text, files } = await build();

  const inline = refs(text['0_0.xhtml'])[0];
  const inGallery = refs(text['0_1.xhtml']);

  assert.ok(inGallery.includes(inline), '正文引用的就是插图章里的那份文件');
  const imageFiles = files.filter(n => n.startsWith('OEBPS/Image/') && !n.endsWith('/') && !n.includes('cover'));
  assert.equal(imageFiles.length, 8, '不应因为引用两次而多存一份');
});

test('彩插页排在卷首页之前，第一卷时紧跟封面', async () => {
  const { opf } = await build();
  const idrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);
  const colorAt = idrefs.indexOf('color-0');
  const volAt = idrefs.indexOf('vol-0');

  assert.ok(colorAt >= 0, '彩插页应进 spine');
  assert.ok(colorAt < volAt, '彩插页应排在卷首页之前');
  assert.equal(idrefs[0], 'color-0', '单卷时彩插页应是第一项（封面未提供）');
});

test('标记段落的原文被替换掉，且段落切分正确（前后文字都保留）', async () => {
  const { text } = await build();
  const $ = cheerio.load(text['0_0.xhtml'], { xmlMode: true });
  const paras = $('p').toArray().map(p => $(p).text());

  assert.ok(paras.includes('前文甲'), '标记前的文字应保留');
  assert.ok(paras.includes('后文乙'), '标记后的文字应保留');
  assert.ok(!paras.some(t => t.includes('插图006')), '标记文字应已被替换');
});

test('没有标记的卷完全不动：不出彩插页，正文里也不插图', async () => {
  chapterHtml = { ...chapterHtml, 'https://wenku.test/0.htm': '<div id="content">完全没有标记的正文</div>' };
  try {
    const { json, files, text } = await build();

    assert.deepEqual(json._colorPages, {}, '不应生成彩插');
    assert.ok(!files.includes('OEBPS/Text/color_0.xhtml'));
    assert.deepEqual(refs(text['0_0.xhtml']), [], '正文里不应有图');
    assert.equal(refs(text['0_1.xhtml']).length, 8, '插图章保持不变');
  } finally {
    chapterHtml = { ...chapterHtml, 'https://wenku.test/0.htm': CHAPTER_0 };
  }
});

test('关闭 illustrationAnchors 时行为回到改动前（标记就是普通文字）', async () => {
  const { json, files, text } = await build({ illustrationAnchors: false });

  assert.deepEqual(json._colorPages, {});
  assert.ok(!files.includes('OEBPS/Text/color_0.xhtml'));
  assert.deepEqual(refs(text['0_0.xhtml']), []);
  assert.ok(text['0_0.xhtml'].includes('（插图006）'), '标记应原样留在正文里');
});

test('编号超出本卷图片总数时保留原始标记文字，且不误判彩插', async () => {
  chapterHtml = { ...chapterHtml, 'https://wenku.test/0.htm': '<div id="content">正文（插图099）结束</div>' };
  try {
    const { text, json, files } = await build();
    assert.deepEqual(refs(text['0_0.xhtml']), []);
    assert.ok(text['0_0.xhtml'].includes('（插图099）'), '越界标记应原样保留');
    // 关键：越界标记不能把 1..98 全判成彩插
    assert.deepEqual(json._colorPages, {}, '无效标记不应产生彩插');
    assert.ok(!files.includes('OEBPS/Text/color_0.xhtml'));
  } finally {
    chapterHtml = { ...chapterHtml, 'https://wenku.test/0.htm': CHAPTER_0 };
  }
});

test('对应图片下载失败时保留原始标记文字，且不误判彩插', async () => {
  failingSrcs = new Set(['https://i.test/5.jpg']);   // 第 6 张
  try {
    const { text, json } = await build();
    assert.deepEqual(refs(text['0_0.xhtml']), []);
    assert.ok(text['0_0.xhtml'].includes('（插图006）'), '失败的标记应原样保留');
    assert.deepEqual(json._colorPages, {}, '唯一标记不可用时整卷不动');
  } finally {
    failingSrcs = new Set();
  }
});

test('下载失败不会让后面的序号错位（slots 与文档顺序对齐）', async () => {
  failingSrcs = new Set(['https://i.test/2.jpg']);   // 第 3 张失败
  try {
    const { json, text } = await build();
    const plan = json._slots[0][1];

    assert.equal(plan.length, 8, '槽位数应仍为 8');
    assert.equal(plan[2], null, '失败的位置记为 null');
    // 标记 6 指向第 6 张，不应因为第 3 张失败而指到第 5 张
    assert.deepEqual(refs(text['0_0.xhtml']), [plan[5]]);
    assert.equal(plan[5], '0_1_5.jpg');
    // 彩插取 1..5 中成功的那 4 张（第 3 张失败）
    assert.equal(json._colorPages[0].length, 4);
    assert.ok(!json._colorPages[0].includes(null));
  } finally {
    failingSrcs = new Set();
  }
});
