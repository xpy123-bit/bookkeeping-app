import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * 安全与隐私断言。
 *
 * 这个应用最核心的安全承诺是：**账本数据不离开设备**。
 * 这类承诺如果只写在文档里，很容易在某次改动中被无声破坏
 * （比如有人加了个「云备份」功能，或把流水带进了分析埋点）。
 * 因此这里把它变成可执行的断言。
 */

const WECHAT_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/wechat-real.csv', import.meta.url),
);

test('记账全过程没有任何请求把流水内容发到服务器', async ({ page }) => {
  // 用可识别的哨兵值，这样一旦泄漏就能精确定位。
  const sentinel = 'zz-PRIVACY-SENTINEL-zz-4242';

  /** 记录所有请求的方法、地址与请求体。 */
  const requests: Array<{ url: string; method: string; body: string }> = [];

  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      body: request.postData() ?? '',
    });
  });

  // 走完整流程：手工记一笔 + 导入账单。
  await page.goto('/');

  await page.getByRole('button', { name: '记一笔' }).click();
  await page.getByPlaceholder('0.00').fill('77.77');
  await page.getByPlaceholder('例如：肯德基').fill(sentinel);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('li').filter({ hasText: sentinel })).toHaveCount(1);

  await page.getByRole('button', { name: '导入' }).click();
  await page.setInputFiles('input[type="file"]', WECHAT_FIXTURE);
  await page.getByRole('button', { name: '读取并预览' }).click();
  await expect(page.getByText(/将入账 \d+ 笔/)).toBeVisible();
  await page.getByRole('button', { name: '确认入账' }).click();
  await expect(page.getByText(/已入账 \d+ 笔/)).toBeVisible();

  // 断言一：哨兵值从未出现在任何请求体里。
  const leaked = requests.filter((request) => request.body.includes(sentinel));
  expect(leaked.map((request) => request.url)).toEqual([]);

  // 断言二：哨兵值也从未出现在 URL 里（避免被拼进查询串或埋点）。
  expect(requests.filter((request) => request.url.includes(sentinel))).toEqual([]);

  // 断言三：整个过程中没有向 /api/ 之外的第三方地址发起请求。
  // 本地开发下允许 127.0.0.1 / localhost 的自身请求。
  const external = requests.filter((request) => {
    try {
      const url = new URL(request.url);
      const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
      return !isLocal;
    } catch {
      return false;
    }
  });
  expect(external.map((request) => request.url)).toEqual([]);
});

test('账单文件名与内容都不进入请求体（导入完全在本地完成）', async ({ page }) => {
  const bodies: string[] = [];
  page.on('request', (request) => {
    const body = request.postData();
    if (body) bodies.push(body);
  });

  await page.goto('/');
  await page.getByRole('button', { name: '导入' }).click();
  await page.setInputFiles('input[type="file"]', WECHAT_FIXTURE);
  await page.getByRole('button', { name: '读取并预览' }).click();
  await expect(page.getByText(/预览：微信支付账单/)).toBeVisible();

  // 账单解析完全在浏览器里完成，不应有任何上传。
  const combined = bodies.join('\n');
  expect(combined).not.toContain('wechat-real');
  expect(combined).not.toContain('微信支付账单明细');
  // 账单里的真实商户名也不应外传。
  expect(combined).not.toContain('云膳过桥米线');
});

test('账本数据存在 IndexedDB，不使用 localStorage', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();
  await page.getByPlaceholder('0.00').fill('11.11');
  await page.getByPlaceholder('例如：肯德基').fill('存储位置测试');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('li').filter({ hasText: '存储位置测试' })).toHaveCount(1);

  // localStorage 是同步、易被 XSS 读取、且容量小的存储，
  // 不适合放账本数据；这里确认实现用的是 IndexedDB。
  const localStorageDump = await page.evaluate(() => JSON.stringify(window.localStorage));
  expect(localStorageDump).not.toContain('存储位置测试');

  const indexedDbHasIt = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('bookkeeping');
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          let found = false;
          const transaction = db.transaction('transactions', 'readonly');
          const store = transaction.objectStore('transactions');
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const result = cursor.result;
            if (result) {
              const value = result.value as { counterparty?: string };
              if (value.counterparty === '存储位置测试') found = true;
              result.continue();
            } else {
              resolve(found);
            }
          };
          cursor.onerror = () => resolve(false);
        };
      }),
  );

  expect(indexedDbHasIt).toBe(true);
});

test('会话 Cookie 不可被页面脚本读取', async ({ page, context }) => {
  await page.goto('/');

  // 即便后端未运行，这里的断言依然有意义：确认应用没有把任何令牌
  // 放进可被 JS 读取的位置（document.cookie 或 localStorage）。
  const documentCookie = await page.evaluate(() => document.cookie);
  expect(documentCookie).not.toContain('bk_session');

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === 'bk_session');
  // 后端未运行时本就没有会话 Cookie；有的话必须带 HttpOnly。
  if (session) {
    expect(session.httpOnly).toBe(true);
  }
});

test('发票 XML 在本地解析，文件内容不上传', async ({ page }) => {
  const bodies: string[] = [];
  page.on('request', (request) => {
    const body = request.postData();
    if (body) bodies.push(body);
  });

  const sentinelSeller = 'zz-XML-隐私哨兵-zz';
  const xml = `<?xml version="1.0"?><Invoice><InvoiceNumber>123</InvoiceNumber><SellerName>${sentinelSeller}</SellerName><TotalAmWithTax>10.00</TotalAmWithTax></Invoice>`;

  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();
  await page.setInputFiles('input[accept=".xml,.ofd"]', {
    name: 'invoice.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(xml, 'utf8'),
  });

  await expect(page.getByText(/已解析发票/)).toBeVisible();

  // 数电发票 XML 是本地解析的，发票内容（含销售方名称）绝不应外传。
  expect(bodies.join('\n')).not.toContain(sentinelSeller);
});
