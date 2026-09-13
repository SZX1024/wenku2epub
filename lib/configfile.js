const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILENAME = '.wenku2epubrc';

// 白名单：配置文件里出现未知字段只警告、不生效，避免拼错名字后静默失效
const ALLOWED_KEYS = [
  'url', 'volumes', 'chapters', 'format', 'out', 'epubVersion', 'separate',
  'cover', 'coverUrl', 'coverFile', 'delay', 'rate', 'concurrency',
  'imageConcurrency', 'cache', 'dedupeImages', 'compressImages',
];

function readConfigFile(file, { explicit }) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || !explicit) return null;
    throw new Error(`无法读取配置文件 ${file}：${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${file} 不是合法 JSON：${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${file} 必须是一个 JSON 对象`);
  }

  const config = {};
  const ignored = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (ALLOWED_KEYS.includes(key)) config[key] = value;
    else ignored.push(key);
  }
  if (ignored.length > 0) {
    console.warn(`⚠️  配置文件 ${file} 中忽略了未知字段：${ignored.join('、')}`);
  }
  return config;
}

// 读取偏好设置。优先级：--config 指定文件 > 项目内 .wenku2epubrc > ~/.wenku2epubrc
// 返回的对象带 _sources 记录实际生效的文件，便于在启动信息里展示。
function loadConfig(explicitPath = null) {
  if (explicitPath) {
    const config = readConfigFile(path.resolve(explicitPath), { explicit: true });
    if (!config) throw new Error(`配置文件不存在：${explicitPath}`);
    return { ...config, _sources: [path.resolve(explicitPath)] };
  }

  const sources = [];
  const merged = {};

  // 先家目录（通用偏好），再项目内（针对该项目的覆盖）
  for (const file of [
    path.join(os.homedir(), CONFIG_FILENAME),
    path.join(process.cwd(), CONFIG_FILENAME),
  ]) {
    const config = readConfigFile(file, { explicit: false });
    if (!config) continue;
    Object.assign(merged, config);
    sources.push(file);
  }

  return { ...merged, _sources: sources };
}

function configPaths() {
  return {
    home: path.join(os.homedir(), CONFIG_FILENAME),
    project: path.join(process.cwd(), CONFIG_FILENAME),
  };
}

module.exports = { loadConfig, configPaths, CONFIG_FILENAME, ALLOWED_KEYS };
