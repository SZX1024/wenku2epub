const fs = require('fs');
const path = require('path');
const ProgressBar = require('./progress');
const { getBookInfo } = require('./parse');
const { creatEpub, writtenVolumes } = require('./epub');
const { sanitizeFilename, parseVolumeNumber, DEFAULT_OUTPUT_DIR } = require('./config');
const { createRunContext } = require('./runtime');

// 合并模式的文件名 = 书名 + 所有卷名，很容易超过文件系统 255 字节上限
const MAX_FILENAME_LENGTH = 150;

function reportSkipped(json) {
  const skipped = json.skipped || [];
  if (skipped.length === 0) return;

  console.warn(`\n⚠️  ${skipped.length} 个章节下载失败，已从目录和正文中排除，不会留下断链：`);
  for (const item of skipped.slice(0, 10)) {
    const volName = json.content[item.volume]?.volume ?? item.volume;
    console.warn(`   - ${volName} / ${item.title}（${item.reason}）`);
  }
  if (skipped.length > 10) console.warn(`   ... 其余 ${skipped.length - 10} 条省略`);
  console.warn('   直接重跑一次即可：已成功的章节会命中缓存，只会重新下载失败的章节。');
}

// volumeCovers 形如 { [volIdx]: { ext, data } }，用于分散模式下每卷使用不同封面
function coverForVolume(volumeCovers, volIdx, fallback) {
  const specific = volumeCovers && volumeCovers[volIdx];
  return specific || fallback;
}

// 把失败章节落成机器可读的清单，供 `--retry-failed` 使用。
// 注意合并模式与分散模式共用一个位置，方便脚本直接取。
function writeFailureReport(json, { url, safeTitle, skipped, outDir = DEFAULT_OUTPUT_DIR }) {
  if (!skipped || skipped.length === 0) return null;

  const chapters = {};
  for (const item of skipped) {
    (chapters[item.volume] ||= []).push(item.chapter);
  }
  for (const key of Object.keys(chapters)) chapters[key].sort((a, b) => a - b);

  const report = {
    generatedAt: new Date().toISOString(),
    url: url || null,
    title: json.titles,
    volumes: Object.keys(chapters).map(Number).sort((a, b) => a - b),
    chapters,
    items: skipped.map(item => ({
      volume: item.volume,
      volumeName: json.content[item.volume]?.volume ?? null,
      chapter: item.chapter,
      title: item.title,
      reason: item.reason,
    })),
  };

  const file = path.join(outDir, `${safeTitle}.failed.json`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
    console.warn(`📝 失败清单已写出：${file}（可用 --retry-failed 只重试这些章节）`);
    return file;
  } catch (err) {
    console.warn(`⚠️  失败清单写入失败（已忽略）：${err.message}`);
    return null;
  }
}

