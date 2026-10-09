/**
 * 支付宝账单（CSV）解析器。
 *
 * 格式事实来源：GBK 编码的真实账单样本逐字节核对 + ezBookkeeping（MIT）与
 * double-entry-generator（Apache-2.0）的实现交叉印证。
 *
 * 已确认存在三种列序变体：
 *   A. 新版（2022 至今，App「开具交易流水证明 / 电子客户回单」）——12 列。
 *   B. 2020–2021 变体 —— 同名但列序不同，`收/支` 在第 0 列、`交易时间` 在末列。
 *   C. 旧版 PC 网页导出 —— 16 列，字段名完全不同（`交易号`/`商品名称`/`金额（元）`/
 *      `交易创建时间`），且不含付款账户。此格式明确拒绝并给出替代路径。
 *
 * 设计要点：**一律按字段名取值，不按下标**。这样变体 A 与 B 无需分别处理 ——
 * 它们字段名相同，只是顺序不同，按名读取天然兼容。只有变体 C 需要显式拒绝。
 */

import {
  BillParseError,
  type BillSummary,
  type ParseResult,
  type ParsedTransaction,
  type SkippedRow,
  type TxDirection,
} from '../domain/types.ts';
import { tryParseAmountToCents } from '../domain/money.ts';
import {
  buildColumnIndex,
  findMissingColumns,
  isEmptyRow,
  normalizePlaceholder,
  parseCsvText,
  readColumn,
  type CsvRow,
} from './csv.ts';
import { summarize } from './wechat.ts';

/** 支付宝账单的字段名（变体 A 与 B 共用）。与账单文件逐字一致。 */
export const ALIPAY_COLUMNS = {
  time: '交易时间',
  category: '交易分类',
  counterparty: '交易对方',
  counterpartyAccount: '对方账号',
  product: '商品说明',
  direction: '收/支',
  amount: '金额',
  method: '收/付款方式',
  status: '交易状态',
  orderId: '交易订单号',
  merchantOrderId: '商家订单号',
  remark: '备注',
} as const;

/** 定位表头所必需的最小列集合。 */
const REQUIRED_COLUMNS = [
  ALIPAY_COLUMNS.time,
  ALIPAY_COLUMNS.direction,
  ALIPAY_COLUMNS.amount,
] as const;

/** 旧版 PC 导出格式的指纹字段，用于给出精准的拒绝提示。 */
const LEGACY_COLUMN_FINGERPRINTS = ['交易号', '商品名称', '金额（元）', '交易创建时间'] as const;

/** 中性交易的商品说明关键词。 */
const NEUTRAL_PRODUCT_KEYWORDS = [
  '充值-',
  '提现-',
  '转入',
  '转出',
  '转账',
  '还款',
  '余额宝-单次转入',
  '收益发放',
  '买入',
  '卖出',
] as const;

/** 退款成功的状态值。 */
const REFUND_STATUS = '退款成功';

/** 交易关闭的状态值。 */
const CLOSED_STATUS = '交易关闭';

/**
 * 解析支付宝账单文本。
 *
 * @param text 已按 GB18030（或 UTF-8）解码的账单全文。
 * @returns 解析结果。
 * @throws {BillParseError} 当文件不是支付宝账单、是旧版格式、或缺少必需列时。
 */
