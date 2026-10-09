/**
 * 登录渠道注册表。
 *
 * 未启用或未配置的渠道在这里就被过滤掉 —— **从注册表移除，而不是在路由里返回 403**。
 * 两者的安全差异是实质性的：返回 403 意味着路由和代码路径依然存在，
 * 一旦鉴权判断写错就变成可利用的入口；从注册表移除则连路由都不存在。
 */

import type { IdentityProvider, ProviderCapabilities } from './types.ts';
import { mockProvider, isMockLoginEnabled } from './providers/mock.ts';
import { alipayProvider } from './providers/alipay.ts';
import { wechatProvider } from './providers/wechat.ts';

/** 全部候选渠道。 */
const ALL_PROVIDERS: readonly IdentityProvider[] = [
  mockProvider,
  alipayProvider,
  wechatProvider,
];

/**
 * 取出当前可用的渠道。
 *
 * 演示渠道只在显式开启且非生产环境时出现。
 *
 * @returns 可用渠道列表。
 */
export function activeProviders(): IdentityProvider[] {
  return ALL_PROVIDERS.filter((provider) => {
    if (provider.key === 'mock') {
      return isMockLoginEnabled();
    }
    return true;
  });
}

/**
 * 按 key 取渠道。
 *
 * @param key 渠道标识。
 * @returns 渠道，不存在或未启用时返回 `null`。
 */
export function getProvider(key: string): IdentityProvider | null {
  return activeProviders().find((provider) => provider.key === key) ?? null;
}

/** 面向客户端的渠道描述，不含任何密钥。 */
export interface ProviderDescriptor {
  key: string;
  displayName: string;
  configured: boolean;
  capabilities: ProviderCapabilities;
  note: string;
  configurationHint: string;
}

/**
 * 生成可安全下发给客户端的渠道描述。
 *
 * 只暴露「是否已配置」这一个布尔值，绝不下发密钥或密钥片段。
 *
 * @returns 渠道描述列表。
 */
export function describeProviders(): ProviderDescriptor[] {
  return activeProviders().map((provider) => ({
    key: provider.key,
    displayName: provider.displayName,
    configured: provider.isConfigured(),
    capabilities: provider.capabilities,
    note: provider.note,
    configurationHint: provider.configurationHint(),
  }));
}
