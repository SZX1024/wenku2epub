const fs = require('fs');
const path = require('path');
const { input, select, checkbox } = require('@inquirer/prompts');
const { getBookInfo } = require('./parse');
const { downloadCover, readCoverFromFile } = require('./cover');
const { scraper } = require('./scraper');
const { exportAsTxt } = require('./txt');
const { sanitizeFilename, parseIndexSpec, formatIndexLabel } = require('./config');
const { loadConfig } = require('./configfile');
const { createRunContext } = require('./runtime');

// 配置文件提供交互默认值；读不到或损坏时只警告，不打断交互
function loadTuiConfig() {
  try {
    const config = loadConfig();
    if (config._sources.length > 0) {
      console.log(`⚙️  已加载配置：${config._sources.join('、')}\n`);
    }
    return config;
  } catch (err) {
    console.warn(`⚠️  配置文件读取失败，使用内置默认值：${err.message}\n`);
    return {};
  }
}

function reportCache(run) {
  if (!run.cache.isEnabled()) return;
  const stats = run.cache.getStats();
  if (stats.hits > 0 || stats.writes > 0) {
    console.log(`💾 缓存命中 ${stats.hits} 次，新下载 ${stats.writes} 次（${run.cache.root}）`);
  }
}

const ESC_TIMEOUT_MS = 80;   // 只收到 ESC：判断为单独按下 Esc
const CSI_TIMEOUT_MS = 250;  // 转义序列迟迟收不全：兜底当 Esc，避免永久卡死

class CancelledError extends Error {
  constructor() {
    super('用户取消');
    this.name = 'CancelledError';
  }
}

