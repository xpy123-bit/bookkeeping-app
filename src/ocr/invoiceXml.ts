/**
 * 数电发票（全电发票）解析。
 *
 * **这条路完全不需要 OCR。**
 *
 * 依据：国家税务总局公告 2024 年第 11 号明确，单位和个人可登录税务数字账户
 * 免费查询、下载数电发票；电子税务局提供 **PDF / OFD / XML** 三种原件，
 * 其中 **XML 就是发票原件**，以结构化形式保存了发票号码、开票日期、购销方、
 * 金额、税额在内的全部要素，供系统直接识别。
 *
 * 因此：**拿得到 XML 就直接解析，零 OCR、零误差**。「把 XML 发票再走一遍 OCR」
 * 既慢又引入误差，是应当避免的做法。
 *
 * OFD 本身是「ZIP + XML」容器（GB/T 33190-2016），因此 OFD 也能取出要素 ——
 * 解压后按同样的方式找 XML 即可。
 */

import { tryParseAmountToCents } from '../domain/money.ts';

/** 从发票中解析出的要素。 */
export interface InvoiceFields {
  /** 发票号码（数电票为 20 位）。 */
  invoiceNumber: string | null;
  /** 开票日期，规范化为 `YYYY-MM-DD`。 */
  issueDate: string | null;
  /** 销售方名称（支出时的商户）。 */
  sellerName: string | null;
  /** 购买方名称。 */
  buyerName: string | null;
  /** 不含税金额，单位分。 */
  amountWithoutTaxCents: number | null;
  /** 税额，单位分。 */
  taxCents: number | null;
  /** 价税合计，单位分 —— 这才是记账要用的金额。 */
  totalCents: number | null;
  /** 来源格式。 */
  source: 'xml' | 'ofd';
  /** 交叉校验不通过时的说明。 */
  warnings: string[];
}

/**
 * 各要素可能的标签名。
 *
 * 不同开票平台/版本的标签命名不完全一致（英文驼峰与中文混用），
 * 因此每个要素给一组候选名，按顺序尝试。
 */
const TAG_ALIASES: Record<string, readonly string[]> = {
  invoiceNumber: ['InvoiceNumber', '发票号码', 'invoiceNo', 'InvoiceNo'],
  issueTime: ['IssueTime', '开票日期', 'IssueDate'],
  sellerName: ['SellerName', '销售方名称', '销售方'],
  buyerName: ['BuyerName', '购买方名称', '购买方'],
  amountWithoutTax: ['TotalAmWithoutTax', '合计金额', 'AmountWithoutTax', '金额'],
  tax: ['TotalTax', '合计税额', 'TaxAmount', '税额'],
  total: ['TotalAmWithTax', '价税合计', 'TotalAmount', 'AmountWithTax'],
};

/**
 * 从 XML 文本中取出某个标签的值。
 *
 * 刻意不用 DOM 解析器：发票 XML 由机器生成、结构规整，而我们只取少量叶子节点的值；
 * 用轻量提取可以同时运行在浏览器与 Node 测试环境里，避免引入 DOM 依赖。
 * 命名空间前缀（如 `<ns:Tag>`）会被容忍。
 *
 * @param xml XML 文本。
 * @param aliases 候选标签名。
 * @returns 标签值（已 trim 并去实体），未找到返回 `null`。
 */
function findTagValue(xml: string, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    // 容忍命名空间前缀与属性。
    const pattern = new RegExp(
      `<(?:[\\w.-]+:)?${alias}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${alias}>`,
      'i',
    );
    const match = pattern.exec(xml);
    const raw = match?.[1];
    if (raw === undefined) continue;

    const value = decodeEntities(raw).trim();
    if (value !== '') return value;
  }
  return null;
}

/**
 * 解码 XML 实体。
 *
 * @param value 原始文本。
 * @returns 解码后的文本。
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 把开票日期规范化成 `YYYY-MM-DD`。
 *
 * 数电票常见形态是 `2024-06-07` 或带时间的 `2024-06-07 13:20:16`。
 *
 * @param raw 原始日期文本。
 * @returns 规范化日期，无法解析时返回 `null`。
 */
function normalizeDate(raw: string | null): string | null {
  if (raw === null) return null;

  const match = /(\d{4})\s*[-/年]?\s*(\d{1,2})\s*[-/月]?\s*(\d{1,2})/.exec(raw);
  if (!match) return null;

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * 解析发票 XML 文本。
 *
 * 会做一次交叉校验：`价税合计 ≈ 不含税金额 + 税额`。不成立时给出 warning 而不是
 * 直接失败 —— 有些发票形态（如差额征税）不满足该等式，仍应允许用户核对后入账。
 *
 * @param xml XML 文本。
 * @returns 解析结果，若不是发票 XML 则返回 `null`。
 */
export function parseInvoiceXml(xml: string): InvoiceFields | null {
  const invoiceNumber = findTagValue(xml, TAG_ALIASES.invoiceNumber ?? []);
  const totalRaw = findTagValue(xml, TAG_ALIASES.total ?? []);

  // 判定「这是不是一张发票」：至少要有发票号码或价税合计。
  if (invoiceNumber === null && totalRaw === null) {
    return null;
  }

  const amountWithoutTaxCents = toCents(findTagValue(xml, TAG_ALIASES.amountWithoutTax ?? []));
  const taxCents = toCents(findTagValue(xml, TAG_ALIASES.tax ?? []));
  const totalCents = toCents(totalRaw);

  const warnings: string[] = [];

  if (amountWithoutTaxCents !== null && taxCents !== null && totalCents !== null) {
    const expected = amountWithoutTaxCents + taxCents;
    // 允许 1 分的舍入差。
    if (Math.abs(expected - totalCents) > 1) {
      warnings.push(
        `价税合计（${(totalCents / 100).toFixed(2)}）与「金额 + 税额」` +
          `（${(expected / 100).toFixed(2)}）不一致，请核对后再入账`,
      );
    }
  }

  if (totalCents === null) {
    warnings.push('未找到价税合计，请手工填写金额');
  }

  return {
    invoiceNumber,
    issueDate: normalizeDate(findTagValue(xml, TAG_ALIASES.issueTime ?? [])),
    sellerName: findTagValue(xml, TAG_ALIASES.sellerName ?? []),
    buyerName: findTagValue(xml, TAG_ALIASES.buyerName ?? []),
    amountWithoutTaxCents,
    taxCents,
    totalCents,
    source: 'xml',
    warnings,
  };
}

/**
 * 把金额文本转成分。
 *
 * @param raw 金额文本。
 * @returns 分值，无法解析时返回 `null`。
 */
function toCents(raw: string | null): number | null {
  if (raw === null) return null;
  return tryParseAmountToCents(raw);
}
