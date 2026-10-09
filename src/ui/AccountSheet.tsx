/**
 * 账户面板。
 *
 * 明确传达一个设计事实：**登录是可选的**。账本数据留在本机，
 * 不登录也能完整使用。这样用户不会因为「必须登录」而放弃使用，
 * 也不会误以为数据被上传了。
 */

import clsx from 'clsx';
import { AlertTriangle, Cloud, HardDrive, LogOut, ShieldCheck, X } from 'lucide-react';
import { startLogin, type SessionState } from '../auth/session.ts';

interface Props {
  session: SessionState;
  onClose: () => void;
}

/**
 * 账户面板。
 *
 * @param props.session 会话状态。
 * @param props.onClose 关闭面板。
 */
export default function AccountSheet({ session, onClose }: Props) {
  const { ready, backendAvailable, user, identities, providers } = session;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="账户"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border-t border-slate-700 bg-slate-900 px-4 pb-6 pt-4"
        style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">账户与数据</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg p-1.5 text-slate-500 active:bg-slate-800"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {/* 数据存放位置是这个应用最重要的事实，必须放在最显眼处。 */}
        <section className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-3.5">
          <h3 className="flex items-center gap-2 text-xs font-medium text-emerald-300">
            <HardDrive size={15} aria-hidden />
            账本数据存在这台设备上
          </h3>
          <p className="mt-1.5 text-[11px] leading-relaxed text-emerald-200/70">
            流水保存在浏览器的 IndexedDB 里，<b>不会上传到服务器</b>。
            后端只负责登录与可选的云端 OCR，不持有任何流水。
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300/80">
            ⚠️ 清除浏览器数据会清空账本。跨设备同步尚未实现。
          </p>
        </section>

        {!ready && (
          <p className="mt-3 text-[11px] text-slate-500">正在检查登录状态…</p>
        )}

        {ready && user === null && (
          <section className="mt-3">
            <h3 className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <Cloud size={15} aria-hidden />
              登录（可选）
            </h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              不登录也能完整使用记账、导入和报表。登录用于将来接入多设备同步。
            </p>

            {!backendAvailable && (
              <p className="mt-2 rounded-lg bg-slate-800/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                后端服务未运行，因此无法登录。这不影响记账 —— 用{' '}
                <code className="rounded bg-slate-950 px-1">pnpm dev</code> 启动后端即可启用登录。
              </p>
            )}

            {providers.length === 0 && backendAvailable && (
              <p className="mt-2 rounded-lg bg-slate-800/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                当前没有可用的登录渠道。
              </p>
            )}

            <ul className="mt-2.5 space-y-2">
              {providers.map((provider) => (
                <li
                  key={provider.key}
                  className="rounded-xl border border-slate-800 bg-slate-800/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-200">
                        {provider.displayName}
                        {!provider.configured && (
                          <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
                            未配置
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                        {provider.note}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!provider.configured}
                      onClick={() => startLogin(provider.key)}
                      className="shrink-0 rounded-lg bg-sky-600 px-3 py-1.5 text-[11px] font-medium text-white enabled:active:bg-sky-700 disabled:opacity-30"
                    >
                      登录
                    </button>
                  </div>

                  {provider.configured && <CapabilityWarnings provider={provider} />}

                  {!provider.configured && (
                    <p className="mt-2 rounded bg-slate-900/70 px-2 py-1.5 text-[10px] leading-relaxed text-slate-500">
                      {provider.configurationHint}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {ready && user !== null && (
          <section className="mt-3 rounded-xl border border-slate-800 bg-slate-800/40 p-3.5">
            <h3 className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <ShieldCheck size={15} aria-hidden />
              已登录
            </h3>

            <p className="mt-2 text-sm text-slate-200">
              {user.displayName ?? (
                <span className="text-slate-400">
                  未提供昵称
                  <span className="ml-1.5 text-[10px] text-slate-500">
                    （支付宝个人账号拿不到昵称，属正常）
                  </span>
                </span>
              )}
            </p>

            <p className="mt-1 text-[11px] text-slate-500">
              账号 id {user.id} · 已绑定：
              {identities.length > 0
                ? identities
                    .map((identity) => `${identity.provider}(${identity.subjectStandard})`)
                    .join('、')
                : '无'}
            </p>

            <button
              type="button"
              onClick={() => void session.logout()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400 active:bg-slate-800"
            >
              <LogOut size={14} aria-hidden />
              退出登录
            </button>
          </section>
        )}

        <section className="mt-3 rounded-xl border border-slate-800 bg-slate-800/40 p-3.5">
          <h3 className="text-xs font-medium text-slate-300">尚未实现的能力</h3>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-slate-500">
            <li>· 多设备同步（登录已就绪，同步逻辑未实现）</li>
            <li>· 数据导出备份（清空浏览器数据会丢账本，请留意）</li>
            <li>· 微信小程序登录</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/** 渠道能力的如实提示。 */
function CapabilityWarnings({ provider }: { provider: SessionState['providers'][number] }) {
  const warnings: string[] = [];

  // 两家都不支持 PKCE，state 是唯一防线 —— 这属于实现细节，不必打扰用户。
  if (!provider.capabilities.worksInMobileBrowser) {
    warnings.push('授权页只能在支付宝客户端内打开，手机浏览器里会失败，建议用电脑扫码');
  }
  if (!provider.capabilities.providesDisplayName) {
    warnings.push('拿不到昵称和头像，登录后需要自己填显示名');
  }

  if (warnings.length === 0) return null;

  return (
    <ul className="mt-2 space-y-0.5 rounded bg-amber-950/30 px-2 py-1.5">
      {warnings.map((warning) => (
        <li key={warning} className={clsx('flex gap-1.5 text-[10px] leading-relaxed text-amber-300')}>
          <AlertTriangle size={11} className="mt-px shrink-0" aria-hidden />
          <span>{warning}</span>
        </li>
      ))}
    </ul>
  );
}
