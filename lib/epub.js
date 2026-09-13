const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const JsZip = require('jszip');
const iconv = require('iconv-lite');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const xmlFormatter = require('xml-formatter');
const beautify = require('js-beautify').html;
const { default: pLimit } = require('p-limit');
const {
  MIME_MAP,
  SUPPORTED_COVER_EXTS,
  PROJECT_ROOT,
  escapeXml,
  convertVolumeNumeral,
  parseVolumeNumber,
  content_opf,
  content_opf_epub2,
  container_xml,
  content_xhtml,
  content_xhtml_epub2,
  nav_xhtml,
  ncx_template,
} = require('./config');
const { askChapter, fetchImage } = require('./fetch');
const { extractChapterContent } = require('./parse');
const { imageDimensions, pixelCount } = require('./cover');

// 章节默认串行（对站点最友好），可通过 setConcurrency / --concurrency 提高
let imgLimit = pLimit(3);
let chapterLimit = pLimit(1);

const MAX_CONCURRENCY = 8;

// style.css 是程序自带资源，必须相对项目根目录解析，不能依赖 cwd
const STYLE_SOURCE = path.join(PROJECT_ROOT, 'style.css');

const COVER_PAGE = 'cover.xhtml';

// ── 可选的图片压缩 ──
// sharp 是可选依赖：装了才启用有损压缩，没装就只做内容去重，不影响其他功能。
let sharpModule;
let sharpChecked = false;

function getSharp() {
  if (!sharpChecked) {
    sharpChecked = true;
    try {
      sharpModule = require('sharp');
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

function warnSharpMissing() {
  if (getSharp()) return false;
  console.warn('\n⚠️  未安装 sharp，--compress-images 已跳过（只做去重）。安装后可启用：npm install sharp');
  return true;
}

async function compressImage(data, quality) {
  const sharp = getSharp();
  if (!sharp) return null;

  try {
    return await sharp(data).jpeg({ quality, mozjpeg: true }).toBuffer();
  } catch (err) {
    console.warn(`\n图片压缩失败（已忽略）: ${err.message}`);
    return null;
  }
}

function clampConcurrency(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n)));
}

function setConcurrency({ chapters, images } = {}) {
  if (chapters !== undefined) chapterLimit = pLimit(clampConcurrency(chapters, 1));
  if (images !== undefined) imgLimit = pLimit(clampConcurrency(images, 3));
}

function getConcurrency() {
  return { chapters: chapterLimit.concurrency, images: imgLimit.concurrency };
}

