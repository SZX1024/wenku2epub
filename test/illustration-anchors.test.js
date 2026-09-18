const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { createRunContext } = require('../lib/runtime');
const { creatEpub } = require('../lib/epub');
const { splitIllustrationMarkers, isWatermarkText, extractChapterContent } = require('../lib/parse');

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

function makeImages(count, prefix) {
  const map = {};
  for (let i = 0; i < count; i++) map[`https://i.test/${prefix}/${i}.jpg`] = makeJpeg(600 + i, 800, i + 1);
  return map;
}

let world = null;

function setup({ galleryCount = 8, markerText = '（插图006）', galleryTitle = '插图' } = {}) {
  const galleryHtml = `<div id="content">${Array.from({ length: galleryCount }, (_, i) => `<img src="https://i.test/g/${i}.jpg"/>`).join('')}</div>`;
  world = {
    images: makeImages(galleryCount, 'g'),
    failing: new Set(),
    chapters: {
      'https://wenku.test/0.htm': `<div id="content">前文甲${markerText}后文乙</div>`,
      'https://wenku.test/1.htm': galleryHtml,
    },
    galleryTitle,
  };
}

function makeRun(logger) {
  return createRunContext({
    cache: { enabled: false },
    logger,
    net: {
      loadChapterPage: async (href) => cheerio.load(world.chapters[href] ?? '<div id="content"></div>'),
      loadImage: async (src) => (world.failing.has(src) ? null : world.images[src] || null),
    },
  });
}

function makeJson() {
  return {
    titles: '测试书',
    authors: '作者',
    intro: '简介',
    content: {
      0: {
        volume: '第一卷',
        chapters: {
          0: { title: '第1话', href: 'https://wenku.test/0.htm' },
          1: { title: world.galleryTitle, href: 'https://wenku.test/1.htm' },
        },
      },
    },
  };
}

async function build(options = {}) {
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: () => {} };
  const json = makeJson();
  const book = await creatEpub(json, { run: makeRun(logger), dedupeImages: true, ...options });

  const text = {};
  for (const name of Object.keys(book.files)) {
    if (name.startsWith('OEBPS/Text/') && name.endsWith('.xhtml')) {
      text[name.split('/').pop()] = await book.file(name).async('string');
    }
  }
  return { json, book, text, logs, files: Object.keys(book.files), opf: await book.file('OEBPS/content.opf').async('string') };
}

const refs = (html) => [...html.matchAll(/src="\.\.\/Image\/([^"]+)"/g)].map(m => m[1]);

// ── 标记识别 ──

test('识别多种写法的插图标记', () => {
  const cases = [
    ['（插图006）', 6], ['(插图6)', 6], ['【插画3】', 3], ['「插图」', null], ['[image]', null],
    ['image01', 1], ['image-1', 1], ['image_1', 1], ['插图01', 1], ['illust2', 2], ['IMG 7', 7],
    ['image', null], ['插图', null],
  ];
  for (const [text, expected] of cases) {
    const marker = splitIllustrationMarkers(text).find(p => p.type === 'marker');
    assert.ok(marker, `应当识别为标记：${text}`);
    assert.equal(marker.no, expected, `${text} 的编号应为 ${expected}`);
  }
});

test('不误伤正文里的「图」和句中「插图」', () => {
  for (const text of ['图案很美', '他的意图很明显', '企图篡位', '感谢您担任本作的插图。', '这本书的插图真的好看']) {
    assert.ok(!splitIllustrationMarkers(text).some(p => p.type === 'marker'), `不应误判：${text}`);
  }
});

// ── 站点水印 ──

test('识别站点水印的多种写法，但不误删录入组署名', () => {
  for (const text of [
    '本文来自 轻小说文库(http://www.wenku8.com)',
    '最新最全的日本动漫轻小说 轻小说文库(http://www.wenku8.com) 为你一网打尽！',
    '本文来自 轻小说文库(http://www.wenku8.cc)',
  ]) {
    assert.ok(isWatermarkText(text), `应判定为水印：${text}`);
  }

  for (const text of ['台版 转自 轻之国度', '网译版 转自 轻之国度', '轻之国度×天使动漫录入组', '台版 转自 watashi101、哦☆卖糕的']) {
    assert.ok(!isWatermarkText(text), `不应判定为水印：${text}`);
  }

  // 长段落即使提到站点也不整段删掉
  assert.ok(!isWatermarkText('轻小说文库是本作插图来源，感谢所有参与翻译与录入的朋友们，你们的付出让这部作品得以与读者见面。'));
});

test('extractChapterContent 跳过 ul#contentdp 水印、保留正文', () => {
  const $ = cheerio.load('<div id="content"><ul id="contentdp">本文来自 轻小说文库(http://www.wenku8.com)</ul>正文内容<ul id="contentdp">最新最全的日本动漫轻小说 轻小说文库(http://www.wenku8.com) 为你一网打尽！</ul><p>台版 转自 轻之国度</p></div>');
  const items = extractChapterContent($, $('#content'));
  assert.deepEqual(items.map(i => i.text), ['正文内容', '台版 转自 轻之国度']);
});

// ── 映射规则 ──

test('编号触及画廊末尾时偏移为 0（3947 那种约定）', async () => {
  setup({ galleryCount: 8, markerText: '（插图006）（插图007）（插图008）' });
  const { json, text } = await build();

  const plan = json._slots[0][1];
  assert.equal(plan.length, 8);
  assert.deepEqual(refs(text['0_0.xhtml']), [plan[5], plan[6], plan[7]], '应映射到第 6~8 张');
  assert.deepEqual(json._colorPages[0], plan.slice(0, 5), '前 5 张成为卷首彩插');
  assert.deepEqual(json._endPages, {});
});

