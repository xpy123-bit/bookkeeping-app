import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest 内置的 vite 版本早于 `node:sqlite`（Node 22.5 才加入），
  // 其内置模块清单里没有它，会当成 npm 包去解析而失败。
  // 显式声明为外部模块，交给 Node 原生加载。
  ssr: {
    external: ['node:sqlite'],
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    // 夹具目录不放测试文件，避免 vitest 把账单样本当测试收集。
    exclude: ['node_modules/**', 'tests/fixtures/**', 'e2e/**'],
  },
});
