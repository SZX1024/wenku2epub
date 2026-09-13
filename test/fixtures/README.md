# 测试样本（fixtures）

这些文件是 **wenku8 真实页面的快照**，供 `test/scrape.test.js` 做**离线**断言。
抓取层的解析逻辑本身没法用合成 HTML 验证——只有真实样本才能在站点改版时让测试变红。

## 文件

| 文件 | 内容 |
|---|---|
| `book-page.html` | 书籍主页（书名/作者/文库分类/状态/更新时间/作品 Tags/简介/封面/「小说目录」链接） |
| `chapter-index.html` | 目录页（`td.vcss` 卷行 + `td.ccss` 章节行） |
| `chapter-text.html` | 一个正文章节（`#content` 里的文本节点） |
| `chapter-images.html` | 插图章节（`#content` 里的 `<img>`） |
| `capture.json` | 抓取时间、来源 URL、以及断言用到的关键字段 |

## 重新抓取

站点改版导致测试失败时，重跑抓取脚本，然后**看 fixtures 的 diff** 就知道站点具体改了什么：

```bash
node tools/capture-fixtures.js
git diff test/fixtures/
```

脚本放在 `tools/` 而不是 `test/`，因为 `node --test` 会执行 `test/` 下所有 `.js` 文件。

## 做了什么裁剪

样本**只保留解析所依赖的结构**：

- 移除与解析无关的大块内容（评论区、同类推荐、书评）和 `script`/`iframe`。
- 章节页的**正文文字被截断**（正文章节最多保留 15 个文本节点、每段 60 字；插图章节 3 个节点、每段 20 字）。
  这样既压缩体积，也避免把整章小说正文放进仓库。
- **标签名、class、`href`、`src` 一律保持原样** —— 这些才是解析契约。

已验证：用这些样本跑 `getBookInfo` 与直接抓线上页面得到的**书名、作者、简介、出版社、状态、日期、标签、封面 URL，以及全部 11 卷 / 233 章的卷名、章节名、href 完全一致**。

`book-page.html` 里的作品简介（`span[style*="font-size:14px"]`）**未截断**，因为它是测试简介选择器的关键，且本身就是出版方提供的短元数据。