// manifest 的 id 必须是合法 NCName（不能含 "/"），所以不能拿文件路径当 id
function itemId(prefix, value) {
  return `${prefix}-${String(value).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

function chapterFileName(volume, chapter) {
  return `${volume}_${chapter}.xhtml`;
}

// 每卷一个独立的卷首页：它让卷节点拥有自己的跳转目标，
// 于是目录里"卷"与"本卷第一章"不再指向同一个文件。
function volumePageName(volume) {
  return `vol_${volume}.xhtml`;
}

function xhtmlShell({ title, epubVersion, body, extraStyle = '' }) {
  const doctype = epubVersion === 2
    ? '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">'
    : '<!DOCTYPE html>';
  const langAttr = epubVersion === 2
    ? 'xml:lang="zh-CN"'
    : 'lang="zh-CN" xml:lang="zh-CN"';

  return `<?xml version="1.0" encoding="utf-8"?>
${doctype}
<html xmlns="http://www.w3.org/1999/xhtml" ${langAttr}>
<head>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="../Style/style.css" />
  <style type="text/css">
${extraStyle}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function buildCoverPage(coverExt, epubVersion) {
  const style = `    html, body { margin: 0; padding: 0; height: 100%; }
    body { text-align: center; }
    img { max-width: 100%; max-height: 100%; }`;
  const body = `  <div class="cover">
    <img src="../Image/cover${coverExt}" alt="封面" />
  </div>`;
  return xhtmlShell({ title: '封面', epubVersion, body, extraStyle: style });
}

function buildVolumePage(volumeName, epubVersion) {
  const style = `    body { text-align: center; margin-top: 30%; }
    h1 { font-size: 2em; }`;
  const body = `  <div class="volume-title">
    <h1>${escapeXml(volumeName)}</h1>
  </div>`;
  return xhtmlShell({ title: volumeName, epubVersion, body, extraStyle: style });
}

// 只返回"确实成功写出了章节"的卷。
// 目录与 spine 必须以实际产物为准，否则一次网络抖动就会留下指向空文件的断链。
function writtenVolumes(json, selectedVolumes = null) {
  const candidates = selectedVolumes || Object.keys(json.content).map(Number);
  return candidates.filter(v => {
    const list = json._written?.[v];
    return Array.isArray(list) && list.length > 0;
  });
}

// 图片名形如 "0_13_2.jpg"，按 卷/章/序号 排序，保证并发下的顺序可复现
function compareImageNames(a, b) {
  const parse = name => String(name).replace(/\.[^.]+$/, '').split('_').map(Number);
  const [av, ac, ai] = parse(a);
  const [bv, bc, bi] = parse(b);
  return (av - bv) || (ac - bc) || (ai - bi);
}

// ── 章节处理 ──

async function processChapter(ctx, volume, chapter, title, href) {
  const { book, json, parser, serializer, progress, epubVersion, imgCounter } = ctx;

  const $ = await askChapter(href);
  if (!$) return { ok: false, reason: '页面请求失败' };

  const content = $('#content');
  if (!content.length) return { ok: false, reason: '页面结构异常（未找到 #content）' };

  const template = epubVersion === 2 ? content_xhtml_epub2 : content_xhtml;
  const rootTag = epubVersion === 2 ? 'div' : 'section';
  const xhtml = parser.parseFromString(template, 'application/xhtml+xml');

  const container = xhtml.getElementsByTagName(rootTag)[0];
  const titleEl = xhtml.getElementsByTagName('title')[0];
  const headingEl = xhtml.getElementsByTagName('h3')[0];
  if (!container || !titleEl || !headingEl) return { ok: false, reason: '章节模板解析失败' };

  titleEl.textContent = title;
  headingEl.textContent = title;

  // 按文档顺序落地：段落和插图保持原有先后关系，插图不再被统一挤到章末
  const pending = [];
  for (const item of extractChapterContent($, content)) {
    if (item.type === 'text') {
      const p = xhtml.createElement('p');
      p.textContent = item.text;
      container.appendChild(p);
      continue;
    }

    const src = $(item.el).attr('src');
    if (!src) continue;

    let absSrc;
    try {
      absSrc = new URL(src, href).href;
    } catch {
      continue;
    }

    const imgIndex = imgCounter.count++;
    const imgname = `${volume}_${chapter}_${imgIndex}.jpg`;
    const imgTag = xhtml.createElement('img');
    imgTag.setAttribute('src', `../Image/${imgname}`);
    imgTag.setAttribute('alt', '');
    container.appendChild(imgTag);
    pending.push({ imgname, absSrc, imgTag, index: imgIndex });
  }

  const results = await Promise.all(pending.map(entry => imgLimit(async () => {
    const raw = await fetchImage(entry.absSrc);
    if (!raw) return { entry, ok: false };

    let data = raw;
    if (ctx.compressImages) {
      const compressed = await compressImage(raw, ctx.imageQuality);
      if (compressed) data = compressed;
    }

    return { entry, ok: true, data, hash: crypto.createHash('sha1').update(data).digest('hex') };
  })));

  // 去重判定放在这个同步循环里做，才能避免并发章节同时"未命中"而写两份同样的图
  const stored = [];
  for (const result of results) {
    const { entry } = result;

    // 下载失败的图片：连 <img> 标签一起摘掉，不留断链
    if (!result.ok) {
      if (entry.imgTag.parentNode) entry.imgTag.parentNode.removeChild(entry.imgTag);
      continue;
    }

    const existing = ctx.dedupeImages ? ctx.imageStore.get(result.hash) : null;
    if (existing) {
      // 内容与已有插图完全一致：复用它的文件，不再新增 manifest 条目
      entry.imgTag.setAttribute('src', `../Image/${existing}`);
      continue;
    }

    ctx.imageStore.set(result.hash, entry.imgname);
    book.file(`OEBPS/Image/${entry.imgname}`, result.data);
    json.imgs[entry.imgname] = { imgname: entry.imgname };
    json.imgInfo[entry.imgname] = imageDimensions(result.data);
    stored.push(entry.imgname);
  }

  const formattedXhtml = beautify(serializer.serializeToString(xhtml), { indent_size: 2 });
  book.file(`OEBPS/Text/${chapterFileName(volume, chapter)}`, Buffer.from(iconv.encode(formattedXhtml, 'utf-8')));

  if (progress) progress.tick(title);
  return { ok: true, images: stored };
}

// ── 章节批量生成 ──

async function creatText(book, json, selectedVolumes = null, progress = null, epubVersion = 3, {
  chapterSelection = null,
  dedupeImages = true,
  compressImages = false,
  imageQuality = 82,
} = {}) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  json.imgs = {};       // 真正下载成功的插图 { imgname: { imgname } }
  json.imgInfo = {};    // { imgname: { width, height } }，用于挑最高清的封面
  json._volImgs = {};   // { volIdx: [imgname, ...] }
  json._written = {};   // { volIdx: [chapterIdx, ...] } 只记录写成功的章节
  json.skipped = [];    // 失败清单，供上层告警

  if (compressImages) warnSharpMissing();

  const ctx = {
    book, json, parser, serializer, progress, epubVersion,
    imgCounter: { count: 0 },
    dedupeImages,
    compressImages,
    imageQuality,
    imageStore: new Map(),  // content hash -> imgname
  };

  const tasks = [];
  for (const volume in json.content) {
    if (selectedVolumes && !selectedVolumes.includes(Number(volume))) continue;

    const volIdx = Number(volume);
    json._volImgs[volIdx] = [];
    json._written[volIdx] = [];
    const allowedChapters = chapterSelection ? (chapterSelection[volIdx] || []) : null;

    for (const chapter in json.content[volume].chapters) {
      const chapterIdx = Number(chapter);
      // 章节粒度过滤：只有被选中的章节才会进入下载队列
      if (allowedChapters && !allowedChapters.includes(chapterIdx)) continue;

      const { title, href } = json.content[volume].chapters[chapter];
      tasks.push(chapterLimit(async () => {
        const result = await processChapter(ctx, volIdx, chapterIdx, title, href);
        if (result.ok) {
          json._written[volIdx].push(chapterIdx);
          json._volImgs[volIdx].push(...result.images);
        } else {
          json.skipped.push({ volume: volIdx, chapter: chapterIdx, title, reason: result.reason });
        }
      }));
    }
  }

  await Promise.all(tasks);

  for (const key in json._written) {
    json._written[key].sort((a, b) => a - b);
  }
  for (const key in json._volImgs) {
    json._volImgs[key].sort(compareImageNames);
  }
}

