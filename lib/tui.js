const { input, select, checkbox } = require('@inquirer/prompts');
const { getBookInfo } = require('./parse');
const { downloadCover, readCoverFromFile } = require('./cover');
const { scraper } = require('./scraper');
const { setDelayMode } = require('./fetch');

(async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     📚 轻小说文库 EPUB 下载器       ║');
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

    // 第三步：选择保存方式
    const saveMode = await select({
      message: '请选择分卷保存方式：',
      choices: [
        { name: '📦 合并为一个文件', value: 'merged' },
        { name: '📂 分别保存为多个文件（按卷名）', value: 'separate' }
      ],
      default: 'merged'
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
    coverChoices.push(
      { name: '� 从自定义链接下载封面', value: 'url' },
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
      if (coverInfo) {
        console.log('✅ 封面下载成功');
      } else {
        console.warn('⚠️  封面下载失败，将不添加封面');
      }
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
      if (coverInfo) {
        console.log('✅ 封面下载成功');
      } else {
        console.warn('⚠️  封面下载失败，将不添加封面');
      }
    } else if (coverChoice === 'local') {
      const localPath = await input({
        message: '请输入封面图片路径（支持 jpg/png/gif/webp/bmp/svg）：',
        validate: (value) => {
          if (!value.trim()) return '路径不能为空';
          return true;
        }
      });
      coverInfo = readCoverFromFile(localPath.trim());
      if (coverInfo) {
        console.log('✅ 封面读取成功');
      }
    }

    // 第六步：选择 EPUB 版本
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

    console.log('\n🚀 开始下载...\n');
    await scraper(url, volsToDownload, coverInfo, epubVersion, saveMode);
    console.log('\n🎉 全部完成！');
  } catch (err) {
    console.error('❌ 程序出错：', err);
  }
})();
