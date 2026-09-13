
// 从 "$('title').text()" 里拆出书名和作者。
// 站点格式形如 "书名 - 作者 - 轻小说文库 - wenku8.net"。
// 原来的贪婪正则只要格式稍有出入就会返回 undefined，导致整个流程直接失败，因此这里做逐级回退。
function parseTitle(rawTitle) {
  const raw = String(rawTitle || '').trim();
  if (!raw) return { titles: undefined, authors: undefined };

  const match = /^(.*)\s+-\s+(.*)\s+-\s+(.*)\s+-\s+(.*)$/.exec(raw);
  if (match) {
    return { titles: match[1].trim(), authors: match[2].trim() };
  }

  const parts = raw.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { titles: parts[0], authors: parts[1] };
  }
  return { titles: raw, authors: undefined };
}

// 书籍页的信息栏（分类/状态/更新时间/标签）是"标签：值"平铺的文本，
// 用 DOM 结构定位很脆，直接对折叠空白后的文本做字段提取更稳。
function matchInfoField(text, label) {
  const pattern = new RegExp(`${label}[：:]\\s*([^：:]+?)\\s*(?=[\\u4e00-\\u9fa5]{2,8}[：:]|$)`);
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

function parseBookExtras($) {
  const text = $('#content').text().replace(/\s+/g, ' ');

  const pubDateRaw = matchInfoField(text, '最后更新');
  const subjectsRaw = matchInfoField(text, '作品Tags');

  return {
    publisher: matchInfoField(text, '文库分类'),
    status: matchInfoField(text, '文章状态'),
    // dc:date 需要 ISO 8601；站点给的就是 YYYY-MM-DD
    pubDate: pubDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(pubDateRaw) ? pubDateRaw : null,
    subjects: subjectsRaw ? subjectsRaw.split(/\s+/).filter(Boolean) : [],
  };
}

async function getBookInfo(url, json, ctx) {
  const $ = await ctx.net.loadBookPage(url);
  if (!$) return;

  let intro, chapurl, coverUrl;
  const { titles, authors } = parseTitle($('title').text());

  // 简介所在的 span 用属性精确匹配太脆（多一个空格就抓不到），改成包含匹配
  const introSpan = $('span[style*="font-size:14px"]').last();
  if (introSpan.length) intro = introSpan.text().trim();

  $('a').each((i, elem) => {
    if ($(elem).text().trim() === '小说目录') {
      const href = $(elem).attr('href');
      if (href) {
        chapurl = new URL(href, url).href;
      }
    }
  });

  // 根据书号构造封面 URL：https://img.wenku8.com/image/{首数字}/{书ID}/{书ID}s.jpg
  const bookIdMatch = url.match(/\/book\/(\d+)\.htm/);
  if (bookIdMatch) {
    const bookId = bookIdMatch[1];
    coverUrl = `https://img.wenku8.com/image/${bookId[0]}/${bookId}/${bookId}s.jpg`;
  }
  // 无法从 URL 提取书号时回退到页面 DOM 查找。
  // 曾经写死成 table.eq(1)，但封面图实际在第 3 个 table 里（后面几个 table 是推荐位配图），
  // 所以这条回退路径一直是失效的。#content 里的第一张图就是封面。
  if (!coverUrl) {
    const coverImg = $('#content').find('img').first();
    if (coverImg.length) {
      const src = coverImg.attr('src');
      if (src) coverUrl = new URL(src, url).href;
    }
  }

  json.titles = titles;
  json.authors = authors;
  json.intro = intro || '暂无简介';
  json.coverUrl = coverUrl || null;

  const extras = parseBookExtras($);
  json.publisher = extras.publisher;
  json.status = extras.status;
  json.pubDate = extras.pubDate;
  json.subjects = extras.subjects;
  json.content = {};
  if (chapurl) {
    await getChapList(chapurl, json, ctx);
  }
}

async function getChapList(url, json, ctx) {
  const $ = await ctx.net.loadBookPage(url);
  if (!$) return;

  // 目录页 URL 不一定以 index.htm 结尾，取不到就退化成"去掉最后一段路径"
  const baseMatch = /^(.*)index\.htm/.exec(url);
  const realur = baseMatch ? baseMatch[1] : url.replace(/[^/]*$/, '');

  let key;
  let p = 0;
  let v = -1;

  $('td').each((i, elem) => {
    const $elem = $(elem);
    if ($elem.attr('class') === 'vcss') {
      v++;
      key = $elem.text().trim();
      json.content[v] = { volume: key, chapters: {} };
      p = 0;
    } else if ($elem.attr('class') === 'ccss' && $elem.find('a').length > 0) {
      // 有些书没有 vcss 行（全书单卷），此时 v 仍是 -1，直接写就会抛异常
      if (v < 0) {
        v = 0;
        json.content[v] = { volume: '正文', chapters: {} };
        p = 0;
      }
      const link = $elem.find('a').first();
      const title = link.text().trim();
      const href = realur + link.attr('href');
      json.content[v].chapters[p] = { title, href };
      p++;
    }
  });
}

// 正文里的插图位置标记，形如「（插图006）」「(插图6)」。
// 部分录入组会加这种标记（如 3947），另一些则完全不加（如 971），所以这是可选信号。
const ILLUSTRATION_MARKER = /[（(]\s*插图\s*(\d{1,4})\s*[）)]/g;

// 把一段文本按插图标记切成 [文字, 标记, 文字, ...]。
// 标记通常是独立成段的，但也允许夹在句中，所以按子串切分而不是整段匹配。
function splitIllustrationMarkers(text) {
  const parts = [];
  let last = 0;

  ILLUSTRATION_MARKER.lastIndex = 0;
  for (const match of text.matchAll(ILLUSTRATION_MARKER)) {
    const before = text.slice(last, match.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    parts.push({ type: 'marker', no: Number(match[1]), raw: match[0] });
    last = match.index + match[0].length;
  }

  const after = text.slice(last).trim();
  if (after) parts.push({ type: 'text', text: after });

  return parts;
}

// 按文档顺序把章节正文拆成 [段落, 图片, 段落, ...]。
// 这样插图会留在它原本的位置，而不是被统一挪到章末；
// 同时也会递归进入子元素，避免正文被包在 <div>/<p> 里时整段丢失。
function extractChapterContent($, contentRoot) {
  const items = [];

  const walk = (node) => {
    node.contents().each((i, el) => {
      if (el.type === 'text') {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text) items.push(...splitIllustrationMarkers(text));
        return;
      }
      if (el.type !== 'tag') return;

      const name = String(el.name || '').toLowerCase();
      if (name === 'img') {
        items.push({ type: 'img', el });
        return;
      }
      if (name === 'br' || name === 'hr' || name === 'script' || name === 'style') return;
      walk($(el));
    });
  };

  walk(contentRoot);
  return items;
}

module.exports = {
  getBookInfo,
  getChapList,
  parseTitle,
  parseBookExtras,
  extractChapterContent,
  splitIllustrationMarkers,
  ILLUSTRATION_MARKER,
};
