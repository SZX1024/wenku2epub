const fs = require('fs');
const path = require('path');
const { createCacheStore, formatSize } = require('./cache');
const { createRunContext } = require('./runtime');
const { sanitizeFilename, parseIndexSpec, formatIndexLabel } = require('./config');
const { loadConfig, CONFIG_FILENAME } = require('./configfile');
const { getBookInfo } = require('./parse');
const { downloadCover, readCoverFromFile } = require('./cover');
const { scraper } = require('./scraper');
const { exportAsTxt } = require('./txt');

const FORMATS = ['epub', 'txt'];
const EPUB_VERSIONS = [2, 3];
// chapter 需要交互式预览；auto = 每卷第一张插图，best = 分辨率最高的一张
const COVER_MODES = ['web', 'auto', 'best', 'url', 'local', 'skip'];
const MAX_CONCURRENCY = 8;

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

const OPTION_SPEC = {
  url: { flags: ['-u', '--url'], value: '<url>', multiple: true, help: '书籍网址；可重复传入以批量下载' },
  batch: { flags: ['--batch'], value: '<file>', help: '从文本文件读取多个网址（每行一个，# 开头为注释）' },
  volumes: { flags: ['-v', '--volumes'], value: '<spec>', help: '分卷，如 1,3-5 或 all（从第 1 卷起算，默认 all）' },
  chapters: { flags: ['--chapters'], value: '<spec>', help: '每卷内的章节范围，如 1-10 或 1,3,5（默认全部）' },
  format: { flags: ['-f', '--format'], value: '<epub|txt>', help: '输出格式（默认 epub）' },
  out: { flags: ['-o', '--out'], value: '<dir>', help: '输出目录（默认 output）' },
  epubVersion: { flags: ['--epub-version'], value: '<2|3>', help: 'EPUB 版本（默认 3）' },
  separate: { flags: ['--separate'], help: '每卷单独生成一个 EPUB 文件' },
  cover: { flags: ['--cover'], value: '<mode>', help: `封面来源：${COVER_MODES.join(' | ')}` },
  coverUrl: { flags: ['--cover-url'], value: '<url>', help: '自定义封面链接（配合 --cover url）' },
  coverFile: { flags: ['--cover-file'], value: '<path>', help: '本地封面路径（配合 --cover local）' },
  noDelay: { flags: ['--no-delay'], help: '关闭请求延迟（默认开启）' },
  rate: { flags: ['--rate'], value: '<ms>', help: '全局限速间隔毫秒，0 = 关闭（默认 500，带随机抖动）' },
  concurrency: { flags: ['--concurrency'], value: '<n>', help: `章节并发数 1-${MAX_CONCURRENCY}（默认 1）` },
  imageConcurrency: { flags: ['--image-concurrency'], value: '<n>', help: `插图并发数 1-${MAX_CONCURRENCY}（默认 3）` },
  noCache: { flags: ['--no-cache'], help: '不使用本地缓存' },
  refresh: { flags: ['--refresh'], help: '忽略已有缓存，强制重新下载' },
  noDedupeImages: { flags: ['--no-dedupe-images'], help: '关闭插图内容去重（默认开启）' },
  compressImages: { flags: ['--compress-images'], help: '用 sharp 压缩插图（需 npm install sharp，未装则自动跳过）' },
  imageQuality: { flags: ['--image-quality'], value: '<n>', help: 'JPEG 压缩质量 1-100（默认 82）' },
  retryFailed: { flags: ['--retry-failed'], value: '<file>', help: '按失败清单只重试失败的章节' },
  config: { flags: ['--config'], value: '<file>', help: `指定配置文件（默认依次读 ~/${CONFIG_FILENAME} 与 ./${CONFIG_FILENAME}）` },
  clearCache: { flags: ['--clear-cache'], help: '清空缓存后退出' },
  cacheInfo: { flags: ['--cache-info'], help: '显示缓存占用后退出' },
  help: { flags: ['-h', '--help'], help: '显示本帮助' },
  version: { flags: ['--version'], help: '显示版本号' },
};

function buildFlagIndex() {
  const index = new Map();
  for (const [key, spec] of Object.entries(OPTION_SPEC)) {
    for (const flag of spec.flags) index.set(flag, key);
  }
  return index;
}

