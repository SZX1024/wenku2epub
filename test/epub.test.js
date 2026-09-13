const test = require('node:test');
const assert = require('node:assert/strict');
const JsZip = require('jszip');
const {
  creatOpf, creatNav, creatNcx, writtenVolumes, chapterFileName, volumePageName, COVER_PAGE,
} = require('../lib/epub');

// manifest 的 id 必须是合法 NCName
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function makeJson(overrides = {}) {
  return {
    titles: '三体',
    authors: '刘慈欣',
    intro: '简介',
    content: {
      0: {
        volume: '第一卷',
        chapters: {
          0: { title: '第一章', href: 'https://example.com/0.htm' },
          1: { title: '第二章', href: 'https://example.com/1.htm' }
        }
      }
    },
    imgs: { '0_0_0.jpg': { imgname: '0_0_0.jpg' } },
    _written: { 0: [0, 1] },
    _volImgs: { 0: ['0_0_0.jpg'] },
    ...overrides
  };
}

// 按"应该产出什么"把文件真实写进 zip，再由测试断言 manifest 与之一致
async function buildBook({ coverExt = null, hasStyle = false, json = makeJson(), epubVersion = 3 } = {}) {
  const book = new JsZip();
  await creatOpf(book, json, { coverExt, epubVersion, uuid: 'urn:uuid:test', hasStyle });

  if (coverExt) {
    book.file(`OEBPS/Image/cover${coverExt}`, Buffer.from([0xff, 0xd8, 0xff]));
    book.file(`OEBPS/Text/${COVER_PAGE}`, '<html/>');
  }
  if (hasStyle) book.file('OEBPS/Style/style.css', 'body{}');
  book.file(epubVersion === 2 ? 'OEBPS/toc.ncx' : 'OEBPS/nav.xhtml', '<html/>');

  for (const imgname of Object.keys(json.imgs)) {
    book.file(`OEBPS/Image/${imgname}`, Buffer.from([0xff, 0xd8, 0xff]));
  }
  for (const volume of writtenVolumes(json)) {
    book.file(`OEBPS/Text/${volumePageName(volume)}`, '<html/>');
    for (const chapter of json._written[volume]) {
      book.file(`OEBPS/Text/${chapterFileName(volume, chapter)}`, '<html/>');
    }
  }
  return book;
}

function manifestHrefs(opf) {
  return [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map(m => m[1]);
}

function manifestIds(opf) {
  return [...opf.matchAll(/<item id="([^"]+)"/g)].map(m => m[1]);
}

test('creatOpf 不会改坏书名（"三体" 不能变成 "3体"）', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson(), { uuid: 'urn:uuid:test' });
  const opf = await book.file('OEBPS/content.opf').async('string');

  // xml-formatter 会把元素内容换行，所以断言要容忍空白
  assert.match(opf, /<dc:title>\s*三体\s*<\/dc:title>/);
  assert.doesNotMatch(opf, /3体/);
});

test('manifest 的所有 id 都是合法 NCName（原来的 "Text/0_0.xhtml" 非法）', async () => {
  const book = await buildBook({ coverExt: '.jpg', hasStyle: true });
  const opf = await book.file('OEBPS/content.opf').async('string');

  const ids = manifestIds(opf);
  assert.ok(ids.length >= 4, `manifest 条目太少: ${ids.length}`);
  for (const id of ids) {
    assert.match(id, NCNAME, `manifest id 不是合法 NCName: ${id}`);
  }

  const idrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);
  for (const idref of idrefs) {
    assert.ok(ids.includes(idref), `spine 的 idref 在 manifest 中不存在: ${idref}`);
  }
});

test('manifest 不引用 zip 里不存在的文件', async () => {
  const book = await buildBook({ coverExt: '.jpg', hasStyle: true });
  const opf = await book.file('OEBPS/content.opf').async('string');

  const hrefs = manifestHrefs(opf);
  assert.ok(hrefs.length > 0);
  for (const href of hrefs) {
    assert.ok(book.file(`OEBPS/${href}`), `manifest 引用了不存在的文件: ${href}`);
  }
});

test('没有封面时不声明 cover，也不留下悬空引用', async () => {
  const book = await buildBook({ coverExt: null, hasStyle: false });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.doesNotMatch(opf, /Image\/cover/);
  assert.doesNotMatch(opf, /cover-image/);
  assert.doesNotMatch(opf, /cover\.xhtml/);

  for (const href of manifestHrefs(opf)) {
    assert.ok(book.file(`OEBPS/${href}`), `manifest 引用了不存在的文件: ${href}`);
  }
});

test('没有 style.css 时不声明 css 条目', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson(), { uuid: 'urn:uuid:test' });
  const opf = await book.file('OEBPS/content.opf').async('string');
  assert.doesNotMatch(opf, /style\.css/);
});

