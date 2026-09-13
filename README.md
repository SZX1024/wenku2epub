# Wenku8 下载器

> **本项目由 AI 编写。**
>
> 代码实现（含重构、测试与文档）由 AI 编程代理完成；需求定义、方案取舍与验收由人工把关。
> 所有改动都跑过回归测试（`npm test`，91 个用例）并用 [EPUBCheck](https://github.com/w3c/epubcheck) 校验过产物（EPUB 2 / EPUB 3 均为 0 error / 0 warning），
> 但这**不构成对代码正确性或适用性的保证**，使用前请自行评估。

从 [wenku8](https://www.wenku8.net/) 下载轻小说，支持 EPUB 电子书和 TXT+插图两种输出格式的 Node.js 命令行工具。

## 功能

- 下载轻小说正文及插图，生成 EPUB 电子书或 TXT+插图文件
- **交互式 TUI 与命令行两种用法**：`node index.js` 进入向导，带参数即为非交互模式，便于脚本化与批量下载
- **增量更新**：章节正文与插图本地缓存，追更时只下载新增/失败的章节（实测重跑从 29.7s 降到 2.0s）
- **可调并发**：章节与插图并发数可配置；延迟模式下一个全局限速器统一控制所有请求速率
- 支持 EPUB 2 和 EPUB 3 两种格式（两种输出均通过 epubcheck 校验，0 error / 0 warning）
- 生成独立的封面页与每卷卷首页，阅读顺序与目录层级完整
- **插图按索引放回正文**：部分录入组会在正文里留下 `（插图006）` 这类位置标记。识别到标记时，会把对应插画插到正文原处，并把编号更小的口绘/彩页单独做成「彩页」放在该卷正文之前；**插图章仍保留全部图片不变**。没有标记的书（或卷）完全按原样输出 —— 见下方说明
- **系列元数据**：写入 `belongs-to-collection`（EPUB3）/ `calibre:series`（EPUB2），阅读器可自动归组排序；同时补上 `dc:date`、`dc:publisher`、`dc:subject`（作品标签）
- **章节粒度下载**：可以只下第 5~10 章，而不必整卷
- **批量下载**：一次传入多个网址，或从文件批量读取
- **失败清单**：失败章节写成 `*.failed.json`，用 `--retry-failed` 精确重试
- **配置文件**：`~/.wenku2epubrc` 或项目内 `.wenku2epubrc` 保存常用偏好
- **插图去重**：内容相同的插图只保存一份；可选调用 `sharp` 压缩
- 插图按原文顺序插入，不会被统一挤到章末
- TXT 模式：文本按分卷合并为 `.txt`，正文中插入 `［插图：images/xxx.jpg］` 占位标记；插图保留原格式（png/webp/jpg）
- 支持分卷选择下载，可分卷保存或合并为一个文件
- 多来源封面：网页、章节插图手动挑选、**分辨率最高的插图（`best`）**、该卷第一张插图（`auto`）、自定义 URL、本地图片
- 卷名中的中文数字自动转阿拉伯数字（如"第一卷"→"第1卷"），便于阅读器排序；书名保持原样
- 自动重试机制（429 限流、5xx、超时等瞬时错误），`Retry-After` 封顶 60s
- 下载失败的章节会明确告警并从目录中剔除，不会留下断链；此时退出码为 1
- 终端进度条显示下载进度

## 使用说明

### 环境要求

需要 Node.js **20.19+**（依赖 `@inquirer/prompts`、`p-limit` 等 ESM-only 包，通过 `require(esm)` 加载）。
建议从 [nodejs.org](https://nodejs.org/) 下载安装。

### 安装与运行

```bash
git clone https://github.com/Summerburier/wenku2epub.git
cd wenku2epub
npm install
node index.js            # 交互式
node index.js --help     # 查看全部命令行参数
```

> 交互模式必须在**真实交互式终端**中运行。通过管道喂入 stdin（如 `echo | node index.js`）会被视为取消并退出（退出码 130）；脚本场景请改用命令行参数。

### 交互流程

1. 输入小说的 wenku8 网址（如 `https://www.wenku8.net/book/3057.htm`）
2. 选择要下载的分卷（默认全选）
3. 输入章节范围（直接回车=全部；也可填 `1-10` 或 `1,3,5`，按每卷内部序号）
4. 选择输出格式（EPUB 电子书 / TXT+插图）
5. 选择是否启用请求延迟（推荐启用）
6. 选择章节并发数（默认 3）
7. 选择封面来源（网页/章节插图/最高分辨率插图/该卷第一张/自定义 URL/本地文件/跳过）
8. EPUB 模式：选择保存方式（合并/分散）+ EPUB 版本
9. 等待下载完成，文件生成在 `output/` 目录

### 命令行用法

```bash
# 下载整本书为 EPUB3
node index.js -u https://www.wenku8.net/book/3057.htm

# 只要第 1、3~5 卷，输出到 ./books
node index.js -u https://www.wenku8.net/book/3057.htm -v 1,3-5 -o ./books

# 每卷只下前 10 章
node index.js -u https://www.wenku8.net/book/3057.htm -v 1 --chapters 1-10

# 每卷一个 EPUB，封面用全书分辨率最高的插图（站内封面只有 209x300，
# 书内插图常有 2000px 级，像素量差几十倍）
node index.js -u https://www.wenku8.net/book/3057.htm --separate --cover best

# 关闭限速并提高到 4 并发（更快，但更容易被限流）
node index.js -u https://www.wenku8.net/book/3057.htm --no-delay --concurrency 4

# 批量下载：重复传 -u，或从文件读取（每行一个网址，# 开头为注释）
node index.js -u URL1 -u URL2 -u URL3 -o ./books
node index.js --batch urls.txt -o ./books

# 按失败清单只重试失败的章节
node index.js --retry-failed "output/某书.failed.json"

# TXT + 插图
node index.js -u https://www.wenku8.net/book/3057.htm -f txt

# 缓存管理
node index.js --cache-info
node index.js --clear-cache
```

退出码：`0` 成功，`1` 有章节失败或运行出错，`2` 参数错误，`130` 用户取消。

### 配置文件

在 `~/.wenku2epubrc`（全局）或项目根目录的 `.wenku2epubrc`（项目级，优先级更高）放一份 JSON，即可省去重复输入。命令行显式给出的参数永远优先。

```json
{
  "out": "./books",
  "epubVersion": 3,
  "cover": "best",
  "delay": true,
  "concurrency": 3,
  "imageConcurrency": 3,
  "cache": true,
  "dedupeImages": true,
  "chapters": "all"
}
```

可用 `--config <file>` 指定别的配置文件。无法识别的字段只会警告并忽略。

### 失败清单与重试

有章节下载失败时，会在输出目录写出 `{书名}.failed.json`，记录失败的卷/章与原因。直接重跑同一命令即可（已成功的章节命中缓存），也可以精确重试：

```bash
node index.js --retry-failed "output/某书.failed.json"
```

### 增量更新与缓存

章节正文和插图会缓存到 `.cache/wenku2epub/`（已加入 `.gitignore`）。书籍主页与目录页**不缓存**，所以连载更新后直接重跑同一命令即可：已成功的章节走缓存，只下载新增和上次失败的章节。

- `--no-cache` 关闭缓存
- `--refresh` 忽略已有缓存、全部重下（仍会写回缓存）
- `--cache-info` / `--clear-cache` 查看占用 / 清空
- 缓存目录可用环境变量 `WENKU2EPUB_CACHE_DIR` 覆盖

### 输出结构

```
output/
├── {书名}.epub                      （EPUB 合并模式）
├── {书名}_{卷名}.epub               （EPUB 部分选择合并）
├── {书名}_{卷名}_章节1-10.epub      （带章节范围时会加后缀，避免互相覆盖）
├── {书名}.failed.json               （有失败章节时才生成）
├── {书名}/
│   ├── {卷名}.epub                  （EPUB 分散模式）
│   ├── cover.jpg
│   └── {卷名}/
│       ├── {卷名}.txt               （TXT 模式）
│       └── images/
│           ├── 000_000_000.png
│           └── ...
.cache/wenku2epub/                   （章节/插图缓存，可随时删除）
```

### 本地封面

如需使用本地封面，将图片放在项目根目录并命名为 `cover.jpg`（也支持 `.png`、`.gif`、`.webp`、`.bmp`、`.svg`），程序会自动检测。也可在交互界面中指定路径，或用 `--cover local --cover-file <path>`。

### 插图去重与压缩

同一张插图常在特典、正文章节里重复出现，程序会按内容哈希去重，只保存一份并让引用指向同一文件。

可选的有损压缩依赖 [sharp](https://sharp.pixelplumbing.com/)：装了就自动启用，没装则只做去重并给出提示。

```bash
npm install sharp
node index.js -u <url> --compress-images --image-quality 80
```

### 插图按索引放回正文

轻小说站点的「插图」章往往把整卷的图**堆在最后**，读起来和正文脱节。部分录入组会在正文里留下位置标记，形如：

```
「──终局停滞委员会。我们是持续守护着已经完蛋的世界，一群愚蠢的好事分子！」
（插图006）
```

程序识别到这种标记后（**默认开启**）：

| 图片编号 | 处理 |
|---|---|
| 有标记的（如 6~14） | 插到正文中标记所在的位置 |
| 编号更小的（如 1~5，通常是口绘/角色页） | 汇总成一个「彩页」页，放在该卷卷首页之前 |
| **「插图」章** | **完全不动，全部图片照旧保留一份** |
| 整个卷没有标记 | **完全不动**，插图仍留在最后的「插图」章 |

正文里的插图与「插图」章里的是**同一个文件**，不会重复占体积。

实测效果（`https://www.wenku8.net/book/3947.htm` 第一卷，14 张图、9 个标记）：

```
阅读顺序: 封面页 → 彩页(1~5) → 卷首页 → 序幕(含 6,7) → 第1话(含 8,9) → …
「插图」章: 仍是完整的 14 张
```

关闭这个行为用 `--no-illustration-anchors`，或在配置文件里设 `"illustrationAnchors": false`。

> 注意：这个标记是**录入组自觉添加**的，并非站点保证。同一本书里可能只有部分卷有（例如 3947 只有第一卷、第二卷有），没有标记的卷按原样输出。程序只认「有效且对应图片确实下载成功」的标记，遇到越界编号或下载失败时**保留原始标记文字**并给出告警，不会丢内容。

## 技术说明

- 网站编码为 GBK，使用 `iconv-lite` 解码
- 全局限速器串行发放请求"发车时刻"，正文与插图共用同一个速率上限
- 同一 URL 的并发请求会合并成一次，避免重复下载同一张插图
- EPUB 2 使用 NCX 导航与 XHTML 1.1 章节模板，EPUB 3 使用 nav.xhtml 导航
- manifest 中的 id 全部为合法 NCName；manifest 只声明确实写入压缩包的文件
- 不预先创建空的 `OEBPS/Image` 等目录（会触发 epubcheck PKG-014）
- TXT 插图按章节来源分组，文件名中保留卷/章/序号信息
- 请求失败会按指数退避重试（429 遵循 `Retry-After`，上限 60s），非瞬时错误不重试

## 开发

```bash
npm test        # 运行回归测试（node:test，无需额外依赖）
npm run lint    # ESLint 检查
java -jar epubcheck.jar output/*.epub   # EPUB 合规性校验
```

抓取层的解析逻辑用 `test/fixtures/` 下的**真实页面快照**做离线断言。站点改版导致解析测试失败时，重跑抓取脚本并看 fixtures 的 diff：

```bash
node tools/capture-fixtures.js   # 重新抓取样本（需要联网）
git diff test/fixtures/          # 站点具体改了什么，一目了然
```
