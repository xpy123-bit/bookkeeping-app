import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeBill } from './encoding.ts';
import { parseAlipayBill } from './alipay.ts';
import { BillParseError } from '../domain/types.ts';

/** 读取并解码真实支付宝账单夹具（GBK 编码）。 */
function loadRealBill(): string {
  const path = fileURLToPath(new URL('../../tests/fixtures/alipay-real.csv', import.meta.url));
  return decodeBill(new Uint8Array(readFileSync(path))).text;
}

describe('parseAlipayBill — 真实账单样本（GBK）', () => {
  const result = parseAlipayBill(loadRealBill());

  it('先确认夹具确实是 GBK，否则后续断言没有意义', () => {
    const path = fileURLToPath(
      new URL('../../tests/fixtures/alipay-real.csv', import.meta.url),
    );
    const decoded = decodeBill(new Uint8Array(readFileSync(path)));
    expect(decoded.encoding).toBe('gb18030');
  });

  it('识别来源与导出人', () => {
    expect(result.source).toBe('alipay');
    expect(result.ownerName).toBe('xx');
  });

  it('提取导出区间', () => {
    expect(result.period?.start).toBe('2023-02-10 00:00:00');
  });

  it('提取账单顶部声明的统计块（含「不计收支」）', () => {
    expect(result.declared.totalCount).toBe(66);
    expect(result.declared.incomeCount).toBe(1);
    expect(result.declared.incomeCents).toBe(2850);
    expect(result.declared.expenseCount).toBe(63);
    expect(result.declared.expenseCents).toBe(1654);
    expect(result.declared.neutralCount).toBe(2);
    expect(result.declared.neutralCents).toBe(1637);
  });

  it('不抛错且解析出交易', () => {
    expect(result.transactions.length).toBeGreaterThan(0);
  });

  it('中文字段正确解码，无乱码', () => {
    // 若编码判断错误，交易分类会变成乱码，这里能第一时间发现。
    const categories = new Set(result.transactions.map((tx) => tx.rawCategory));
    expect(categories.has('日用百货') || categories.has('交通出行')).toBe(true);
  });

  it('「不计收支」被识别为转账而非支出', () => {
    const neutral = result.transactions.filter((tx) => tx.direction === 'transfer');
    expect(neutral.length).toBeGreaterThan(0);
  });

  it('交易状态为「交易关闭」的行走被剔除', () => {
    const closed = result.transactions.filter((tx) => tx.status === '交易关闭');
    expect(closed).toHaveLength(0);
    // 夹具中确有 2 条「交易关闭」，必须记入 skipped 而不是静默丢弃。
    expect(result.skipped.filter((row) => row.reason === 'closed')).toHaveLength(2);
  });

  it('金额全部为非负整数分', () => {
    for (const tx of result.transactions) {
      expect(Number.isInteger(tx.amountCents)).toBe(true);
      expect(tx.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('订单号不残留制表符', () => {
    for (const tx of result.transactions) {
      expect(tx.orderId).not.toContain('\t');
      expect(tx.merchantOrderId).not.toContain('\t');
    }
  });

  it('表头字段名带填充空格时仍能按名匹配', () => {
    // 支付宝表头形如 `交易时间            ,交易分类                ,...`。
    // 不 trim 就完全匹配不上任何字段名，交易数会掉到 0。
    // 夹具共 10 条数据行，其中 2 条「交易关闭」被剔除，故剩 8 条。
    expect(result.transactions).toHaveLength(8);
  });
});

describe('parseAlipayBill — 变体兼容与拒绝', () => {
  it('兼容 2020–2021 变体（收/支 在第 0 列、交易时间在末列）', () => {
    // 该变体字段名与新版相同，只是列序不同。按名读取应天然兼容。
    const text = [
      '------------------------------------------------------------------------------------',
      '导出信息：',
      '姓名：张三',
      '起始时间：[2020-06-01 00:00:00]    终止时间：[2020-06-30 23:59:59]',
      '共2笔记录',
      '收入：0笔 0.00元',
      '支出：1笔 12.34元',
      '不计收支：1笔 5.00元',
      '------------------------支付宝（中国）网络技术有限公司  电子客户回单------------------------',
      '收/支,交易对方,对方账号,商品说明,收/付款方式,金额,交易状态,交易分类,交易订单号,商家订单号,交易时间,',
      '支出,某超市,/,日用采购,余额,12.34,交易成功,日用百货,2020AAA,2020BBB,2020-06-15 12:00:00,',
      '不计收支,余额宝,/,余额宝-单次转入,余额,5.00,交易成功,投资理财,2020CCC,2020DDD,2020-06-16 09:00:00,',
    ].join('\n');

    const result = parseAlipayBill(text);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]?.direction).toBe('expense');
    expect(result.transactions[0]?.amountCents).toBe(1234);
    expect(result.transactions[0]?.occurredAt).toBe('2020-06-15 12:00:00');
    expect(result.transactions[1]?.direction).toBe('transfer');
  });

  it('明确拒绝旧版 PC 网页导出格式并给出替代路径', () => {
    const legacy = [
      '支付宝交易记录明细查询',
      '账号:[test@example.com]',
      '交易号,商户订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态',
      '202001,202002,2020-01-01 00:00:00,2020-01-01 00:00:01,2020-01-01 00:00:02,支付宝,即时到账,某商户,某商品,10.00,支出,交易成功,0.00,0.00,/,已支出',
    ].join('\n');

    expect(() => parseAlipayBill(legacy)).toThrow(BillParseError);
    try {
      parseAlipayBill(legacy);
    } catch (error) {
      const parseError = error as BillParseError;
      expect(parseError.message).toContain('旧版');
      expect(parseError.detail).toContain('开具交易流水证明');
    }
  });

  it('「收/支」为空字符串时按转账处理', () => {
    const text = [
      '------------------------支付宝（中国）网络技术有限公司  电子客户回单------------------------',
      '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
      '2024-01-01 10:00:00,转账红包,某人,/,转账,,50.00,余额,交易成功,X001,Y001,',
    ].join('\n');

    const result = parseAlipayBill(text);
    expect(result.transactions[0]?.direction).toBe('transfer');
  });

  it('「其他」取值按转账处理（仅见于 2020 变体）', () => {
    const text = [
      '------------------------支付宝（中国）网络技术有限公司  电子客户回单------------------------',
      '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
      '2024-01-01 10:00:00,投资理财,基金,/,基金-买入,其他,100.00,余额,交易成功,X002,Y002,',
    ].join('\n');

    const result = parseAlipayBill(text);
    expect(result.transactions[0]?.direction).toBe('transfer');
  });

  it('拒绝不是支付宝账单的文件', () => {
    expect(() => parseAlipayBill('姓名：张三\n随便什么内容')).toThrow(BillParseError);
  });
});