function parseArgv(argv) {
  const index = buildFlagIndex();
  const values = {};
  const flags = new Set();
  const provided = new Set();
  const unknown = [];

  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    let inlineValue = null;

    if (token.startsWith('--') && token.includes('=')) {
      const at = token.indexOf('=');
      inlineValue = token.slice(at + 1);
      token = token.slice(0, at);
    }

    const key = index.get(token);
    if (!key) {
      unknown.push(argv[i]);
      continue;
    }

    provided.add(key);
    if (OPTION_SPEC[key].value) {
      const value = inlineValue !== null ? inlineValue : argv[++i];
      if (value === undefined) throw new CliError(`选项 ${token} 缺少取值`);
      if (OPTION_SPEC[key].multiple) {
        (values[key] ||= []).push(value);
      } else {
        values[key] = value;
      }
    } else {
      flags.add(key);
    }
  }

  return { values, flags, provided, unknown };
}

function toInt(raw, name, { min, max }) {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new CliError(`${name} 必须是整数，收到：${raw}`);
  if (value < min || value > max) throw new CliError(`${name} 必须在 ${min}~${max} 之间，收到：${value}`);
  return value;
}

function toBool(raw, name) {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new CliError(`${name} 必须是 true 或 false，收到：${raw}`);
}

function resolveOptions(argv) {
  const { values, flags, provided, unknown } = parseArgv(argv);
  if (unknown.length > 0) {
    throw new CliError(`未知选项：${unknown.join('、')}（用 --help 查看用法）`);
  }

  // 配置文件只提供默认值，命令行显式给出的参数永远优先
  let config;
  try {
    config = loadConfig(provided.has('config') ? values.config : null);
  } catch (err) {
    // 配置文件属于用户输入，归为参数错误（退出码 2）
    throw new CliError(err.message);
  }
  const withConfig = (key, fallback) => {
    if (provided.has(key)) return values[key];
    if (config[key] !== undefined) return config[key];
    return fallback;
  };
  const boolWithConfig = (flagKey, configKey, fallback) => {
    if (provided.has(flagKey)) return true;
    if (config[configKey] !== undefined) return toBool(config[configKey], `配置项 ${configKey}`);
    return fallback;
  };

  const format = String(withConfig('format', 'epub')).toLowerCase();
  if (!FORMATS.includes(format)) {
    throw new CliError(`--format 只能是 ${FORMATS.join(' 或 ')}，收到：${format}`);
  }

  const epubVersion = Number(withConfig('epubVersion', 3));
  if (!EPUB_VERSIONS.includes(epubVersion)) {
    throw new CliError(`--epub-version 只能是 2 或 3，收到：${epubVersion}`);
  }

  const cover = values.cover ? String(values.cover).toLowerCase()
    : (config.cover ? String(config.cover).toLowerCase() : null);
  if (cover === 'chapter') {
    throw new CliError('--cover chapter 需要交互式终端，请改用 --cover auto 或 --cover best');
  }
  if (cover && !COVER_MODES.includes(cover)) {
    throw new CliError(`--cover 只能是 ${COVER_MODES.join(' / ')}，收到：${cover}`);
  }

  const urls = [...(values.url || [])];
  if (values.batch) urls.push(...readBatchFile(values.batch));

  return {
    help: flags.has('help'),
    version: flags.has('version'),
    clearCache: flags.has('clearCache'),
    cacheInfo: flags.has('cacheInfo'),
    urls,
    volumes: withConfig('volumes', 'all'),
    chapters: withConfig('chapters', 'all'),
    format,
    out: withConfig('out', 'output'),
    epubVersion,
    separate: boolWithConfig('separate', 'separate', false),
    cover,
    coverUrl: withConfig('coverUrl', null),
    coverFile: withConfig('coverFile', null),
    delay: provided.has('noDelay') ? false : toBool(config.delay ?? true, '配置项 delay'),
    rate: values.rate === undefined
      ? (config.rate === undefined ? null : toInt(config.rate, '配置项 rate', { min: 0, max: 60000 }))
      : toInt(values.rate, '--rate', { min: 0, max: 60000 }),
    concurrency: toInt(withConfig('concurrency', 1), '--concurrency', { min: 1, max: MAX_CONCURRENCY }),
    imageConcurrency: toInt(withConfig('imageConcurrency', 3), '--image-concurrency', { min: 1, max: MAX_CONCURRENCY }),
    cache: provided.has('noCache') ? false : toBool(config.cache ?? true, '配置项 cache'),
    refresh: flags.has('refresh'),
    // --no-dedupe-images 是"关闭"开关；其余情况读配置，默认开启
    dedupeImages: provided.has('noDedupeImages')
      ? false
      : toBool(config.dedupeImages ?? true, '配置项 dedupeImages'),
    compressImages: boolWithConfig('compressImages', 'compressImages', false),
    imageQuality: toInt(withConfig('imageQuality', 82), '--image-quality', { min: 1, max: 100 }),
    retryFailed: values.retryFailed || null,
    configSources: config._sources || [],
  };
}

function readBatchFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`无法读取批量文件 ${file}：${err.message}`);
  }

  const urls = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  if (urls.length === 0) throw new CliError(`批量文件 ${file} 里没有有效网址`);
  return urls;
}

function printHelp() {
  const lines = [
    'wenku2epub — 从 wenku8 下载轻小说并导出为 EPUB / TXT',
    '',
    '用法：',
    '  node index.js                       交互式界面',
    '  node index.js --url <书籍网址> [选项]  非交互模式',
    '',
    '选项：',
  ];

  const rows = [];
  for (const spec of Object.values(OPTION_SPEC)) {
    const flags = spec.flags.join(', ');
    rows.push([spec.value ? `${flags} ${spec.value}` : flags, spec.help]);
  }
  const width = Math.max(...rows.map(([left]) => left.length));
  for (const [left, right] of rows) {
    lines.push(`  ${left.padEnd(width)}  ${right}`);
  }

  lines.push(
    '',
    '示例：',
    '  node index.js -u https://www.wenku8.net/book/3057.htm',
    '  node index.js -u https://www.wenku8.net/book/3057.htm -v 1,3-5 -o ./books',
    '  node index.js -u https://www.wenku8.net/book/3057.htm -v 1 --chapters 1-10',
    '  node index.js -u https://www.wenku8.net/book/3057.htm --separate --cover best',
    '  node index.js -u URL1 -u URL2 -u URL3            # 批量下载',
    '  node index.js --batch urls.txt -o ./books        # 从文件批量下载',
    '  node index.js --retry-failed "output/书名.failed.json"',
    '  node index.js --cache-info',
  );

  console.log(lines.join('\n'));
}

// 分卷与章节共用一套下标语法，都从 1 起算
function resolveVolumes(spec, json) {
  const total = Object.keys(json.content).length;
  try {
    return parseIndexSpec(spec, total, '分卷');
  } catch (err) {
    throw new CliError(err.message);
  }
}

// 章节范围作用于"每一个被选中的卷"，返回 { volIdx: [chapterIdx] } 或 null
function resolveChapters(spec, json, selectedVolumes) {
  const raw = String(spec ?? 'all').trim().toLowerCase();
  if (!raw || raw === 'all' || raw === '*') return null;

  const vols = selectedVolumes || Object.keys(json.content).map(Number);
  const selection = {};

  for (const volIdx of vols) {
    const chapters = json.content[volIdx]?.chapters || {};
    const total = Object.keys(chapters).length;
    if (total === 0) continue;

    try {
      const indices = parseIndexSpec(raw, total, `第 ${volIdx + 1} 卷的章节`);
      if (indices) selection[volIdx] = indices;
    } catch (err) {
      throw new CliError(err.message);
    }
  }

  if (Object.keys(selection).length === 0) {
    throw new CliError(`--chapters ${spec} 没有匹配到任何章节`);
  }
  return selection;
}

function loadFailureReport(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`无法读取失败清单 ${file}：${err.message}`);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`失败清单 ${file} 不是合法 JSON：${err.message}`);
  }

  if (!report || typeof report !== 'object' || !report.chapters) {
    throw new CliError(`失败清单 ${file} 结构不正确（缺少 chapters 字段）`);
  }

  const chapters = {};
  for (const [vol, list] of Object.entries(report.chapters)) {
    chapters[Number(vol)] = [...list].sort((a, b) => a - b);
  }

  return {
    url: report.url || null,
    title: report.title || null,
    chapters,
    volumes: Object.keys(chapters).map(Number),
  };
}