test('编号不到画廊末尾时整体右移（3396 那种约定）', async () => {
  setup({ galleryCount: 10, markerText: 'image01 image02' });
  const { json, text } = await build();

  const plan = json._slots[0][1];
  // 最大编号 2、画廊 10 张 → 偏移 8 → 映射到第 9、10 张
  assert.deepEqual(refs(text['0_0.xhtml']), [plan[8], plan[9]]);
  assert.deepEqual(json._colorPages[0], plan.slice(0, 8), '前 8 张成为卷首彩插');
});

test('编号缺口：缺号的那张图就近跟随前一张已映射图', async () => {
  setup({ galleryCount: 10, markerText: 'image01 image02 image04' });
  const { json, text } = await build();

  const plan = json._slots[0][1];
  // 最大编号 4、画廊 10 → 偏移 6 → 映射到 7、8、10；图 9 是缺口
  assert.deepEqual(refs(text['0_0.xhtml']), [plan[6], plan[7], plan[8], plan[9]]);
  assert.deepEqual(json._colorPages[0], plan.slice(0, 6));
});

test('插图章保留全部图片，与正文引用同一个文件', async () => {
  setup({ galleryCount: 8, markerText: '（插图006）' });
  const { text, files } = await build();

  const gallery = refs(text['0_1.xhtml']);
  assert.equal(gallery.length, 8, '插图章应保留 8 张');

  const inline = refs(text['0_0.xhtml']);
  assert.equal(inline.length, 1);
  assert.ok(gallery.includes(inline[0]), '正文引用的是插图章里的同一份文件');

  const imageFiles = files.filter(n => n.startsWith('OEBPS/Image/') && !n.endsWith('/') && !n.includes('cover'));
  assert.equal(imageFiles.length, 8, '不应多存一份');
});

test('彩插页排在卷首页之前', async () => {
  setup({ galleryCount: 8, markerText: '（插图006）' });
  const { opf } = await build();
  const idrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);

  assert.ok(idrefs.indexOf('color-0') >= 0, '应生成彩插页');
  assert.ok(idrefs.indexOf('color-0') < idrefs.indexOf('vol-0'), '彩插页应在卷首页之前');
  assert.ok(!idrefs.includes('colorend-0'), '当前规则下卷尾组恒为空，不应生成卷尾页');
});

// ── 报告 ──

test('命令行报告：识别到标记时给出编号范围与去向', async () => {
  setup({ galleryCount: 10, markerText: 'image01 image02 image04' });
  const { logs } = await build();

  const line = logs.find(l => l.includes('识别到'));
  assert.ok(line, `应有识别报告，实际：${JSON.stringify(logs)}`);
  assert.match(line, /识别到 3 个插图标记/);
  assert.match(line, /1~4，缺 3/);
  assert.match(line, /卷首 6 张/);
  assert.match(line, /缺口跟随 1 张/);
});

test('命令行报告：没有标记时也明确说明', async () => {
  setup({ galleryCount: 8, markerText: '完全没有标记的正文' });
  const { logs, json } = await build();

  assert.ok(logs.some(l => l.includes('未识别到插图标记')), `实际：${JSON.stringify(logs)}`);
  assert.deepEqual(json._colorPages, {});
});

// ── 边界 ──

test('编号超出画廊范围时整卷不动，且保留原始标记文字', async () => {
  setup({ galleryCount: 8, markerText: '（插图099）' });
  const { text, json, files, logs } = await build();

  assert.deepEqual(refs(text['0_0.xhtml']), []);
  assert.ok(text['0_0.xhtml'].includes('（插图099）'), '越界标记应原样保留');
  assert.deepEqual(json._colorPages, {});
  assert.ok(!files.includes('OEBPS/Text/color_0.xhtml'));
  assert.ok(logs.some(l => l.includes('无法安全映射')));
});

test('对应图片下载失败时整卷不动', async () => {
  setup({ galleryCount: 8, markerText: '（插图008）' });   // 最大编号 8 → 映射到第 8 张
  world.failing = new Set(['https://i.test/g/7.jpg']);
  const { text, json } = await build();

  assert.deepEqual(refs(text['0_0.xhtml']), []);
  assert.ok(text['0_0.xhtml'].includes('（插图008）'));
  assert.deepEqual(json._colorPages, {});
});

test('下载失败不会让序号错位（slots 与文档顺序对齐）', async () => {
  setup({ galleryCount: 10, markerText: 'image02' });
  world.failing = new Set(['https://i.test/g/2.jpg']);   // 第 3 张失败
  const { json } = await build();

  const plan = json._slots[0][1];
  assert.equal(plan.length, 10, '槽位数应仍为 10');
  assert.equal(plan[2], null, '失败位置记为 null');
  assert.equal(plan[9], '0_1_9.jpg', '后面的序号不应错位');
});

test('关闭 illustrationAnchors 时标记就是普通文字', async () => {
  setup({ galleryCount: 8, markerText: '（插图006）' });
  const { text, json, files } = await build({ illustrationAnchors: false });

  assert.deepEqual(refs(text['0_0.xhtml']), []);
  assert.ok(text['0_0.xhtml'].includes('（插图006）'));
  assert.deepEqual(json._colorPages, {});
  assert.ok(!files.includes('OEBPS/Text/color_0.xhtml'));
});

test('没有「插图」章时退化为按整卷图片编号', async () => {
  setup({ galleryCount: 8, markerText: '（插图006）', galleryTitle: '附录' });
  const { json, text, logs } = await build();

  assert.equal(json._slots[0][1].length, 8);
  assert.equal(refs(text['0_0.xhtml']).length, 1);
  assert.ok(logs.some(l => l.includes('全卷')), '报告应说明退化成了全卷');
});
