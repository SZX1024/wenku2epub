const fs = require('fs');
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
  content_opf,
  content_opf_epub2,
  container_xml,
  content_xhtml,
  nav_xhtml,
  ncx_template,
} = require('./config');
const { ask, getImgWithRetry } = require('./fetch');

const imgLimit = pLimit(3);
const chapterLimit = pLimit(1);

// ── 章节处理 ──

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

// ── 章节批量生成 ──

async function creatText(book, json, selectedVolumes = null, progress = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  json.imgs = {};

  const imgCounter = { count: 0 };
  const chapterPromises = [];

  for (const volume in json.content) {
    if (selectedVolumes && !selectedVolumes.includes(Number(volume))) continue;

    for (const chapter in json.content[volume].chapters) {
      const { title, href } = json.content[volume].chapters[chapter];
      const promise = chapterLimit(() =>
        processChapter(book, json, volume, chapter, title, href, parser, serializer, imgCounter, progress)
      );
      chapterPromises.push(promise);
    }
  }

  await Promise.all(chapterPromises);
}

// ── EPUB3 nav.xhtml ──

async function creatNav(book, json, selectedVolumes = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const nav = parser.parseFromString(nav_xhtml, 'text/xml');
  const ol = nav.createElement('ol');

  for (const volume in json.content) {
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

// ── EPUB2 toc.ncx ──

async function creatNcx(book, json, selectedVolumes = null, uuid = null) {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const ncx = parser.parseFromString(ncx_template, 'text/xml');
  const navMap = ncx.getElementsByTagName('navMap')[0];

  const uidMeta = ncx.getElementsByTagNameNS('http://www.daisy.org/z3986/2005/ncx/', 'meta');
  for (let i = 0; i < uidMeta.length; i++) {
    if (uidMeta[i].getAttribute('name') === 'dtb:uid') {
      uidMeta[i].setAttribute('content', uuid || '');
      break;
    }
  }
  ncx.getElementsByTagName('text')[0].textContent = json.titles;

  let playOrder = 1;
  for (const volume in json.content) {
    if (selectedVolumes && !selectedVolumes.includes(Number(volume))) continue;

    const volData = json.content[volume];
    const volPoint = ncx.createElement('navPoint');
    volPoint.setAttribute('id', `vol_${volume}`);
    volPoint.setAttribute('playOrder', String(playOrder++));

    const volLabel = ncx.createElement('navLabel');
    const volText = ncx.createElement('text');
    volText.textContent = volData.volume;
    volLabel.appendChild(volText);
    volPoint.appendChild(volLabel);
    volPoint.appendChild(ncx.createElement('content')).setAttribute('src', `Text/${volume}_0.xhtml`);

    for (const chapter in volData.chapters) {
      const chData = volData.chapters[chapter];
      const chPoint = ncx.createElement('navPoint');
      chPoint.setAttribute('id', `ch_${volume}_${chapter}`);
      chPoint.setAttribute('playOrder', String(playOrder++));

      const chLabel = ncx.createElement('navLabel');
      const chText = ncx.createElement('text');
      chText.textContent = chData.title;
      chLabel.appendChild(chText);
      chPoint.appendChild(chLabel);

      const contentEl = ncx.createElement('content');
      contentEl.setAttribute('src', `Text/${volume}_${chapter}.xhtml`);
      chPoint.appendChild(contentEl);

      volPoint.appendChild(chPoint);
    }
    navMap.appendChild(volPoint);
  }

  const formattedNcx = xmlFormatter(serializer.serializeToString(ncx), { indentation: '  ' });
  book.file('OEBPS/toc.ncx', formattedNcx);
}

// ── content.opf ──

async function creatOpf(book, json, selectedVolumes = null, coverExt = '.jpg', epubVersion = 3, uuid = null) {
  const parser = new DOMParser();
  const opfTemplate = epubVersion === 2 ? content_opf_epub2 : content_opf;
  const opf = parser.parseFromString(opfTemplate, 'text/xml');
  const bookId = uuid || `urn:uuid:${crypto.randomUUID()}`;

  opf.getElementsByTagName('dc:title')[0].textContent = json.titles;
  opf.getElementsByTagName('dc:creator')[0].textContent = json.authors;
  opf.getElementsByTagName('dc:description')[0].textContent = json.intro;
  opf.getElementsByTagName('dc:identifier')[0].textContent = bookId;

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

  const coverMime = MIME_MAP[coverExt] || 'image/jpeg';
  addItem('cover', `Image/cover${coverExt}`, coverMime, epubVersion !== 2 ? 'cover-image' : null);
  addItem('style.css', 'Style/style.css', 'text/css');

  if (epubVersion === 2) {
    addItem('ncx', 'toc.ncx', 'application/x-dtbncx+xml');
    const guide = opf.getElementsByTagName('guide')[0];
    if (guide) {
      const ref = opf.createElement('reference');
      ref.setAttribute('type', 'cover');
      ref.setAttribute('title', '封面');
      ref.setAttribute('href', `Image/cover${coverExt}`);
      guide.appendChild(ref);
    }
  } else {
    addItem('nav', 'nav.xhtml', 'application/xhtml+xml', 'nav');
  }

  for (const volume in json.content) {
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

// ── 创建完整 EPUB ──

async function creatEpub(json, selectedVolumes = null, coverInfo = null, progress = null, epubVersion = 3) {
  const book = new JsZip();
  const uuid = `urn:uuid:${crypto.randomUUID()}`;

  book.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  book.folder('META-INF').file('container.xml', container_xml);
  book.folder('OEBPS');
  book.folder('OEBPS/Image');
  book.folder('OEBPS/Text');
  book.folder('OEBPS/Style');

  let coverExt = '.jpg';
  if (coverInfo && coverInfo.data) {
    coverExt = coverInfo.ext;
    book.file(`OEBPS/Image/cover${coverExt}`, coverInfo.data);
    if (progress) progress.render('封面已就绪');
  } else {
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

  if (epubVersion === 2) {
    await creatNcx(book, json, selectedVolumes, uuid);
  } else {
    await creatNav(book, json, selectedVolumes);
  }
  await creatText(book, json, selectedVolumes, progress);
  await creatOpf(book, json, selectedVolumes, coverExt, epubVersion, uuid);

  return book;
}

module.exports = { creatEpub, creatNav, creatNcx, creatOpf, creatText, processChapter };
