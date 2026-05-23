# Wenku8 EPUB 下载器

从 [wenku8](https://www.wenku8.net/) 下载轻小说并生成 EPUB 电子书的 Node.js 命令行工具。

## 功能

- 下载轻小说正文及插图，生成 EPUB 电子书
- 支持 EPUB 2 和 EPUB 3 两种格式
- 支持分卷选择下载（可只下载特定卷）
- 支持多来源封面：网页自动获取、自定义 URL、本地图片
- 可选的请求延迟，防止被服务器限流
- 自动重试机制（处理 429 限流）
- 终端进度条显示下载进度

## 使用说明

### 环境要求

需要 Node.js 环境，建议从 [nodejs.org](https://nodejs.org/) 下载安装。

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/Summerburier/wenku2epub.git
cd wenku2epub

# 安装依赖
npm install

# 运行
node index.js
```

### 交互流程

1. 输入小说的 wenku8 网址（如 `https://www.wenku8.net/book/3057.htm`）
2. 选择要下载的分卷（默认全选）
3. 选择是否启用请求延迟（推荐启用）
4. 选择封面来源（网页/自定义 URL/本地文件/跳过）
5. 选择 EPUB 版本（EPUB 3 或 EPUB 2）
6. 等待下载完成，EPUB 文件生成在当前目录

### 本地封面

如需使用本地封面，将图片放在项目根目录并命名为 `cover.jpg`（也支持 `.png`、`.gif`、`.webp`、`.bmp`、`.svg`），程序会自动检测。也可在交互界面中手动指定路径。

## 技术说明

- 网站编码为 GBK，使用 `iconv-lite` 解码
- 章节下载串行、图片下载并发（最多 3 个）
- EPUB 2 使用 NCX 导航，EPUB 3 使用 nav.xhtml 导航
- 打包为独立可执行文件：`npm run pkg`（输出到 `dist/`）