// ── EPUB3 nav.xhtml ──

async function creatNav(book, json, selectedVolumes = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const nav = parser.parseFromString(nav_xhtml, 'text/xml');
  const toc = nav.getElementById('toc');
  if (!toc) return;

  const ol = nav.createElement('ol');

  for (const volume of writtenVolumes(json, selectedVolumes)) {
    const volData = json.content[volume];
    const chapters = json._written[volume];

    const li = nav.createElement('li');
    const a = nav.createElement('a');
    // 指向独立的卷首页，而不是本卷第一章
    a.setAttribute('href', `Text/${volumePageName(volume)}`);
    a.textContent = convertVolumeNumeral(volData.volume);
    li.appendChild(a);

    const nestedOl = nav.createElement('ol');
    for (const chapter of chapters) {
      const chData = volData.chapters[chapter];
      if (!chData) continue;
      const nestedLi = nav.createElement('li');
      const nestedA = nav.createElement('a');
      nestedA.setAttribute('href', `Text/${chapterFileName(volume, chapter)}`);
      nestedA.textContent = chData.title;
      nestedLi.appendChild(nestedA);
      nestedOl.appendChild(nestedLi);
    }
    li.appendChild(nestedOl);
    ol.appendChild(li);
  }

  toc.appendChild(ol);
  const formattedNav = beautify(serializer.serializeToString(nav), { indent_size: 2 });
  book.file('OEBPS/nav.xhtml', Buffer.from(iconv.encode(formattedNav, 'utf-8')));
}

