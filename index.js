#!/usr/bin/env node
// 有参数 → 非交互 CLI；无参数 → 交互式 TUI
const args = process.argv.slice(2);

const fail = (err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 2;
};

if (args.length > 0) {
  const { resolveOptions, runCli, CliError } = require('./lib/cli');

  (async () => {
    let options;
    try {
      options = resolveOptions(args);
    } catch (err) {
      if (err instanceof CliError) {
        console.error(`❌ ${err.message}`);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
    process.exitCode = await runCli(options);
  })().catch((err) => {
    if (err instanceof CliError) return fail(err);
    console.error('❌ 程序出错：', err);
    process.exitCode = 1;
  });
} else {
  require('./lib/tui').main().catch((err) => {
    console.error('❌ 程序出错：', err);
    process.exitCode = 1;
  });
}
