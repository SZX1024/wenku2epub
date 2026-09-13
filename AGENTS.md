# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## Project overview

A Node.js tool that downloads light novels from wenku8.net and packages them as EPUB 2 / EPUB 3 files or TXT + images. It has two front ends: an interactive TUI (`@inquirer/prompts`) when invoked with no arguments, and a non-interactive CLI when given flags.

The entry point `index.js` is a thin dispatcher; all logic lives in `lib/`:

| File | Responsibility |
|---|---|
| `index.js` | Shebang shim — no args → `lib/tui.js`'s `main()`; args → `lib/cli.js`'s `runCli()` |
| `lib/tui.js` | Interactive flow; exports `main()` and `selectChapterCover()` |
| `lib/cli.js` | Argument parsing + non-interactive pipeline (batch URLs, retry-failed); exports `resolveOptions()`, `resolveVolumes()`, `resolveChapters()`, `loadFailureReport()`, `runCli()` |
| `lib/scraper.js` | Orchestrates EPUB output (merged / separate-per-volume); writes `*.failed.json` |
| `lib/epub.js` | EPUB assembly: chapters, cover page, volume pages, nav.xhtml, toc.ncx, content.opf, image dedup/compression |
| `lib/txt.js` | TXT + images output |
| `lib/parse.js` | Book metadata (title, tags, date, publisher), chapter index, ordered content extraction |
| `lib/runtime.js` | `createRunContext()` — the per-run config object (outDir, cache, rate limiter, concurrency limits, net client) |
| `lib/fetch.js` | `createRateLimiter()` / `createNetClient()` / `decodePage()`; retry/backoff, caching, GBK decoding |
| `lib/cache.js` | `createCacheStore()` — content-addressed on-disk cache for chapter HTML and images |
| `lib/configfile.js` | Loads `~/.wenku2epubrc` and `./.wenku2epubrc` (whitelisted keys, CLI wins) |
| `lib/cover.js` | Cover from URL/file; magic-byte format detection; image dimension parsing |
| `lib/config.js` | Constants, XML/XHTML templates, filename/numeral/index-spec helpers |
| `lib/progress.js` | Terminal progress bar |

Outside `lib/`:

| Path | Responsibility |
|---|---|
| `test/fixtures/` | Real captured wenku8 pages (see its README) used by `test/scrape.test.js` |
| `tools/capture-fixtures.js` | Maintenance script that re-captures those fixtures — **kept out of `test/` on purpose**, since `node --test` executes every `.js` under `test/` |

## Commands