// ── EPUB2 toc.ncx ──

async function creatNcx(book, json, selectedVolumes = null, uuid = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const ncx = parser.parseFromString(ncx_template, 'text/xml');
  const navMap = ncx.getElementsByTagName('navMap')[0];
  if (!navMap) return;

  const uidMeta = ncx.getElementsByTagNameNS('http://www.daisy.org/z3986/2005/ncx/', 'meta');
  for (let i = 0; i < uidMeta.length; i++) {
    if (uidMeta[i].getAttribute('name') === 'dtb:uid') {
      uidMeta[i].setAttribute('content', uuid || '');
      break;
    }
  }

  const titleNode = ncx.getElementsByTagName('text')[0];
  if (titleNode) titleNode.textContent = json.titles;

  // 卷节点指向各自的卷首页，与章节页不再重复，因此 playOrder 可以保持唯一递增
  let playOrder = 1;
  for (const volume of writtenVolumes(json, selectedVolumes)) {
    const volData = json.content[volume];
    const chapters = json._written[volume];

    const volPoint = ncx.createElement('navPoint');
    volPoint.setAttribute('id', itemId('vol', volume));
    volPoint.setAttribute('playOrder', String(playOrder++));

    const volLabel = ncx.createElement('navLabel');
    const volText = ncx.createElement('text');
    volText.textContent = convertVolumeNumeral(volData.volume);
    volLabel.appendChild(volText);
    volPoint.appendChild(volLabel);
    volPoint.appendChild(ncx.createElement('content')).setAttribute('src', `Text/${volumePageName(volume)}`);

    for (const chapter of chapters) {
      const chData = volData.chapters[chapter];
      if (!chData) continue;

      const chPoint = ncx.createElement('navPoint');
      chPoint.setAttribute('id', itemId('ch', `${volume}_${chapter}`));
      chPoint.setAttribute('playOrder', String(playOrder++));

      const chLabel = ncx.createElement('navLabel');
      const chText = ncx.createElement('text');
      chText.textContent = chData.title;
      chLabel.appendChild(chText);
      chPoint.appendChild(chLabel);

      const contentEl = ncx.createElement('content');
      contentEl.setAttribute('src', `Text/${chapterFileName(volume, chapter)}`);
      chPoint.appendChild(contentEl);

      volPoint.appendChild(chPoint);
    }
    navMap.appendChild(volPoint);
  }

  const formattedNcx = xmlFormatter(serializer.serializeToString(ncx), { indentation: '  ' });
  book.file('OEBPS/toc.ncx', formattedNcx);
}

// ── content.opf ──

