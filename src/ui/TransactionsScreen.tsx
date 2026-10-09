/**
 * 明细页：按月列出流水，并在顶部展示当月收支汇总。
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDownLeft, ArrowUpRight, Repeat } from 'lucide-react';
import clsx from 'clsx';
import { db, summarizeMonth } from '../db/db.ts';
import { formatCents } from '../domain/money.ts';
import type { TransactionRecord } from '../db/db.ts';

interface Props {
  month: string;
}

/** 按 `YYYY-MM` 起止构造查询边界。 */
function monthRange(month: string): [string, string] {
  return [`${month}-01 00:00:00`, `${month}-31 23:59:59`];
}

/**
 * 明细页。
 *
 * @param props.month `YYYY-MM` 格式的月份。
 */
export default function TransactionsScreen({ month }: Props) {
  const [start, end] = monthRange(month);

  const rows = useLiveQuery(
    async () =>
      (
        await db.transactions
          .where('occurredAt')
          .between(start, end, true, true)
          .toArray()
      ).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    [start, end],
  );

  const summary = useLiveQuery(() => summarizeMonth(month), [month]);
  const categories = useLiveQuery(() => db.categories.toArray(), []);
  const categoryName = new Map(categories?.map((c) => [c.id, c.name]) ?? []);

  return (
    <div className="space-y-3">
      <section className="grid grid-cols-3 gap-2">
        <SummaryCard label="收入" value={summary?.incomeCents ?? 0} tone="income" />
        <SummaryCard label="支出" value={summary?.expenseCents ?? 0} tone="expense" />
        <SummaryCard label="结余" value={summary?.balanceCents ?? 0} tone="balance" />
      </section>

      {rows === undefined && <p className="py-8 text-center text-sm text-slate-500">加载中…</p>}

      {rows?.length === 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-800/40 p-6 text-center">
          <p className="text-sm text-slate-400">这个月还没有记录</p>
          <p className="mt-1 text-xs text-slate-500">
            到「导入」页拖入微信或支付宝账单，或到「记一笔」手工添加
          </p>
        </div>
      )}

      <ul className="space-y-1.5">
        {rows?.map((row) => (
          <TransactionItem
            key={row.id}
            row={row}
            categoryName={
              row.categoryId !== undefined ? categoryName.get(row.categoryId) : undefined
            }
          />
        ))}
      </ul>
    </div>
  );
}

/** 汇总卡片。 */
function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'income' | 'expense' | 'balance';
}) {
  const toneClass = {
    income: 'text-emerald-400',
    expense: 'text-rose-400',
    balance: value < 0 ? 'text-rose-400' : 'text-sky-400',
  }[tone];

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-800/40 px-2.5 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={clsx('mt-0.5 text-sm font-semibold tabular-nums', toneClass)}>
        {formatCents(value)}
      </p>
    </div>
  );
}

/** 单条流水。 */
function TransactionItem({
  row,
  categoryName,
}: {
  row: TransactionRecord;
  categoryName?: string;
}) {
  const Icon =
    row.direction === 'income'
      ? ArrowDownLeft
      : row.direction === 'expense'
        ? ArrowUpRight
        : Repeat;

  const iconTone =
    row.direction === 'income'
      ? 'bg-emerald-500/15 text-emerald-400'
      : row.direction === 'expense'
        ? 'bg-rose-500/15 text-rose-400'
        : 'bg-slate-500/15 text-slate-400';

  const amountTone =
    row.direction === 'income'
      ? 'text-emerald-400'
      : row.direction === 'expense'
        ? 'text-slate-200'
        : 'text-slate-500';

  return (
    <li className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2.5">
      <span className={clsx('grid size-8 shrink-0 place-items-center rounded-full', iconTone)}>
        <Icon size={16} aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-slate-200">
          {row.counterparty || row.description || '（无商户信息）'}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {[categoryName ?? '未分类', row.accountName, row.occurredAt.slice(5, 16)]
            .filter((part) => part !== '')
            .join(' · ')}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className={clsx('text-sm font-medium tabular-nums', amountTone)}>
          {row.direction === 'income' ? '+' : row.direction === 'expense' ? '-' : ''}
          {formatCents(row.amountCents, { symbol: false })}
        </p>
        {row.direction === 'transfer' && (
          <p className="text-[10px] text-slate-600">不计收支</p>
        )}
      </div>
    </li>
  );
}
