/**
 * 本地数据库（IndexedDB / Dexie）。
 *
 * 架构定位：数据**只存在用户设备的浏览器里**，不上传服务器。这是记账应用最合理的
 * 默认姿态 —— 账单含真实姓名、商户、金额与消费习惯。服务器只负责两件必须服务端
 * 完成的事：OAuth 换取令牌（客户端密钥不能下发）、可选的大模型/OCR 代理。
 *
 * 因此即使后端完全不可用，应用依然可以记账、导入、看报表。
 */

import Dexie, { type Table } from 'dexie';
import type { BillSource, LocalDateTime, TxDirection } from '../domain/types.ts';

/** 一条已入账的流水。 */
export interface TransactionRecord {
  id?: number;
  occurredAt: LocalDateTime;
  direction: TxDirection;
  /** 金额，单位为分，恒为非负。 */
  amountCents: number;
  /** 分类 id，指向 `categories`。 */
  categoryId?: number;
  counterparty: string;
  description: string;
  /** 账户名，例如「零钱」「招商银行(9876)」。 */
  accountName: string;
  /** 来源；手工录入为 `manual`。 */
  source: BillSource | 'manual';
  /** 账单原始分类，保留用于回溯自动分类的效果。 */
  rawCategory: string;
  status: string;
  remark: string;
  /**
   * 去重键。同一份账单重复导入时用它避免产生重复流水，
   * 这是「反复导入同一个月账单」这一真实使用习惯的必要保障。
   */
  dedupeKey: string;
  createdAt: number;
}

/** 分类。 */
export interface CategoryRecord {
  id?: number;
  name: string;
  /** 仅用于展示与分组，不参与金额计算。 */
  icon: string;
  direction: 'income' | 'expense';
  /** 是否为内置分类。内置分类不可删除。 */
  builtin: boolean;
  /** 排序权重，越小越靠前。 */
  order: number;
}

/** 自动分类规则。 */
export interface RuleRecord {
  id?: number;
  /** 规则优先级，数值越小越先匹配。 */
  priority: number;
  /** 关键词列表，命中任意一个即算匹配。 */
  keywords: string[];
  /** 匹配目标：交易对方、商品说明，或两者。 */
  matchOn: 'counterparty' | 'description' | 'both';
  /** 命中后归属的分类名。 */
  categoryName: string;
  /** 是否启用。 */
  enabled: boolean;
}

/** 预算。 */
export interface BudgetRecord {
  id?: number;
  /** 分类名；为空表示总预算。 */
  categoryName?: string;
  /** 预算金额，单位为分。 */
  limitCents: number;
  /** `YYYY-MM`；为空表示每月循环。 */
  month?: string;
}

/** Dexie 数据库定义。 */
class BookkeepingDatabase extends Dexie {
  transactions!: Table<TransactionRecord, number>;
  categories!: Table<CategoryRecord, number>;
  rules!: Table<RuleRecord, number>;
  budgets!: Table<BudgetRecord, number>;

  constructor() {
    super('bookkeeping');

    this.version(1).stores({
      // `&dedupeKey` 建立唯一索引，从数据库层面杜绝重复导入。
      transactions: '++id, occurredAt, direction, categoryId, dedupeKey, source',
      categories: '++id, &name, direction, order',
      rules: '++id, priority, enabled',
      budgets: '++id, categoryName, month',
    });
  }
}

/** 全局唯一的数据库实例。 */
export const db = new BookkeepingDatabase();

/** 内置的收支分类，首次启动时写入。 */
export const BUILTIN_CATEGORIES: readonly Omit<CategoryRecord, 'id'>[] = [
  { name: '餐饮', icon: '🍜', direction: 'expense', builtin: true, order: 10 },
  { name: '交通', icon: '🚇', direction: 'expense', builtin: true, order: 20 },
  { name: '购物', icon: '🛍️', direction: 'expense', builtin: true, order: 30 },
  { name: '日用', icon: '🧴', direction: 'expense', builtin: true, order: 40 },
  { name: '居住', icon: '🏠', direction: 'expense', builtin: true, order: 50 },
  { name: '通讯', icon: '📱', direction: 'expense', builtin: true, order: 60 },
  { name: '娱乐', icon: '🎬', direction: 'expense', builtin: true, order: 70 },
  { name: '医疗', icon: '💊', direction: 'expense', builtin: true, order: 80 },
  { name: '教育', icon: '📚', direction: 'expense', builtin: true, order: 90 },
  { name: '人情', icon: '🧧', direction: 'expense', builtin: true, order: 100 },
  { name: '投资', icon: '📈', direction: 'expense', builtin: true, order: 110 },
  { name: '其他支出', icon: '❓', direction: 'expense', builtin: true, order: 900 },
  { name: '工资', icon: '💰', direction: 'income', builtin: true, order: 10 },
  { name: '奖金', icon: '🎁', direction: 'income', builtin: true, order: 20 },
  { name: '理财收益', icon: '📊', direction: 'income', builtin: true, order: 30 },
  { name: '退款', icon: '↩️', direction: 'income', builtin: true, order: 40 },
  { name: '其他收入', icon: '❓', direction: 'income', builtin: true, order: 900 },
];

