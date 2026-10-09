import { describe, expect, it } from 'vitest';
import { classifyDocument, extractFields } from './extract.ts';

describe('extractFields — 支付截图', () => {
  // 模拟微信/支付宝「账单详情」页的 OCR 结果。
  const paymentScreenshot = `微信支付
￥28.16
支付成功
商户名称：云膳过桥米线(传奇广场店)
当前状态：支付成功
商品：总共消费:28.16
支付方式：中国银行(1234)
交易时间：2024-06-07 13:20:16
交易单号：4200002168202406076349`;

  it('抽出金额', () => {
    const fields = extractFields(paymentScreenshot);
    expect(fields.amounts.length).toBeGreaterThan(0);
    expect(fields.amounts[0]?.value).toBe(2816);
  });

  it('抽出日期并规范化', () => {
    const fields = extractFields(paymentScreenshot);
    expect(fields.dates[0]?.value).toBe('2024-06-07 13:20:16');
  });

  it('抽出商户名', () => {
    const fields = extractFields(paymentScreenshot);
    const merchant = fields.merchants.find((c) => c.value.includes('云膳'));
    expect(merchant).toBeDefined();
  });

  it('识别为支付截图', () => {
    expect(classifyDocument(paymentScreenshot)).toBe('payment-screenshot');
  });
});

describe('extractFields — 多个金额候选时绝不猜测', () => {
  it('把可能的总金额都返回，让用户选择', () => {
    // 发票上「价税合计」与「合计金额」都可能被当成这笔交易的钱，
    // 猜错就是记错账，因此两者都要返回让用户确认。
    const text = `价税合计：￥113.00
合计金额：￥100.00`;

    const fields = extractFields(text);
    const values = fields.amounts.map((c) => c.value);

    expect(values).toContain(11300);
    expect(values).toContain(10000);
  });

  it('价税合计排在合计金额之前（带符号且先出现）', () => {
    const text = `价税合计：￥113.00
合计金额：￥100.00`;
    expect(extractFields(text).amounts[0]?.value).toBe(11300);
  });

  it('把税额排除在候选之外（它是组成部分，不是交易总额）', () => {
    // 这是刻意的设计取舍：税额、单价、数量、找零都不是「这笔交易付了多少钱」，
    // 放进候选只会让用户误选。宁可少给候选，也不能给错候选。
    const text = `价税合计：￥113.00
合计金额：￥100.00
合计税额：￥13.00`;

    const values = extractFields(text).amounts.map((c) => c.value);

    expect(values).toContain(11300);
    expect(values).toContain(10000);
    expect(values).not.toContain(1300);
  });

  it('带货币符号的候选可信度高于仅靠关键词命中的', () => {
    const fields = extractFields('金额：50.00\n￥88.00');
    // 两者都会被抽到，但带 ¥ 的应排在前面。
    expect(fields.amounts[0]?.value).toBe(8800);
  });

  it('排除税额、单价、找零等噪声数字', () => {
    const text = `税额：13.00
单价：25.00
数量：2
找零：5.00`;

    const fields = extractFields(text);
    // 这些都不是交易总额，不应进入金额候选。
    expect(fields.amounts).toHaveLength(0);
  });
});

describe('extractFields — 边界情况', () => {
  it('空文本返回空候选而不是抛错', () => {
    const fields = extractFields('');
    expect(fields.amounts).toHaveLength(0);
    expect(fields.dates).toHaveLength(0);
    expect(fields.merchants).toHaveLength(0);
    expect(fields.lines).toHaveLength(0);
  });

  it('没有可识别内容时全部为空，且不抛错', () => {
    const fields = extractFields('随便写点什么\n第二行');
    expect(fields.amounts).toHaveLength(0);
    expect(fields.dates).toHaveLength(0);
    expect(fields.merchants).toHaveLength(0);
  });

  it('忽略零金额（通常是空白占位）', () => {
    const fields = extractFields('￥0.00');
    expect(fields.amounts).toHaveLength(0);
  });

  it('处理中文日期格式', () => {
    const fields = extractFields('开票日期：2024年6月7日');
    expect(fields.dates[0]?.value).toBe('2024-06-07 12:00:00');
  });

  it('金额候选去重', () => {
    const fields = extractFields('￥28.16\n￥28.16\n￥28.16');
    expect(fields.amounts).toHaveLength(1);
  });

  it('识别收款方这类商户关键词', () => {
    const fields = extractFields('收款方：某某便利店');
    expect(fields.merchants[0]?.value).toBe('某某便利店');
  });
});

describe('classifyDocument', () => {
  it('识别发票', () => {
    expect(classifyDocument('发票号码：123\n价税合计：￥100.00')).toBe('invoice');
  });

  it('识别小票', () => {
    expect(classifyDocument('欢迎光临\n单价 5.00\n数量 2\n找零 1.00')).toBe('receipt');
  });

  it('无法判断时返回 unknown', () => {
    expect(classifyDocument('今天天气不错')).toBe('unknown');
  });
});
