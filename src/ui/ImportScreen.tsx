/**
 * 导入页：把微信/支付宝账单导入账本。
 *
 * 交互上刻意分成三步 —— 选择文件 → 预览核对 → 确认入账。
 * 账单是外部数据，直接落库会让错误的分类或方向无声地污染账本，
 * 因此预览阶段必须把「跳过了什么」和「自检不一致」显示出来。
 */

import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Info } from 'lucide-react';
import { buildSelfCheckNotes, loadBillFile, isZipFile, type LoadBillOutcome } from '../import/billFile.ts';
import { BillParseError } from '../domain/types.ts';
import { categorizeAll } from '../categorize/rules.ts';
import { buildDedupeKey, db, insertTransactions, type TransactionRecord } from '../db/db.ts';
import { formatCents } from '../domain/money.ts';

interface Props {
  month: string;
  /** 入账成功后切换到明细页；携带应展示的月份（账单可能在历史月份）。 */
  onDone: (month?: string) => void;
}

/** 导入完成后的结果摘要。 */
interface CommitOutcome {
  inserted: number;
  duplicated: number;
  /**
   * 本次导入的交易中最近的月份（`YYYY-MM`）。
   *
   * 账单通常是历史月份，而界面默认停在本月 —— 若不跳转，用户导入完
   * 上月账单会看到「这个月还没有记录」，误以为导入失败。
   */
  latestMonth?: string;
}

/**
 * 导入页。
 *
 * @param props.month 当前选中的月份，仅用于入账提示。
 * @param props.onDone 入账成功后切换到明细页。
 */