export function parseAlipayBill(text: string): ParseResult {
  const rows = parseCsvText(text);

  // 旧版格式的字段名与新版完全不同（`交易号`/`商品名称`/`金额（元）`），
  // 因此它必然通不过下面的必需列检查。必须在「不是支付宝账单」之前先识别它，
  // 否则用户只会收到一句无从下手的「文件不对」。
  const legacyRow = rows.find(
    (row) => LEGACY_COLUMN_FINGERPRINTS.filter((name) => row.fields.includes(name)).length >= 2,
  );
  if (legacyRow) {
    throw new BillParseError(
      '这是支付宝「旧版网页导出」格式，暂不支持',
      `检测到旧版特征字段：${legacyRow.fields
        .filter((name) => (LEGACY_COLUMN_FINGERPRINTS as readonly string[]).includes(name))
        .join('、')}。该格式不含付款账户信息，无法正确对账。` +
        '请改用支付宝 App 的「我的 → 账单 → ··· → 开具交易流水证明 → 用于个人对账」重新导出。',
    );
  }

  const headerPosition = findHeaderRow(rows);

  if (headerPosition < 0) {
    throw new BillParseError(
      '这个文件不像是支付宝账单',
      `未找到包含「${ALIPAY_COLUMNS.time}」「${ALIPAY_COLUMNS.direction}」「${ALIPAY_COLUMNS.amount}」的表头行。` +
        '请确认导出的是「支付宝 → 我的 → 账单 → 右上角 ··· → 开具交易流水证明 → 用于个人对账」。',
    );
  }

  const header = rows[headerPosition] as CsvRow;
  const index = buildColumnIndex(header);

  const missing = findMissingColumns(index, REQUIRED_COLUMNS);
  if (missing.length > 0) {
    throw new BillParseError(
      '支付宝账单缺少必需列',
      `缺少字段：${missing.join('、')}。实际表头为：${header.fields.join('、')}`,
    );
  }

  const preamble = parsePreamble(rows.slice(0, headerPosition));
  const dataRows = rows.slice(headerPosition + 1);

  const transactions: ParsedTransaction[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];

  for (const row of dataRows) {
    if (isEmptyRow(row)) continue;

    const parsed = parseRow(row, index, header.fields.length, warnings);
    if (parsed.kind === 'skip') {
      skipped.push(parsed.skipped);
    } else {
      transactions.push(parsed.transaction);
    }
  }

  const cleaned = dropClosedAndRefunds(transactions, warnings);
  const actual = summarize(cleaned.kept);

  return {
    source: 'alipay',
    ownerName: preamble.ownerName,
    period: preamble.period,
    transactions: cleaned.kept,
    skipped: [...skipped, ...cleaned.skipped],
    declared: preamble.summary,
    actual,
    warnings,
  };
}

/**
 * 按字段名定位表头行下标。
 *
 * @param rows 全部分词结果。
 * @returns 表头行下标，未找到时返回 `-1`。
 */
function findHeaderRow(rows: readonly CsvRow[]): number {
  return rows.findIndex((row) => {
    const names = new Set(row.fields);
    return REQUIRED_COLUMNS.every((column) => names.has(column));
  });
}

/** 账单顶部元信息。 */
interface Preamble {
  ownerName?: string;
  period?: { start?: string; end?: string };
  summary: BillSummary;
}

/**
 * 从顶部噪声行中提取姓名、导出区间与统计块。
 *
 * 统计块用「不计收支」而非「中性交易」，与微信措辞不同。
 *
 * @param rows 表头之前的行。
 * @returns 提取到的元信息。
 */
function parsePreamble(rows: readonly CsvRow[]): Preamble {
  const result: Preamble = { summary: {} };

  for (const row of rows) {
    const line = row.fields[0] ?? '';
    if (line === '') continue;

    const name = /^姓名：(.*)$/.exec(line);
    if (name?.[1] !== undefined && name[1].trim() !== '') {
      result.ownerName = name[1].trim();
    }

    const start = /起始时间：\[(.*?)\]/.exec(line);
    const end = /终止时间：\[(.*?)\]/.exec(line);
    if (start?.[1] !== undefined || end?.[1] !== undefined) {
      result.period = { start: start?.[1], end: end?.[1] };
    }

    const total = /^共\s*(\d+)\s*笔记录/.exec(line);
    if (total?.[1] !== undefined) {
      result.summary.totalCount = Number(total[1]);
    }

    const income = /^收入：\s*(\d+)\s*笔\s*([\d.,]+)\s*元/.exec(line);
    if (income?.[1] !== undefined && income[2] !== undefined) {
      result.summary.incomeCount = Number(income[1]);
      result.summary.incomeCents = tryParseAmountToCents(income[2]) ?? undefined;
    }

    const expense = /^支出：\s*(\d+)\s*笔\s*([\d.,]+)\s*元/.exec(line);
    if (expense?.[1] !== undefined && expense[2] !== undefined) {
      result.summary.expenseCount = Number(expense[1]);
      result.summary.expenseCents = tryParseAmountToCents(expense[2]) ?? undefined;
    }

    const neutral = /^不计收支：\s*(\d+)\s*笔\s*([\d.,]+)\s*元/.exec(line);
    if (neutral?.[1] !== undefined && neutral[2] !== undefined) {
      result.summary.neutralCount = Number(neutral[1]);
      result.summary.neutralCents = tryParseAmountToCents(neutral[2]) ?? undefined;
    }
  }

  return result;
}

