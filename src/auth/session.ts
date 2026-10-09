/**
 * 客户端会话与登录渠道。
 *
 * **登录是可选的，永不阻塞应用。** 账本数据在本地 IndexedDB 里，
 * 登不登录都能记账、导入、看报表。后端不可达时这里静默降级为「本地模式」，
 * 绝不弹错误挡住用户 —— 否则一个后端故障就让整个记账应用不可用。
 */

import { useCallback, useEffect, useState } from 'react';

/** 登录渠道的能力声明，与服务端一致。 */
export interface ProviderCapabilities {
  supportsPkce: boolean;
  worksInMobileBrowser: boolean;
  providesDisplayName: boolean;
  providesAvatar: boolean;
}

/** 一个可用的登录渠道。 */
export interface LoginProvider {
  key: string;
  displayName: string;
  configured: boolean;
  capabilities: ProviderCapabilities;
  note: string;
  configurationHint: string;
}

/** 当前用户。 */
export interface SessionUser {
  id: number;
  displayName: string | null;
  avatarUrl: string | null;
}

/** 会话状态。 */
export interface SessionState {
  /** 是否已完成首次查询。首次查询前不应展示「未登录」以免闪烁。 */
  ready: boolean;
  /** 后端是否可达。不可达时应用以本地模式运行。 */
  backendAvailable: boolean;
  user: SessionUser | null;
  identities: Array<{ provider: string; subjectStandard: string }>;
  providers: LoginProvider[];
  /** 重新查询会话与渠道。 */
  refresh: () => Promise<void>;
  /** 注销。 */
  logout: () => Promise<void>;
}

/**
 * 查询当前会话与可用渠道。
 *
 * 任何网络失败都降级为「本地模式」而不是抛错。
 *
 * @returns 会话状态。
 */
export function useSession(): SessionState {
  const [ready, setReady] = useState(false);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [identities, setIdentities] = useState<Array<{ provider: string; subjectStandard: string }>>([]);
  const [providers, setProviders] = useState<LoginProvider[]>([]);

  const refresh = useCallback(async () => {
    // 渠道列表与当前用户并行查询。
    const [providersResult, meResult] = await Promise.allSettled([
      fetch('/api/auth/providers').then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as { providers?: LoginProvider[] };
      }),
      fetch('/api/auth/me').then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as {
          user?: SessionUser;
          identities?: Array<{ provider: string; subjectStandard: string }>;
        };
      }),
    ]);

    if (providersResult.status === 'fulfilled') {
      setProviders(providersResult.value.providers ?? []);
      setBackendAvailable(true);
    } else {
      setProviders([]);
      setBackendAvailable(false);
    }

    if (meResult.status === 'fulfilled') {
      const value = meResult.value;
      setUser(value?.user ?? null);
      setIdentities(value?.identities ?? []);
    } else {
      setUser(null);
      setIdentities([]);
    }

    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // 后端不可达时本地状态也要清掉，否则界面会显示一个已经不存在的登录态。
    }
    setUser(null);
    setIdentities([]);
  }, []);

  return { ready, backendAvailable, user, identities, providers, refresh, logout };
}

/**
 * 发起登录。
 *
 * 用整页跳转而不是 fetch：OAuth 授权必须离开本站点，
 * 且 `fetch` 无法跨站跟随重定向并携带 Cookie。
 *
 * @param provider 渠道标识。
 * @param returnTo 登录后要返回的站内路径。
 */
export function startLogin(provider: string, returnTo = '/'): void {
  const url = new URL(`/api/auth/${provider}/start`, window.location.origin);
  url.searchParams.set('return_to', returnTo);
  window.location.href = url.toString();
}
