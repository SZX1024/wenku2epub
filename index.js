const axios = require('axios');
const iconv = require('iconv-lite');
const JsZip = require('jszip');
const cheerio = require('cheerio');
const fs = require('fs');
const { input, select, checkbox } = require('@inquirer/prompts');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const xmlFormatter = require('xml-formatter');
const beautify = require('js-beautify').html;

// 引入 p-limit 控制并发
const { default: pLimit } = require('p-limit');

// 降低并发数，从1开始测试
const imgLimit = pLimit(3);
const chapterLimit = pLimit(1);
let delayOrNot = false; // 是否启用请求延迟
// 随机延迟函数，避免规律性请求
async function delay() {
  // 基础延迟0.5秒，随机增加0-0.5秒，总延迟0.5-1秒
  const baseDelay = 500;
  const randomDelay = Math.floor(Math.random() * 500);
  const totalDelay = baseDelay + randomDelay;
  return new Promise(resolve => setTimeout(resolve, totalDelay));
}

// ========== 进度条（TUI） ==========
class ProgressBar {
  constructor(total, title = '进度') {
    this.total = total;
    this.current = 0;
    this.title = title;
    this.startTime = Date.now();
    this.width = 40; // 进度条宽度
  }

  tick(msg = '') {
    this.current++;
    this.render(msg);
  }

  render(msg = '') {
    const pct = this.total > 0 ? Math.min(100, Math.floor(this.current / this.total * 100)) : 0;
    const filled = Math.floor(pct / 100 * this.width);
    const empty = this.width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const remaining = pct > 0 ? ` 剩余约${((Date.now() - this.startTime) / pct * (100 - pct) / 1000).toFixed(0)}s` : '';
    const displayMsg = msg ? ` ${msg}` : '';
    process.stdout.write(`\r\x1b[K${this.title} [${bar}] ${pct}% (${this.current}/${this.total}) ${elapsed}s${remaining}${displayMsg}`);
  }

  complete(msg = '') {
    this.current = this.total;
    this.render(msg);
    process.stdout.write('\n');
  }
}

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
  const ext = require('path').extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'image/jpeg';
}

// 扩展User-Agent列表，增加多样性
function getRandomUserAgent() {
  const uas = [
    // PC端浏览器
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/130.0.0.0 Safari/537.36',

    // 移动端浏览器
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
    'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',

    // 小众浏览器
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Vivaldi/6.5.3206.53 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Brave/131.0.0.0 Safari/537.36'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

// container.xml 文件内容
const container_xml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
   </rootfiles>
</container>
`;

// OPF 文件内容
const content_opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="PrimaryID">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title></dc:title>
    <dc:identifier opf:scheme="ISBN"/>
    <dc:language>zh-CN</dc:language>
    <dc:creator></dc:creator>
    <dc:description></dc:description>
  </metadata>
  <manifest>
  </manifest>
  <spine toc="ncx">
  </spine>
</package>
`;

// XHTML 文件模板
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

// nav.xhtml 导航文件内容
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

// 带重试机制的请求函数，处理429错误
async function fetchWithRetry(url, maxRetries = 3) {
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      if (delayOrNot) await delay(); // 每次请求前先延迟
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
          'Connection': 'keep-alive',
          'Referer': 'https://www.wenku8.net/',
          'DNT': '1',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1'
        },
        timeout: 15000
      });

      const decodedData = iconv.decode(Buffer.from(response.data), 'GBK');
      return cheerio.load(decodedData);
    } catch (error) {
      // 处理429错误
      if (error.response?.status === 429) {
        // 从响应头获取建议的重试时间，默认5秒
        const retryAfter = parseInt(error.response.headers['retry-after']) || 5;
        console.warn(`请求 ${url} 被限流（429），将在 ${retryAfter} 秒后重试（第 ${retry+1}/${maxRetries} 次）`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        console.error(`请求 ${url} 失败（非429）：`, error.message);
        break;
      }
    }
  }
  console.error(`请求 ${url} 重试 ${maxRetries} 次后仍失败`);
  return null;
}

// 获取网页内容的函数（使用带重试的请求）
async function ask(url) {
  return fetchWithRetry(url);
}

