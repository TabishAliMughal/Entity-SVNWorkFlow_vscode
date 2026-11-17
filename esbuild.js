const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  const configs = tests
    ? [{
        ...common,
        entryPoints: [
          'test/integration/runTest.ts',
          'test/integration/suite/index.ts',
          'test/integration/suite/smoke.test.ts',
          'test/integration/suite/e2e.test.ts',
        ],
        outdir: 'out/test/integration',
        outbase: 'test/integration',
        external: ['vscode', '@vscode/test-electron', 'mocha'],
      }]
    : [{
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        external: ['vscode'],
      }];
  if (!tests) {
    configs.push({
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      sourcemap: false,
      minify: production,
      logLevel: 'info',
      entryPoints: ['src/compare/webview/main.ts'],
      outfile: 'dist/compare/webview.js',
    });
    configs.push({
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      sourcemap: false,
      minify: production,
      logLevel: 'info',
      entryPoints: ['src/conflict/webview/main.ts'],
      outfile: 'dist/conflict/webview.js',
    });
  }
  for (const cfg of configs) {
    if (watch) {
      const ctx = await esbuild.context(cfg);
      await ctx.watch();
    } else {
      await esbuild.build(cfg);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
