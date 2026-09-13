const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { default: pLimit } = require('p-limit');
const ProgressBar = require('./progress');
const { askChapter, fetchImage } = require('./fetch');
const { sanitizeFilename, getOutputDir } = require('./config');
const { extractChapterContent } = require('./parse');

const imgLimit = pLimit(3);

function pad(n) {
  return String(n).padStart(3, '0');
}

function getExtFromUrl(url) {
  try {
    const p = path.extname(new URL(url).pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(p) ? p : '.jpg';
  } catch {
    return '.jpg';
  }
}

function imageMarker(imgname) {
  return `［插图：images/${imgname}］`;
}

// 按文档顺序提取：段落之间插入插图占位标记，读者才能把图片和正文对上位置
async function processChapterTxt(href, volIdx, chapIdx) {
  const $ = await askChapter(href);
  if (!$) return { ok: false, reason: '页面请求失败', text: '', images: [] };

  const content = $('#content');
  if (!content.length) return { ok: false, reason: '页面结构异常（未找到 #content）', text: '', images: [] };

  const lines = [];
  const images = [];
  let imgSeq = 0;

  for (const item of extractChapterContent($, content)) {
    if (item.type === 'text') {
      lines.push(item.text);
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

    const imgname = `${pad(volIdx)}_${pad(chapIdx)}_${pad(imgSeq++)}${getExtFromUrl(absSrc)}`;
    images.push({ src: absSrc, name: imgname });
    lines.push(imageMarker(imgname));
  }

  return { ok: true, text: lines.join('\n\n'), images };
}

async function exportAsTxt(json, selectedVolumes, { chapterSelection = null, dedupeImages = true } = {}) {
  const safeTitle = sanitizeFilename(json.titles);
  const bookDir = path.join(getOutputDir(), safeTitle);
  fs.mkdirSync(bookDir, { recursive: true });

  const volumesToProcess = selectedVolumes || Object.keys(json.content).map(Number);
  const failedChapters = [];

  for (const volIdx of volumesToProcess) {
    const volData = json.content[volIdx];
    if (!volData) continue;

    const allowedChapters = chapterSelection ? (chapterSelection[volIdx] || []) : null;
    const safeVolName = sanitizeFilename(volData.volume);
    const selectedCount = allowedChapters
      ? allowedChapters.filter(c => volData.chapters[c]).length
      : Object.keys(volData.chapters).length;
    const progress = new ProgressBar(selectedCount, `📖 下载进度 [${volData.volume}]`);

    const volDir = path.join(bookDir, safeVolName);
    const imgDir = path.join(volDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });

    const chapters = [];
    const imgTasks = [];

    for (const chapter in volData.chapters) {
      const chapterIdx = Number(chapter);
      if (allowedChapters && !allowedChapters.includes(chapterIdx)) continue;

      const { title, href } = volData.chapters[chapter];
      const result = await processChapterTxt(href, volIdx, chapterIdx);

      if (!result.ok) {
        failedChapters.push({ volume: volIdx, chapter: chapterIdx, title, reason: result.reason });
        progress.tick(title);
        continue;
      }

      chapters.push({ title, text: result.text, images: result.images });
      for (const img of result.images) {
        imgTasks.push(imgLimit(async () => ({ name: img.name, data: await fetchImage(img.src) })));
      }

      progress.tick(title);
    }

    // 先全部下载完，再做去重与落盘：这样失败的插图能把占位标记改掉，不留悬空指引
    const imgResults = await Promise.all(imgTasks);

    const canonical = new Map();   // content hash -> 保留的文件名
    const aliases = new Map();     // 被判定为重复的文件名 -> 保留的文件名
    const failedImages = new Set();

    for (const result of imgResults) {
      if (!result.data) {
        failedImages.add(result.name);
        continue;
      }
      const hash = crypto.createHash('sha1').update(result.data).digest('hex');
      const existing = dedupeImages ? canonical.get(hash) : null;
      if (existing) aliases.set(result.name, existing);
      else canonical.set(hash, result.name);
    }

    for (const result of imgResults) {
      if (!result.data || aliases.has(result.name)) continue;
      fs.writeFileSync(path.join(imgDir, result.name), result.data);
    }

    const volTexts = chapters.map(ch => {
      let text = ch.text;
      for (const [from, to] of aliases) {
        text = text.split(imageMarker(from)).join(imageMarker(to));
      }
      for (const name of failedImages) {
        text = text.split(imageMarker(name)).join('［插图下载失败］');
      }
      return `【${ch.title}】\n\n${text}`;
    });

    if (volTexts.length === 0) {
      progress.complete('该卷没有可输出的章节');
      console.error(`❌ ${volData.volume} 没有任何章节下载成功，跳过生成。`);
      process.exitCode = 1;
      continue;
    }

    const txtPath = path.join(volDir, `${safeVolName}.txt`);
    fs.writeFileSync(txtPath, volTexts.join('\n\n————————————————\n\n'), 'utf-8');
    progress.complete('完成');
  }

  console.log(`✅ TXT 文件已保存到：${bookDir}/`);
  return { bookDir, failedChapters };
}

module.exports = { exportAsTxt };
