#!/usr/bin/env node
/**
 * 维护工具（**不是测试**）：重新抓取 wenku8 的真实页面，生成 test/fixtures/ 下的样本。
 *
 *     node tools/capture-fixtures.js [书籍网址]
 *
 * 这些样本供 test/scrape.test.js 做离线断言。当站点改版导致解析测试失败时，
 * 重跑本脚本并查看 fixtures 的 diff，就能直接看出站点到底改了什么。
 *
 * 两点约定：
 *  1. 脚本放在 tools/ 而不是 test/ —— `node --test` 会执行 test/ 下所有 .js 文件。
 *  2. fixture 只保留"解析所依赖的结构"，正文文字会被截断（见 truncateText），
 *     既压缩体积也避免把整章小说正文放进仓库。结构（标签、class、href/src）保持原样。
 */
const fs = require('fs');
const path = require('path');
const { createRunContext } = require('../lib/runtime');
const { getBookInfo } = require('../lib/parse');

const BOOK_URL = process.argv[2] || 'https://www.wenku8.net/book/3057.htm';
const OUT_DIR = path.join(__dirname, '..', 'test', 'fixtures');

// 与解析无关的大块内容（评论区、推荐位、书评），去掉以缩小 fixture
const NOISE = /吐槽|同分类|发表书评|小说资源交流|推荐/;

function stripNoise($, $root) {
  $root.find('script, iframe, noscript').remove();
  $root.find('table').each((i, table) => {
    if (NOISE.test($(table).text())) $(table).remove();
  });
}

// 保留前 maxNodes 个文本节点，每个最多 maxChars 个字符；标签结构完全不动
function truncateText($, $root, { maxNodes, maxChars }) {
  let seen = 0;

  const walk = (node) => {
    for (const child of $(node).contents().toArray()) {
      if (child.type === 'text') {
        seen++;
        const raw = child.data || '';
        if (seen > maxNodes) child.data = '';
        else if (raw.length > maxChars) child.data = `${raw.slice(0, maxChars)}…`;
      } else if (child.type === 'tag') {
        walk(child);
      }
    }
  };

  walk($root);
}

function findChapterIndexUrl($, bookUrl) {
  let found = null;
  $('a').each((i, el) => {
    if ($(el).text().trim() === '小说目录') {
      const href = $(el).attr('href');
      if (href) found = new URL(href, bookUrl).href;
    }
  });
  return found;
}

function write(name, html) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, html, 'utf-8');
  const kb = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1);
  console.log(`  ✅ ${name.padEnd(24)} ${kb.padStart(7)} KB`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 抓取时不用缓存，确保拿到的是站点当前的样子
  const run = createRunContext({ cache: { enabled: false }, delay: true, rateLimitMs: 400 });

  console.log(`📚 抓取书籍页：${BOOK_URL}`);
  const json = {};
  await getBookInfo(BOOK_URL, json, run);
  if (!json.titles) throw new Error('未能解析出书名，站点结构可能已变');

  const $book = await run.net.loadBookPage(BOOK_URL);
  stripNoise($book, $book('#content'));
  write('book-page.html', $book.html());

  const indexUrl = findChapterIndexUrl($book, BOOK_URL);
  if (!indexUrl) throw new Error('未能找到「小说目录」链接');

  console.log(`📑 抓取目录页：${indexUrl}`);
  const $index = await run.net.loadBookPage(indexUrl);
  stripNoise($index, $index('#content'));
  write('chapter-index.html', $index.html());

  // 从解析结果里挑两个有代表性的章节
  const flat = [];
  for (const v in json.content) {
    for (const c in json.content[v].chapters) {
      flat.push({ volume: Number(v), chapter: Number(c), ...json.content[v].chapters[c] });
    }
  }

  const illustration = flat.find(ch => /插图|彩页/.test(ch.title));
  const text = flat.find(ch => !/插图|彩页/.test(ch.title) && ch.chapter >= 1) || flat[1];

  if (text) {
    console.log(`📄 抓取正文章节：${text.title}`);
    const $ch = await run.net.loadChapterPage(text.href);
    stripNoise($ch, $ch('#content'));
    truncateText($ch, $ch('#content'), { maxNodes: 15, maxChars: 60 });
    write('chapter-text.html', $ch.html());
  }

  if (illustration) {
    console.log(`🖼️  抓取插图章节：${illustration.title}`);
    const $ch = await run.net.loadChapterPage(illustration.href);
    stripNoise($ch, $ch('#content'));
    truncateText($ch, $ch('#content'), { maxNodes: 3, maxChars: 20 });
    write('chapter-images.html', $ch.html());
  }

  const meta = {
    capturedAt: new Date().toISOString(),
    bookUrl: BOOK_URL,
    chapterIndexUrl: indexUrl,
    titles: json.titles,
    authors: json.authors,
    publisher: json.publisher,
    pubDate: json.pubDate,
    subjects: json.subjects,
    volumes: Object.keys(json.content).length,
    chapters: flat.length,
    textChapter: text ? { title: text.title, href: text.href } : null,
    illustrationChapter: illustration ? { title: illustration.title, href: illustration.href } : null,
  };
  write('capture.json', JSON.stringify(meta, null, 2));

  console.log(`\n共 ${Object.keys(json.content).length} 卷 / ${flat.length} 章`);
}

main().catch((err) => {
  console.error('❌ 抓取失败：', err.message);
  process.exitCode = 1;
});
