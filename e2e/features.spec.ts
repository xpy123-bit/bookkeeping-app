import { expect, test } from '@playwright/test';

/**
 * 新功能的端到端测试：账户面板与 OCR / 发票识别。
 *
 * 注意：e2e 只启动前端（`pnpm run dev:web`），后端不在运行。
 * 这恰好是验证「后端不可用时应用仍完整可用」这一核心设计的好条件 ——
 * 应用是本地优先的，后端挂掉不应影响记账。
 */

/** 一份贴近真实形态的数电发票 XML。 */
const INVOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <InvoiceNumber>24312000000012345678</InvoiceNumber>
  <IssueTime>2024-06-07 13:20:16</IssueTime>
  <SellerName>某某餐饮管理有限公司</SellerName>
  <BuyerName>张三</BuyerName>
  <TotalAmWithoutTax>100.00</TotalAmWithoutTax>
  <TotalTax>13.00</TotalTax>
  <TotalAmWithTax>113.00</TotalAmWithTax>
</Invoice>`;

test('账户面板说明数据存在本机，且在后端不可用时优雅降级', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '账户' }).click();

  const dialog = page.getByRole('dialog', { name: '账户' });
  await expect(dialog).toBeVisible();

  // 「数据不上传」是这个应用最重要的事实，必须显眼。
  await expect(dialog.getByText('账本数据存在这台设备上')).toBeVisible();
  await expect(dialog.getByText(/不会上传到服务器/)).toBeVisible();

  // 后端未运行 → 应给出说明而不是报错，且明确告知不影响记账。
  await expect(dialog.getByText(/后端服务未运行/)).toBeVisible();
  await expect(dialog.getByText(/不影响记账/)).toBeVisible();

  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toBeHidden();
});

test('后端不可用时仍能正常记账（本地优先的核心保障）', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  await page.getByPlaceholder('0.00').fill('66.66');
  await page.getByPlaceholder('例如：肯德基').fill('后端离线测试');
  await page.getByRole('button', { name: '保存' }).click();

  const item = page.locator('li').filter({ hasText: '后端离线测试' });
  await expect(item).toHaveCount(1);
});

test('记一笔页面提供拍照/发票识别入口', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  await expect(page.getByText('拍照 / 发票识别')).toBeVisible();
  await expect(page.getByText('选择图片')).toBeVisible();
  // 用 exact 避免同时命中正文里的「数电发票 XML」。
  await expect(page.getByText('发票 XML', { exact: true })).toBeVisible();
  // 必须明确告知用户 XML 不需要 OCR 也不上传。
  await expect(page.getByText(/直接解析，不需要 OCR，也不会上传/)).toBeVisible();
});

test('导入数电发票 XML 能解析出要素并填入表单', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  await page.setInputFiles('input[accept=".xml,.ofd"]', {
    name: 'invoice.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(INVOICE_XML, 'utf8'),
  });

  // 应展示解析结果。
  await expect(page.getByText(/已解析发票/)).toBeVisible();
  await expect(page.getByText('24312000000012345678')).toBeVisible();
  await expect(page.getByText('某某餐饮管理有限公司')).toBeVisible();
  // 价税合计应正确转成金额。
  await expect(page.getByText('¥113.00')).toBeVisible();
  await expect(page.getByText('¥100.00')).toBeVisible();
  await expect(page.getByText('¥13.00')).toBeVisible();

  await page.getByRole('button', { name: '填入表单' }).click();

  // 金额与商户应被填进表单。
  await expect(page.getByPlaceholder('0.00')).toHaveValue('113.00');
  await expect(page.getByPlaceholder('例如：肯德基')).toHaveValue('某某餐饮管理有限公司');
  await expect(page.getByText(/来自数电发票 XML/)).toBeVisible();

  // 保存后明细页应能看到。发票日期是 2024-06，应用应自动跳到该月，
  // 否则用户会停在本月看到空列表而以为保存失败。
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByLabel('选择月份')).toHaveValue('2024-06');
  await expect(page.locator('li').filter({ hasText: '某某餐饮管理有限公司' })).toHaveCount(1);
});

test('发票 XML 的价税合计不一致时给出警告', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  const broken = INVOICE_XML.replace('113.00', '999.00');

  await page.setInputFiles('input[accept=".xml,.ofd"]', {
    name: 'broken.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from(broken, 'utf8'),
  });

  await expect(page.getByText(/不一致，请核对/)).toBeVisible();
});

test('不是发票的 XML 会明确报错而不是静默失败', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  await page.setInputFiles('input[accept=".xml,.ofd"]', {
    name: 'random.xml',
    mimeType: 'text/xml',
    buffer: Buffer.from('<Root><Something>无关内容</Something></Root>', 'utf8'),
  });

  await expect(page.getByText(/没有找到发票要素/)).toBeVisible();
});

test('OFD 给出可操作的替代路径而不是死路', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  await page.setInputFiles('input[accept=".xml,.ofd"]', {
    name: 'invoice.ofd',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('PK-not-really-an-ofd', 'utf8'),
  });

  await expect(page.getByText(/OFD 格式暂不支持直接解析/)).toBeVisible();
  // 必须告诉用户怎么办，不能只说「不支持」。
  await expect(page.getByText(/用压缩软件打开后取出里面的 XML/)).toBeVisible();
});
