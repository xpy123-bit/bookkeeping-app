/**
 * 微信支付账单（CSV）解析器。
 *
 * 格式事实来源：真实账单样本逐行核对 + ezBookkeeping（MIT）与
 * double-entry-generator（Apache-2.0）的实现交叉印证。
 *
 * 关键约束：
 * - 编码为 UTF-8。
 * - 顶部有约 16 行元信息/统计/说明，随后是「-------微信支付账单明细列表-------」分隔线，
 *   再下一行是表头，之后才是数据。**绝不能硬编码行号** —— 各平台版本会调整噪声行数，
 *   因此这里一律按字段名定位表头。
 * - `收/支` 列的中性值是**字面量斜杠 `/`**，不是空值。只判空会把提现/充值误判为支出。
 * - `交易单号`/`商户单号` 尾部带制表符，分词器已 trim。
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

/** 微信账单的字段名。与账单文件逐字一致。 */
export const WECHAT_COLUMNS = {
  time: '交易时间',
  category: '交易类型',
  counterparty: '交易对方',
  product: '商品',
  direction: '收/支',
  amount: '金额(元)',
  method: '支付方式',
  status: '当前状态',
  orderId: '交易单号',
  merchantOrderId: '商户单号',
  remark: '备注',
} as const;

/** 定位表头所必需的最小列集合。 */
const REQUIRED_COLUMNS = [
  WECHAT_COLUMNS.time,
  WECHAT_COLUMNS.direction,
  WECHAT_COLUMNS.amount,
] as const;

/**
 * 中性交易类型关键词。
 *
 * 用「包含」而非全等匹配：真实取值带后缀，例如 `转入零钱通-来自工商银行(9876)`。
 * 这些交易是账户之间搬钱，不是消费，必须建模为转账，否则资产恒等式会崩。
 */
const NEUTRAL_CATEGORY_KEYWORDS = [
  '零钱充值',
  '零钱提现',
  '信用卡还款',
  '转入零钱通',
  '零钱通转出',
  '购买理财通',
  '理财通购买',
  '零钱通存取',
] as const;

/** 提现手续费的正则。备注形如 `服务费¥0.10`。 */
const SERVICE_FEE_PATTERN = /服务费\s*[¥￥]?\s*([\d.,]+)/;

/**
 * 解析微信支付账单文本。
 *
 * @param text 已按 UTF-8 解码的账单全文。
 * @returns 解析结果，含交易、跳过明细与统计自检数据。
 * @throws {BillParseError} 当文件不是微信账单或缺少必需列时。
 */