// 获取小说信息
async function getBookInfo(url, json) {
  const $ = await ask(url);
  if ($) {
    let titles, authors, intro, chapurl, coverUrl;
    const patt = new RegExp('(.*)\\x20-\\x20(.*)\\x20-\\x20(.*)\\x20-\\x20(.*)');
    const match = patt.exec($('title').text());
    if (match) {
      titles = match[1];
      authors = match[2];
    }

    $('span[style="font-size:14px;"]').each((i, elem) => {
      intro = $(elem).text().trim();
    });

    $('a').each((i, elem) => {
      if ($(elem).text().trim() === '小说目录') {
        const href = $(elem).attr('href');
        if (href) {
          chapurl = new URL(href, url).href;
        }
      }
    });

    // 提取封面图片 URL（查找页面中的封面图片）
    $('img').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src && !coverUrl) {
        // 优先匹配包含 cover 的路径，否则取第一张大图
        const absSrc = new URL(src, url).href;
        if (/cover|fengmian|fm/i.test(src)) {
          coverUrl = absSrc;
          return false; // break
        }
        if (!coverUrl) coverUrl = absSrc;
      }
    });

    json.titles = titles;
    json.authors = authors;
    json.intro = intro || '暂无简介';
    json.coverUrl = coverUrl || null;
    json.content = {};
    if (chapurl) {
      await getChapList(chapurl, json);
    }
  }
}

// 获取章节列表
async function getChapList(url, json) {
  const $ = await ask(url);
  if ($) {
    let key;
    let p = 0;
    let v = -1;
    const patt = /(.*)index\.htm/;
    const realur = patt.exec(url)[1];

    $('td').each((i, elem) => {
      const $elem = $(elem);
      if ($elem.attr('class') === 'vcss') {
        v++;
        key = $elem.text().trim();
        json.content[v] = { volume: key, chapters: {} };
        p = 0;
      } else if ($elem.attr('class') === 'ccss' && $elem.find('a').length > 0) {
        const link = $elem.find('a').first();
        const title = link.text().trim();
        const href = realur + link.attr('href');
        json.content[v].chapters[p] = { title, href };
        p++;
      }
    });
  }
}

// 带重试机制的图片下载函数
async function getImgWithRetry(src, volume, chapter, j, book, maxRetries = 3) {
  const imgname = `${volume}_${chapter}_${j}.jpg`;
  const imgpath = `OEBPS/Image/${imgname}`;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      //await delay(); // 图片请求前的延迟
      const response = await axios.get(src, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Referer': 'https://www.wenku8.net/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
          // 已移除Cookie配置
        },
        timeout: 15000
      });
      book.file(imgpath, response.data);
      return; // 下载成功，退出函数
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after']) || 5;
        console.warn(`图片 ${src} 被限流（429），将在 ${retryAfter} 秒后重试（第 ${retry+1}/${maxRetries} 次）`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        console.error(`图片 ${src} 下载失败（非429）：`, error.message);
        break;
      }
    }
  }
  console.error(`图片 ${src} 重试 ${maxRetries} 次后仍失败`);
}

// 下载封面图片（从 wenku8 或本地文件）
async function downloadCover(coverUrl) {
  try {
    const response = await axios.get(coverUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Referer': 'https://www.wenku8.net/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
      },
      timeout: 15000
    });
    const ext = require('path').extname(new URL(coverUrl).pathname).toLowerCase();
    const validExt = SUPPORTED_COVER_EXTS.includes(ext) ? ext : '.jpg';
    return { data: Buffer.from(response.data), ext: validExt };
  } catch (err) {
    console.warn(`封面下载失败: ${err.message}`);
    return null;
  }
}

// 从本地文件读取封面
function readCoverFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`封面文件不存在: ${filePath}`);
    return null;
  }
  const ext = require('path').extname(filePath).toLowerCase();
  if (!SUPPORTED_COVER_EXTS.includes(ext)) {
    console.warn(`不支持的封面格式: ${ext}，支持: ${SUPPORTED_COVER_EXTS.join(', ')}`);
    return null;
  }
  return { data: fs.readFileSync(filePath), ext };
}

// 创建章节文本内容
async function creatText(book, json, selectedVolumes = null, progress = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  json.imgs = {};

  // 使用一个共享的图片计数器对象
  const imgCounter = { count: 0 };

  // 收集所有章节的处理任务
  const chapterPromises = [];

  for (const volume in json.content) {
    // 如果指定了分卷选择，跳过未选中的卷
    if (selectedVolumes && !selectedVolumes.includes(Number(volume))) continue;

    for (const chapter in json.content[volume].chapters) {
      const { title, href } = json.content[volume].chapters[chapter];

      // 使用并发控制器包装章节处理函数
      const promise = chapterLimit(() => processChapter(book, json, volume, chapter, title, href, parser, serializer, imgCounter, progress));
      chapterPromises.push(promise);
    }
  }

  // 等待所有章节处理完成
  await Promise.all(chapterPromises);
}

