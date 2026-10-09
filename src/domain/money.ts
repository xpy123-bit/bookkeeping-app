/**
 * 金额解析与格式化。
 *
 * 账单文件里的金额写法很不统一，实测见过的形态包括：
 *   `¥28.16`、`￥0.12`、`50.00`、`1,234.56`、` 9.90 `、`-3.00`、`0.01`
 * 因此解析必须是「剥离噪声 → 严格校验 → 转整数分」，不能直接交给 `parseFloat`。
 */

import { BillParseError } from '../domain/types.ts';

/** 匹配一个合法的十进制金额，允许前导符号与千分位逗号。 */
const AMOUNT_PATTERN = /^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^[+-]?\d+(?:\.\d{1,2})?$/;

/**
 * 把账单里的金额字符串转成整数分。
 *
 * @param input 账单原文，例如 `"¥28.16"`。
 * @returns 金额的分值。`-` 号会被保留，因为退款行可能依赖符号判断方向。
 * @throws {BillParseError} 当字符串不是可识别的金额时。
 */
export function parseAmountToCents(input: string): number {
  const cleaned = stripCurrencyNoise(input);

  if (cleaned === '') {
    throw new BillParseError(`金额为空，无法解析（原文：${JSON.stringify(input)}）`);
  }

  if (!AMOUNT_PATTERN.test(cleaned)) {
    throw new BillParseError(
      `无法识别的金额格式（原文：${JSON.stringify(input)}）`,
      `剥离货币符号后得到 ${JSON.stringify(cleaned)}，不符合十进制金额写法`,
    );
  }

  const negative = cleaned.startsWith('-');
  const unsigned = cleaned.replace(/^[+-]/, '').replace(/,/g, '');
  const [yuanPart = '0', fractionPart = ''] = unsigned.split('.');

  // 两位小数补齐后按字符串拼接再转整数，规避浮点乘法误差。
  const fraction = (fractionPart + '00').slice(0, 2);
  const cents = Number(yuanPart) * 100 + Number(fraction);

  if (!Number.isSafeInteger(cents)) {
    throw new BillParseError(`金额超出可安全表示的范围（原文：${JSON.stringify(input)}）`);
  }

  return negative ? -cents : cents;
}

/**
 * 尝试解析金额，失败时返回 `null` 而不抛错。用于「尽力而为」的场景。
 *
 * @param input 账单原文。
 * @returns 分值，或 `null`。
 */
export function tryParseAmountToCents(input: string): number | null {
  try {
    return parseAmountToCents(input);
  } catch {
    return null;
  }
}

/**
 * 剥离货币符号、千分位、空白与常见占位符。
 *
 * @param input 账单原文。
 * @returns 只含数字、小数点与符号的字符串。
 */
function stripCurrencyNoise(input: string): string {
  return input
    // 微信/支付宝可能使用全角或半角货币符号，以及「元」「人民币」等后缀。
    .replace(/[¥￥$]/g, '')
    .replace(/\s|\u00a0|\t/g, '')
    .replace(/元$/, '')
    .replace(/,/g, '')
    .trim();
}

/**
 * 把分值格式化成人可读的金额字符串。
 *
 * @param cents 分值。
 * @param options.symbol 是否带 `¥` 前缀，默认 `true`。
 * @returns 例如 `"¥1,234.56"`；负数输出 `"-¥1,234.56"`。
 */
export function formatCents(cents: number, options: { symbol?: boolean } = {}): string {
  const symbol = options.symbol ?? true;
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const yuan = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  const grouped = yuan.toLocaleString('zh-CN');
  const body = `${grouped}.${fraction}`;

  if (!symbol) {
    return negative ? `-${body}` : body;
  }
  return negative ? `-¥${body}` : `¥${body}`;
}

/**
 * 按方向给出带符号的分值，用于汇总计算。
 *
 * @param direction 交易方向。
 * @param amountCents 非负金额分值。
 * @returns 收入为正、支出为负、转账为 `0`。
 */
export function signedCents(
  direction: 'income' | 'expense' | 'transfer',
  amountCents: number,
): number {
  switch (direction) {
    case 'income':
      return amountCents;
    case 'expense':
      return -amountCents;
    case 'transfer':
      return 0;
  }
}