async function resolveCover(options, json) {
  const mode = options.cover
    || (options.format === 'epub' && json.coverUrl ? 'web' : 'skip');

  if (mode === 'skip') return { coverInfo: null, autoCover: false };
  if (mode === 'auto') return { coverInfo: null, autoCover: 'first' };
  if (mode === 'best') return { coverInfo: null, autoCover: 'best' };

  if (mode === 'web') {
    if (!json.coverUrl) {
      console.warn('⚠️  未能解析到网站封面，改为跳过封面');
      return { coverInfo: null, autoCover: false };
    }
    console.log('⏳ 正在下载封面...');
    return { coverInfo: await downloadCover(json.coverUrl), autoCover: false };
  }

  if (mode === 'url') {
    if (!options.coverUrl) throw new CliError('--cover url 需要同时提供 --cover-url');
    console.log('⏳ 正在下载封面...');
    return { coverInfo: await downloadCover(options.coverUrl), autoCover: false };
  }

  if (mode === 'local') {
    if (!options.coverFile) throw new CliError('--cover local 需要同时提供 --cover-file');
    return { coverInfo: readCoverFromFile(options.coverFile), autoCover: false };
  }

  return { coverInfo: null, autoCover: false };
}

function reportFailures(failed, describe) {
  if (failed.length === 0) return false;

  console.warn(`\n⚠️  ${failed.length} 个章节下载失败：`);
  for (const item of failed.slice(0, 10)) console.warn(`   - ${describe(item)}`);
  if (failed.length > 10) console.warn(`   ... 其余 ${failed.length - 10} 条省略`);
  console.warn('   直接重跑，或用 --retry-failed 只重试失败的章节（已成功的会命中缓存）。');
  return true;
}

async function runOne(options, url, run) {
  console.log('⏳ 正在获取书籍信息...\n');
  const json = {};
  await getBookInfo(url, json, run);

  if (!json.titles) {
    console.error('❌ 未能获取书籍标题，可能网址无效或页面结构变化。');
    return 1;
  }

  const selectedVolumes = options.volumesOverride || resolveVolumes(options.volumes, json);
  const chapterSelection = options.chapterOverride || resolveChapters(options.chapters, json, selectedVolumes);
  const chapterLabel = options.chapterLabel
    || (chapterSelection ? formatIndexLabel(collectChapterIndices(chapterSelection)) : '');

  const volumeNames = selectedVolumes
    ? selectedVolumes.map(v => json.content[v].volume).join('、')
    : `全部 ${Object.keys(json.content).length} 卷`;

  console.log(`📚 ${json.titles} — ${json.authors || '未知'}`);
  console.log(`📖 ${volumeNames}${chapterLabel ? `（仅章节 ${chapterLabel}）` : ''}`);
  console.log(`📦 格式：${options.format.toUpperCase()}${options.format === 'epub' ? ` (EPUB${options.epubVersion})` : ''}`);
  console.log(`💾 输出：${path.resolve(run.outDir)}`);
  console.log(`⚙️  延迟：${options.delay ? '开' : '关'}｜章节并发：${options.concurrency}｜插图并发：${options.imageConcurrency}｜缓存：${options.cache ? (options.refresh ? '刷新' : '开') : '关'}｜去重：${options.dedupeImages ? '开' : '关'}${options.compressImages ? '｜压缩：开' : ''}\n`);

  const { coverInfo, autoCover } = await resolveCover(options, json);

  if (options.format === 'txt') {
    console.log('\n🚀 开始下载（TXT + 插图）...\n');
    const safeTitle = sanitizeFilename(json.titles);
    const bookDir = path.join(run.outDir, safeTitle);
    fs.mkdirSync(bookDir, { recursive: true });

    if (coverInfo && coverInfo.data) {
      const coverPath = path.join(bookDir, `cover${coverInfo.ext}`);
      fs.writeFileSync(coverPath, coverInfo.data);
      console.log(`✅ 封面已保存：${coverPath}`);
    }

    const { failedChapters } = await exportAsTxt(json, selectedVolumes, { chapterSelection, run });
    const failed = reportFailures(failedChapters, item => `${json.content[item.volume]?.volume ?? item.volume} / ${item.title}（${item.reason}）`);
    console.log('\n🎉 全部完成！');
    return failed ? 1 : 0;
  }

  console.log('\n🚀 开始下载（EPUB）...\n');
  const built = await scraper({
    url,
    json,
    selectedVolumes,
    coverInfo,
    epubVersion: options.epubVersion,
    saveMode: options.separate ? 'separate' : 'merged',
    autoCover,
    chapterSelection,
    chapterLabel,
    dedupeImages: options.dedupeImages,
    compressImages: options.compressImages,
    imageQuality: options.imageQuality,
    run,
  });

  const failed = reportFailures(json.skippedTotal || [], item => `${json.content[item.volume]?.volume ?? item.volume} / ${item.title}（${item.reason}）`);

  if (!built || built.length === 0) return 1;
  console.log('\n🎉 全部完成！');
  return failed ? 1 : 0;
}

