# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A Node.js CLI tool that downloads light novels from wenku8.net and packages them as EPUB3 files. It uses an interactive TUI (text user interface) for input. The entire application lives in a single file — `index.js`.

## Commands

- **Run the app**: `node index.js`
- **Build standalone executable**: `npm run pkg` (uses `pkg` to bundle into `dist/`)
- **Lint**: `npx eslint index.js` (eslint is in devDependencies but no config exists yet)

There are no tests.

## Architecture and data flow

1. **Entry**: The IIFE at the bottom of `index.js` runs an interactive TUI sequence using `@inquirer/prompts` (`input`, `checkbox`, `select`). It gathers: book URL → volume selection → delay preference → cover source.

2. **Scraping**: `getBookInfo()` fetches the book page (GBK-encoded), parses metadata with `cheerio`, then calls `getChapList()` to scrape the chapter index page. The chapter list is stored in a nested JSON structure: `json.content[volumeIndex] = { volume: "卷名", chapters: { chapterIndex: { title, href } } }`.

3. **EPUB generation**: `scraper()` orchestrates the pipeline:
   - `creatEpub()` initializes a JSZip archive with the standard EPUB3 skeleton (`mimetype`, `META-INF/container.xml`, `OEBPS/`).
   - `creatNav()` builds `nav.xhtml` — the EPUB3 table of contents.
   - `creatText()` downloads each chapter page, extracts text as `<p>` elements and images as `<img>` tags into per-chapter XHTML files in `OEBPS/Text/`.
   - `creatOpf()` generates `content.opf` — the EPUB3 manifest and spine.
   - Images are stored in `OEBPS/Image/`, CSS from `style.css` goes to `OEBPS/Style/`.

4. **Output**: The JSZip archive is written as a `.epub` file (which is just a ZIP with a specific structure). Filename is derived from the book title and selected volumes.

## Key libraries

| Library | Purpose |
|---|---|
| `axios` | HTTP requests, with arraybuffer responseType |
| `cheerio` | Parse GBK-decoded HTML to extract metadata, chapter lists, content |
| `jszip` | Build the EPUB ZIP archive in memory |
| `@xmldom/xmldom` | Parse and manipulate XML/XHTML templates (OPF, nav, chapter files) |
| `iconv-lite` | Decode GBK responses to UTF-8 |
| `p-limit` | Concurrency limiting — chapters are processed 1 at a time, images 3 at a time |
| `@inquirer/prompts` | Interactive TUI (input, select, checkbox) |
| `js-beautify` / `xml-formatter` | Pretty-print generated XHTML and OPF XML |

## Reliability patterns

- **Retry with backoff**: `fetchWithRetry()` retries up to 3 times on 429 (rate limit), respecting the `Retry-After` header. Same pattern in `getImgWithRetry()` for images.
- **User-Agent rotation**: `getRandomUserAgent()` returns one of ~10 desktop/mobile UAs.
- **Request delay**: Optional 0.5–1s random delay between requests, controlled by the `delayOrNot` flag set in the TUI.
- **Encoding**: wenku8 pages are GBK-encoded; `iconv-lite` decodes them before cheerio parsing.
- **EPUB3 only**: The tool generates EPUB3 (not EPUB2), which some older readers may not support.
