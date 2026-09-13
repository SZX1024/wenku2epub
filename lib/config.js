const path = require('path');

// 项目根目录：style.css、本地封面等资源一律相对它解析，而不是相对 process.cwd()。
// 否则换目录运行（例如全局安装后）会产生悬空的 manifest 引用并丢失样式。
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 图片 MIME 类型映射
const MIME_MAP = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.svg':  'image/svg+xml',
};
const SUPPORTED_COVER_EXTS = Object.keys(MIME_MAP);

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'image/jpeg';
}

// Windows 保留设备名，直接拿来当文件名会失败
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// 把任意文本变成安全的文件/目录名：
//   1. 替换非法字符（含控制字符）
//   2. 去掉首尾空白与点 —— 顺带挡掉 ".." 这种会写到上级目录的名字
//   3. 规避 Windows 保留名
//   4. 按 maxLength 截断，并保留扩展名
function sanitizeFilename(name, maxLength = 120) {
  let safe = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');

  if (!safe) safe = 'untitled';
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  if (safe.length <= maxLength) return safe;

  const ext = /^\.[A-Za-z0-9]{1,5}$/.test(path.extname(safe)) ? path.extname(safe) : '';
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  const cut = Math.max(1, maxLength - ext.length);
  const truncated = stem.slice(0, cut).replace(/[\s.]+$/g, '');
  return (truncated || 'untitled') + ext;
}

// User-Agent 列表
function getRandomUserAgent() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
    'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Vivaldi/6.5.3206.53 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Brave/131.0.0.0 Safari/537.36'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

// EPUB3 OPF 模板
const content_opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title></dc:title>
    <dc:creator></dc:creator>
    <dc:description></dc:description>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId"></dc:identifier>
    <meta property="dcterms:modified"></meta>
  </metadata>
  <manifest>
  </manifest>
  <spine>
  </spine>
</package>
`;

// EPUB2 OPF 模板
const content_opf_epub2 = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title></dc:title>
    <dc:creator></dc:creator>
    <dc:description></dc:description>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId"></dc:identifier>
    <meta name="cover" content="cover"/>
  </metadata>
  <manifest>
  </manifest>
  <spine toc="ncx">
  </spine>
  <guide>
  </guide>
</package>`;

// container.xml
const container_xml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
   </rootfiles>
</container>
`;

// XHTML 章节模板
const content_xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title></title>
  <link rel="stylesheet" type="text/css" href="../Style/style.css" />
</head>
<body>
  <section>
    <h3></h3>
  </section>
</body>
</html>
`;

// EPUB2 章节模板：EPUB2 基于 XHTML 1.1，不能使用 HTML5 的 <section>
const content_xhtml_epub2 = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title></title>
  <link rel="stylesheet" type="text/css" href="../Style/style.css" />
</head>
<body>
  <div class="chapter">
    <h3></h3>
  </div>
</body>
</html>
`;

// EPUB3 nav.xhtml 导航模板
const nav_xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>ePub Nav</title>
    <style type="text/css">
      ol { list-style-type: none; margin: 0; padding: 0; }
      li { margin: 0.2em 0; }
    </style>
  </head>
  <body epub:type="frontmatter">
    <nav epub:type="toc" id="toc">
    </nav>
  </body>
</html>`;

// EPUB2 NCX 导航模板
const ncx_template = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content=""/>
    <meta name="dtb:depth" content="2"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text></text>
  </docTitle>
  <navMap>
  </navMap>
