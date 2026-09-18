
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

  // 根据书号构造封面 URL：https://img.wenku8.com/image/{千位桶}/{书ID}/{书ID}s.jpg
  // 桶位是 Math.floor(书号 / 1000)，不是书号首位数字。四位数书名号两者恰好相同，
  // 所以这个错误一直没暴露；对 ID<1000 的老书会拼出 404 路径
  // （971 实际在 /image/0/971/，首位数字却给出 /image/9/971/）。
  const bookIdMatch = url.match(/\/book\/(\d+)\.htm/);
  if (bookIdMatch) {
    const bookId = bookIdMatch[1];
    const bucket = Math.floor(Number(bookId) / 1000);
    coverUrl = `https://img.wenku8.com/image/${bucket}/${bookId}/${bookId}s.jpg`;
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

// ── 插图位置标记 ──
// 录入组的习惯并不统一，实测见过两大类：
//   3947：`（插图006）`      编号 = 画廊序号
//   3396：`image01`（裸写）  编号 = 黑白插画序号
// 所以这里匹配"意思近似"的多种写法，而不是只认一种。
//
// 三种合法形态（缺一不可，否则会误伤正文）：
//   1. 括号包裹：`（插图006）` `(image 6)` `【插画3】` `[image]` `「插图」`
//   2. 关键词紧跟数字：`image01` `image-1` `image_1` `插图01` `illust2`
//   3. 整段只有关键词：单独一个 `image` / `插图`
// 明确不匹配：裸的「图」（图案/意图/企图会全中），以及夹在句子中间的「插图」
//（后记致谢里"感谢您担任本作的插图。"那种）。
const MARKER_KEYWORDS = '(?:image|img|illust(?:ration)?|pic(?:ture)?|fig(?:ure)?|photo|插图|插画|插圖|彩页|彩图|扉页|口绘)';
const MARKER_NUM = '\\d{1,4}';
const MARKER_SEP = '[-_.\\uFF03#\\s]*';   // 允许 - _ . ＃ # 与空格作分隔

const ILLUSTRATION_MARKER = new RegExp(
  // 形态 1：括号包裹，编号可省略
  `[\\uFF08(\\[\\u3010\\u300C\\u300E]\\s*${MARKER_KEYWORDS}\\s*${MARKER_SEP}(${MARKER_NUM})?\\s*[\\uFF09)\\]\\u3011\\u300D\\u300F]`
  // 形态 2：关键词紧跟数字（ASCII 关键词两侧加词边界，避免命中单词内部）
  + `|(?<![A-Za-z0-9])${MARKER_KEYWORDS}\\s*${MARKER_SEP}(${MARKER_NUM})(?![A-Za-z0-9])`,
  'gi',
);

// 形态 3：整段就是一个关键词
const STANDALONE_MARKER = new RegExp(`^${MARKER_KEYWORDS}$`, 'i');

function markerNumber(match) {
  const raw = match[1] !== undefined ? match[1] : match[2];
  return raw === undefined ? null : Number(raw);
}

// 把一段文本按插图标记切成 [文字, 标记, 文字, ...]。
// 标记通常独立成段，但也允许夹在句中，所以按子串切分而不是整段匹配。
function splitIllustrationMarkers(text) {
  const parts = [];
  const pushText = (value) => {
    const trimmed = value.trim();
    if (trimmed) parts.push({ type: 'text', text: trimmed });
  };

  // 整段就是一个关键词（没有编号，无法定位，交给上层报告）
  if (STANDALONE_MARKER.test(text)) {
    return [{ type: 'marker', no: null, raw: text.trim() }];
  }

  let last = 0;
  ILLUSTRATION_MARKER.lastIndex = 0;
  for (const match of text.matchAll(ILLUSTRATION_MARKER)) {
    pushText(text.slice(last, match.index));
    parts.push({ type: 'marker', no: markerNumber(match), raw: match[0] });
    last = match.index + match[0].length;
  }

  if (last === 0) return [{ type: 'text', text: text.trim() }];
  pushText(text.slice(last));
  return parts;
}

// ── 站点水印 ──
// 每章的首尾各塞一条 <ul id="contentdp">：
//   章首「本文来自 轻小说文库(http://www.wenku8.com)」
//   章末「最新最全的日本动漫轻小说 轻小说文库(...) 为你一网打尽！」
// 主要靠结构（跳过 ul#contentdp）去除，域名换成 .cc/.net 也一样；
// 下面这层是文本兜底，防止某些书把它写成普通段落。
const WATERMARK_PATTERNS = [
  /本文来自\s*轻小说文库/,
  /最新最全的日本动漫轻小说/,
  /为你一网打尽/,
  /轻小说文库\s*[（(]\s*https?:\/\/[^）)]*wenku8/i,
  /https?:\/\/[^\s）)]*wenku8\.(?:com|cc|net|org)/i,
];

function isWatermarkText(text) {
  const value = String(text ?? '').trim();
  // 水印都很短；长段落即使提到站点也不该整段删掉
  if (!value || value.length > 80) return false;
  return WATERMARK_PATTERNS.some(pattern => pattern.test(value));
}

function isWatermarkElement(el) {
  const attrs = el.attribs || {};
  return String(attrs.id || '').toLowerCase() === 'contentdp';
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
        if (text && !isWatermarkText(text)) items.push(...splitIllustrationMarkers(text));
        return;
      }
      if (el.type !== 'tag') return;

      const name = String(el.name || '').toLowerCase();
      if (name === 'img') {
        items.push({ type: 'img', el });
        return;
      }
      if (name === 'br' || name === 'hr' || name === 'script' || name === 'style') return;
      if (isWatermarkElement(el)) return;
      walk($(el));
    });
  };

  walk(contentRoot);
  return items.filter(item => !(item.type === 'text' && isWatermarkText(item.text)));
}

module.exports = {
  getBookInfo,
  getChapList,
  parseTitle,
  parseBookExtras,
  extractChapterContent,
  splitIllustrationMarkers,
  isWatermarkText,
  ILLUSTRATION_MARKER,
};
