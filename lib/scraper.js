const fs = require('fs');
const ProgressBar = require('./progress');
const { getBookInfo } = require('./parse');
const { creatEpub } = require('./epub');

async function scraper(url, selectedVolumes = null, coverInfo = null, epubVersion = 3, saveMode = 'merged') {
  const json = {};
  await getBookInfo(url, json);
  if (!json.titles) {
    console.error('未能获取书籍标题，可能网址无效或页面结构变化。');
    return;
  }

  const safeTitle = json.titles.replace(/[<>:"/\\|?*]/g, '_');
  const volumesToProcess = selectedVolumes || Object.keys(json.content).map(Number);

  // 分散保存模式：每个分卷生成独立 EPUB 文件
  if (saveMode === 'separate' && volumesToProcess.length > 0) {
    fs.mkdirSync(safeTitle, { recursive: true });
    const originalTitle = json.titles;

    for (const volIdx of volumesToProcess) {
      const volData = json.content[volIdx];
      if (!volData) continue;
      const safeVolName = volData.volume.replace(/[<>:"/\\|?*]/g, '_');
      const chapterCount = Object.keys(volData.chapters).length;
      const progress = new ProgressBar(chapterCount, `📖 下载进度 [${volData.volume}]`);

      json.titles = `${originalTitle} - ${volData.volume}`;

      const book = await creatEpub(json, [volIdx], coverInfo, progress, epubVersion);
      const content = await book.generateAsync({ type: 'nodebuffer' });
      progress.complete('打包完成');

      const filepath = `${safeTitle}/${safeVolName}.epub`;
      fs.writeFileSync(filepath, content);
      console.log(`✅ EPUB 文件已生成：${filepath}`);
    }

    json.titles = originalTitle;
    return;
  }

  // 合并保存模式：所有分卷合并为一个文件
  let totalChapters = 0;
  for (const v in json.content) {
    if (selectedVolumes && !selectedVolumes.includes(Number(v))) continue;
    totalChapters += Object.keys(json.content[v].chapters).length;
  }
  const progress = new ProgressBar(totalChapters, '📖 下载进度');

  const book = await creatEpub(json, selectedVolumes, coverInfo, progress, epubVersion);
  return book.generateAsync({ type: 'nodebuffer' }).then(content => {
    progress.complete('打包完成');
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

module.exports = { scraper };