</ncx>`;

// 中文数字 → 阿拉伯数字（处理卷号，如 "第一卷" → "第1卷"）
const CN_NUMS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };

function cnToArabic(cn) {
  let result = 0;
  let temp = 0;
  for (const ch of cn) {
    const n = CN_NUMS[ch];
    if (n === undefined) return null;
    if (n >= 10) {
      temp = (temp || 1) * n;
      if (n >= 100) { result += temp; temp = 0; }
    } else {
      temp += n;
    }
  }
  return result + temp;
}

function convertCnNumerals(text) {
  return text.replace(/[零一二三四五六七八九十百千]+/g, (match) => {
    const n = cnToArabic(match);
    return n !== null ? String(n) : match;
  });
}

// 只转换"第X卷/册/部/篇"里的卷号，用于让阅读器正确排序。
// 注意：绝不能拿它去处理书名 —— "三体" 会变成 "3体"、"四月是你的谎言" 会变成 "4月是你的谎言"。
function convertVolumeNumeral(text) {
  return String(text ?? '').replace(/第([零一二三四五六七八九十百千]+)(?=[卷册部篇])/g, (whole, cn) => {
    const n = cnToArabic(cn);
    return n === null ? whole : `第${n}`;
  });
}

// 从卷名里取出卷号："第十二卷" → 12；取不到返回 null。
// 用于给阅读器写系列序号（group-position / calibre:series_index）。
function parseVolumeNumber(volumeName) {
  const match = /第([零一二三四五六七八九十百千]+)[卷册部篇]/.exec(String(volumeName ?? ''));
  if (match) {
    const n = cnToArabic(match[1]);
    if (n !== null) return n;
  }
  const arabic = /(\d+)/.exec(String(volumeName ?? ''));
  return arabic ? Number(arabic[1]) : null;
}

// 把 "1,3-5" 这类下标表达式解析成 0 基下标数组。
// 'all' / '' / '*' 返回 null 表示"全部"。总数为 0 或全部越界都会抛错。
// 分卷（--volumes）与章节（--chapters）共用同一套语法。
function parseIndexSpec(spec, total, label = '范围') {
  const raw = String(spec ?? 'all').trim().toLowerCase();
  if (!raw || raw === 'all' || raw === '*') return null;

  const picked = new Set();
  for (const chunk of raw.split(',')) {
    const part = chunk.trim();
    if (!part) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) picked.add(i);
      continue;
    }
    if (/^\d+$/.test(part)) {
      picked.add(Number(part));
      continue;
    }
    throw new Error(`无法识别的${label}写法：${part}（支持 1,3-5 或 all）`);
  }

  const indices = [...picked].filter(n => n >= 1 && n <= total).map(n => n - 1).sort((a, b) => a - b);
  if (indices.length === 0) {
    throw new Error(`${label}没有匹配到任何条目（总共 ${total} 项）`);
  }
  return indices;
}

// 把若干下标压缩成紧凑标签，用于文件名："1,2,3,7" → "1-3,7"
function formatIndexLabel(indices) {
  if (!indices || indices.length === 0) return '';
  const nums = [...indices].map(n => n + 1).sort((a, b) => a - b);
  const parts = [];
  let start = nums[0];
  let prev = nums[0];

  for (let i = 1; i <= nums.length; i++) {
    const cur = nums[i];
    if (cur !== prev + 1) {
      parts.push(start === prev ? String(start) : `${start}-${prev}`);
      start = cur;
    }
    prev = cur;
  }
  return parts.join(',');
}

// 默认输出目录。真实的输出目录由 RunContext 持有并逐层显式传递，
// 这里不再保留可变的模块级单例（那样会让同进程内的并发任务互相覆盖）。
const DEFAULT_OUTPUT_DIR = 'output';

// XML 文本转义：卷名/书名直接拼进 XHTML 时必须转义
function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  MIME_MAP,
  SUPPORTED_COVER_EXTS,
  PROJECT_ROOT,
  DEFAULT_OUTPUT_DIR,
  getMimeType,
  sanitizeFilename,
  escapeXml,
  getRandomUserAgent,
  convertCnNumerals,
  convertVolumeNumeral,
  parseVolumeNumber,
  parseIndexSpec,
  formatIndexLabel,
  content_opf,
  content_opf_epub2,
  container_xml,
  content_xhtml,
  content_xhtml_epub2,
  nav_xhtml,
  ncx_template,
};
