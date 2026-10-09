/**
 * 开发态演示登录渠道。
 *
 * 关键设计：它是**一个真正的渠道**，走与真实渠道完全相同的路径
 * （生成 state → 重定向到授权页 → 回调 → 换取身份 → 建会话），
 * 而不是一条「绕过认证」的分支。
 *
 * 为什么这点重要：如果 mock 是绕过，那么 mock 路径永远不会经过 state 校验、
 * 会话创建、身份 upsert 这些环节，真实渠道接入时这些环节的问题要到线上才暴露。
 *
 * 生产安全的四道闸门：
 * 1. 未显式开启时从注册表移除（不是返回 403）—— 路由根本不存在。
 * 2. 环境变量缺失时**失败关闭**（默认关闭），而不是失败开放。
 * 3. subject 带 `mock:` 前缀命名空间，不可能与真实标识冲突。
 * 4. 生产环境用独立数据库与独立签名密钥（见 README 的部署说明）。
 */

import { AuthExchangeError, type IdentityProvider, type NormalizedIdentity } from '../types.ts';

/** 是否允许启用演示渠道。默认关闭；必须显式设为 `true`。 */
export function isMockLoginEnabled(): boolean {
  return process.env.ENABLE_MOCK_LOGIN === 'true' && process.env.NODE_ENV !== 'production';
}

/**
 * 演示渠道。
 *
 * 授权页是一个服务端渲染的极简页面（见 routes/auth.ts），
 * 让用户输入一个昵称以模拟「渠道返回了资料」和「渠道没返回资料」两种真实情况。
 */
export const mockProvider: IdentityProvider = {
  key: 'mock',
  displayName: '本地演示登录',
  capabilities: {
    // 走的是真实 state 校验路径，因此这里如实声明不支持 PKCE。
    supportsPkce: false,
    worksInMobileBrowser: true,
    providesDisplayName: true,
    providesAvatar: false,
  },
  note:
    '仅用于本地开发与预览，不需要任何凭据。它不绕过任何校验，' +
    '而是完整走一遍授权码流程，因此可以用来验证登录链路的正确性。' +
    '生产环境必须关闭（ENABLE_MOCK_LOGIN 不设为 true 即可）。',

  isConfigured(): boolean {
    return isMockLoginEnabled();
  },

  configurationHint(): string {
    return '设置 ENABLE_MOCK_LOGIN=true 并在非 production 环境下重启服务即可启用。';
  },

  buildAuthorizeUrl({ state, redirectUri }): string {
    // 演示渠道的授权页由本服务自己提供，模拟第三方授权页的行为。
    const url = new URL(redirectUri);
    url.pathname = '/api/auth/mock/authorize';
    url.search = '';
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  },

  async exchangeCode({ code }): Promise<NormalizedIdentity> {
    // 演示授权页把用户填的昵称放进 code（形如 `nick:<昵称>` 或 `anon`）。
    if (code === '') {
      throw new AuthExchangeError('演示登录未返回授权码');
    }

    const anonymous = code === 'anon';
    const nickname = code.startsWith('nick:') ? code.slice(5).trim() : '';

    return {
      provider: 'mock',
      // 命名空间化，绝不可能与真实渠道的标识冲突。
      subject: `mock:${code}`,
      subjectStandard: 'mock',
      // 刻意支持「没有昵称」这一真实情况，用来暴露上层对可空资料的处理缺陷。
      displayName: anonymous || nickname === '' ? null : nickname,
      avatarUrl: null,
    };
  },
};
