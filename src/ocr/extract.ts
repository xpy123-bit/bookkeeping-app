/**
 * 从 OCR 文本中抽取记账所需字段。
 *
 * 设计原则（来自真实票据的脏数据经验）：
 * 1. **金额可能有多个候选**（合计、税额、单价……），此时**绝不猜**，全部返回让用户确认。
 *    金额记错在记账里是不可接受的，而让用户点一下是廉价的。
 * 2. 结果一律标记为「建议值」，必须经用户确认才入账。
 * 3. 抽取失败不是错误，而是返回空候选 —— 用户可以手工填。
 */

import { tryParseAmountToCents } from '../domain/money.ts';

/** 抽取出的一个字段候选。 */
export interface Candidate<T> {
  value: T;
  /** 该候选来自文本的哪一行，便于用户在界面上核对。 */
  source: string;
  /** 相对可信度，越大越可信。仅用于排序，不用于自动决策。 */
  weight: number;
}

/** 抽取结果。 */
export interface ExtractedFields {
  amounts: Array<Candidate<number>>;
  dates: Array<Candidate<string>>;
  merchants: Array<Candidate<string>>;
  /** 原始文本按行切分，界面上要展示给用户核对。 */
  lines: string[];
}

/** 带货币符号的金额，可信度最高。 */
const CURRENCY_AMOUNT = /[¥￥]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;

/** 关键词后跟金额，次高可信度。 */
const KEYWORD_AMOUNT =
  /(?:实付|实收|合计|总计|价税合计|金额|应付|支付金额|订单金额|小计|总额|收款)\s*[:：]?\s*[¥￥]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;

/**
 * 明确应当排除的金额上下文。
 *
 * 税额、单价、数量、找零这些数字不是这笔交易的总金额，
 * 混进候选会让用户误选，进而记错账。
 */
const NOISE_AMOUNT_CONTEXT = /税额|税率|单价|数量|找零|余额|折扣|优惠|积分|发票号码|订单号|交易单号/;

/** 日期形态：`2024-06-07`、`2024/6/7`、`2024年6月7日`。 */
const DATE_PATTERN = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/;

/** 商户名关键词。命中后取该行剩余内容。 */
const MERCHANT_KEYWORDS = [
  '商户名称',
  '商户全称',
  '交易对方',
  '收款方',
  '收款单位',
  '销售方名称',
  '销售方',
  '商家名称',
  '付款给',
];

/**
 * 从一行文本里抽取全部金额候选。
 *
 * @param line 单行文本。
 * @returns 候选列表。
 */
function amountCandidatesFromLine(line: string): Array<Candidate<number>> {
  const results: Array<Candidate<number>> = [];

  // 噪声行整体跳过：这一行里的数字都不是交易总额。
  if (NOISE_AMOUNT_CONTEXT.test(line)) {
    return results;
  }

  for (const match of line.matchAll(CURRENCY_AMOUNT)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const cents = tryParseAmountToCents(raw);
    // 记账场景下 0 元没有意义，通常是「¥0.00」这类留白。
    if (cents !== null && cents > 0) {
      results.push({ value: cents, source: line.trim(), weight: 100 });
    }
  }

  if (results.length > 0) return results;

  for (const match of line.matchAll(KEYWORD_AMOUNT)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const cents = tryParseAmountToCents(raw);
    if (cents !== null && cents > 0) {
      results.push({ value: cents, source: line.trim(), weight: 60 });
    }
  }

  return results;
}

/**
 * 从一行文本里抽取日期候选。
 *
 * @param line 单行文本。
 * @returns 候选列表。
 */
function dateCandidatesFromLine(line: string): Array<Candidate<string>> {
  const match = DATE_PATTERN.exec(line);
  if (!match) return [];

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return [];

  const normalized =
    `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ` +
    // 时间部分若存在则一并取出，否则给一个中性时刻。
    (/(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(line)?.[0]?.length === 5
      ? `${/(\d{1,2}):(\d{2})/.exec(line)?.[0]}:00`
      : (/(\d{1,2}):(\d{2}):(\d{2})/.exec(line)?.[0] ?? '12:00:00'));

  return [{ value: normalized, source: line.trim(), weight: 50 }];
}

/**
 * 从一行文本里抽取商户名候选。
 *
 * @param line 单行文本。
 * @returns 候选列表。
 */
function merchantCandidatesFromLine(line: string): Array<Candidate<string>> {
  for (const keyword of MERCHANT_KEYWORDS) {
    const position = line.indexOf(keyword);
    if (position < 0) continue;

    const rest = line
      .slice(position + keyword.length)
      .replace(/^[\s:：]+/, '')
      .trim();

    if (rest !== '') {
      return [{ value: rest, source: line.trim(), weight: 80 }];
    }
  }
  return [];
}

/**
 * 从 OCR 文本中抽取记账字段。
 *
 * @param text OCR 识别出的原始文本。
 * @returns 抽取结果，含全部候选供用户确认。
 */
export function extractFields(text: string): ExtractedFields {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const amounts: Array<Candidate<number>> = [];
  const dates: Array<Candidate<string>> = [];
  const merchants: Array<Candidate<string>> = [];

  for (const line of lines) {
    amounts.push(...amountCandidatesFromLine(line));
    dates.push(...dateCandidatesFromLine(line));
    merchants.push(...merchantCandidatesFromLine(line));
  }

  return {
    // 按可信度排序；同分保持原文顺序。
    amounts: dedupe(amounts, (candidate) => String(candidate.value)),
    dates: dedupe(dates, (candidate) => candidate.value.slice(0, 10)),
    merchants: dedupe(merchants, (candidate) => candidate.value),
    lines,
  };
}

/**
 * 按某个键去重并按可信度排序。
 *
 * @param candidates 候选列表。
 * @param keyOf 取去重键的函数。
 * @returns 去重排序后的列表。
 */
function dedupe<T>(
  candidates: readonly Candidate<T>[],
  keyOf: (candidate: Candidate<T>) => string,
): Array<Candidate<T>> {
  const seen = new Set<string>();
  const unique: Array<Candidate<T>> = [];

  for (const candidate of candidates) {
    const key = keyOf(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique.sort((a, b) => b.weight - a.weight);
}

/**
 * 判断 OCR 文本像是哪一类凭证，用于给出针对性提示。
 *
 * @param text OCR 文本。
 * @returns 凭证类型。
 */
export function classifyDocument(text: string): 'payment-screenshot' | 'invoice' | 'receipt' | 'unknown' {
  if (text.includes('发票') || /发票号码|价税合计|销售方/.test(text)) return 'invoice';
  if (/支付成功|交易成功|收款方|付款方式|订单号/.test(text)) return 'payment-screenshot';
  if (/小票|收银|找零|单价|数量/.test(text)) return 'receipt';
  return 'unknown';
}
