const path = require('path');

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

module.exports = {
  MIME_MAP,
  SUPPORTED_COVER_EXTS,
  getMimeType,
  getRandomUserAgent,
  convertCnNumerals,
  content_opf,
  content_opf_epub2,
  container_xml,
  content_xhtml,
  nav_xhtml,
  ncx_template,
};
