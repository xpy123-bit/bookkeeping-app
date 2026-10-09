/**
 * 记账应用的领域模型。
 *
 * 关键设计约束：
 * 1. 金额一律用整数「分」（cents）存储，绝不使用浮点数。0.1 + 0.2 !== 0.3 在记账里
 *    会直接导致对账失败，这是最常见的实现事故。
 * 2. 时间用本地时间的字符串 'YYYY-MM-DD HH:mm:ss'（不带时区偏移）。账单文件里的时间
 *    就是持卡人本地的墙上时间，转成 UTC 再转回来只会引入跨日误差。
 * 3. 中性交易（充值/提现/理财/信用卡还款）不是支出也不是收入，而是账户间转账。
 *    若把它们当支出，资产恒等式必然不平 —— 这是导入器最核心的正确性陷阱。
 */

/** 交易方向。`transfer` 表示账户间搬钱，不计入收支统计。 */
export type TxDirection = 'income' | 'expense' | 'transfer';

/** 账单来源。 */
export type BillSource = 'wechat' | 'alipay';

/** 本地墙上时间，格式固定为 `YYYY-MM-DD HH:mm:ss`，与账单文件中的写法一致。 */
export type LocalDateTime = string;

/** 一条已完成解析、尚未落库的交易。 */
export interface ParsedTransaction {
  /** 交易发生的本地时间。 */
  occurredAt: LocalDateTime;
  /** 交易方向。 */
  direction: TxDirection;
  /** 金额，单位为分，恒为非负。方向由 `direction` 表达。 */
  amountCents: number;
  /** 交易对方 / 商户名。 */
  counterparty: string;
  /** 商品说明。空字符串表示账单里该字段为空或 `/`。 */
  description: string;
  /** 账单原始分类（微信的「交易类型」、支付宝的「交易分类」）。 */
  rawCategory: string;
  /** 支付方式 / 收付款方式，用于映射到账户。 */
  method: string;
  /** 交易状态原文。刻意不做成枚举 —— 平台会随时新增取值。 */
  status: string;
  /** 平台交易单号，用于去重。 */
  orderId: string;
  /** 商户单号，用于退款配对。 */
  merchantOrderId: string;
  /** 备注原文。 */
  remark: string;
  /** 来源账单。 */
  source: BillSource;
  /** 原始行字段，保留用于审计与问题排查。 */
  rawRow: readonly string[];
}

/** 跳过某一行数据的原因。 */
export interface SkippedRow {
  /** 该行在账单文件中的行号（从 1 开始），便于用户回查。 */
  line: number;
  /** 机器可读的跳过原因。 */
  reason:
    | 'neutral'
    | 'closed'
    | 'refund-paired'
    | 'bad-direction'
    | 'bad-amount'
    | 'fewer-fields'
    | 'empty';
  /** 面向用户的中文说明。 */
  detail: string;
}

/**
 * 账单顶部自带的统计块，例如微信的「共43笔记录 / 收入：1笔 0.35元 / 支出：1笔 28.16元」。
 * 用它做导入后的自检是最便宜的正确性护栏。
 */
export interface BillSummary {
  totalCount?: number;
  incomeCount?: number;
  incomeCents?: number;
  expenseCount?: number;
  expenseCents?: number;
  neutralCount?: number;
  neutralCents?: number;
}

/** 一次解析的完整结果。 */
export interface ParseResult {
  source: BillSource;
  /** 账单里声明的导出区间，若能取到。 */
  period?: { start?: string; end?: string };
  /** 账单里声明的账户名 / 昵称，若能取到。 */
  ownerName?: string;
  transactions: ParsedTransaction[];
  skipped: SkippedRow[];
  /** 账单顶部声明的统计值，用于自检。 */
  declared: BillSummary;
  /** 解析器实际统计出的值。 */
  actual: BillSummary;
  /** 参数层面跳过的非致命问题，例如无法配对到原始支出的退款。 */
  warnings: string[];
}

/** 解析失败时抛出。携带面向用户的中文提示与诊断细节。 */
export class BillParseError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'BillParseError';
    this.detail = detail;
  }
}
