/**
 * 应用外壳：底部标签栏 + 页面切换。
 *
 * 移动优先布局 —— 用 `dvh` 而非 `vh` 避免移动端浏览器地址栏收起时内容被截断。
 */

import { useState } from 'react';
import { BarChart3, Import, ListOrdered, PlusCircle, UserRound } from 'lucide-react';
import clsx from 'clsx';
import TransactionsScreen from './ui/TransactionsScreen.tsx';
import ImportScreen from './ui/ImportScreen.tsx';
import StatsScreen from './ui/StatsScreen.tsx';
import AddScreen from './ui/AddScreen.tsx';
import AccountSheet from './ui/AccountSheet.tsx';
import { useSession } from './auth/session.ts';

/** 可用页面。 */
type TabKey = 'transactions' | 'add' | 'import' | 'stats';

/** 标签栏定义。 */
const TABS: ReadonlyArray<{ key: TabKey; label: string; Icon: typeof ListOrdered }> = [
  { key: 'transactions', label: '明细', Icon: ListOrdered },
  { key: 'add', label: '记一笔', Icon: PlusCircle },
  { key: 'import', label: '导入', Icon: Import },
  { key: 'stats', label: '统计', Icon: BarChart3 },
];

/**
 * 取当前月份，格式 `YYYY-MM`。
 *
 * @returns 本地时区的当前月份。
 */
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function App() {
  const [tab, setTab] = useState<TabKey>('transactions');
  const [month, setMonth] = useState<string>(currentMonth);
  const [accountOpen, setAccountOpen] = useState(false);

  // 登录是可选的：会话查询失败会静默降级为本地模式，不阻塞界面。
  const session = useSession();

  return (
    <div className="flex min-h-dvh flex-col bg-slate-900 text-slate-200">
      <header
        className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/95 backdrop-blur"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-base font-semibold tracking-wide">记账本</h1>
          <div className="flex items-center gap-2">
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              aria-label="选择月份"
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-200 outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              aria-label="账户"
              className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-400 active:text-slate-200"
            >
              <UserRound size={16} aria-hidden />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 pb-4 pt-3">
        {tab === 'transactions' && <TransactionsScreen month={month} />}
        {tab === 'add' && (
          <AddScreen
            onDone={(savedMonth) => {
              // 补录历史账或经 OCR 填入历史发票日期时，要跳到对应月份才看得到。
              if (savedMonth !== undefined) {
                setMonth(savedMonth);
              }
              setTab('transactions');
            }}
          />
        )}
        {tab === 'import' && (
          <ImportScreen
            month={month}
            onDone={(importedMonth) => {
              // 账单通常是历史月份；不跳转的话用户会看到空列表而误以为导入失败。
              if (importedMonth !== undefined) {
                setMonth(importedMonth);
              }
              setTab('transactions');
            }}
          />
        )}
        {tab === 'stats' && <StatsScreen month={month} />}
      </main>

      {accountOpen && <AccountSheet session={session} onClose={() => setAccountOpen(false)} />}

      <nav
        className="sticky bottom-0 z-10 grid grid-cols-4 border-t border-slate-800 bg-slate-900/95 backdrop-blur"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? 'page' : undefined}
            className={clsx(
              'flex flex-col items-center gap-1 py-2.5 text-xs transition-colors',
              tab === key ? 'text-sky-400' : 'text-slate-500 active:text-slate-300',
            )}
          >
            <Icon size={20} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
