const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('./config');

// 缓存放在项目内的 .cache/ 下：不污染 output/，也方便整体删除或加入 .gitignore
const CACHE_ROOT = process.env.WENKU2EPUB_CACHE_DIR || path.join(PROJECT_ROOT, '.cache', 'wenku2epub');

// 默认开启。章节正文和插图在发布后不会变化，缓存它们是安全的；
// 书籍主页与目录页永远不走缓存（连载会有新章节），由调用方决定传不传 kind。
let enabled = true;
let refresh = false;

const stats = { hits: 0, misses: 0, writes: 0 };

function configure({ enabled: on, refresh: force } = {}) {
  if (on !== undefined) enabled = Boolean(on);
  if (force !== undefined) refresh = Boolean(force);
  return { enabled, refresh };
}

function isEnabled() {
  return enabled;
}

function isRefresh() {
  return refresh;
}

function getStats() {
  return { ...stats };
}

function resetStats() {
  stats.hits = 0;
  stats.misses = 0;
  stats.writes = 0;
}

function cachePath(kind, key) {
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(CACHE_ROOT, kind, hash.slice(0, 2), `${hash}.bin`);
}

// 命中返回 Buffer；未命中、缓存关闭或 refresh 模式返回 null
function read(kind, key) {
  if (!enabled || refresh) return null;

  try {
    const data = fs.readFileSync(cachePath(kind, key));
    stats.hits++;
    return data;
  } catch {
    stats.misses++;
    return null;
  }
}

function write(kind, key, buffer) {
  if (!enabled || !buffer) return;

  const file = cachePath(kind, key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    stats.writes++;
  } catch (err) {
    // 缓存写失败不应该影响正常下载
    console.warn(`缓存写入失败（已忽略）: ${err.message}`);
  }
}

function clear() {
  fs.rmSync(CACHE_ROOT, { recursive: true, force: true });
  resetStats();
}

// 递归统计缓存占用，供 --cache-info 使用
function size() {
  let bytes = 0;
  let files = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {
          // 文件可能刚被删除，忽略
        }
      }
    }
  };

  walk(CACHE_ROOT);
  return { bytes, files, root: CACHE_ROOT };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

module.exports = {
  CACHE_ROOT,
  configure,
  isEnabled,
  isRefresh,
  read,
  write,
  clear,
  size,
  formatSize,
  getStats,
  resetStats,
  cachePath,
};
