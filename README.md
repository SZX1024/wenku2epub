# Wenku8 下载器

从 [wenku8](https://www.wenku8.net/) 下载轻小说，支持 EPUB 电子书和 TXT+插图两种输出格式的 Node.js 命令行工具。

## 功能

- 下载轻小说正文及插图，生成 EPUB 电子书或 TXT+插图文件
- 支持 EPUB 2 和 EPUB 3 两种格式
- TXT 模式：文本按分卷合并为 `.txt`，插图保留原格式（png/webp/jpg）
- 支持分卷选择下载，可分卷保存或合并为一个文件
- 多来源封面：网页自动获取、章节插图选择（含浏览器 HTML 预览）、自定义 URL、本地图片
- 章节插图封面支持逐卷选择，下载完成后从实际图片中挑选
- 元数据中文数字自动转阿拉伯数字（如"第一卷"→"第1卷"），便于阅读器排序
- 可选的请求延迟，防止被服务器限流
- 自动重试机制（处理 429 限流）
- 终端进度条显示下载进度
- 所有生成文件统一输出到 `output/` 目录

## 使用说明

### 环境要求

需要 Node.js 环境，建议从 [nodejs.org](https://nodejs.org/) 下载安装。

### 安装与运行

```bash
git clone https://github.com/Summerburier/wenku2epub.git
cd wenku2epub
npm install
node index.js
```

### 交互流程

1. 输入小说的 wenku8 网址（如 `https://www.wenku8.net/book/3057.htm`）
2. 选择要下载的分卷（默认全选）
3. 选择输出格式（EPUB 电子书 / TXT+插图）
4. 选择是否启用请求延迟（推荐启用）
5. 选择封面来源（网页/章节插图/自定义 URL/本地文件/跳过）
6. EPUB 模式：选择保存方式（合并/分散）+ EPUB 版本
7. 等待下载完成，文件生成在 `output/` 目录

### 输出结构

```
output/
├── {书名}.epub                      （EPUB 合并模式）
├── {书名}_{卷名}.epub               （EPUB 部分选择合并）
├── {书名}/
│   ├── {卷名}.epub                  （EPUB 分散模式）
│   ├── cover.jpg
│   └── {卷名}/
│       ├── {卷名}.txt               （TXT 模式）
│       └── images/
│           ├── 000_000_000.png
│           └── ...
```

### 本地封面

如需使用本地封面，将图片放在项目根目录并命名为 `cover.jpg`（也支持 `.png`、`.gif`、`.webp`、`.bmp`、`.svg`），程序会自动检测。也可在交互界面中手动指定路径。

## 技术说明

- 网站编码为 GBK，使用 `iconv-lite` 解码
- 章节下载串行、图片下载并发（最多 3 个）
- EPUB 2 使用 NCX 导航，EPUB 3 使用 nav.xhtml 导航
- TXT 插图按章节来源分组，文件名中保留卷/章/序号信息
- 打包为独立可执行文件：`npm run pkg`（输出到 `dist/`）