async function creatOpf(book, json, {
  selectedVolumes = null,
  coverExt = null,
  epubVersion = 3,
  uuid = null,
  hasStyle = false,
  series = null,
  subjects = [],
  pubDate = null,
  publisher = null,
} = {}) {
  const parser = new DOMParser();
  const opfTemplate = epubVersion === 2 ? content_opf_epub2 : content_opf;
  const opf = parser.parseFromString(opfTemplate, 'text/xml');
  const bookId = uuid || `urn:uuid:${crypto.randomUUID()}`;

  // 书名保持原样："三体" 不能被转成 "3体"
  opf.getElementsByTagName('dc:title')[0].textContent = json.titles;
  opf.getElementsByTagName('dc:creator')[0].textContent = json.authors || '未知';
  opf.getElementsByTagName('dc:description')[0].textContent = json.intro || '暂无简介';
  opf.getElementsByTagName('dc:identifier')[0].textContent = bookId;

  // ── 扩展元数据 ──
  const metadata = opf.getElementsByTagName('metadata')[0];

  const addDc = (name, value) => {
    const el = opf.createElement(`dc:${name}`);
    el.textContent = value;
    metadata.appendChild(el);
  };
  const addMeta = (name, content) => {
    const el = opf.createElement('meta');
    el.setAttribute('name', name);
    el.setAttribute('content', content);
    metadata.appendChild(el);
  };
  const addProperty = (property, content, { id = null, refines = null } = {}) => {
    const el = opf.createElement('meta');
    el.setAttribute('property', property);
    if (id) el.setAttribute('id', id);
    if (refines) el.setAttribute('refines', refines);
    el.textContent = content;
    metadata.appendChild(el);
  };

  if (pubDate) addDc('date', pubDate);              // 站点"最后更新"日期
  if (publisher) addDc('publisher', publisher);     // 文库分类
  for (const subject of subjects) addDc('subject', subject);  // 作品 Tags

  // 系列信息：让阅读器把同一部作品的各卷归组并按序号排序
  if (series && series.name) {
    if (epubVersion === 2) {
      addMeta('calibre:series', series.name);
      if (series.index) addMeta('calibre:series_index', String(series.index));
    } else {
      addProperty('belongs-to-collection', series.name, { id: 'series-id' });
      addProperty('collection-type', 'series', { refines: '#series-id' });
      if (series.index) addProperty('group-position', String(series.index), { refines: '#series-id' });
    }
  }

  if (epubVersion !== 2) {
    const metaModified = opf.getElementsByTagNameNS('http://www.idpf.org/2007/opf', 'meta');
    for (let i = 0; i < metaModified.length; i++) {
      if (metaModified[i].getAttribute('property') === 'dcterms:modified') {
        metaModified[i].textContent = new Date().toISOString().split('.')[0] + 'Z';
        break;
      }
    }
  }

  const manifest = opf.getElementsByTagName('manifest')[0];
  const spine = opf.getElementsByTagName('spine')[0];

  const addItem = (id, href, mediaType, properties = null) => {
    const item = opf.createElement('item');
    item.setAttribute('id', id);
    item.setAttribute('href', href);
    item.setAttribute('media-type', mediaType);
    if (properties && epubVersion !== 2) item.setAttribute('properties', properties);
    manifest.appendChild(item);
  };

  const addSpineRef = (id) => {
    const itemref = opf.createElement('itemref');
    itemref.setAttribute('idref', id);
    spine.appendChild(itemref);
  };

  // manifest 只声明"确实存在的文件"，否则会留下悬空引用（epubcheck 会直接报错）
  if (coverExt) {
    addItem('cover', `Image/cover${coverExt}`, MIME_MAP[coverExt] || 'image/jpeg', epubVersion !== 2 ? 'cover-image' : null);
    addItem('cover-page', `Text/${COVER_PAGE}`, 'application/xhtml+xml');
  } else if (epubVersion === 2) {
    // EPUB2 模板预置了 <meta name="cover" content="cover"/>，没有封面时要一并移除
    const metas = opf.getElementsByTagName('meta');
    for (let i = metas.length - 1; i >= 0; i--) {
      if (metas[i].getAttribute('name') === 'cover') {
        metas[i].parentNode.removeChild(metas[i]);
      }
    }
  }

  if (hasStyle) addItem('css', 'Style/style.css', 'text/css');

  if (epubVersion === 2) {
    addItem('ncx', 'toc.ncx', 'application/x-dtbncx+xml');
    // guide 只能指向内容文档；有了独立的封面页，这里终于可以写一条合法引用
    if (coverExt) {
      const guide = opf.getElementsByTagName('guide')[0];
      if (guide) {
        const ref = opf.createElement('reference');
        ref.setAttribute('type', 'cover');
        ref.setAttribute('title', '封面');
        ref.setAttribute('href', `Text/${COVER_PAGE}`);
        guide.appendChild(ref);
      }
    }
  } else {
    addItem('nav', 'nav.xhtml', 'application/xhtml+xml', 'nav');
  }

  // 封面页排在阅读顺序最前面
  if (coverExt) addSpineRef('cover-page');

  for (const volume of writtenVolumes(json, selectedVolumes)) {
    const volPageId = itemId('vol', volume);
    addItem(volPageId, `Text/${volumePageName(volume)}`, 'application/xhtml+xml');
    addSpineRef(volPageId);

    for (const chapter of json._written[volume]) {
      const id = itemId('text', `${volume}_${chapter}`);
      addItem(id, `Text/${chapterFileName(volume, chapter)}`, 'application/xhtml+xml');
      addSpineRef(id);
    }
  }

  for (const imgname in json.imgs) {
    addItem(itemId('img', imgname.replace(/\.[^.]+$/, '')), `Image/${imgname}`, 'image/jpeg');
  }

  const formattedOpf = xmlFormatter(new XMLSerializer().serializeToString(opf), { indentation: '  ' });
  book.file('OEBPS/content.opf', formattedOpf);
}

