import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeBill } from './encoding.ts';
import { parseWechatBill } from './wechat.ts';
import { parseCsvText } from './csv.ts';
import { BillParseError } from '../domain/types.ts';

/** 读取并解码真实微信账单夹具。 */
function loadRealBill(): string {
  const path = fileURLToPath(new URL('../../tests/fixtures/wechat-real.csv', import.meta.url));
  return decodeBill(new Uint8Array(readFileSync(path))).text;
}

describe('parseWechatBill — 真实账单样本', () => {
  const result = parseWechatBill(loadRealBill());

  it('识别来源与导出人', () => {
    expect(result.source).toBe('wechat');
    expect(result.ownerName).toBe('测试');
  });

  it('提取导出区间', () => {
    expect(result.period?.start).toBe('2019-08-01 00:00:00');
    expect(result.period?.end).toBe('2019-09-30 23:59:59');
  });

  it('提取账单顶部声明的统计块', () => {
    expect(result.declared.totalCount).toBe(43);
    expect(result.declared.incomeCount).toBe(1);
    expect(result.declared.incomeCents).toBe(35);
    expect(result.declared.expenseCount).toBe(1);
    expect(result.declared.expenseCents).toBe(2816);
    expect(result.declared.neutralCount).toBe(0);
  });

  it('不抛错且解析出交易', () => {
    expect(result.transactions.length).toBeGreaterThan(0);
  });

  it('把「/」识别为中性转账，而不是支出', () => {
    // 这是最关键的正确性判据：若把「/」当支出，资产恒等式必然崩。
    const neutral = result.transactions.filter((tx) => tx.direction === 'transfer');
    expect(neutral.length).toBeGreaterThan(0);
    // 中性交易里应能看到充值/提现这类账户间搬钱。
    expect(
      neutral.some(
        (tx) => tx.rawCategory.includes('充值') || tx.rawCategory.includes('提现'),
      ),
    ).toBe(true);
  });

  it('金额全部为非负整数分', () => {
    for (const tx of result.transactions) {
      expect(Number.isInteger(tx.amountCents)).toBe(true);
      expect(tx.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('金额去掉了货币符号并正确换算为分', () => {
    const expense = result.transactions.find((tx) =>
      tx.description.includes('总共消费:28.16'),
    );
    expect(expense?.amountCents).toBe(2816);
  });

  it('交易单号不残留制表符', () => {
    // 微信在单号尾部塞了 \t 以阻止 Excel 转科学计数法；
    // 不 trim 会让去重键带上不可见字符，导致重复导入无法识别。
    for (const tx of result.transactions) {
      expect(tx.orderId).not.toContain('\t');
      expect(tx.merchantOrderId).not.toContain('\t');
    }
  });

  it('汇总值与交易列表一致（自检基线）', () => {
    const recomputed = result.transactions.filter((tx) => tx.direction === 'expense');
    expect(result.actual.expenseCount).toBe(recomputed.length);
  });
});

describe('parseWechatBill — 构造的边界用例', () => {
  /** 用给定的表头与数据行拼一个最小账单。 */
  function buildBill(header: string, rows: string[]): string {
    return [
      '微信支付账单明细,,,,,,,,,,',
      '微信昵称：[测试],,,,,,,,,,',
      '起始时间：[2024-01-01 00:00:00] 终止时间：[2024-01-31 23:59:59],,,,,,,,,,',
      ',,,,,,,,,,',
      '----------------------微信支付账单明细列表--------------------,,,,,,,,,,',
      header,
      ...rows,
    ].join('\n');
  }

  const HEADER = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';

  it('把提现计为转账并扣除服务费', () => {
    const text = buildBill(HEADER, [
      // 11 个字段必须与表头一一对应：时间,类型,对方,商品,收/支,金额,方式,状态,单号,商户单号,备注
      '2024-01-15 10:00:00,零钱提现,招商银行(),/,/,¥100.00,零钱,提现已到账,W001,M001,服务费¥0.10',
    ]);
    const result = parseWechatBill(text);
    const tx = result.transactions[0];

    expect(tx?.direction).toBe('transfer');
    // 100.00 元本金扣除 0.10 元服务费。
    expect(tx?.amountCents).toBe(9990);
    expect(result.warnings.some((w) => w.includes('服务费'))).toBe(true);
  });

  it('列数与表头不符时不猜测，而是明确跳过', () => {
    // 少写一个字段会让后续所有列错位。解析器必须拒绝，
    // 绝不能把错位的值当成金额或方向记进账本。
    const text = buildBill(HEADER, [
      '2024-01-15 10:00:00,商户消费,某商户,商品,支出,¥10.00,零钱,支付成功,W009,M009',
    ]);
    const result = parseWechatBill(text);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('无法识别的收/支取值会被跳过而不是误判为支出', () => {
    const text = buildBill(HEADER, [
      '2024-01-15 10:00:00,商户消费,某商户,商品,未知值,¥10.00,零钱,支付成功,W002,M002,/',
    ]);
    const result = parseWechatBill(text);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('bad-direction');
  });

  it('无法解析的金额会被跳过而不是静默记为 0', () => {
    const text = buildBill(HEADER, [
      '2024-01-15 10:00:00,商户消费,某商户,商品,支出,待确认,零钱,支付成功,W003,M003,/',
    ]);
    const result = parseWechatBill(text);
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('bad-amount');
  });

  it('拒绝不是微信账单的文件并给出可操作提示', () => {
    expect(() => parseWechatBill('姓名：张三\n随便什么内容')).toThrow(BillParseError);
    try {
      parseWechatBill('姓名：张三');
    } catch (error) {
      expect((error as BillParseError).detail).toContain('微信');
    }
  });
});

describe('parseCsvText', () => {
  it('处理引号内逗号', () => {
    const rows = parseCsvText('a,"b,c",d');
    expect(rows[0]?.fields).toEqual(['a', 'b,c', 'd']);
  });

  it('处理转义双引号', () => {
    const rows = parseCsvText('a,"say ""hi""",c');
    expect(rows[0]?.fields).toEqual(['a', 'say "hi"', 'c']);
  });

  it('trim 制表符与全角空格', () => {
    const rows = parseCsvText('a\t, \u3000b\u3000 ,c');
    expect(rows[0]?.fields).toEqual(['a', 'b', 'c']);
  });

  it('容忍字段数不齐', () => {
    const rows = parseCsvText('a,b,c\nd,e');
    expect(rows[0]?.fields).toHaveLength(3);
    expect(rows[1]?.fields).toHaveLength(2);
  });

  it('兼容 CRLF 与 LF', () => {
    expect(parseCsvText('a,b\r\nc,d').map((r) => r.fields)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('记录行号', () => {
    const rows = parseCsvText('a\n\nb');
    expect(rows[0]?.line).toBe(1);
    expect(rows[1]?.line).toBe(2);
    expect(rows[2]?.line).toBe(3);
  });
});