- **Interactive**: `node index.js` — requires a real TTY; piped stdin is treated as a cancel (exit 130)
- **Non-interactive**: `node index.js -u <url> [-v 1,3-5] [--chapters 1-10] [-f epub|txt] [-o dir] [...]`; `--help` lists everything
- **Test**: `npm test` (`node --test`, Node's built-in runner, no extra deps)
- **Lint**: `npm run lint` (`eslint.config.js` is a flat config)
- **Node version**: 20.19+ required. `@inquirer/prompts` and `p-limit` are ESM-only and are loaded from CommonJS via `require(esm)`.
- **Optional**: `npm install sharp` enables `--compress-images`; without it only dedup runs and the flag degrades with a warning.

Exit codes: `0` success, `1` partial failure / runtime error, `2` bad arguments, `130` user cancelled.

## Architecture and data flow

1. **Entry**: `lib/tui.js` gathers book URL → volume selection → chapter range → format → delay preference → chapter concurrency → cover source → (EPUB) save mode + version. `lib/cli.js` parses the equivalent flags and runs the same pipeline without prompts, optionally for several URLs in one invocation. Precedence for every setting is **CLI flag > config file > built-in default** (`lib/configfile.js`). TUI exceptions are caught in `main()`: `CancelledError`/`ExitPromptError` → exit 130, anything else → exit 1.

2. **Scraping** (`lib/parse.js`): `getBookInfo()` fetches the book page (GBK), parses metadata with `cheerio`, then `getChapList()` scrapes the index page into `json.content[volumeIndex] = { volume, chapters: { chapterIndex: { title, href } } }`. `extractChapterContent()` walks `#content` in document order and returns `[text|img]` items — this is shared by both `epub.js` and `txt.js`, so paragraphs and illustrations stay in their original relative order and nested text is not dropped.

3. **Fetching** (`lib/fetch.js` + `lib/cache.js`): every request goes through the `net` client on the run context. `net.requestBuffer()` is the only HTTP entry point and does cache lookup → in-flight de-duplication → rate-limit slot → retry. **`net.loadBookPage()` never caches** (book/index pages change as chapters are published); **`net.loadChapterPage()` and `net.loadImage()` do** (published content is immutable). This is what makes re-running for new chapters an incremental update.

4. **EPUB generation** (`lib/epub.js`): `creatEpub(json, options)` drives:
   - `creatText()` downloads each chapter, writing `OEBPS/Text/{vol}_{ch}.xhtml` and images into `OEBPS/Image/`.
   - `creatNav()` (EPUB3) / `creatNcx()` (EPUB2) build the TOC.
   - `creatOpf()` builds `content.opf`.
   - A `cover.xhtml` page and one `vol_{n}.xhtml` title page per volume are generated so that every nav/NCX target is a real document.

5. **State tracking is authoritative, not planned.** `creatText()` records `json._written` (chapters actually written), `json.imgs` (images actually downloaded), and `json.skipped` (failures). `creatNav`/`creatNcx`/`creatOpf` iterate over `writtenVolumes()` / `json._written`, never over the raw chapter index — so a failed request can never leave a dangling TOC entry, spine reference, or manifest item. **Preserve this invariant** when touching the EPUB pipeline.

6. **Output**: the JSZip archive is written under `run.outDir` (default `output/`, overridable with `-o`). `scraper()` accepts an options object and can reuse an already-fetched `json` (both front ends pass it in) to avoid re-requesting the book page.

## RunContext: no module-level mutable state

Everything that used to be a module-level singleton is now a field on one explicit object created per run:

| Was | Now |
|---|---|
| `config.setOutputDir()` / `getOutputDir()` | `run.outDir` |
| `fetch.setDelayMode()` / `setRateLimit()` | `run.limiter` (created by `createRateLimiter`) |
| `epub.setConcurrency()` | `run.limits.chapters` / `run.limits.images` (pLimit instances) |
| `cache.configure()` | `run.cache` (a store from `createCacheStore`) |

**Why it matters:** the old design allowed only one configuration per process, so two concurrent jobs with different settings would clobber each other. **Do not reintroduce module-level mutable state** — create it on the context instead. `test/runtime.test.js` asserts the isolation (including two different-config jobs running concurrently).

### Injection points make the pipeline offline-testable

`run.net` is an object with `loadBookPage`, `loadChapterPage`, `loadImage`, `requestBuffer`, `fetchFresh`. Pass overrides to `createRunContext({ net })` and the whole pipeline runs with **no network at all**:

```js
const run = createRunContext({
  cache: { enabled: false },
  net: { loadChapterPage: async () => cheerio.load(html), loadImage: async (src) => buffers[src] },
});
```

Use this rather than monkey-patching module exports. Patching is unreliable here because modules destructure their imports at load time, which makes the result depend on `require` order.

### Offline fixture tests

`test/scrape.test.js` drives `getBookInfo`/`getChapList` against real captured pages from `test/fixtures/`. Note what this does and does not buy:

- It **does** catch regressions in our parsers — any change that breaks real-page parsing fails immediately and offline.
- It does **not** by itself detect site changes: a stale fixture still parses fine. Site changes are found by re-running `node tools/capture-fixtures.js` and reviewing the fixture diff, at which point these tests tell you exactly which parser broke.

The fixtures were verified to parse byte-identically to the live pages at capture time.

## EPUB correctness invariants

These were all previously violated and are now covered by `test/epub.test.js` (and `test/scrape.test.js` for the parser-level ones):

- **manifest `@id` must be a valid NCName** — never use file paths as ids (`Text/0_0.xhtml` is illegal). Use `itemId(prefix, value)`.
- **Nothing may be declared that is not in the archive** — the cover item, the CSS item, and EPUB2's `<meta name="cover">` are all conditional on the file actually existing.
- **EPUB2's `<guide>` may only reference content documents.** `reference type="cover"` points at `Text/cover.xhtml`, never at the image.
- **One nav/NCX target per entry.** Every volume has its own `vol_{n}.xhtml` title page precisely so the volume navPoint and its first chapter do not collide; that also lets NCX `playOrder` stay unique and sequential. Do not point the volume entry back at a chapter.
- **EPUB2 must use XHTML 1.1 markup** (`content_xhtml_epub2`, a `<div>`), not HTML5 `<section>`.
- **Never run `convertCnNumerals()` over a book title** — it turns "三体" into "3体". Use `convertVolumeNumeral()`, which only rewrites `第X卷/册/部/篇`.
- **Never pre-create empty directories in the zip.** JSZip creates parent folders implicitly; calling `book.folder('OEBPS/Image')` up front produces an empty-directory entry that epubcheck flags as `PKG-014` whenever a selection contains no illustrations (e.g. `--chapters 1-2` on a book whose art is in a later chapter).
- **Image dedup happens in a synchronous loop** (`processChapter`) on purpose: deciding inside the concurrent download task would let two chapters both "miss" and write the same image twice. Only images actually written get a manifest item; deduped references are re-pointed at the surviving file.
- **Chapter selection filters at queue time** (`creatText`), and everything downstream already keys off `json._written`, so a filter needs no changes in nav/ncx/opf.

## Image handling

- `--cover best` picks the highest pixel-count illustration across the selection (`json.imgInfo`, filled from `imageDimensions()` in `lib/cover.js`). This exists because the site's own cover is only 209×300 while in-book art is often ~2100×1600 — a ~56× pixel difference.
- `--compress-images` uses `sharp` **only if installed**; `getSharp()` caches the probe and `warnSharpMissing()` degrades gracefully. Never make sharp a hard dependency.

## Reliability patterns

- **Single HTTP entry point** (`lib/fetch.js`): `net.requestBuffer()` does cache → in-flight de-dup → rate-limit slot → retry. Add new requests through it, not with raw `axios`.
- **Caching** (`lib/cache.js`): content-addressed by URL under `.cache/wenku2epub/` (override with `WENKU2EPUB_CACHE_DIR`). Only immutable content is cached (`loadChapterPage`, `loadImage`). This makes "re-run to pick up new chapters" an incremental update.
- **Rate limiting**: `createRunContext({ delay: true })` installs a jittered 500–1000 ms minimum interval shared by *all* of that run's requests; `rateLimitMs` overrides it (`0` = off). Concurrency lives in `run.limits`, capped at 8.
- **Retry with backoff**: retries 429, 5xx, and network errors (timeouts, resets); `Retry-After` is honored but capped at 60s. Other 4xx abort immediately.
- **Success signalling**: `net.loadImage()` returns a `Buffer` or `null`, and callers only register artifacts that really landed (a failed image loses its `<img>` tag and never reaches the manifest).
- **User-Agent rotation**: `getRandomUserAgent()` returns one of ~10 desktop/mobile UAs.
- **Encoding**: wenku8 pages are GBK; `decodePage()` is the single decode point (and is directly unit-tested).
- **Paths**: `style.css` and local `cover.*` resolve against `PROJECT_ROOT`; the output root is `run.outDir`. Never use `process.cwd()` directly.

## Validation

Real end-to-end runs can be validated with [epubcheck](https://github.com/w3c/epubcheck):

```bash
java -jar epubcheck.jar output/*.epub
```

Both EPUB2 and EPUB3 output currently validate with 0 errors / 0 warnings.