export function parseWechatBill(text: string): ParseResult {
  const rows = parseCsvText(text);
  const headerPosition = findHeaderRow(rows);

  if (headerPosition < 0) {
    throw new BillParseError(
      '这个文件不像是微信支付账单',
      `未找到包含「${WECHAT_COLUMNS.time}」「${WECHAT_COLUMNS.direction}」「${WECHAT_COLUMNS.amount}」的表头行。` +
        '请确认导出的是「微信 → 我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账」得到的 CSV。',
    );
  }

  const header = rows[headerPosition] as CsvRow;
  const index = buildColumnIndex(header);
  const missing = findMissingColumns(index, REQUIRED_COLUMNS);

  if (missing.length > 0) {
    throw new BillParseError(
      '微信账单缺少必需列',
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

  const paired = dropPairedRefunds(transactions, warnings);
  const actual = summarize(paired.kept);

  return {
    source: 'wechat',
    ownerName: preamble.ownerName,
    period: preamble.period,
    transactions: paired.kept,
    skipped: [...skipped, ...paired.skipped],
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
 * 从顶部噪声行中提取昵称、导出区间与统计块。
 *
 * 统计块（共 N 笔 / 收入 / 支出 / 中性交易）用于导入后自检 —— 这是最便宜的正确性护栏。
 *
 * @param rows 表头之前的行。
 * @returns 提取到的元信息。
 */
function parsePreamble(rows: readonly CsvRow[]): Preamble {
  const result: Preamble = { summary: {} };

  for (const row of rows) {
    const line = row.fields[0] ?? '';
    if (line === '') continue;

    const nickname = /微信昵称：\[(.*?)\]/.exec(line);
    if (nickname?.[1] !== undefined && nickname[1] !== '') {
      result.ownerName = nickname[1];
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

    const neutral = /^中性交易：\s*(\d+)\s*笔\s*([\d.,]+)\s*元/.exec(line);
    if (neutral?.[1] !== undefined && neutral[2] !== undefined) {
      result.summary.neutralCount = Number(neutral[1]);
      result.summary.neutralCents = tryParseAmountToCents(neutral[2]) ?? undefined;
    }
  }

  return result;
}

/** 单行解析结果：成功产出一笔，或明确跳过。 */
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
  // 字段数不足表头列数时，按名取值会读到错位的值 —— 中间少一个字段会让后面
  // 所有列整体前移，而「收/支」和「金额」恰好可能落在正确位置，于是错数据被
  // 静默记账。这里明确拒绝，而不是猜测。
  // 注意：字段数**多于**表头是合法的（支付宝备注为空时行尾会多一个逗号）。
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

  const rawDirection = readColumn(row, index, WECHAT_COLUMNS.direction);
  const rawAmount = readColumn(row, index, WECHAT_COLUMNS.amount);
  const category = readColumn(row, index, WECHAT_COLUMNS.category);
  const status = readColumn(row, index, WECHAT_COLUMNS.status);

  let direction = normalizeDirection(rawDirection);

  if (direction === null) {
    return {
      kind: 'skip',
      skipped: {
        line: row.line,
        reason: 'bad-direction',
        detail: `无法识别的「${WECHAT_COLUMNS.direction}」取值 ${JSON.stringify(rawDirection)}，已跳过以免误记账`,
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

  const remark = readColumn(row, index, WECHAT_COLUMNS.remark);

  // 中性交易按「收/支=斜杠」或「交易类型属中性关键词」两种信号判定。
  if (direction === 'transfer' || isNeutralCategory(category)) {
    direction = 'transfer';
  }

  let finalAmount = Math.abs(amountCents);

  // 提现会单独收取手续费，账单里的金额是含手续费总额；备注中给出服务费。
  // 不扣除会让账户余额比实际减少额多出几毛钱。
  if (direction === 'transfer' && isWithdrawal(category)) {
    const fee = SERVICE_FEE_PATTERN.exec(remark);
    if (fee?.[1] !== undefined) {
      const feeCents = tryParseAmountToCents(fee[1]);
      if (feeCents !== null && feeCents < finalAmount) {
        finalAmount -= feeCents;
        warnings.push(
          `第 ${row.line} 行提现已扣除服务费 ${feeCents / 100} 元（备注原文：${remark}）`,
        );
      }
    }
  }

  return {
    kind: 'ok',
    transaction: {
      occurredAt: readColumn(row, index, WECHAT_COLUMNS.time),
      direction,
      amountCents: finalAmount,
      counterparty: normalizePlaceholder(readColumn(row, index, WECHAT_COLUMNS.counterparty)),
      description: normalizePlaceholder(readColumn(row, index, WECHAT_COLUMNS.product)),
      rawCategory: category,
      method: normalizePlaceholder(readColumn(row, index, WECHAT_COLUMNS.method)),
      status,
      orderId: readColumn(row, index, WECHAT_COLUMNS.orderId),
      merchantOrderId: readColumn(row, index, WECHAT_COLUMNS.merchantOrderId),
      remark: normalizePlaceholder(remark),
      source: 'wechat',
      rawRow: row.fields,
    },
  };
}

/**
 * 归一化微信的 `收/支` 取值。
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
    case '/':
      // 字面量斜杠 = 中性交易（充值/提现/理财/还款）。
      return 'transfer';
    default:
      return null;
  }
}

/**
 * 判断交易类型是否属于中性交易。
 *
 * @param category `交易类型` 原文。
 * @returns 属中性时为 `true`。
 */
function isNeutralCategory(category: string): boolean {
  return NEUTRAL_CATEGORY_KEYWORDS.some((keyword) => category.includes(keyword));
}

/**
 * 判断是否为提现。
 *
 * @param category `交易类型` 原文。
 * @returns 是提现时为 `true`。
 */
function isWithdrawal(category: string): boolean {
  return category.includes('零钱提现') || category.includes('提现');
}

/**
 * 把「退款」行与其原始支出配对后一起剔除。
 *
 * 微信/支付宝都把退款作为独立一行记录，而原始支出行仍然保留。
 * 若不配对，同一笔消费会被计两次（一次支出、一次冲抵收入），月度统计必然偏差。
 * 配对依据：商户单号相同（或以订单号前缀相同 + 金额相等兜底）。
 *
 * @param transactions 待处理的交易。
 * @param warnings 收集非致命问题。
 * @returns 保留的交易与被剔除的行。
 */
function dropPairedRefunds(
  transactions: readonly ParsedTransaction[],
  warnings: string[],
): { kept: ParsedTransaction[]; skipped: SkippedRow[] } {
  const refunds = transactions.filter(
    (tx) => tx.direction === 'income' && tx.status.includes('退款'),
  );

  if (refunds.length === 0) {
    return { kept: [...transactions], skipped: [] };
  }

  const consumed = new Set<ParsedTransaction>();
  const skipped: SkippedRow[] = [];

  for (const refund of refunds) {
    const original = transactions.find(
      (candidate) =>
        candidate !== refund &&
        !consumed.has(candidate) &&
        candidate.direction === 'expense' &&
        candidate.amountCents === refund.amountCents &&
        hasMatchingOrder(refund, candidate),
    );

    if (original) {
      consumed.add(refund);
      consumed.add(original);
      skipped.push(
        {
          line: 0,
          reason: 'refund-paired',
          detail: `退款 ${refund.amountCents / 100} 元已与原支出配对，两行同时剔除`,
        },
      );
    } else {
      warnings.push(
        `有一条 ${refund.amountCents / 100} 元的退款未找到对应原支出，已按收入保留，请手工核对`,
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
 * @returns 订单号或商户单号相同（兼容前缀匹配）时为 `true`。
 */
function hasMatchingOrder(a: ParsedTransaction, b: ParsedTransaction): boolean {
  const pairs: Array<[string, string]> = [
    [a.orderId, b.orderId],
    [a.merchantOrderId, b.merchantOrderId],
  ];

  return pairs.some(([left, right]) => {
    if (left === '' || right === '') return false;
    return left === right || left.startsWith(right) || right.startsWith(left);
  });
}

/**
 * 按方向统计数据，用于与账单顶部声明值比对。
 *
 * @param transactions 交易列表。
 * @returns 统计结果。
 */
export function summarize(transactions: readonly ParsedTransaction[]): BillSummary {
  const summary: BillSummary = {
    totalCount: transactions.length,
    incomeCount: 0,
    incomeCents: 0,
    expenseCount: 0,
    expenseCents: 0,
    neutralCount: 0,
    neutralCents: 0,
  };

  for (const tx of transactions) {
    switch (tx.direction) {
      case 'income':
        summary.incomeCount = (summary.incomeCount ?? 0) + 1;
        summary.incomeCents = (summary.incomeCents ?? 0) + tx.amountCents;
        break;
      case 'expense':
        summary.expenseCount = (summary.expenseCount ?? 0) + 1;
        summary.expenseCents = (summary.expenseCents ?? 0) + tx.amountCents;
        break;
      case 'transfer':
        summary.neutralCount = (summary.neutralCount ?? 0) + 1;
        summary.neutralCents = (summary.neutralCents ?? 0) + tx.amountCents;
        break;
    }
  }

  return summary;
}
