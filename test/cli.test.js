const os = require('os');
const path = require('path');
const fs = require('fs');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgv, resolveOptions, resolveVolumes, resolveChapters, loadFailureReport, readBatchFile, CliError,
} = require('../lib/cli');
const { writeFailureReport } = require('../lib/scraper');

// 用一份空配置保证测试不受开发机上 ~/.wenku2epubrc 影响
const EMPTY_CONFIG = path.join(os.tmpdir(), `wenku2epub-empty-${process.pid}.json`);
fs.writeFileSync(EMPTY_CONFIG, '{}');
const base = (...args) => resolveOptions(['--config', EMPTY_CONFIG, ...args]);
const tempFile = (name, content) => {
  const file = path.join(os.tmpdir(), `wenku2epub-test-${process.pid}-${name}`);
  fs.writeFileSync(file, content);
  return file;
};

function fakeBook(volumeCount, chaptersPerVolume = 20) {
  const content = {};
  for (let i = 0; i < volumeCount; i++) {
    const chapters = {};
    for (let c = 0; c < chaptersPerVolume; c++) chapters[c] = { title: `第${c + 1}章`, href: 'x' };
    content[i] = { volume: `第${i + 1}卷`, chapters };
  }
  return { content };
}

test('无参数时全部使用默认值', () => {
  const options = base();
  assert.deepEqual(options.urls, []);
  assert.equal(options.volumes, 'all');
  assert.equal(options.chapters, 'all');
  assert.equal(options.format, 'epub');
  assert.equal(options.out, 'output');
  assert.equal(options.epubVersion, 3);
  assert.equal(options.separate, false);
  assert.equal(options.delay, true);
  assert.equal(options.concurrency, 1);
  assert.equal(options.imageConcurrency, 3);
  assert.equal(options.cache, true);
  assert.equal(options.refresh, false);
  assert.equal(options.dedupeImages, true);
  assert.equal(options.compressImages, false);
  assert.equal(options.imageQuality, 82);
});

test('长短选项与 --key=value 都能解析', () => {
  const short = base('-u', 'https://www.wenku8.net/book/1.htm', '-v', '1,2', '-f', 'txt', '-o', './b');
  assert.deepEqual(short.urls, ['https://www.wenku8.net/book/1.htm']);
  assert.equal(short.volumes, '1,2');
  assert.equal(short.format, 'txt');
  assert.equal(short.out, './b');

  const long = base('--url=https://www.wenku8.net/book/1.htm', '--epub-version=2', '--separate', '--no-delay', '--no-cache');
  assert.deepEqual(long.urls, ['https://www.wenku8.net/book/1.htm']);
  assert.equal(long.epubVersion, 2);
  assert.equal(long.separate, true);
  assert.equal(long.delay, false);
  assert.equal(long.cache, false);
});

test('--url 可以重复传入以批量下载', () => {
  const options = base('-u', 'https://www.wenku8.net/book/1.htm', '-u', 'https://www.wenku8.net/book/2.htm');
  assert.equal(options.urls.length, 2);
});

test('--batch 从文件读取网址，跳过空行与注释', () => {
  const file = tempFile('batch.txt', [
    '# 这是注释',
    'https://www.wenku8.net/book/1.htm',
    '',
    '  https://www.wenku8.net/book/2.htm  ',
  ].join('\n'));

  assert.deepEqual(readBatchFile(file), [
    'https://www.wenku8.net/book/1.htm',
    'https://www.wenku8.net/book/2.htm',
  ]);

  const options = base('--batch', file, '-u', 'https://www.wenku8.net/book/9.htm');
  assert.deepEqual(options.urls, ['https://www.wenku8.net/book/9.htm', 'https://www.wenku8.net/book/1.htm', 'https://www.wenku8.net/book/2.htm']);
});

test('--batch 指向空文件时报错', () => {
  const file = tempFile('empty.txt', '\n# 只有注释\n');
  assert.throws(() => readBatchFile(file), CliError);
});

test('非法取值会被拒绝', () => {
  assert.throws(() => base('--format', 'pdf'), CliError);
  assert.throws(() => base('--epub-version', '4'), CliError);
  assert.throws(() => base('--cover', 'nope'), CliError);
  assert.throws(() => base('--concurrency', '0'), CliError);
  assert.throws(() => base('--concurrency', '99'), CliError);
  assert.throws(() => base('--concurrency', '1.5'), CliError);
  assert.throws(() => base('--image-quality', '200'), CliError);
  assert.throws(() => base('--bogus'), CliError);
  assert.throws(() => base('--url'), CliError);
});

test('--cover chapter 在非交互模式下被明确拒绝，并指向 auto/best', () => {
  assert.throws(
    () => base('--cover', 'chapter'),
    (err) => err instanceof CliError && /auto/.test(err.message) && /best/.test(err.message)
  );
});

test('--cover best 可作为封面来源', () => {
  assert.equal(base('--cover', 'best').cover, 'best');
  assert.equal(base('--cover', 'auto').cover, 'auto');
});

test('--no-dedupe-images 关闭去重，默认为开', () => {
  assert.equal(base().dedupeImages, true);
  assert.equal(base('--no-dedupe-images').dedupeImages, false);
});

test('parseArgv 报告未知选项并记录显式给出的参数', () => {
  const { unknown, values, provided } = parseArgv(['--url', 'x', '--nope']);
  assert.deepEqual(values.url, ['x']);
  assert.deepEqual(unknown, ['--nope']);
  assert.ok(provided.has('url'));
  assert.ok(!provided.has('format'));
});