// 章节处理函数
async function processChapter(book, json, volume, chapter, title, href, parser, serializer, imgCounter, progress = null) {
  const $ = await ask(href);
  if (!$) return;

  const content = $('#content');
  if (!content.length) return;

  const xhtml = parser.parseFromString(content_xhtml, 'application/xhtml+xml');
  xhtml.getElementsByTagName('title')[0].textContent = title;
  xhtml.getElementsByTagName('h3')[0].textContent = title;

  content.contents().each((index, element) => {
    if (element.type === 'text' && element.data.trim() !== '') {
      const p = xhtml.createElement('p');
      p.textContent = $(element).text().trim();
      xhtml.getElementsByTagName('section')[0].appendChild(p);
    }
  });

  const imgs = content.find('img');
  const imgPromises = [];
  imgs.each((j, img) => {
    const src = $(img).attr('src');
    if (!src) return;
    const absSrc = new URL(src, href).href;

    // 获取并递增图片计数
    const currentImgCount = imgCounter.count++;
    const imgname = `${volume}_${chapter}_${currentImgCount}.jpg`;
    json.imgs[imgname] = { imgname };

    const imgTag = xhtml.createElement('img');
    imgTag.setAttribute('src', `../Image/${imgname}`);
    xhtml.getElementsByTagName('section')[0].appendChild(imgTag);

    imgPromises.push(
      imgLimit(() => getImgWithRetry(absSrc, volume, chapter, currentImgCount, book))
    );
  });

  await Promise.all(imgPromises);

  const formattedXhtml = beautify(serializer.serializeToString(xhtml), { indent_size: 2 });
  book.file(`OEBPS/Text/${volume}_${chapter}.xhtml`, Buffer.from(iconv.encode(formattedXhtml, 'utf-8')));

  if (progress) progress.tick(title);
}

// 创建 OPF 文件
async function creatOpf(book, json, selectedVolumes = null, coverExt = '.jpg') {
  const parser = new DOMParser();
  const opf = parser.parseFromString(content_opf, 'text/xml');

  opf.getElementsByTagName('dc:title')[0].textContent = json.titles;
  opf.getElementsByTagName('dc:creator')[0].textContent = json.authors;
  opf.getElementsByTagName('dc:description')[0].textContent = json.intro;

  // 添加封面、CSS、nav 等资源
  const manifest = opf.getElementsByTagName('manifest')[0];
  const spine = opf.getElementsByTagName('spine')[0];

  const addItem = (id, href, mediaType, properties = null) => {
    const item = opf.createElement('item');
    item.setAttribute('id', id);
    item.setAttribute('href', href);
    item.setAttribute('media-type', mediaType);
    if (properties) item.setAttribute('properties', properties);
    manifest.appendChild(item);
  };

  const coverMime = MIME_MAP[coverExt] || 'image/jpeg';
  addItem('cover', `Image/cover${coverExt}`, coverMime);
  addItem('style.css', 'Style/style.css', 'text/css');
  addItem('nav', 'nav.xhtml', 'application/xhtml+xml', 'nav');

  // 添加章节和图片
  for (const volume in json.content) {
    // 如果指定了分卷选择，跳过未选中的卷
    if (selectedVolumes && !selectedVolumes.includes(Number(volume))) continue;

    for (const chapter in json.content[volume].chapters) {
      addItem(`Text/${volume}_${chapter}.xhtml`, `Text/${volume}_${chapter}.xhtml`, 'application/xhtml+xml');
      const itemref = opf.createElement('itemref');
      itemref.setAttribute('idref', `Text/${volume}_${chapter}.xhtml`);
      spine.appendChild(itemref);
    }
  }

  for (const i in json.imgs) {
    const { imgname } = json.imgs[i];
    addItem(`Image/${imgname}`, `Image/${imgname}`, 'image/jpeg');
  }

  const formattedOpf = xmlFormatter(new XMLSerializer().serializeToString(opf), { indentation: '  ' });
  book.file('OEBPS/content.opf', formattedOpf);
}

