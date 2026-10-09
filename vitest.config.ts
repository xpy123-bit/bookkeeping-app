import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    // 夹具目录不放测试文件，避免 vitest 把账单样本当测试收集。
    exclude: ['node_modules/**', 'tests/fixtures/**', 'e2e/**'],
  },
});