/** 单行解析结果。 */
type RowOutcome =
  | { kind: 'ok'; transaction: ParsedTransaction }
  | { kind: 'skip'; skipped: SkippedRow };

/**
 * 解析一条数据行。
 *
 * @param row 数据行。
 * @param index 表头索引。
 * @param headerFieldCount 表头的列数。
 * @param warnings 收集非致命问题。
 * @returns 解析结果。
 */
function parseRow(
  row: CsvRow,
  index: Map<string, number>,
  headerFieldCount: number,
  warnings: string[],
): RowOutcome {
  // 字段数不足表头列数时按名取值会读到错位的值，必须拒绝而非猜测。
  // 字段数**多于**表头是合法的：支付宝「备注」为空时行尾会多出一个逗号。
  if (row.fields.length < headerFieldCount) {
    return {
      kind: 'skip',
      skipped: {
        line: row.line,
        reason: 'fewer-fields',
        detail:
          `该行只有 ${row.fields.length} 个字段，少于表头的 ${headerFieldCount} 个，` +
          '列可能已错位，已跳过以免记错账',
      },
    };
  }

  const rawDirection = readColumn(row, index, ALIPAY_COLUMNS.direction);
  const rawAmount = readColumn(row, index, ALIPAY_COLUMNS.amount);
  const status = readColumn(row, index, ALIPAY_COLUMNS.status);
  const product = readColumn(row, index, ALIPAY_COLUMNS.product);
  const category = readColumn(row, index, ALIPAY_COLUMNS.category);

  const direction = normalizeDirection(rawDirection);

  if (direction === null) {
    return {
      kind: 'skip',
      skipped: {
        line: row.line,
        reason: 'bad-direction',
        detail: `无法识别的「${ALIPAY_COLUMNS.direction}」取值 ${JSON.stringify(rawDirection)}，已跳过以免误记账`,
      },
    };
  }

  const amountCents = tryParseAmountToCents(rawAmount);
  if (amountCents === null) {
    return {
      kind: 'skip',
      skipped: {
        line: row.line,
        reason: 'bad-amount',
        detail: `无法解析金额 ${JSON.stringify(rawAmount)}，已跳过`,
      },
    };
  }

  // 关闭的交易不产生资金流动，直接剔除。
  if (status === CLOSED_STATUS) {
    return {
      kind: 'skip',
      skipped: {
        line: row.line,
        reason: 'closed',
        detail: `交易状态为「${CLOSED_STATUS}」，未产生资金流动，已剔除`,
      },
    };
  }

  // 「不计收支」本身已是中性；此外按商品说明关键词兜底识别转账类。
  const effectiveDirection: TxDirection =
    direction === 'transfer' || isNeutralProduct(product)
      ? 'transfer'
      : direction;

  if (direction === 'transfer' && category !== '' && !isNeutralProduct(product)) {
    warnings.push(
      `第 ${row.line} 行按「不计收支」处理为账户间转账（分类：${category}），未计入收支统计`,
    );
  }

  return {
    kind: 'ok',
    transaction: {
      occurredAt: readColumn(row, index, ALIPAY_COLUMNS.time),
      direction: effectiveDirection,
      amountCents: Math.abs(amountCents),
      counterparty: normalizePlaceholder(
        readColumn(row, index, ALIPAY_COLUMNS.counterparty),
      ),
      description: normalizePlaceholder(product),
      rawCategory: category,
      method: normalizePlaceholder(readColumn(row, index, ALIPAY_COLUMNS.method)),
      status,
      orderId: readColumn(row, index, ALIPAY_COLUMNS.orderId),
      merchantOrderId: readColumn(row, index, ALIPAY_COLUMNS.merchantOrderId),
      remark: normalizePlaceholder(readColumn(row, index, ALIPAY_COLUMNS.remark)),
      source: 'alipay',
      rawRow: row.fields,
    },
  };
}