function collectChapterIndices(chapterSelection) {
  const all = [];
  for (const list of Object.values(chapterSelection)) all.push(...list);
  return [...new Set(all)].sort((a, b) => a - b);
}

async function runCli(options) {
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.version) {
    console.log(require('../package.json').version);
    return 0;
  }

  const cacheStore = createCacheStore({ enabled: options.cache, refresh: options.refresh });

  if (options.clearCache) {
    cacheStore.clear();
    console.log(`✅ 缓存已清空：${cacheStore.root}`);
    return 0;
  }
  if (options.cacheInfo) {
    const info = cacheStore.size();
    console.log(`缓存目录：${info.root}`);
    console.log(`文件数：${info.files}，占用：${formatSize(info.bytes)}`);
    return 0;
  }

  // --retry-failed：把失败清单变成"卷 + 章节"的精确选集
  if (options.retryFailed) {
    const report = loadFailureReport(options.retryFailed);
    options.volumesOverride = report.volumes;
    options.chapterOverride = report.chapters;
    options.chapterLabel = '重试';
    if (options.urls.length === 0) {
      if (!report.url) throw new CliError('失败清单里没有网址，请用 -u 指定书籍网址');
      options.urls = [report.url];
    }
    console.log(`📝 将按失败清单重试 ${report.volumes.length} 卷共 ${collectChapterIndices(report.chapters).length} 个章节`);
  }

  if (options.urls.length === 0) {
    throw new CliError('缺少 --url（用 --help 查看用法）');
  }

  // 一次 CLI 调用 = 一个 RunContext。所有可变配置都在这里，
  // 不再有任何模块级单例，因此同一进程里可以安全地并发跑多个任务。
  const run = createRunContext({
    outDir: options.out,
    delay: options.delay,
    rateLimitMs: options.rate,
    chapterConcurrency: options.concurrency,
    imageConcurrency: options.imageConcurrency,
    cache: { enabled: options.cache, refresh: options.refresh },
  });

  if (options.configSources.length > 0) {
    console.log(`⚙️  已加载配置：${options.configSources.join('、')}`);
  }

  let exitCode = 0;
  for (let i = 0; i < options.urls.length; i++) {
    const url = options.urls[i];
    if (options.urls.length > 1) {
      console.log(`\n${'='.repeat(60)}\n[${i + 1}/${options.urls.length}] ${url}\n${'='.repeat(60)}`);
    }

    try {
      const code = await runOne(options, url, run);
      if (code) exitCode = code;
    } catch (err) {
      if (err instanceof CliError) {
        console.error(`❌ ${err.message}`);
        if (!exitCode) exitCode = 2;
      } else {
        console.error(`❌ 处理 ${url} 出错：`, err);
        if (!exitCode) exitCode = 1;
      }
    }
  }

  if (options.urls.length > 1) {
    console.log(`\n📊 批量结束：共 ${options.urls.length} 本${exitCode ? '，其中有失败' : '，全部成功'}`);
  }
  return exitCode;
}

module.exports = {
  parseArgv,
  resolveOptions,
  resolveVolumes,
  resolveChapters,
  loadFailureReport,
  readBatchFile,
  runCli,
  runOne,
  printHelp,
  CliError,
  OPTION_SPEC,
};
