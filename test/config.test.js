const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  PROJECT_ROOT,
  sanitizeFilename,
  convertCnNumerals,
  convertVolumeNumeral,
  content_xhtml,
  content_xhtml_epub2,
  getMimeType,
} = require('../lib/config');

test('convertVolumeNumeral 只转换"第X卷"里的卷号', () => {
  assert.equal(convertVolumeNumeral('第一卷'), '第1卷');
  assert.equal(convertVolumeNumeral('第十二卷'), '第12卷');
  assert.equal(convertVolumeNumeral('第三册 特典'), '第3册 特典');
  assert.equal(convertVolumeNumeral('第二部'), '第2部');
});

test('convertVolumeNumeral 不会误伤普通文字', () => {
  assert.equal(convertVolumeNumeral('三体'), '三体');
  assert.equal(convertVolumeNumeral('四月是你的谎言'), '四月是你的谎言');
  assert.equal(convertVolumeNumeral('第二性'), '第二性');
  assert.equal(convertVolumeNumeral('一亿分之三'), '一亿分之三');
  assert.equal(convertVolumeNumeral('八男？别闹了！'), '八男？别闹了！');
});

test('convertCnNumerals 作为通用工具仍然可用（但不再用于书名）', () => {
  assert.equal(convertCnNumerals('第一卷'), '第1卷');
  assert.equal(convertCnNumerals('三体'), '3体');
});

test('sanitizeFilename 处理非法字符、上级目录、保留名与超长', () => {
  assert.equal(sanitizeFilename('a/b:c*d?e'), 'a_b_c_d_e');
  assert.equal(sanitizeFilename('../evil'), '_evil');
  assert.equal(sanitizeFilename('..'), 'untitled');
  assert.equal(sanitizeFilename('   '), 'untitled');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('第1卷. '), '第1卷');
  assert.ok(sanitizeFilename('x'.repeat(300)).length <= 120);

  const longWithExt = sanitizeFilename(`${'y'.repeat(300)}.epub`, 150);
  assert.ok(longWithExt.length <= 150);
  assert.ok(longWithExt.endsWith('.epub'));
});

test('PROJECT_ROOT 不依赖 process.cwd()', () => {
  const original = process.cwd();
  try {
    process.chdir(path.parse(original).root);
    // 重新加载模块，确认解析结果仍是项目根目录
    delete require.cache[require.resolve('../lib/config')];
    const reloaded = require('../lib/config');
    assert.equal(reloaded.PROJECT_ROOT, PROJECT_ROOT);
  } finally {
    process.chdir(original);
  }
});

test('章节模板：EPUB3 用 section，EPUB2 用 div（XHTML 1.1 没有 section）', () => {
  assert.ok(content_xhtml.includes('<section>'));
  assert.ok(content_xhtml_epub2.includes('<div class="chapter">'));
  assert.ok(!content_xhtml_epub2.includes('<section>'));
});

test('getMimeType 映射常见图片格式', () => {
  assert.equal(getMimeType('a.png'), 'image/png');
  assert.equal(getMimeType('a.webp'), 'image/webp');
  assert.equal(getMimeType('a.unknown'), 'image/jpeg');
});
