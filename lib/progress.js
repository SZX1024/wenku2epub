class ProgressBar {
  constructor(total, title = '进度') {
    this.total = total;
    this.current = 0;
    this.title = title;
    this.startTime = Date.now();
    this.width = 40;
  }

  tick(msg = '') {
    this.current++;
    this.render(msg);
  }

  render(msg = '') {
    const pct = this.total > 0 ? Math.min(100, Math.floor(this.current / this.total * 100)) : 0;
    const filled = Math.floor(pct / 100 * this.width);
    const empty = this.width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const remaining = pct > 0 ? ` 剩余约${((Date.now() - this.startTime) / pct * (100 - pct) / 1000).toFixed(0)}s` : '';
    const displayMsg = msg ? ` ${msg}` : '';
    process.stdout.write(`\r\x1b[K${this.title} [${bar}] ${pct}% (${this.current}/${this.total}) ${elapsed}s${remaining}${displayMsg}`);
  }

  complete(msg = '') {
    this.current = this.total;
    this.render(msg);
    process.stdout.write('\n');
  }
}

module.exports = ProgressBar;
