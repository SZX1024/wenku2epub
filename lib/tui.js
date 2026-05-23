const fs = require('fs');
const path = require('path');
const { input, select, checkbox } = require('@inquirer/prompts');
const { getBookInfo } = require('./parse');
const { downloadCover, readCoverFromFile } = require('./cover');
const { scraper } = require('./scraper');
const { exportAsTxt } = require('./txt');
const { setDelayMode } = require('./fetch');

(async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     📚 轻小说文库 下载器            ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    // 第一步：输入网址
    const url = await input({
      message: '请输入小说网址（如 https://www.wenku8.net/book/xxx.htm）：',
      validate: (value) => {
        if (!value.trim()) return '网址不能为空';
        if (!value.includes('wenku8')) return '请输入有效的 wenku8 网址';
        return true;
      }
    });

    console.log('\n⏳ 正在获取书籍信息...\n');

    const json = {};
    await getBookInfo(url, json);

    if (!json.titles) {
      console.error('❌ 未能获取书籍标题，可能网址无效或页面结构变化。');
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

    // 第三步：选择输出格式
    const formatChoice = await select({
      message: '请选择输出格式：',
      choices: [
        { name: '📗 EPUB 电子书', value: 'epub' },
        { name: '📄 TXT + 插图（文本和图片分开保存）', value: 'txt' }
      ],
      default: 'epub'
    });

    // 第四步：选择是否启用延迟
    const delayChoice = await select({
      message: '是否启用请求延迟（推荐启用，防止被限流）：',
      choices: [
        { name: '✅ 是（启用延迟，速度较慢但更稳定）', value: 'y' },
        { name: '❌ 否（不启用延迟，速度较快但可能被限流）', value: 'n' }
      ],
      default: 'y'
    });
    setDelayMode(delayChoice === 'y');

    // 第五步：选择封面来源
    const coverChoices = [];
    if (json.coverUrl) {
      coverChoices.push({
        name: `🌐 从网站下载封面（${json.coverUrl.slice(0, 50)}...）`,
        value: 'web'
      });
    }
    if (formatChoice === 'epub') {
      coverChoices.push({
        name: '🖼️ 从章节插图选择封面',
        value: 'chapter'
      });
    }
    coverChoices.push(
      { name: '🔗 从自定义链接下载封面', value: 'url' },
      { name: '📁 输入本地图片文件路径', value: 'local' },
      { name: '⏭️  跳过封面', value: 'skip' }
    );

    const coverChoice = await select({
      message: '请选择封面图片来源：',
      choices: coverChoices,
      default: json.coverUrl ? 'web' : 'url'
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
      const safeTitle = json.titles.replace(/[<>:"/\\|?*]/g, '_');
      const bookDir = path.join('output', safeTitle);
      fs.mkdirSync(bookDir, { recursive: true });
      if (coverInfo && coverInfo.data) {
        fs.writeFileSync(path.join(bookDir, `cover${coverInfo.ext}`), coverInfo.data);
        console.log(`✅ 封面已保存：${path.join(bookDir, `cover${coverInfo.ext}`)}`);
      }
      await exportAsTxt(json, selectedVolumes, url);
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

    // 封面选择回调：终端内嵌预览，← → 翻页，Enter 确认，Esc 跳过
    let chapterCoverCallback = null;
    if (coverChoice === 'chapter') {
      chapterCoverCallback = async (volumeImgs, previewDir) => {
        const ti = require('terminal-image').default;
        const selections = {};

        // 原始模式按键监听
        function waitForKey() {
          return new Promise(resolve => {
            const onData = (buf) => {
              const s = buf.toString();
              if (s === '\x1b[D') { cleanup(); resolve('left'); }
              else if (s === '\x1b[C') { cleanup(); resolve('right'); }
              else if (s === '\r' || s === '\n') { cleanup(); resolve('enter'); }
              else if (s === '\x1b') {
                // 可能是 Esc 或箭头序列前缀，50ms 内无后续字符则为 Esc
                const timeout = setTimeout(() => { cleanup(); resolve('esc'); }, 50);
                const orig = process.stdin.once('data', () => { clearTimeout(timeout); });
              }
            };
            const cleanup = () => {
              process.stdin.removeListener('data', onData);
              if (process.stdin.isRaw) process.stdin.setRawMode(false);
            };
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onData);
          });
        }

        for (const [vi, info] of Object.entries(volumeImgs)) {
          if (info.imgs.length === 0) continue;

          let idx = 0;
          let done = false;

          const render = async () => {
            console.clear();
            console.log(`📖 ${info.volName}  —  ${idx + 1}/${info.imgs.length}`);
            console.log(`   ← → 切换   Enter 确认   Esc 跳过\n`);

            const imgPath = path.join(previewDir, String(vi), info.imgs[idx]);
            try {
              const buf = fs.readFileSync(imgPath);
              const termW = Math.floor((process.stdout.columns || 80) * 0.6);
              const rendered = await ti.buffer(buf, { width: termW, preserveAspectRatio: true });
              process.stdout.write((rendered || '') + '\n');
            } catch (e) {
              console.log(`[ 无法预览 ]  ${info.imgs[idx]}`);
            }
          };

          while (!done) {
            await render();
            const key = await waitForKey();

            if (key === 'left' && idx > 0) idx--;
            else if (key === 'right' && idx < info.imgs.length - 1) idx++;
            else if (key === 'enter') { selections[Number(vi)] = info.imgs[idx]; done = true; }
            else if (key === 'esc') { done = true; }
          }
          process.stdin.setRawMode(false);
        }

        console.clear();
        return Object.keys(selections).length > 0 ? selections : null;
      };
    }

    console.log('\n🚀 开始下载（EPUB）...\n');
    await scraper(url, volsToDownload, coverInfo, epubVersion, saveMode, null, chapterCoverCallback);
    console.log('\n🎉 全部完成！');
  } catch (err) {
    console.error('❌ 程序出错：', err);
  }
})();