// 读取单个按键。
// 相比原来的实现，这里修掉了三个问题：
//   1. 方向键的转义序列被拆成多个数据包时不再永久卡死（有超时兜底）
//   2. 不再往 stdin 上挂永不摘除的 once 监听器（原来每按一次 Esc 泄漏一个）
//   3. 支持 Ctrl+C（raw mode 下 ISIG 被关闭，必须自己识别 \x03）
function readKey() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buffer = '';
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stdin.removeListener('data', onData);
      if (stdin.isTTY && stdin.isRaw) stdin.setRawMode(false);
    };

    const settle = (key) => {
      cleanup();
      resolve(key);
    };

    const armTimeout = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => settle('esc'), ms);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      while (buffer.length > 0) {
        if (buffer[0] === '\x03') {
          settle('interrupt');
          return;
        }

        if (buffer[0] === '\x1b') {
          if (buffer.length === 1) {
            armTimeout(ESC_TIMEOUT_MS);
            return;
          }
          if (buffer[1] === '[') {
            if (buffer.length < 3) {
              armTimeout(CSI_TIMEOUT_MS);
              return;
            }
            const code = buffer[2];
            buffer = buffer.slice(3);
            if (code === 'D') return settle('left');
            if (code === 'C') return settle('right');
            if (code === 'A') return settle('up');
            if (code === 'B') return settle('down');
            continue;
          }
          buffer = buffer.slice(1);
          continue;
        }

        const ch = buffer[0];
        buffer = buffer.slice(1);
        if (ch === '\r' || ch === '\n') return settle('enter');
        if (ch === 'q' || ch === 'Q') return settle('esc');
      }
    };

    if (!stdin.isTTY) {
      resolve('esc');
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// 终端内嵌预览章节插图：← → 翻页，Enter 确认，Esc/Q 跳过，Ctrl+C 退出
async function selectChapterCover(volumeImgs, previewDir) {
  if (!process.stdin.isTTY) {
    console.warn('⚠️  当前不是交互式终端，跳过章节插图选封面。');
    return null;
  }

  const ti = require('terminal-image').default;
  const selections = {};

  for (const [vi, info] of Object.entries(volumeImgs)) {
    if (!info.imgs || info.imgs.length === 0) continue;

    let idx = 0;
    let done = false;

    const render = async () => {
      console.clear();
      console.log(`📖 ${info.volName}  —  ${idx + 1}/${info.imgs.length}`);
      console.log('   ← → 切换   Enter 确认   Esc/Q 跳过   Ctrl+C 退出\n');

      const imgPath = path.join(previewDir, String(vi), info.imgs[idx]);
      try {
        const buf = fs.readFileSync(imgPath);
        const termW = Math.max(20, Math.floor((process.stdout.columns || 80) * 0.6));
        const rendered = await ti.buffer(buf, { width: termW, preserveAspectRatio: true });
        process.stdout.write((rendered || '') + '\n');
      } catch {
        console.log(`[ 无法预览 ]  ${info.imgs[idx]}`);
      }
    };

    while (!done) {
      await render();
      const key = await readKey();

      if (key === 'interrupt') throw new CancelledError();
      if (key === 'left' && idx > 0) idx--;
      else if (key === 'right' && idx < info.imgs.length - 1) idx++;
      else if (key === 'enter') {
        selections[Number(vi)] = info.imgs[idx];
        done = true;
      } else if (key === 'esc') {
        done = true;
      }
    }
  }

  console.clear();
  return Object.keys(selections).length > 0 ? selections : null;
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     📚 轻小说文库 下载器            ║');
  console.log('╚══════════════════════════════════════╝\n');

  const config = loadTuiConfig();

  try {
    // 第一步：输入网址
    const url = await input({
      message: '请输入小说网址（如 https://www.wenku8.net/book/xxx.htm）：',
      validate: (value) => {
        const raw = value.trim();
        if (!raw) return '网址不能为空';

        let parsed;
        try {
          parsed = new URL(raw);
        } catch {
          return '请输入完整的网址（含 http:// 或 https://）';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return '只支持 http/https 网址';
        }
        if (!parsed.hostname.includes('wenku8')) {
          return '请输入 wenku8 的书籍网址';
        }
        return true;
      }
    });

    console.log('\n⏳ 正在获取书籍信息...\n');

    // json 只抓一次，后面直接交给 scraper 复用，不再重复请求。
    // 此刻用户还没选延迟/并发，而书页与目录页本来就不走缓存，所以先用一个临时 ctx。
    const json = {};
    await getBookInfo(url.trim(), json, createRunContext({ delay: false }));

    if (!json.titles) {
      console.error('❌ 未能获取书籍标题，可能网址无效或页面结构变化。');
      process.exitCode = 1;
      return;
    }

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
        checked: true
      });
    }

    if (volumeChoices.length === 0) {
      console.error('❌ 未解析到任何分卷，可能页面结构已变化。');
      process.exitCode = 1;
      return;
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

    // 第三步：章节范围（可选，精确到章）
    const chapterSpec = await input({
      message: '章节范围（直接回车=全部；也可填 1-10 或 1,3,5，序号按每卷内部计算）：',
      default: ''
    });

    let chapterSelection = null;
    let chapterLabel = '';
    const trimmedChapterSpec = chapterSpec.trim();

    if (trimmedChapterSpec && trimmedChapterSpec.toLowerCase() !== 'all') {
      chapterSelection = {};
      for (const volIdx of selectedVolumes) {
        const total = Object.keys(json.content[volIdx]?.chapters || {}).length;
        if (total === 0) continue;
        try {
          const indices = parseIndexSpec(trimmedChapterSpec, total, `第 ${volIdx + 1} 卷的章节`);
          if (indices) chapterSelection[volIdx] = indices;
        } catch (err) {
          console.error(`❌ ${err.message}`);
          process.exitCode = 2;
          return;
        }
      }

      if (Object.keys(chapterSelection).length === 0) {
        console.error('❌ 章节范围没有匹配到任何章节。');
        process.exitCode = 2;
        return;
      }

      const allIndices = [...new Set(Object.values(chapterSelection).flat())].sort((a, b) => a - b);
      chapterLabel = formatIndexLabel(allIndices);
      console.log(`\n📑 仅下载章节 ${chapterLabel}\n`);
    }

    // 第三步：选择输出格式
    const formatChoice = await select({
      message: '请选择输出格式：',
      choices: [
        { name: '📗 EPUB 电子书', value: 'epub' },
        { name: '📄 TXT + 插图（文本和图片分开保存）', value: 'txt' }
      ],
      default: config.format === 'txt' ? 'txt' : 'epub'
    });

    // 第四步：选择是否启用延迟
    const delayChoice = await select({
      message: '是否启用请求延迟（推荐启用，防止被限流）：',
      choices: [
        { name: '✅ 是（启用延迟，速度较慢但更稳定）', value: 'y' },
        { name: '❌ 否（不启用延迟，速度较快但可能被限流）', value: 'n' }
      ],
      default: config.delay === false ? 'n' : 'y'
    });

    // 第五步：章节并发数
    const concurrencyChoice = await select({
      message: '章节并发数（越高越快，也越容易被限流）：',
      choices: [
        { name: '1（最保守，逐章串行）', value: 1 },
        { name: '2', value: 2 },
        { name: '3（推荐，兼顾速度与稳定）', value: 3 },
        { name: '5（较快）', value: 5 }
      ],
      default: [1, 2, 3, 5].includes(Number(config.concurrency)) ? Number(config.concurrency) : 3
    });
    const imageConcurrency = [1, 2, 3, 5, 8].includes(Number(config.imageConcurrency))
      ? Number(config.imageConcurrency)
      : 3;

    // 一次交互 = 一个 RunContext：延迟、并发、缓存、输出目录都在这里，
    // 不再改动任何模块级状态。
    const run = createRunContext({
      outDir: config.out || 'output',
      delay: delayChoice === 'y',
      chapterConcurrency: Number(concurrencyChoice),
      imageConcurrency,
      cache: { enabled: config.cache !== false },
    });

    // 第六步：选择封面来源
    const coverChoices = [];
    if (json.coverUrl) {
      coverChoices.push({
        name: `🌐 从网站下载封面（${json.coverUrl.slice(0, 50)}...）`,
        value: 'web'
      });
    }
    if (formatChoice === 'epub') {
      coverChoices.push(
        { name: '🖼️ 从章节插图选择封面（交互预览）', value: 'chapter' },
        { name: '🏆 自动用分辨率最高的插图作封面（最清晰）', value: 'best' },
        { name: '🤖 自动使用该卷第一张插图作为封面', value: 'auto' }
      );
    }
    coverChoices.push(
      { name: '🔗 从自定义链接下载封面', value: 'url' },
      { name: '📁 输入本地图片文件路径', value: 'local' },
      { name: '⏭️  跳过封面', value: 'skip' }
    );

    const coverChoice = await select({
      message: '请选择封面图片来源：',
      choices: coverChoices,
      default: coverChoices.some(c => c.value === config.cover)
        ? config.cover
        : (json.coverUrl ? 'web' : 'url')
    });

    let coverInfo = null;

    if (coverChoice === 'web' && json.coverUrl) {
      console.log('\n⏳ 正在下载封面...');
      coverInfo = await downloadCover(json.coverUrl);
      if (coverInfo) console.log('✅ 封面下载成功');
      else console.warn('⚠️  封面下载失败，将不添加封面');
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
      if (coverInfo) console.log('✅ 封面下载成功');
      else console.warn('⚠️  封面下载失败，将不添加封面');
    } else if (coverChoice === 'local') {
      const localPath = await input({
        message: '请输入封面图片路径（支持 jpg/png/gif/webp/bmp/svg）：',
        validate: (value) => {
          if (!value.trim()) return '路径不能为空';
          return true;
        }
      });
      coverInfo = readCoverFromFile(localPath.trim());
      if (coverInfo) console.log('✅ 封面读取成功');
    }

    if (formatChoice === 'txt') {
      console.log('\n🚀 开始下载（TXT + 插图）...\n');
      const safeTitle = sanitizeFilename(json.titles);
      const bookDir = path.join(run.outDir, safeTitle);
      fs.mkdirSync(bookDir, { recursive: true });
      if (coverInfo && coverInfo.data) {
        const coverPath = path.join(bookDir, `cover${coverInfo.ext}`);
        fs.writeFileSync(coverPath, coverInfo.data);
        console.log(`✅ 封面已保存：${coverPath}`);
      }

      const { failedChapters } = await exportAsTxt(json, selectedVolumes, {
        chapterSelection,
        dedupeImages: config.dedupeImages !== false,
        run,
      });
      if (failedChapters.length > 0) {
        console.warn(`\n⚠️  ${failedChapters.length} 个章节下载失败，已跳过：`);
        for (const item of failedChapters.slice(0, 10)) {
          console.warn(`   - ${json.content[item.volume]?.volume ?? item.volume} / ${item.title}（${item.reason}）`);
        }
        process.exitCode = 1;
      }
      reportCache(run);
      console.log('\n🎉 全部完成！');
      return;
    }

    // EPUB 模式
    const saveMode = await select({
      message: '请选择分卷保存方式：',
      choices: [
        { name: '📦 合并为一个文件', value: 'merged' },
        { name: '📂 分别保存为多个文件（按卷名）', value: 'separate' }
      ],
      default: 'merged'
    });

    const epubVersionChoice = await select({
      message: '请选择 EPUB 版本（EPUB2 兼容性更好，EPUB3 功能更丰富）：',
      choices: [
        { name: '📗 EPUB 3（推荐，支持更多排版特性）', value: 3 },
        { name: '📘 EPUB 2（兼容旧版阅读器）', value: 2 }
      ],
      default: 3
    });
    const epubVersion = Number(epubVersionChoice);

    const allSelected = selectedVolumes.length === Object.keys(json.content).length;
    const volsToDownload = (allSelected && saveMode === 'merged') ? null : selectedVolumes;

    console.log('\n🚀 开始下载（EPUB）...\n');
    await scraper({
      url: url.trim(),
      json,
      selectedVolumes: volsToDownload,
      coverInfo,
      epubVersion,
      saveMode,
      onSelectCover: coverChoice === 'chapter' ? selectChapterCover : null,
      autoCover: coverChoice === 'best' ? 'best' : coverChoice === 'auto',
      chapterSelection,
      chapterLabel,
      dedupeImages: config.dedupeImages !== false,
      compressImages: config.compressImages === true,
      imageQuality: Number(config.imageQuality) || 82,
      illustrationAnchors: config.illustrationAnchors !== false,
      run,
    });

    reportCache(run);
    console.log('\n🎉 全部完成！');
  } catch (err) {
    if (err && err.name === 'CancelledError') {
      console.log('\n已取消。');
      process.exitCode = 130;
      return;
    }
    // inquirer 在 Ctrl+C / stdin 关闭时抛出的错误，属于正常取消，不该当成崩溃
    if (err && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError')) {
      console.log('\n已取消。');
      process.exitCode = 130;
      return;
    }

    console.error('❌ 程序出错：', err);
    // 出错必须有非零退出码，否则脚本/CI 无法判断成败
    process.exitCode = 1;
  }
}

module.exports = { main, selectChapterCover };