// ── 封面 ──

function readLocalCover() {
  for (const ext of SUPPORTED_COVER_EXTS) {
    const candidate = path.join(PROJECT_ROOT, `cover${ext}`);
    if (fs.existsSync(candidate)) {
      return { ext, data: fs.readFileSync(candidate) };
    }
  }
  return null;
}

// ── 创建完整 EPUB ──
// onSelectCover(volumeImgs, previewDir) 可选回调：下载完章节后调用，让用户从已下载图片中选封面
//   volumeImgs = { volIdx: { volName, imgs: [imgname, ...] } }
//   返回 { [volIdx]: imgname } 或 null（跳过）
// autoCover = true 时，不需要交互，直接用本卷第一张插图当封面（分散模式下每卷各自取自己的）

async function creatEpub(json, {
  selectedVolumes = null,
  coverInfo = null,
  progress = null,
  epubVersion = 3,
  onSelectCover = null,
  autoCover = false,
  chapterSelection = null,
  dedupeImages = true,
  compressImages = false,
  imageQuality = 82,
  seriesName = null,
  seriesIndex = null,
} = {}) {
  const book = new JsZip();
  const uuid = `urn:uuid:${crypto.randomUUID()}`;
  const hasStyle = fs.existsSync(STYLE_SOURCE);

  book.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  book.folder('META-INF').file('container.xml', container_xml);
  // 这里刻意不预建 OEBPS/Image、OEBPS/Text 等目录：JSZip 会随文件自动补全父目录，
  // 而显式创建空目录会让 epubcheck 报 PKG-014（含空目录）。
  // 例如用 --chapters 只选到没有插图的章节时，Image/ 就会是空的。

  if (hasStyle) {
    book.file('OEBPS/Style/style.css', fs.readFileSync(STYLE_SOURCE));
  }

  // 1) 下载所有章节（图片落入 OEBPS/Image/）
  await creatText(book, json, selectedVolumes, progress, epubVersion, {
    chapterSelection,
    dedupeImages,
    compressImages,
    imageQuality,
  });

  // 2) 可选回调：让用户从已下载图片中选封面（先提取到临时目录供预览）
  let coverSelections = null;
  if (onSelectCover) {
    const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wenku2epub-'));
    const previewDir = path.join(previewRoot, 'preview');
    try {
      fs.mkdirSync(previewDir, { recursive: true });

      const volumeImgs = {};
      for (const vi of writtenVolumes(json, selectedVolumes)) {
        const volData = json.content[vi];
        const imgs = json._volImgs?.[vi] || [];
        if (!volData || imgs.length === 0) continue;

        volumeImgs[vi] = { volName: convertVolumeNumeral(volData.volume), imgs };

        // 提取该卷图片到预览目录
        const volPreview = path.join(previewDir, String(vi));
        fs.mkdirSync(volPreview, { recursive: true });
        for (const imgname of imgs) {
          const srcFile = book.file(`OEBPS/Image/${imgname}`);
          if (!srcFile) continue;
          const data = await srcFile.async('arraybuffer');
          fs.writeFileSync(path.join(volPreview, imgname), Buffer.from(data));
        }
      }

      if (Object.keys(volumeImgs).length > 0) {
        coverSelections = await onSelectCover(volumeImgs, previewDir);
      }
    } finally {
      // 必须清理，否则每跑一次就在 /tmp 里留一份全卷插图
      fs.rmSync(previewRoot, { recursive: true, force: true });
    }
  }

  // 3) 确定封面：回调选择 → 外部 coverInfo → 自动挑插图 → 项目根目录的 cover.*
  const vols = writtenVolumes(json, selectedVolumes);
  const primaryVol = vols[0];
  let cover = null;

  // 'first'：本卷第一张插图；'best'：整个选集里像素最多的一张。
  // 站点自带封面只有 209x300，书内插图往往 2000px 级，所以 best 能拿到高清封面。
  const pickFromImages = (mode) => {
    if (mode === 'best') {
      let best = null;
      let bestPixels = -1;
      for (const vi of vols) {
        for (const imgname of json._volImgs?.[vi] || []) {
          const pixels = pixelCount(json.imgInfo?.[imgname]);
          if (pixels > bestPixels) {
            bestPixels = pixels;
            best = imgname;
          }
        }
      }
      if (best) return best;
    }
    return json._volImgs?.[primaryVol]?.[0] || null;
  };

  const selectedName = coverSelections && coverSelections[primaryVol];
  // 兼容 autoCover: true（等价于 'first'）
  const autoMode = autoCover === true ? 'first' : autoCover;
  const autoName = !selectedName && autoMode ? pickFromImages(autoMode) : null;
  const sourceName = selectedName || autoName;

  if (sourceName) {
    const sourceFile = book.file(`OEBPS/Image/${sourceName}`);
    if (sourceFile) {
      cover = { ext: '.jpg', data: Buffer.from(await sourceFile.async('arraybuffer')) };
    }
  }
  if (!cover && coverInfo && coverInfo.data) {
    cover = { ext: coverInfo.ext, data: coverInfo.data };
  }
  if (!cover) {
    cover = readLocalCover();
  }

  let coverExt = null;
  if (cover) {
    coverExt = cover.ext;
    book.file(`OEBPS/Image/cover${coverExt}`, cover.data);
    book.file(`OEBPS/Text/${COVER_PAGE}`, Buffer.from(iconv.encode(buildCoverPage(coverExt, epubVersion), 'utf-8')));
    if (progress) progress.render('封面已就绪');
  } else {
    console.warn('\n⚠️  未提供封面图片，将生成无封面的电子书');
  }

  // 4) 每卷生成一个卷首页
  for (const volume of vols) {
    const volData = json.content[volume];
    if (!volData) continue;
    const page = buildVolumePage(convertVolumeNumeral(volData.volume), epubVersion);
    book.file(`OEBPS/Text/${volumePageName(volume)}`, Buffer.from(iconv.encode(page, 'utf-8')));
  }

  // 5) 生成导航和 OPF
  if (epubVersion === 2) {
    await creatNcx(book, json, selectedVolumes, uuid);
  } else {
    await creatNav(book, json, selectedVolumes);
  }

  const resolvedSeriesIndex = seriesIndex !== null
    ? seriesIndex
    : parseVolumeNumber(json.content[primaryVol]?.volume);

  await creatOpf(book, json, {
    selectedVolumes,
    coverExt,
    epubVersion,
    uuid,
    hasStyle,
    series: seriesName ? { name: seriesName, index: resolvedSeriesIndex } : null,
    subjects: json.subjects || [],
    pubDate: json.pubDate || null,
    publisher: json.publisher || null,
  });

  return book;
}

module.exports = {
  creatEpub,
  creatNav,
  creatNcx,
  creatOpf,
  creatText,
  processChapter,
  writtenVolumes,
  setConcurrency,
  getConcurrency,
  chapterFileName,
  volumePageName,
  COVER_PAGE,
};
