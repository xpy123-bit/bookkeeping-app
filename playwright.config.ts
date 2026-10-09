import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置。
 *
 * 用真实的手机设备描述符做模拟 —— 视口、触控、User-Agent、设备像素比
 * 都按手机配置，这样验证的是「在手机上的实际表现」，而不是一个窄窗口。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // 只保留 Chromium 手机模拟：CI 里只安装 chromium，保留 webkit 项目会让
    // 流水线必然失败。要加 iOS Safari 覆盖时，需同时安装 webkit：
    //   pnpm exec playwright install webkit
    // 并把下面这行加回来，同时修改 .github/workflows/ci.yml 的安装步骤。
    // { name: 'mobile-safari', use: { ...devices['iPhone 12'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],

  webServer: {
    // 只起前端：应用在无后端时也应完整可用（数据在本地）。
    command: 'pnpm run dev:web --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