// 创建导航文件 nav.xhtml
async function creatNav(book, json, selectedVolumes = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const nav = parser.parseFromString(nav_xhtml, 'text/xml');
  const ol = nav.createElement('ol');

  for (const volume in json.content) {
    // 如果指定了分卷选择，跳过未选中的卷
    if (selectedVolumes && !selectedVolumes.includes(Number(volume))) continue;

    const volData = json.content[volume];
    const li = nav.createElement('li');
    const a = nav.createElement('a');
    a.setAttribute('href', `Text/${volume}_0.xhtml`);
    a.textContent = volData.volume;
    li.appendChild(a);

    const nestedOl = nav.createElement('ol');
    for (const chapter in volData.chapters) {
      const chData = volData.chapters[chapter];
      const nestedLi = nav.createElement('li');
      const nestedA = nav.createElement('a');
      nestedA.setAttribute('href', `Text/${volume}_${chapter}.xhtml`);
      nestedA.textContent = chData.title;
      nestedLi.appendChild(nestedA);
      nestedOl.appendChild(nestedLi);
    }
    li.appendChild(nestedOl);
    ol.appendChild(li);
  }

  nav.getElementById('toc').appendChild(ol);
  const formattedNav = beautify(serializer.serializeToString(nav), { indent_size: 2 });
  book.file('OEBPS/nav.xhtml', Buffer.from(iconv.encode(formattedNav, 'utf-8')));
}

// 创建完整 EPUB 压缩包
async function creatEpub(json, selectedVolumes = null, coverInfo = null, progress = null) {
  const book = new JsZip();

  book.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  book.folder('META-INF').file('container.xml', container_xml);
  book.folder('OEBPS');
  book.folder('OEBPS/Image');
  book.folder('OEBPS/Text');
  book.folder('OEBPS/Style');

  // 确定封面
  let coverExt = '.jpg';
  if (coverInfo && coverInfo.data) {
    coverExt = coverInfo.ext;
    book.file(`OEBPS/Image/cover${coverExt}`, coverInfo.data);
    if (progress) progress.render('封面已就绪');
  } else {
    // 兼容旧行为：检查本地 cover.* 文件
    const localCover = SUPPORTED_COVER_EXTS.map(ext => `./cover${ext}`).find(p => fs.existsSync(p));
    if (localCover) {
      coverExt = require('path').extname(localCover).toLowerCase();
      book.file(`OEBPS/Image/cover${coverExt}`, fs.readFileSync(localCover));
    } else {
      console.warn('⚠️  未提供封面图片');
    }
  }

  if (fs.existsSync('style.css')) {
    book.file('OEBPS/Style/style.css', fs.readFileSync('style.css'));
  }

  await creatNav(book, json, selectedVolumes);
  await creatText(book, json, selectedVolumes, progress);
  await creatOpf(book, json, selectedVolumes, coverExt);

  return book;
}