/**
 * 首次运行时写入内置分类。已有数据时不重复写入。
 *
 * @returns 初始化完成后的分类总数。
 */
export async function seedCategories(): Promise<number> {
  const existing = await db.categories.count();
  if (existing > 0) {
    return existing;
  }
  await db.categories.bulkAdd(BUILTIN_CATEGORIES as CategoryRecord[]);
  return BUILTIN_CATEGORIES.length;
}

/**
 * 计算去重键。
 *
 * 优先使用平台交易单号；缺失时退化为「时间 + 金额 + 交易对方」的组合。
 * 同一账单重复导入必须被识别为同一笔。
 *
 * @param input 构成去重键的字段。
 * @returns 去重键字符串。
 */
export function buildDedupeKey(input: {
  source: string;
  orderId: string;
  occurredAt: string;
  amountCents: number;
  counterparty: string;
}): string {
  if (input.orderId !== '') {
    return `${input.source}:${input.orderId}`;
  }
  return `${input.source}:${input.occurredAt}:${input.amountCents}:${input.counterparty}`;
}

/**
 * 批量写入流水，自动跳过已存在的记录。
 *
 * @param records 待写入记录。
 * @returns 实际新增的条数与因重复而跳过的条数。
 */
export async function insertTransactions(
  records: readonly TransactionRecord[],
): Promise<{ inserted: number; duplicated: number }> {
  if (records.length === 0) {
    return { inserted: 0, duplicated: 0 };
  }

  const keys = records.map((record) => record.dedupeKey);
  const existing = await db.transactions.where('dedupeKey').anyOf(keys).toArray();
  const existingKeys = new Set(existing.map((row) => row.dedupeKey));

  const fresh = records.filter((record) => !existingKeys.has(record.dedupeKey));
  if (fresh.length > 0) {
    await db.transactions.bulkAdd(fresh as TransactionRecord[]);
  }

  return { inserted: fresh.length, duplicated: records.length - fresh.length };
}

/**
 * 按月份查询流水。
 *
 * @param month `YYYY-MM` 格式的月份。
 * @returns 该月流水，按时间倒序。
 */
export async function listTransactionsByMonth(
  month: string,
): Promise<TransactionRecord[]> {
  const start = `${month}-01 00:00:00`;
  const end = `${month}-31 23:59:59`;
  const rows = await db.transactions
    .where('occurredAt')
    .between(start, end, true, true)
    .toArray();

  return rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/**
 * 统计某月的收支。
 *
 * @param month `YYYY-MM` 格式的月份。
 * @returns 收入、支出与结余，单位为分。转账不计入。
 */
export async function summarizeMonth(
  month: string,
): Promise<{ incomeCents: number; expenseCents: number; balanceCents: number }> {
  const rows = await listTransactionsByMonth(month);
  let incomeCents = 0;
  let expenseCents = 0;

  for (const row of rows) {
    if (row.direction === 'income') incomeCents += row.amountCents;
    if (row.direction === 'expense') expenseCents += row.amountCents;
  }

  return { incomeCents, expenseCents, balanceCents: incomeCents - expenseCents };
}

/**
 * 按分类汇总某月支出。
 *
 * @param month `YYYY-MM` 格式的月份。
 * @returns 每个分类的金额，按金额倒序。
 */
export async function summarizeByCategory(
  month: string,
): Promise<Array<{ categoryName: string; cents: number }>> {
  const rows = await listTransactionsByMonth(month);
  const categories = await db.categories.toArray();
  const nameById = new Map(categories.map((category) => [category.id, category.name]));

  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.direction !== 'expense') continue;
    const name =
      row.categoryId !== undefined
        ? (nameById.get(row.categoryId) ?? '未分类')
        : '未分类';
    totals.set(name, (totals.get(name) ?? 0) + row.amountCents);
  }

  return [...totals.entries()]
    .map(([categoryName, cents]) => ({ categoryName, cents }))
    .sort((a, b) => b.cents - a.cents);
}