async function scraper({
  url = null,
  json: preloaded = null,
  selectedVolumes = null,
  coverInfo = null,
  epubVersion = 3,
  saveMode = 'merged',
  volumeCovers = null,
  onSelectCover = null,
  autoCover = false,
  chapterSelection = null,
  chapterLabel = '',
  dedupeImages = true,
  compressImages = false,
  imageQuality = 82,
  illustrationAnchors = true,
  run = createRunContext(),
} = {}) {
  // 调用方（TUI / CLI）已经抓过一次书籍信息，这里直接复用，避免重复请求
  const json = preloaded || {};
  if (!preloaded) {
    await getBookInfo(url, json, run);
  }

  if (!json.titles) {
    console.error('未能获取书籍标题，可能网址无效或页面结构变化。');
    process.exitCode = 1;
    return null;
  }

  const outRoot = run.outDir;
  const safeTitle = sanitizeFilename(json.titles);
  const volumesToProcess = selectedVolumes || Object.keys(json.content).map(Number);
  const imageOptions = { chapterSelection, dedupeImages, compressImages, imageQuality, illustrationAnchors, run };

  // 分散保存模式：每个分卷生成独立 EPUB 文件
  if (saveMode === 'separate' && volumesToProcess.length > 0) {
    const outDir = path.join(outRoot, safeTitle);
    fs.mkdirSync(outDir, { recursive: true });

    const originalTitle = json.titles;
    const built = [];
    // 分散模式下每卷都会重置 json.skipped，这里汇总一份供调用方判断整体成败
    const allSkipped = [];

    try {
      for (const volIdx of volumesToProcess) {
        const volData = json.content[volIdx];
        if (!volData) continue;

        const safeVolName = sanitizeFilename(volData.volume);
        const chapterCount = Object.keys(volData.chapters).length;
        const progress = new ProgressBar(chapterCount, `📖 下载进度 [${volData.volume}]`);

        json.titles = `${originalTitle} - ${volData.volume}`;
        json.skipped = [];

        const book = await creatEpub(json, {
          selectedVolumes: [volIdx],
          coverInfo: coverForVolume(volumeCovers, volIdx, coverInfo),
          progress,
          epubVersion,
          onSelectCover,
          // 分散模式下每卷各取自己卷内的插图
          autoCover,
          // 系列名必须用原始书名：json.titles 此刻已被改成"书名 - 卷名"
          seriesName: originalTitle,
          seriesIndex: parseVolumeNumber(volData.volume),
          ...imageOptions,
        });

        if (writtenVolumes(json, [volIdx]).length === 0) {
          progress.complete('该卷章节全部失败');
          console.error(`❌ ${volData.volume} 没有任何章节下载成功，跳过生成。`);
          process.exitCode = 1;
          continue;
        }

        const content = await book.generateAsync({ type: 'nodebuffer' });
        progress.complete('打包完成');

        const filepath = path.join(outDir, `${safeVolName}.epub`);
        fs.writeFileSync(filepath, content);
        built.push(filepath);
        console.log(`✅ EPUB 文件已生成：${filepath}`);
        reportSkipped(json);
        allSkipped.push(...(json.skipped || []));
      }
    } finally {
      // 出错也要还原标题，否则 json 会残留在"书名 - 卷名"的状态
      json.titles = originalTitle;
      json.skippedTotal = allSkipped;
    }

    writeFailureReport(json, { url, safeTitle, skipped: allSkipped, outDir: outRoot });
    return built;
  }

  // 合并保存模式：所有分卷合并为一个文件
  let totalChapters = 0;
  for (const v in json.content) {
    if (selectedVolumes && !selectedVolumes.includes(Number(v))) continue;
    const chapters = json.content[v].chapters;
    if (chapterSelection) {
      totalChapters += (chapterSelection[Number(v)] || []).filter(c => chapters[c]).length;
    } else {
      totalChapters += Object.keys(chapters).length;
    }
  }
  const progress = new ProgressBar(totalChapters, '📖 下载进度');

  // 合并模式：优先使用第一卷的指定封面
  const book = await creatEpub(json, {
    selectedVolumes,
    coverInfo: coverForVolume(volumeCovers, volumesToProcess[0], coverInfo),
    progress,
    epubVersion,
    onSelectCover,
    autoCover,
    seriesName: json.titles,
    ...imageOptions,
  });

  if (writtenVolumes(json, selectedVolumes).length === 0) {
    progress.complete('全部章节失败');
    console.error('❌ 没有任何章节下载成功，未生成文件。');
    process.exitCode = 1;
    return null;
  }

  const content = await book.generateAsync({ type: 'nodebuffer' });
  progress.complete('打包完成');

  // 章节过滤生效时把范围写进文件名，避免与"整本"的输出互相覆盖
  const chapterSuffix = chapterLabel ? `_章节${chapterLabel}` : '';
  let filename;
  if (selectedVolumes) {
    const volNames = selectedVolumes
      .map(v => json.content[v]?.volume)
      .filter(Boolean)
      .join('_');
    filename = sanitizeFilename(`${json.titles}_${volNames}${chapterSuffix}.epub`, MAX_FILENAME_LENGTH);
  } else {
    filename = sanitizeFilename(`${json.titles}${chapterSuffix}.epub`, MAX_FILENAME_LENGTH);
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const filepath = path.join(outRoot, filename);
  fs.writeFileSync(filepath, content);
  console.log(`✅ EPUB 文件已生成：${filepath}`);
  json.skippedTotal = json.skipped || [];
  reportSkipped(json);
  writeFailureReport(json, { url, safeTitle, skipped: json.skippedTotal, outDir: outRoot });

  return [filepath];
}

module.exports = { scraper, writeFailureReport };