test('EPUB2 没有封面时连 <meta name="cover"> 一起移除', async () => {
  const withCover = await buildBook({ coverExt: '.jpg', epubVersion: 2 });
  assert.match(await withCover.file('OEBPS/content.opf').async('string'), /name="cover"/);

  const withoutCover = await buildBook({ coverExt: null, epubVersion: 2 });
  const opf = await withoutCover.file('OEBPS/content.opf').async('string');
  assert.doesNotMatch(opf, /name="cover"/);
  assert.doesNotMatch(opf, /Image\/cover/);

  for (const href of manifestHrefs(opf)) {
    assert.ok(withoutCover.file(`OEBPS/${href}`), `manifest 引用了不存在的文件: ${href}`);
  }
});

test('封面页进入 manifest 与 spine，并排在阅读顺序最前', async () => {
  const book = await buildBook({ coverExt: '.jpg', hasStyle: true });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.match(opf, /<item id="cover-page" href="Text\/cover\.xhtml"/);
  assert.match(opf, /href="Image\/cover\.jpg"[^>]*properties="cover-image"/);

  const idrefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);
  assert.equal(idrefs[0], 'cover-page', '封面页应当是 spine 的第一项');
});

test('每卷生成卷首页，且目录中的卷链接指向卷首页而不是第一章', async () => {
  const book = new JsZip();
  const json = makeJson();
  await creatOpf(book, json, { uuid: 'urn:uuid:test' });
  await creatNav(book, json, null);

  const opf = await book.file('OEBPS/content.opf').async('string');
  assert.match(opf, /href="Text\/vol_0\.xhtml"/);

  const nav = await book.file('OEBPS/nav.xhtml').async('string');
  assert.match(nav, /<a href="Text\/vol_0\.xhtml">第1卷<\/a>/);
  assert.match(nav, /<a href="Text\/0_0\.xhtml">第一章<\/a>/);
});

test('EPUB2 有封面时 guide 指向封面页（内容文档），而不是图片', async () => {
  const book = new JsZip();
  await creatOpf(book, makeJson(), { coverExt: '.jpg', epubVersion: 2, uuid: 'urn:uuid:test' });
  const opf = await book.file('OEBPS/content.opf').async('string');

  assert.match(opf, /<reference[^>]*type="cover"[^>]*href="Text\/cover\.xhtml"/);
  assert.doesNotMatch(opf, /type="cover"[^>]*href="Image/);
});

test('EPUB2 的 playOrder 唯一递增（卷节点有自己的目标，不再与首章冲突）', async () => {
  const book = new JsZip();
  const json = makeJson({
    content: {
      0: { volume: '第一卷', chapters: { 0: { title: '第一章', href: 'a' }, 1: { title: '第二章', href: 'b' } } },
      1: { volume: '第二卷', chapters: { 0: { title: '第三章', href: 'c' } } }
    },
    _written: { 0: [0, 1], 1: [0] }
  });

  await creatNcx(book, json, null, 'urn:uuid:test');
  const ncx = await book.file('OEBPS/toc.ncx').async('string');

  // vol_0=1, 0_0=2, 0_1=3, vol_1=4, 1_0=5
  const orders = [...ncx.matchAll(/playOrder="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(orders, [1, 2, 3, 4, 5], `playOrder 应当唯一递增，实际: ${orders}`);

  const targets = [...ncx.matchAll(/<content src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(targets).size, targets.length, '不应有两个 navPoint 指向同一目标');
});

test('writtenVolumes 只返回真正写出章节的卷', () => {
  const json = {
    content: { 0: { volume: '第一卷', chapters: {} }, 1: { volume: '第二卷', chapters: {} } },
    _written: { 0: [0, 1], 1: [] }
  };
  assert.deepEqual(writtenVolumes(json), [0]);
  assert.deepEqual(writtenVolumes(json, [1]), []);
  assert.deepEqual(writtenVolumes(json, [0, 1]), [0]);
});

test('nav 只为真正写出的章节生成链接', async () => {
  const book = new JsZip();
  // 第二卷整卷失败：_written 为空
  const json = makeJson({
    content: {
      0: { volume: '第一卷', chapters: { 0: { title: '第一章', href: 'x' } } },
      1: { volume: '第二卷', chapters: { 0: { title: '失败章', href: 'y' } } }
    },
    _written: { 0: [0], 1: [] }
  });

  await creatNav(book, json, null);
  const nav = await book.file('OEBPS/nav.xhtml').async('string');

  assert.match(nav, /Text\/0_0\.xhtml/);
  assert.doesNotMatch(nav, /Text\/1_0\.xhtml/);
  assert.doesNotMatch(nav, /失败章/);
  assert.doesNotMatch(nav, /vol_1\.xhtml/);
});
