const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('./config');

// 缓存放在项目内的 .cache/ 下：不污染 output/，也方便整体删除或加入 .gitignore
const DEFAULT_CACHE_ROOT = process.env.WENKU2EPUB_CACHE_DIR || path.join(PROJECT_ROOT, '.cache', 'wenku2epub');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 缓存句柄。以前这里是模块级单例（configure/isEnabled/...），
// 导致同一个进程里无法用不同开关并发跑两个任务；现在改成一次性创建的对象，
// 每个 RunContext 持有自己的实例。
//
// 默认开启。章节正文和插图在发布后不会变化，缓存它们是安全的；
// 书籍主页与目录页永远不走缓存（连载会有新章节），由调用方决定传不传 kind。
function createCacheStore({ enabled = true, refresh = false, root = DEFAULT_CACHE_ROOT } = {}) {
  const stats = { hits: 0, misses: 0, writes: 0 };
  let on = Boolean(enabled);
  let force = Boolean(refresh);

  function cachePath(kind, key) {
    const hash = crypto.createHash('sha1').update(String(key)).digest('hex');
    return path.join(root, kind, hash.slice(0, 2), `${hash}.bin`);
  }

  return {
    root,

    configure({ enabled: nextEnabled, refresh: nextRefresh } = {}) {
      if (nextEnabled !== undefined) on = Boolean(nextEnabled);
      if (nextRefresh !== undefined) force = Boolean(nextRefresh);
      return { enabled: on, refresh: force };
    },

    isEnabled: () => on,
    isRefresh: () => force,

    // 命中返回 Buffer；未命中、缓存关闭或 refresh 模式返回 null
    read(kind, key) {
      if (!on || force) return null;

      try {
        const data = fs.readFileSync(cachePath(kind, key));
        stats.hits++;
        return data;
      } catch {
        stats.misses++;
        return null;
      }
    },

    write(kind, key, buffer) {
      if (!on || !buffer) return;

      const file = cachePath(kind, key);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buffer);
        stats.writes++;
      } catch (err) {
        // 缓存写失败不应该影响正常下载
        console.warn(`缓存写入失败（已忽略）: ${err.message}`);
      }
    },

    clear() {
      fs.rmSync(root, { recursive: true, force: true });
      stats.hits = 0;
      stats.misses = 0;
      stats.writes = 0;
    },

    // 递归统计缓存占用，供 --cache-info 使用
    size() {
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

      walk(root);
      return { bytes, files, root };
    },

    getStats: () => ({ ...stats }),
    resetStats() {
      stats.hits = 0;
      stats.misses = 0;
      stats.writes = 0;
    },

    cachePath,
  };
}

module.exports = { createCacheStore, formatSize, DEFAULT_CACHE_ROOT };
