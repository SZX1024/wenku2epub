const fs = require('fs');
const path = require('path');
const { default: pLimit } = require('p-limit');
const ProgressBar = require('./progress');
const { ask, downloadImageToFs } = require('./fetch');

const OUT_DIR = 'output';

const imgLimit = pLimit(3);

function pad(n) {
  return String(n).padStart(3, '0');
}

function getExtFromUrl(url) {
  const p = path.extname(new URL(url).pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(p) ? p : '.jpg';
}

async function processChapterTxt(href, volIdx, chapIdx) {
  const $ = await ask(href);
  if (!$) return { text: '', images: [] };

  const content = $('#content');
  if (!content.length) return { text: '', images: [] };

  // 提取文本段落
  const lines = [];
  content.contents().each((index, element) => {
    if (element.type === 'text' && element.data.trim() !== '') {
      lines.push($(element).text().trim());
    }
  });

  // 收集图片下载信息
  const images = [];
  const imgs = content.find('img');
  imgs.each((j, img) => {
    const src = $(img).attr('src');
    if (!src) return;
    const absSrc = new URL(src, href).href;
    const ext = getExtFromUrl(absSrc);
    const imgname = `${pad(volIdx)}_${pad(chapIdx)}_${pad(j)}${ext}`;
    images.push({ src: absSrc, name: imgname });
  });

  return { text: lines.join('\n\n'), images };
}

async function exportAsTxt(json, selectedVolumes, url) {
  const safeTitle = json.titles.replace(/[<>:"/\\|?*]/g, '_');
  const bookDir = path.join(OUT_DIR, safeTitle);
  fs.mkdirSync(bookDir, { recursive: true });

  const volumesToProcess = selectedVolumes || Object.keys(json.content).map(Number);

  for (const volIdx of volumesToProcess) {
    const volData = json.content[volIdx];
    if (!volData) continue;

    const safeVolName = volData.volume.replace(/[<>:"/\\|?*]/g, '_');
    const chapterCount = Object.keys(volData.chapters).length;
    const progress = new ProgressBar(chapterCount, `📖 下载进度 [${volData.volume}]`);

    const volDir = path.join(bookDir, safeVolName);
    const imgDir = path.join(volDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });

    // 收集分卷内所有章节文本和图片任务
    const volTexts = [];
    const allImgPromises = [];

    for (const chapter in volData.chapters) {
      const { title, href } = volData.chapters[chapter];
      const result = await processChapterTxt(href, volIdx, Number(chapter));

      // 添加章节标题和正文
      volTexts.push(`【${title}】\n\n${result.text}`);

      // 收集图片下载
      for (const img of result.images) {
        allImgPromises.push(
          imgLimit(() => downloadImageToFs(img.src, path.join(imgDir, img.name)))
        );
      }

      progress.tick(title);
    }

    // 写入分卷合并文本
    const txtPath = path.join(volDir, `${safeVolName}.txt`);
    fs.writeFileSync(txtPath, volTexts.join('\n\n————————————————\n\n'), 'utf-8');

    // 等待图片下载完成
    if (allImgPromises.length > 0) {
      await Promise.all(allImgPromises);
    }

    progress.complete('完成');
  }

  console.log(`✅ TXT 文件已保存到：${bookDir}/`);
}

module.exports = { exportAsTxt };
