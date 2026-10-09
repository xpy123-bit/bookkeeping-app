import { describe, expect, it } from 'vitest';
import { formatCents, parseAmountToCents, signedCents, tryParseAmountToCents } from './money.ts';
import { BillParseError } from './types.ts';

describe('parseAmountToCents', () => {
  it('解析带人民币符号的金额', () => {
    expect(parseAmountToCents('¥28.16')).toBe(2816);
    expect(parseAmountToCents('￥0.12')).toBe(12);
  });

  it('解析千分位与空白', () => {
    expect(parseAmountToCents('1,234.56')).toBe(123456);
    expect(parseAmountToCents(' 9.90 ')).toBe(990);
    expect(parseAmountToCents('50.00')).toBe(5000);
  });

  it('整数金额按元处理', () => {
    expect(parseAmountToCents('12')).toBe(1200);
  });

  it('保留负号', () => {
    expect(parseAmountToCents('-3.00')).toBe(-300);
  });

  it('处理「元」后缀', () => {
    expect(parseAmountToCents('28.16元')).toBe(2816);
  });

  it('符合小数的位数上限', () => {
    // 超过两位小数不是合法金额，应明确报错而非静默截断。
    expect(() => parseAmountToCents('1.234')).toThrow(BillParseError);
  });

  it('拒绝非金额文本', () => {
    expect(() => parseAmountToCents('/')).toThrow(BillParseError);
    expect(() => parseAmountToCents('abc')).toThrow(BillParseError);
    expect(() => parseAmountToCents('')).toThrow(BillParseError);
  });

  it('避免浮点误差', () => {
    // 0.1 元 + 0.2 元必须精确等于 0.3 元，这是整数分存储的核心收益。
    expect(parseAmountToCents('0.10') + parseAmountToCents('0.20')).toBe(
      parseAmountToCents('0.30'),
    );
  });
});

describe('tryParseAmountToCents', () => {
  it('失败时返回 null 而不抛错', () => {
    expect(tryParseAmountToCents('/')).toBeNull();
    expect(tryParseAmountToCents('¥1.00')).toBe(100);
  });
});

describe('formatCents', () => {
  it('格式化带符号金额', () => {
    expect(formatCents(123456)).toBe('¥1,234.56');
    expect(formatCents(12)).toBe('¥0.12');
    expect(formatCents(0)).toBe('¥0.00');
  });

  it('负数符号在货币符号之前', () => {
    expect(formatCents(-300)).toBe('-¥3.00');
  });

  it('可关闭货币符号', () => {
    expect(formatCents(123456, { symbol: false })).toBe('1,234.56');
  });
});

describe('signedCents', () => {
  it('支出为负、收入为正、转账为零', () => {
    expect(signedCents('expense', 100)).toBe(-100);
    expect(signedCents('income', 100)).toBe(100);
    expect(signedCents('transfer', 100)).toBe(0);
  });
});
