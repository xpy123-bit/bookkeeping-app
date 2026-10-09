/**
 * 统计页：月度报表 + 预算设置 + 超支提醒。
 */

import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, PiggyBank } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, summarizeByCategory, summarizeMonth } from '../db/db.ts';
import { formatCents, parseAmountToCents } from '../domain/money.ts';

interface Props {
  month: string;
}

/**
 * 统计页。
 *
 * @param props.month `YYYY-MM` 格式的月份。
 */
export default function StatsScreen({ month }: Props) {
  const summary = useLiveQuery(() => summarizeMonth(month), [month]);
  const byCategory = useLiveQuery(() => summarizeByCategory(month), [month]);
  const budgets = useLiveQuery(() => db.budgets.toArray(), []);

  const totalExpense = summary?.expenseCents ?? 0;
  const maxCategory = Math.max(1, ...(byCategory?.map((row) => row.cents) ?? [1]));
  const totalBudget = (budgets ?? [])
    .filter((budget) => budget.categoryName === undefined || budget.categoryName === '')
    .reduce((sum, budget) => sum + budget.limitCents, 0);

  const overspent = (budgets ?? []).filter((budget) => {
    if (!budget.categoryName) return false;
    const row = byCategory?.find((item) => item.categoryName === budget.categoryName);
    return row !== undefined && row.cents > budget.limitCents;
  });

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-slate-800 bg-slate-800/40 p-4">
        <h2 className="text-sm font-medium text-slate-200">{month} 月度报表</h2>
        <dl className="mt-3 space-y-1.5 text-xs">
          <Row label="收入" value={formatCents(summary?.incomeCents ?? 0)} tone="text-emerald-400" />
          <Row label="支出" value={formatCents(totalExpense)} tone="text-rose-400" />
          <Row
            label="结余"
            value={formatCents(summary?.balanceCents ?? 0)}
            tone={(summary?.balanceCents ?? 0) < 0 ? 'text-rose-400' : 'text-sky-400'}
          />
          {totalBudget > 0 && (
            <Row
              label="预算使用"
              value={`${Math.round((totalExpense / totalBudget) * 100)}%（${formatCents(totalBudget)}）`}
              tone={totalExpense > totalBudget ? 'text-rose-400' : 'text-slate-300'}
            />
          )}
        </dl>
      </section>

      {overspent.length > 0 && (
        <section className="rounded-xl border border-amber-900/60 bg-amber-950/40 p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-amber-300">
            <AlertTriangle size={16} aria-hidden />
            超支提醒
          </h2>
          <ul className="mt-1.5 space-y-0.5">
            {overspent.map((budget) => {
              const row = byCategory?.find((item) => item.categoryName === budget.categoryName);
              return (
                <li key={budget.id} className="text-[11px] text-amber-200/80">
                  「{budget.categoryName}」已花 {formatCents(row?.cents ?? 0)}，
                  超出预算 {formatCents((row?.cents ?? 0) - budget.limitCents)}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-slate-800 bg-slate-800/40 p-4">
        <h2 className="text-sm font-medium text-slate-200">支出构成</h2>
        {byCategory?.length === 0 && (
          <p className="mt-2 text-[11px] text-slate-500">本月还没有支出记录</p>
        )}
        <ul className="mt-3 space-y-2.5">
          {byCategory?.map((row) => (
            <li key={row.categoryName}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-300">{row.categoryName}</span>
                <span className="tabular-nums text-slate-400">
                  {formatCents(row.cents)}
                  <span className="ml-1 text-slate-600">
                    {totalExpense > 0 ? `${Math.round((row.cents / totalExpense) * 100)}%` : '0%'}
                  </span>
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-700/60">
                <div
                  className="h-full rounded-full bg-sky-500"
                  style={{ width: `${(row.cents / maxCategory) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <BudgetEditor categoryNames={byCategory?.map((row) => row.categoryName) ?? []} />
    </div>
  );
}

/** 一行统计值。 */
function Row({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className={clsx('tabular-nums', tone)}>{value}</dd>
    </div>
  );
}

/** 预算设置。 */
function BudgetEditor({ categoryNames }: { categoryNames: string[] }) {
  const [categoryName, setCategoryName] = useState('');
  const [limit, setLimit] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const budgets = useLiveQuery(() => db.budgets.toArray(), []);

  /**
   * 保存一条预算。
   */
  async function handleSave(): Promise<void> {
    setMessage(null);
    let cents: number;
    try {
      cents = parseAmountToCents(limit);
    } catch {
      setMessage('预算金额格式不对');
      return;
    }
    if (cents <= 0) {
      setMessage('预算金额必须大于 0');
      return;
    }

    const existing = (budgets ?? []).find((budget) => budget.categoryName === categoryName);
    if (existing?.id !== undefined) {
      await db.budgets.update(existing.id, { limitCents: cents });
    } else {
      await db.budgets.add({
        categoryName: categoryName === '' ? undefined : categoryName,
        limitCents: cents,
      });
    }

    setLimit('');
    setMessage('已保存');
  }

  /**
   * 删除一条预算。
   *
   * @param id 预算记录 id。
   */
  async function handleDelete(id: number | undefined): Promise<void> {
    if (id === undefined) return;
    await db.budgets.delete(id);
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-800/40 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
        <PiggyBank size={16} aria-hidden />
        预算
      </h2>

      <div className="mt-3 flex gap-2">
        <select
          value={categoryName}
          onChange={(event) => setCategoryName(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-slate-300 outline-none focus:border-sky-500"
        >
          <option value="">总预算</option>
          {categoryNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          type="text"
          inputMode="decimal"
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
          placeholder="金额"
          className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs tabular-nums text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500"
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white active:bg-sky-700"
        >
          保存
        </button>
      </div>

      {message && <p className="mt-2 text-[11px] text-slate-400">{message}</p>}

      {(budgets?.length ?? 0) > 0 && (
        <ul className="mt-3 space-y-1">
          {budgets?.map((budget) => (
            <li
              key={budget.id}
              className="flex items-center justify-between rounded-lg bg-slate-900/50 px-2.5 py-1.5"
            >
              <span className="text-[11px] text-slate-300">
                {budget.categoryName ?? '总预算'}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-slate-400">
                  {formatCents(budget.limitCents)}
                </span>
                <button
                  type="button"
                  onClick={() => void handleDelete(budget.id)}
                  className="text-[11px] text-slate-600 active:text-rose-400"
                >
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