test('配置文件提供默认值，命令行参数优先', () => {
  const config = tempFile('rc.json', JSON.stringify({
    out: './from-config',
    format: 'txt',
    concurrency: 4,
    delay: false,
    dedupeImages: false,
    unknownKey: 1,
  }));

  const options = resolveOptions(['--config', config, '-u', 'x']);
  assert.equal(options.out, './from-config');
  assert.equal(options.format, 'txt');
  assert.equal(options.concurrency, 4);
  assert.equal(options.delay, false);
  assert.equal(options.dedupeImages, false);

  const overridden = resolveOptions(['--config', config, '-o', './cli-wins', '-f', 'epub', '--concurrency', '2']);
  assert.equal(overridden.out, './cli-wins');
  assert.equal(overridden.format, 'epub');
  assert.equal(overridden.concurrency, 2);
});

test('配置文件不存在或 JSON 非法时报错', () => {
  assert.throws(() => resolveOptions(['--config', path.join(os.tmpdir(), 'definitely-missing-rc.json')]), CliError);
  const bad = tempFile('bad.json', '{ not json');
  assert.throws(() => resolveOptions(['--config', bad]), CliError);
});

test('resolveVolumes：all / 列表 / 区间，且是 1 基', () => {
  const json = fakeBook(6);
  assert.equal(resolveVolumes('all', json), null);
  assert.equal(resolveVolumes('', json), null);
  assert.deepEqual(resolveVolumes('1', json), [0]);
  assert.deepEqual(resolveVolumes('1,3', json), [0, 2]);
  assert.deepEqual(resolveVolumes('2-4', json), [1, 2, 3]);
  assert.deepEqual(resolveVolumes('5,2-3', json), [1, 2, 4]);
  assert.deepEqual(resolveVolumes('4-2', json), [1, 2, 3], '倒序区间也应当可用');
});

test('resolveVolumes 会忽略越界分卷，全越界时报错', () => {
  const json = fakeBook(3);
  assert.deepEqual(resolveVolumes('2,99', json), [1]);
  assert.throws(() => resolveVolumes('99', json), CliError);
  assert.throws(() => resolveVolumes('abc', json), CliError);
});

test('resolveChapters：章节范围作用于每个选中的卷', () => {
  const json = fakeBook(3, 20);
  assert.equal(resolveChapters('all', json, [0, 1]), null);

  const ranged = resolveChapters('3-5', json, [0, 1]);
  assert.deepEqual(ranged, { 0: [2, 3, 4], 1: [2, 3, 4] });

  const listed = resolveChapters('1,10', json, [2]);
  assert.deepEqual(listed, { 2: [0, 9] });
});

test('resolveChapters：卷内章节数不足时报错', () => {
  const json = fakeBook(2, 3);
  assert.throws(() => resolveChapters('9-12', json, [0, 1]), CliError);
});

test('loadFailureReport 解析失败清单并还原成章节选集', () => {
  const file = tempFile('failed.json', JSON.stringify({
    url: 'https://www.wenku8.net/book/1.htm',
    title: '某书',
    volumes: [0, 2],
    chapters: { 0: [3, 1], 2: [5] },
    items: [],
  }));

  const report = loadFailureReport(file);
  assert.equal(report.url, 'https://www.wenku8.net/book/1.htm');
  assert.deepEqual(report.volumes, [0, 2]);
  assert.deepEqual(report.chapters, { 0: [1, 3], 2: [5] }, '章节应当被排序');
});

test('loadFailureReport 对缺失或非法文件报错', () => {
  assert.throws(() => loadFailureReport(path.join(os.tmpdir(), 'nope-failed.json')), CliError);
  const bad = tempFile('bad-failed.json', '{"title":"x"}');
  assert.throws(() => loadFailureReport(bad), CliError);
  const notJson = tempFile('notjson-failed.json', 'nope');
  assert.throws(() => loadFailureReport(notJson), CliError);
});

test('失败清单可以「写出→读回」闭环（生产者与消费者契约一致）', () => {
  const outDir = path.join(os.tmpdir(), `wenku2epub-fail-${process.pid}`);

  try {
    const json = {
      titles: '某书',
      content: {
        0: { volume: '第一卷', chapters: {} },
        2: { volume: '第三卷', chapters: {} },
      },
      skipped: [
        { volume: 0, chapter: 7, title: '第七章', reason: '页面请求失败' },
        { volume: 0, chapter: 3, title: '第三章', reason: '页面请求失败' },
        { volume: 2, chapter: 1, title: '第一章', reason: '页面结构异常' },
      ],
    };

    const file = writeFailureReport(json, {
      url: 'https://www.wenku8.net/book/9.htm',
      safeTitle: '某书',
      skipped: json.skipped,
      outDir,
    });
    assert.ok(file && fs.existsSync(file), '应当写出失败清单');

    const report = loadFailureReport(file);
    assert.equal(report.url, 'https://www.wenku8.net/book/9.htm');
    assert.deepEqual(report.volumes, [0, 2]);
    assert.deepEqual(report.chapters, { 0: [3, 7], 2: [1] });
    assert.equal(report.title, '某书');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('没有失败章节时不写失败清单', () => {
  const outDir = path.join(os.tmpdir(), `wenku2epub-nofail-${process.pid}`);

  try {
    const result = writeFailureReport(
      { titles: '某书', content: {}, skipped: [] },
      { url: 'x', safeTitle: '某书', skipped: [], outDir }
    );
    assert.equal(result, null);
    assert.equal(fs.existsSync(outDir), false, '不应创建任何文件');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
