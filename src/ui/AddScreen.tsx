/**
 * 记一笔：手工录入流水。
 *
 * 手工录入是兜底通道而非主路径 —— 主路径是导入账单。但只要 OCR 或解析
 * 出现任何不确定，用户都必须有一条可靠的补录方式。
 */

import { useState } from 'react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildDedupeKey, db, type TransactionRecord } from '../db/db.ts';
import { parseAmountToCents } from '../domain/money.ts';

interface Props {
  onDone: () => void;
}

/** 取本地当前时间，格式与账单文件一致。 */
function nowLocal(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * 手工记账页。
 *
 * @param props.onDone 保存成功后跳转到明细页。
 */
export default function AddScreen({ onDone }: Props) {
  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [occurredAt, setOccurredAt] = useState(nowLocal);
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const categories = useLiveQuery(
    () => db.categories.where('direction').equals(direction).sortBy('order'),
    [direction],
  );

  /**
   * 保存这笔流水。
   */
  async function handleSave(): Promise<void> {
    setError(null);

    let cents: number;
    try {
      cents = parseAmountToCents(amount);
    } catch {
      setError('金额格式不对，请输入例如 12.34 这样的数字');
      return;
    }

    if (cents <= 0) {
      setError('金额必须大于 0');
      return;
    }

    setSaving(true);
    try {
      const record: TransactionRecord = {
        occurredAt,
        direction,
        amountCents: cents,
        categoryId,
        counterparty: counterparty.trim(),
        description: '',
        accountName: '手工录入',
        source: 'manual',
        rawCategory: '',
        status: '',
        remark: '',
        // 手工录入没有平台订单号，用时间+金额+商户构成去重键。
        dedupeKey: buildDedupeKey({
          source: 'manual',
          orderId: '',
          occurredAt,
          amountCents: cents,
          counterparty: counterparty.trim(),
        }),
        createdAt: Date.now(),
      };

      await db.transactions.add(record);
      setAmount('');
      setCounterparty('');
      setCategoryId(undefined);
      setOccurredAt(nowLocal());
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {(['expense', 'income'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setDirection(value);
              setCategoryId(undefined);
            }}
            className={clsx(
              'rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
              direction === value
                ? value === 'expense'
                  ? 'border-rose-700 bg-rose-950/50 text-rose-300'
                  : 'border-emerald-700 bg-emerald-950/50 text-emerald-300'
                : 'border-slate-700 bg-slate-800/40 text-slate-400',
            )}
          >
            {value === 'expense' ? '支出' : '收入'}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="text-[11px] font-medium text-slate-400">金额（元）</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-2xl font-semibold tabular-nums text-slate-100 outline-none placeholder:text-slate-700 focus:border-sky-500"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-medium text-slate-400">商户 / 说明</span>
        <input
          type="text"
          value={counterparty}
          onChange={(event) => setCounterparty(event.target.value)}
          placeholder="例如：肯德基"
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-medium text-slate-400">时间</span>
        <input
          type="text"
          value={occurredAt}
          onChange={(event) => setOccurredAt(event.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm tabular-nums text-slate-200 outline-none focus:border-sky-500"
        />
      </label>

      <div>
        <span className="text-[11px] font-medium text-slate-400">分类</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {categories?.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => setCategoryId(category.id)}
              className={clsx(
                'rounded-full border px-3 py-1.5 text-xs transition-colors',
                categoryId === category.id
                  ? 'border-sky-600 bg-sky-950/60 text-sky-300'
                  : 'border-slate-700 bg-slate-800/40 text-slate-400',
              )}
            >
              <span aria-hidden>{category.icon}</span> {category.name}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-950/40 px-3 py-2 text-[11px] text-rose-300">{error}</p>
      )}

      <button
        type="button"
        disabled={saving || amount === ''}
        onClick={() => void handleSave()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white enabled:active:bg-sky-700 disabled:opacity-40"
      >
        <Check size={16} aria-hidden />
        保存
      </button>
    </div>
  );
}
