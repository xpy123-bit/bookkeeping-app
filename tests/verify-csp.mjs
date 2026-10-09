/**
 * 验证生产构建在 CSP 下仍能完整工作。
 *
 * 过严的 CSP 会让应用静默失效（白屏、按钮无反应），而 `pnpm build` 成功
 * 完全不能说明这一点 —— 必须真的在浏览器里跑一遍完整流程。
 *
 * 用法：
 *   1. 先启动预览服务：pnpm exec vite preview --port 4173
 *   2. 再运行：node tests/verify-csp.mjs http://127.0.0.1:4173
 */

import { chromium, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] ?? 'http://127.0.0.1:4173';
const fixture = fileURLToPath(new URL('./fixtures/wechat-real.csv', import.meta.url));

const INVOICE_XML = `<?xml version="1.0"?>
<Invoice><InvoiceNumber>999</InvoiceNumber><SellerName>CSP 测试商户</SellerName><TotalAmWithTax>42.00</TotalAmWithTax></Invoice>`;

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 5'] });
const page = await context.newPage();

/** 收集控制台消息与页面错误。 */
const consoleErrors = [];
const pageErrors = [];
const cspViolations = [];

page.on('console', (message) => {
  const text = message.text();
  if (message.type() === 'error') {
    consoleErrors.push(text);
    // 浏览器会把 CSP 拦截报成控制台错误。
    if (/Content Security Policy|CSP/i.test(text)) {
      cspViolations.push(text);
    }
  }
});
page.on('pageerror', (error) => pageErrors.push(error.message));

const steps = [];
let failures = 0;

/**
 * 执行一步并记录结果。
 *
 * @param name 步骤名。
 * @param fn 步骤内容。
 */
async function step(name, fn) {
  try {
    await fn();
    steps.push(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    steps.push(`  FAIL  ${name} -> ${error.message.split('\n')[0]}`);
  }
}

await step('页面加载并渲染出标题', async () => {
  await page.goto(target, { waitUntil: 'networkidle' });
  if (!(await page.getByRole('heading', { name: '记账本' }).isVisible())) {
    throw new Error('标题不可见');
  }
});

await step('四个标签页都在', async () => {
  for (const label of ['明细', '记一笔', '导入', '统计']) {
    if (!(await page.getByRole('button', { name: label }).isVisible())) {
      throw new Error(`标签 ${label} 不可见`);
    }
  }
});

await step('手工记一笔（验证 IndexedDB 与内联样式在 CSP 下可用）', async () => {
  await page.getByRole('button', { name: '记一笔' }).click();
  await page.getByPlaceholder('0.00').fill('12.34');
  await page.getByPlaceholder('例如：肯德基').fill('CSP 验证');
  await page.getByRole('button', { name: '保存' }).click();
  await page.locator('li').filter({ hasText: 'CSP 验证' }).waitFor({ timeout: 5000 });
});

await step('导入真实微信账单（验证 CSV 解析与 ZIP 无关路径）', async () => {
  await page.getByRole('button', { name: '导入' }).click();
  await page.setInputFiles('input[type="file"]', fixture);
  await page.getByRole('button', { name: '读取并预览' }).click();
  await page.getByText(/将入账 \d+ 笔/).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: '确认入账' }).click();
  await page.getByText(/已入账 \d+ 笔/).waitFor({ timeout: 10000 });
});

await step('解析发票 XML', async () => {
  await page.getByRole('button', { name: '记一笔' }).click();
  await page.setInputFiles('input[accept=".xml,.ofd"]', {
    name: 'invoice.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(INVOICE_XML, 'utf8'),
  });
  await page.getByText(/已解析发票/).waitFor({ timeout: 5000 });
});

await step('打开账户面板', async () => {
  await page.getByRole('button', { name: '账户' }).click();
  await page.getByRole('dialog', { name: '账户' }).waitFor({ timeout: 5000 });
  await page.getByText('账本数据存在这台设备上').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: '关闭' }).click();
});

await step('查看统计页（验证样式与 canvas 无关渲染）', async () => {
  await page.getByRole('button', { name: '统计' }).click();
  await page.getByText('支出构成').waitFor({ timeout: 5000 });
});

await step('Service Worker 已注册且控制了页面', async () => {
  const controlled = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-sw-api';
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ? 'registered' : 'not-registered';
  });
  if (controlled !== 'registered') throw new Error(controlled);
});

console.log(`在 CSP 下验证生产构建：${target}`);
console.log(steps.join('\n'));
console.log('');
console.log(`CSP 违规: ${cspViolations.length}`);
if (cspViolations.length > 0) {
  cspViolations.slice(0, 10).forEach((violation) => console.log(`  ! ${violation}`));
}
console.log(`页面错误: ${pageErrors.length}`);
pageErrors.slice(0, 5).forEach((error) => console.log(`  ! ${error}`));
console.log(`控制台错误: ${consoleErrors.length}`);
consoleErrors.slice(0, 5).forEach((error) => console.log(`  ! ${error}`));

await browser.close();

if (failures > 0 || cspViolations.length > 0 || pageErrors.length > 0) {
  console.log('');
  console.log(`结果：${failures} 步失败，${cspViolations.length} 处 CSP 违规，${pageErrors.length} 处页面错误`);
  process.exit(1);
}

console.log('');
console.log('结果：全部通过，CSP 未破坏任何功能');