export default function ImportScreen({ onDone }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<LoadBillOutcome | null>(null);
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [committed, setCommitted] = useState<CommitOutcome | null>(null);
  // 入账后要清空 file 状态，但 input 是**非受控**的，DOM 里仍留着上次的文件。
  // 用户再次选择同一个文件时不会触发 change 事件，按钮就会一直灰着。
  // 用递增的 key 强制重建 input 来消除这个陷阱。
  const [inputKey, setInputKey] = useState(0);

  const needsPassword = file !== null && isZipFile(file.name);
  const notes = outcome ? buildSelfCheckNotes(outcome.result) : [];

  /**
   * 读取并解析选中的文件。
   */
  async function handleParse(): Promise<void> {
    if (!file) return;
    setLoading(true);
    setError(null);
    setCommitted(null);
    setOutcome(null);

    try {
      const result = await loadBillFile(file, password);
      setOutcome(result);
    } catch (caught) {
      if (caught instanceof BillParseError) {
        setError({ message: caught.message, detail: caught.detail });
      } else {
        setError({
          message: '导入失败',
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    } finally {
      setLoading(false);
    }
  }

  /**
   * 把预览中的交易自动分类后写入本地账本。
   */
  async function handleCommit(): Promise<void> {
    if (!outcome) return;
    setLoading(true);

    try {
      const { transactions } = outcome.result;
      const rules = await db.rules.toArray();
      const results = categorizeAll(transactions, rules);

      const categories = await db.categories.toArray();
      const idByName = new Map(categories.map((category) => [category.name, category.id]));

      const records: TransactionRecord[] = transactions.map((tx, i) => {
        const decision = results[i]?.categoryName ?? '其他支出';
        return {
          occurredAt: tx.occurredAt,
          direction: tx.direction,
          amountCents: tx.amountCents,
          categoryId: tx.direction === 'transfer' ? undefined : idByName.get(decision),
          counterparty: tx.counterparty,
          description: tx.description,
          accountName: tx.method,
          source: tx.source,
          rawCategory: tx.rawCategory,
          status: tx.status,
          remark: tx.remark,
          dedupeKey: buildDedupeKey({
            source: tx.source,
            orderId: tx.orderId,
            occurredAt: tx.occurredAt,
            amountCents: tx.amountCents,
            counterparty: tx.counterparty,
          }),
          createdAt: Date.now(),
        };
      });

      const result = await insertTransactions(records);

      // 计算账单里最近的月份，供跳转使用。
      const latestMonth = transactions.reduce<string | undefined>((latest, tx) => {
        const month = tx.occurredAt.slice(0, 7);
        return latest === undefined || month > latest ? month : latest;
      }, undefined);

      setCommitted({ ...result, latestMonth });
      setOutcome(null);
      setFile(null);
      setPassword('');
      setInputKey((value) => value + 1);
    } catch (caught) {
      setError({
        message: '写入账本失败',
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-slate-800 bg-slate-800/40 p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <FileUp size={16} aria-hidden />
          选择账单文件
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          支持微信支付与支付宝导出的<b className="text-slate-400">加密 ZIP</b>（推荐），
          也支持已解压的 CSV。
        </p>

        <input
          key={inputKey}
          type="file"
          accept=".zip,.csv"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setOutcome(null);
            setError(null);
            setCommitted(null);
          }}
          className="mt-3 block w-full cursor-pointer rounded-lg border border-slate-700 bg-slate-900 text-xs text-slate-400 file:mr-3 file:cursor-pointer file:border-0 file:bg-sky-600 file:px-3 file:py-2 file:text-xs file:font-medium file:text-white"
        />

        {needsPassword && (
          <div className="mt-3">
            <label
              htmlFor="zip-password"
              className="block text-[11px] font-medium text-slate-400"
            >
              解压密码
            </label>
            <input
              id="zip-password"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="微信见「微信支付」通知；支付宝为身份证后 6 位"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500"
            />
          </div>
        )}

        <button
          type="button"
          disabled={!file || loading}
          onClick={() => void handleParse()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition-colors enabled:active:bg-sky-700 disabled:opacity-40"
        >
          {loading && <Loader2 size={16} className="animate-spin" aria-hidden />}
          {loading ? '处理中…' : '读取并预览'}
        </button>
      </section>

      {error && (
        <section className="rounded-xl border border-rose-900/60 bg-rose-950/40 p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-rose-300">
            <AlertTriangle size={16} aria-hidden />
            {error.message}
          </h2>
          {error.detail && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-rose-200/70">
              {error.detail}
            </p>
          )}
        </section>
      )}

      {committed && (
        <section className="rounded-xl border border-emerald-900/60 bg-emerald-950/40 p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-emerald-300">
            <CheckCircle2 size={16} aria-hidden />
            已入账 {committed.inserted} 笔
          </h2>
          {committed.duplicated > 0 && (
            <p className="mt-1.5 text-[11px] text-emerald-200/70">
              另有 {committed.duplicated} 笔此前已导入过，已自动去重跳过。
            </p>
          )}
          {committed.latestMonth !== undefined && (
            <p className="mt-1.5 text-[11px] text-emerald-200/70">
              账单月份为 {committed.latestMonth}，将切换到该月查看。
            </p>
          )}
          <button
            type="button"
            onClick={() => onDone(committed.latestMonth)}
            className="mt-3 w-full rounded-lg border border-emerald-800 px-4 py-2 text-xs font-medium text-emerald-300"
          >
            去看明细
          </button>
        </section>
      )}

      {outcome && <Preview outcome={outcome} notes={notes} onCommit={handleCommit} loading={loading} />}
    </div>
  );
}

/** 预览面板。 */
function Preview({
  outcome,
  notes,
  onCommit,
  loading,
}: {
  outcome: LoadBillOutcome;
  notes: string[];
  onCommit: () => Promise<void>;
  loading: boolean;
}) {
  const { result } = outcome;
  const sourceLabel = result.source === 'wechat' ? '微信支付' : '支付宝';

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-800/40 p-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
          <Info size={16} aria-hidden />
          预览：{sourceLabel}账单
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          文件 {outcome.fileName} · 编码 {outcome.encoding}
          {result.ownerName ? ` · ${result.ownerName}` : ''}
          {result.period?.start ? ` · ${result.period.start.slice(0, 10)} 起` : ''}
        </p>
      </div>

      {result.period?.start && result.period.end && (
        <p className="text-[11px] text-slate-500">
          导出区间：{result.period.start.slice(0, 10)} ~ {result.period.end.slice(0, 10)}
        </p>
      )}

      {outcome.suspicious && (
        <p className="rounded-lg bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">
          文件中出现了无法解码的字符，可能有部分内容已损坏。请核对下方笔数是否合理。
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="收入" value={result.actual.incomeCents ?? 0} count={result.actual.incomeCount ?? 0} />
        <MiniStat label="支出" value={result.actual.expenseCents ?? 0} count={result.actual.expenseCount ?? 0} />
        <MiniStat label="不计收支" value={result.actual.neutralCents ?? 0} count={result.actual.neutralCount ?? 0} />
      </div>

      {notes.length > 0 && (
        <div className="rounded-lg bg-amber-950/40 px-3 py-2">
          <p className="text-[11px] font-medium text-amber-300">自检提示</p>
          <ul className="mt-1 space-y-0.5">
            {notes.map((note) => (
              <li key={note} className="text-[11px] leading-relaxed text-amber-200/70">
                · {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.skipped.length > 0 && (
        <details className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-slate-400">
            跳过了 {result.skipped.length} 行（点击展开）
          </summary>
          <ul className="mt-1.5 space-y-1">
            {result.skipped.slice(0, 30).map((row, index) => (
              <li key={index} className="text-[11px] leading-relaxed text-slate-500">
                {row.line > 0 ? `第 ${row.line} 行：` : ''}
                {row.detail}
              </li>
            ))}
            {result.skipped.length > 30 && (
              <li className="text-[11px] text-slate-600">
                …另有 {result.skipped.length - 30} 行未显示
              </li>
            )}
          </ul>
        </details>
      )}

      <div>
        <p className="text-[11px] font-medium text-slate-400">
          将入账 {result.transactions.length} 笔（分类已自动匹配，可在明细页查看）
        </p>
        <ul className="mt-1.5 max-h-56 space-y-1 overflow-y-auto no-scrollbar">
          {result.transactions.slice(0, 50).map((tx, index) => (
            <li
              key={index}
              className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/50 px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
                {tx.counterparty || tx.description || '（无商户信息）'}
                <span className="ml-1 text-slate-600">{tx.occurredAt.slice(5, 10)}</span>
              </span>
              <span
                className={clsx(
                  'shrink-0 text-[11px] tabular-nums',
                  tx.direction === 'income'
                    ? 'text-emerald-400'
                    : tx.direction === 'expense'
                      ? 'text-slate-300'
                      : 'text-slate-600',
                )}
              >
                {tx.direction === 'income' ? '+' : tx.direction === 'expense' ? '-' : ''}
                {formatCents(tx.amountCents, { symbol: false })}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        disabled={loading || result.transactions.length === 0}
        onClick={() => void onCommit()}
        className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white enabled:active:bg-sky-700 disabled:opacity-40"
      >
        确认入账
      </button>
    </section>
  );
}

/** 预览用的小统计块。 */
function MiniStat({ label, value, count }: { label: string; value: number; count: number }) {
  return (
    <div className="rounded-lg bg-slate-900/50 px-2.5 py-1.5">
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="mt-0.5 text-xs font-medium tabular-nums text-slate-200">
        {formatCents(value)}
      </p>
      <p className="text-[10px] text-slate-600">{count} 笔</p>
    </div>
  );
}
