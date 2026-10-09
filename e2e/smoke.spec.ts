import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * 手机模拟下的端到端冒烟测试。
 *
 * 覆盖真实用户路径：应用能渲染 → 能选账单文件 → 能解析并预览 → 能入账 → 明细页可见。
 * 用真实的微信账单夹具，而不是合成数据。
 */

const WECHAT_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/wechat-real.csv', import.meta.url),
);

test('应用能加载并展示四个标签页', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '记账本' })).toBeVisible();

  for (const label of ['明细', '记一笔', '导入', '统计']) {
    await expect(page.getByRole('button', { name: label })).toBeVisible();
  }

  // 空状态提示应当出现，确认明细页确实完成了数据查询。
  await expect(page.getByText('这个月还没有记录')).toBeVisible();
});

test('手工记一笔后能在明细页看到', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '记一笔' }).click();

  await page.getByPlaceholder('0.00').fill('12.34');
  await page.getByPlaceholder('例如：肯德基').fill('肯德基');
  await page.getByRole('button', { name: '保存' }).click();

  // 保存后应自动跳回明细页。
  // 注意金额在页面上会出现多次（汇总卡、结余、列表项），因此必须
  // 把断言限定在具体那一条流水上，否则会命中 strict mode 冲突。
  const item = page.locator('li').filter({ hasText: '肯德基' });
  await expect(item).toHaveCount(1);
  await expect(item.getByText('-12.34')).toBeVisible();
});

test('导入真实微信账单并完成入账', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '导入' }).click();

  await page.setInputFiles('input[type="file"]', WECHAT_FIXTURE);
  await page.getByRole('button', { name: '读取并预览' }).click();

  // 预览面板应显示识别结果与将入账的笔数。
  await expect(page.getByText(/预览：微信支付账单/)).toBeVisible();
  await expect(page.getByText(/文件 wechat-real\.csv/)).toBeVisible();
  await expect(page.getByText(/将入账 \d+ 笔/)).toBeVisible();

  await page.getByRole('button', { name: '确认入账' }).click();

  // 入账成功后应显示成功面板。
  await expect(page.getByText(/已入账 \d+ 笔/)).toBeVisible();

  await page.getByRole('button', { name: '去看明细' }).click();

  // 账单是历史月份，应用应自动跳到有数据的月份，而不是停在本月显示空列表。
  await expect(page.getByText('这个月还没有记录')).toBeHidden();
  // 从账单区间可知最近一笔在 2024-06，月份选择器应停在该月。
  await expect(page.getByLabel('选择月份')).toHaveValue('2024-06');
});

test('重复导入同一份账单会被去重', async ({ page }) => {
  await page.goto('/');

  /** 完整走一遍导入流程。 */
  async function importFixture(): Promise<void> {
    await page.getByRole('button', { name: '导入' }).click();
    await page.setInputFiles('input[type="file"]', WECHAT_FIXTURE);
    await page.getByRole('button', { name: '读取并预览' }).click();
    await expect(page.getByText(/将入账 \d+ 笔/)).toBeVisible();
    await page.getByRole('button', { name: '确认入账' }).click();
    await expect(page.getByText(/已入账 \d+ 笔/)).toBeVisible();
  }

  await importFixture();
  await importFixture();

  // 第二次导入应全部命中去重，新增 0 笔。
  await expect(page.getByText('已入账 0 笔')).toBeVisible();
  await expect(page.getByText(/此前已导入过/)).toBeVisible();
});

test('拒绝损坏的文件并给出可操作提示', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '导入' }).click();

  // 直接喂一个不是账单的 CSV。
  await page.setInputFiles('input[type="file"]', {
    name: 'not-a-bill.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('姓名：张三\n这是一份随便的文件\n', 'utf8'),
  });
  await page.getByRole('button', { name: '读取并预览' }).click();

  await expect(page.getByText(/无法识别这个账单文件/)).toBeVisible();
});