// 主入口函数
async function scraper(url, selectedVolumes = null, coverInfo = null) {
  const json = {};
  await getBookInfo(url, json);
  if (!json.titles) {
    console.error('未能获取书籍标题，可能网址无效或页面结构变化。');
    return;
  }

  // 统计总章节数用于进度条
  let totalChapters = 0;
  for (const v in json.content) {
    if (selectedVolumes && !selectedVolumes.includes(Number(v))) continue;
    totalChapters += Object.keys(json.content[v].chapters).length;
  }
  const progress = new ProgressBar(totalChapters, '📖 下载进度');

  const book = await creatEpub(json, selectedVolumes, coverInfo, progress);
  return book.generateAsync({ type: 'nodebuffer' }).then(content => {
    progress.complete('打包完成');
    // 如果选择了分卷，文件名加上卷信息
    let filename;
    if (selectedVolumes) {
      const volNames = selectedVolumes.map(v => json.content[v].volume).join('_');
      filename = `${json.titles}_${volNames}.epub`.replace(/[<>:"/\\|?*]/g, '_');
    } else {
      filename = `${json.titles}.epub`.replace(/[<>:"/\\|?*]/g, '_');
    }
    fs.writeFileSync(filename, content);
    console.log(`✅ EPUB 文件已生成：${filename}`);
  });
}

// ========== TUI 交互式入口 ==========
(async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     📚 轻小说文库 EPUB 下载器       ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    // 第一步：输入网址
    const url = await input({
      message: '请输入小说网址（如 https://www.wenku8.net/book/xxx.htm）：',
      validate: (value) => {
        if (!value.trim()) return '网址不能为空';
        if (!value.includes('wenku8')) return '请输入有效的 wenku8 网址';
        return true;
      }
    });

    console.log('\n⏳ 正在获取书籍信息...\n');

    // 先获取书籍信息
    const json = {};
    await getBookInfo(url, json);

    if (!json.titles) {
      console.error('❌ 未能获取书籍标题，可能网址无效或页面结构变化。');
      return;
    }

    // 显示书籍信息
    console.log('┌─────────────────────────────────────┐');
    console.log(`│  书名：${json.titles.slice(0, 26).padEnd(26)}│`);
    console.log(`│  作者：${(json.authors || '未知').slice(0, 26).padEnd(26)}│`);
    console.log('└─────────────────────────────────────┘\n');

    // 第二步：选择分卷
    const volumeChoices = [];
    for (const v in json.content) {
      const volData = json.content[v];
      const chapterCount = Object.keys(volData.chapters).length;
      volumeChoices.push({
        name: `${volData.volume}（${chapterCount} 章）`,
        value: Number(v),
        checked: true  // 默认全选
      });
    }

    const selectedVolumes = await checkbox({
      message: '请选择要下载的分卷（空格选择/取消，回车确认）：',
      choices: volumeChoices,
      pageSize: 15,
      instructions: '（使用 ↑↓ 移动，空格 选择，回车 确认）'
    });

    if (selectedVolumes.length === 0) {
      console.log('❌ 未选择任何分卷，退出。');
      return;
    }

    // 第三步：选择是否启用延迟
    const delayChoice = await select({
      message: '是否启用请求延迟（推荐启用，防止被限流）：',
      choices: [
        { name: '✅ 是（启用延迟，速度较慢但更稳定）', value: 'y' },
        { name: '❌ 否（不启用延迟，速度较快但可能被限流）', value: 'n' }
      ],
      default: 'y'
    });
    delayOrNot = (delayChoice === 'y');

    // 第四步：选择封面来源
    const coverChoices = [];
    if (json.coverUrl) {
      coverChoices.push({
        name: `🌐 从网站下载封面（${json.coverUrl.slice(0, 50)}...）`,
        value: 'web'
      });
    }
    coverChoices.push(
      { name: '� 从自定义链接下载封面', value: 'url' },
      { name: '📁 输入本地图片文件路径', value: 'local' },
      { name: '⏭️  跳过封面', value: 'skip' }
    );

    const coverChoice = await select({
      message: '请选择封面图片来源：',
      choices: coverChoices,
      default: json.coverUrl ? 'web' : 'url'
    });

    let coverInfo = null;
    if (coverChoice === 'web' && json.coverUrl) {
      console.log('\n⏳ 正在下载封面...');
      coverInfo = await downloadCover(json.coverUrl);
      if (coverInfo) {
        console.log('✅ 封面下载成功');
      } else {
        console.warn('⚠️  封面下载失败，将不添加封面');
      }
    } else if (coverChoice === 'url') {
      const customUrl = await input({
        message: '请输入封面图片链接：',
        validate: (value) => {
          if (!value.trim()) return '链接不能为空';
          if (!/^https?:\/\//.test(value.trim())) return '请输入有效的 http/https 链接';
          return true;
        }
      });
      console.log('\n⏳ 正在下载封面...');
      coverInfo = await downloadCover(customUrl.trim());
      if (coverInfo) {
        console.log('✅ 封面下载成功');
      } else {
        console.warn('⚠️  封面下载失败，将不添加封面');
      }
    } else if (coverChoice === 'local') {
      const localPath = await input({
        message: '请输入封面图片路径（支持 jpg/png/gif/webp/bmp/svg）：',
        validate: (value) => {
          if (!value.trim()) return '路径不能为空';
          return true;
        }
      });
      coverInfo = readCoverFromFile(localPath.trim());
      if (coverInfo) {
        console.log('✅ 封面读取成功');
      }
    }

    // 如果全选了所有卷，传 null 表示全本下载
    const allSelected = selectedVolumes.length === Object.keys(json.content).length;
    const volsToDownload = allSelected ? null : selectedVolumes;

    console.log('\n🚀 开始下载...\n');
    await scraper(url, volsToDownload, coverInfo);
    console.log('\n🎉 全部完成！');
  } catch (err) {
    console.error('❌ 程序出错：', err);
  }
})();