/**
 * 归一化支付宝的 `收/支` 取值。
 *
 * 已确认的五种取值：`支出`、`收入`、`不计收支`、**空字符串**、`其他`。
 * 空字符串与 `其他` 都表示中性/未知，绝不能当作支出 —— 否则资产恒等式会崩。
 *
 * @param value 原始取值。
 * @returns 方向，无法识别时返回 `null`。
 */
function normalizeDirection(value: string): TxDirection | null {
  switch (value) {
    case '收入':
      return 'income';
    case '支出':
      return 'expense';
    case '不计收支':
      return 'transfer';
    case '':
      // 空值是真实存在的取值，语义同「不计收支」。
      return 'transfer';
    case '其他':
      // 仅见于 2020–2021 变体，等价于不计收支。
      return 'transfer';
    default:
      return null;
  }
}

/**
 * 判断商品说明是否指示账户间转账。
 *
 * @param product `商品说明` 原文。
 * @returns 属转账类时为 `true`。
 */
function isNeutralProduct(product: string): boolean {
  return NEUTRAL_PRODUCT_KEYWORDS.some((keyword) => {
    if (keyword.endsWith('-')) {
      return product.startsWith(keyword);
    }
    return product.includes(keyword);
  });
}

/**
 * 剔除「交易关闭」与配对成功的退款。
 *
 * @param transactions 待处理交易。
 * @param warnings 收集非致命问题。
 * @returns 保留的交易与剔除明细。
 */
function dropClosedAndRefunds(
  transactions: readonly ParsedTransaction[],
  warnings: string[],
): { kept: ParsedTransaction[]; skipped: SkippedRow[] } {
  const consumed = new Set<ParsedTransaction>();
  const skipped: SkippedRow[] = [];

  for (const tx of transactions) {
    if (tx.status !== REFUND_STATUS) continue;

    const original = transactions.find(
      (candidate) =>
        candidate !== tx &&
        !consumed.has(candidate) &&
        candidate.direction === 'expense' &&
        candidate.amountCents === tx.amountCents &&
        sameOrder(tx, candidate),
    );

    if (original) {
      consumed.add(tx);
      consumed.add(original);
      skipped.push({
        line: 0,
        reason: 'refund-paired',
        detail: `退款 ${tx.amountCents / 100} 元已与原支出配对，两行同时剔除`,
      });
    } else {
      warnings.push(
        `有一条 ${tx.amountCents / 100} 元的退款未找到对应原支出，请手工核对（分类：${tx.rawCategory}）`,
      );
    }
  }

  return {
    kept: transactions.filter((tx) => !consumed.has(tx)),
    skipped,
  };
}

/**
 * 判断两条记录是否指向同一笔交易。
 *
 * @param a 记录一。
 * @param b 记录二。
 * @returns 订单号相同或互为前缀时为 `true`。
 */
function sameOrder(a: ParsedTransaction, b: ParsedTransaction): boolean {
  const pairs: Array<[string, string]> = [
    [a.orderId, b.orderId],
    [a.merchantOrderId, b.merchantOrderId],
  ];

  return pairs.some(([left, right]) => {
    if (left === '' || right === '') return false;
    return left === right || left.startsWith(right) || right.startsWith(left);
  });
}
