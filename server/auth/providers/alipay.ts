/**
 * 支付宝登录渠道（OAuth2 授权码流程）。
 *
 * ⚠️ 端点地址：网上大量教程（**包括支付宝官方文档里的一段 Java 示例**）仍在用
 * `openauth.alipaydev.com` / `openapi.alipaydev.com`。这两个主机**已经失效**
 * （网关直接返回 502）。当前正确地址带 `-sandbox.dl` 段，见下方常量。
 *
 * 关于个人主体的真实边界（已核实官方文档）：
 * - 个人实名账号**可以**创建网页/移动应用并上线。
 * - 但 `alipay.user.info.share` 需要「获取会员信息」权限，其隐私申请
 *   **要求企业认证**。因此个人账号只能拿到 `user_id` / `open_id`，
 *   **拿不到昵称和头像** —— 归一化时这两项必须允许为空。
 *
 * 令牌绝不持久化：换取 → 取资料 → 归一化 → 丢弃。
 */

import { createSign } from 'node:crypto';
import {
  AuthExchangeError,
  type IdentityProvider,
  type NormalizedIdentity,
} from '../types.ts';

/** 生产端点。 */
const PROD = {
  authorize: 'https://openauth.alipay.com/oauth2/publicAppAuthorize.htm',
  gateway: 'https://openapi.alipay.com/gateway.do',
} as const;

/**
 * 沙箱端点。
 *
 * 已实测确认有效。旧的 `openauth.alipaydev.com` / `openapi.alipaydev.com` 已失效。
 */
const SANDBOX = {
  authorize: 'https://openauth-sandbox.dl.alipaydev.com/oauth2/publicAppAuthorize.htm',
  gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
} as const;

/** 是否使用沙箱。 */
function useSandbox(): boolean {
  return process.env.ALIPAY_SANDBOX !== 'false';
}

/**
 * 读取应用私钥。
 *
 * 环境变量里常常是去掉 PEM 头的裸 base64（.env 里放多行 PEM 很别扭），
 * 这里统一补全，避免用户因为格式问题卡住。
 *
 * @returns PEM 格式私钥，未配置时返回 `null`。
 */
function readPrivateKey(): string | null {
  const raw = process.env.ALIPAY_PRIVATE_KEY;
  if (!raw) return null;
  if (raw.includes('-----BEGIN')) return raw;

  // 允许用 \n 转义的形式写在单行里。
  const normalized = raw.replace(/\\n/g, '').replace(/\s/g, '');
  const lines = normalized.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

/** 支付宝要求的时间戳：GMT+8 的 `yyyy-MM-dd HH:mm:ss`。 */
function alipayTimestamp(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`
  );
}

/**
 * 对参数做 RSA2 签名。
 *
 * 规则：剔除空值、按参数名升序、以 `k=v&k=v` 拼接、用 SHA256withRSA 签名后 base64。
 * 这一步容易手写出错，所以没有用第三方 SDK 时也必须严格照此实现。
 *
 * @param params 业务参数（不含 sign）。
 * @param privateKeyPem PEM 私钥。
 * @returns base64 签名。
 */
function signParams(params: Record<string, string>, privateKeyPem: string): string {
  const content = Object.keys(params)
    .filter((key) => params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return createSign('RSA-SHA256').update(content, 'utf8').sign(privateKeyPem, 'base64');
}

/**
 * 调用支付宝网关。
 *
 * @param method 接口名，如 `alipay.system.oauth.token`。
 * @param business 业务参数。
 * @returns 响应中对应接口的响应体。
 * @throws {AuthExchangeError} 网络失败或返回错误时。
 */
async function callGateway(
  method: string,
  business: Record<string, string>,
): Promise<Record<string, unknown>> {
  const appId = process.env.ALIPAY_APP_ID;
  const privateKey = readPrivateKey();

  if (!appId || !privateKey) {
    throw new AuthExchangeError('支付宝凭据未配置');
  }

  const params: Record<string, string> = {
    app_id: appId,
    method,
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    ...business,
  };

  params.sign = signParams(params, privateKey);

  const gateway = useSandbox() ? SANDBOX.gateway : PROD.gateway;

  let response: Response;
  try {
    response = await fetch(gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AuthExchangeError(
      '连接支付宝网关失败',
      error instanceof Error ? error.message : String(error),
    );
  }

  const text = await response.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AuthExchangeError(
      '支付宝返回了无法解析的响应',
      `HTTP ${response.status}：${text.slice(0, 200)}`,
    );
  }

  if (payload.error_response) {
    const detail = JSON.stringify(payload.error_response).slice(0, 300);
    throw new AuthExchangeError('支付宝接口返回错误', detail);
  }

  // 响应节点名：点号换成下划线，例如 alipay.system.oauth.token
  // → alipay_system_oauth_token_response。
  const nodeName = `${method.replace(/\./g, '_')}_response`;
  const node = payload[nodeName];

  if (!node || typeof node !== 'object') {
    throw new AuthExchangeError(
      '支付宝响应缺少预期字段',
      `期望 ${nodeName}，实际顶层键：${Object.keys(payload).join('、')}`,
    );
  }

  return node as Record<string, unknown>;
}

/** 从响应对象里安全地取字符串。 */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export const alipayProvider: IdentityProvider = {
  key: 'alipay',
  displayName: '支付宝登录',
  capabilities: {
    // 支付宝没有文档化 PKCE，state 是唯一防线。
    supportsPkce: false,
    // H5 授权页只能在支付宝客户端内打开，手机浏览器会报错。
    worksInMobileBrowser: false,
    // 「获取会员信息」需企业认证，个人账号拿不到。
    providesDisplayName: false,
    providesAvatar: false,
  },
  note:
    '个人实名账号即可创建应用并上线，沙箱环境无需商业资质即可完整联调。' +
    '但「获取会员信息」需企业认证，因此个人账号只能拿到稳定的 user_id / open_id，' +
    '拿不到昵称和头像，需要用户自行填写显示名。',

  isConfigured(): boolean {
    return Boolean(process.env.ALIPAY_APP_ID) && readPrivateKey() !== null;
  },

  configurationHint(): string {
    return (
      '请在 .env 中设置 ALIPAY_APP_ID 与 ALIPAY_PRIVATE_KEY（RSA2 私钥）。' +
      '本地联调用 ALIPAY_SANDBOX=true 走沙箱，无需商业资质。'
    );
  },

  buildAuthorizeUrl({ state, redirectUri }): string {
    const appId = process.env.ALIPAY_APP_ID;
    if (!appId) {
      throw new AuthExchangeError('ALIPAY_APP_ID 未配置');
    }

    const base = useSandbox() ? SANDBOX.authorize : PROD.authorize;
    const url = new URL(base);
    url.searchParams.set('app_id', appId);
    // scope 只支持 auth_user（需用户同意，返回完整标识）与 auth_base（静默，仅 user_id）。
    url.searchParams.set('scope', 'auth_user');
    url.searchParams.set('redirect_uri', redirectUri);
    // 注意：支付宝要求 state base64 后 ≤100 字符且不能含中文。
    url.searchParams.set('state', state);
    return url.toString();
  },

  async exchangeCode({ code }): Promise<NormalizedIdentity> {
    // 第一步：授权码换令牌。
    const tokenNode = await callGateway('alipay.system.oauth.token', {
      grant_type: 'authorization_code',
      code,
    });

    const accessToken = readString(tokenNode, 'access_token');
    if (!accessToken) {
      throw new AuthExchangeError(
        '支付宝未返回 access_token',
        JSON.stringify(tokenNode).slice(0, 300),
      );
    }

    const openId = readString(tokenNode, 'open_id');
    const userId = readString(tokenNode, 'user_id');

    // 优先用 open_id：支付宝正在把标识从 user_id 迁到 open_id，
    // 官方明确「未来推出的新产品将只支持 openid」，user_id 计划逐步回收。
    const subject = openId ?? userId;
    if (!subject) {
      throw new AuthExchangeError(
        '支付宝既未返回 open_id 也未返回 user_id',
        JSON.stringify(tokenNode).slice(0, 300),
      );
    }

    // 第二步：尝试取资料。**失败不是致命错误** —— 个人账号本来就拿不到，
    // 把它当成登录失败会让个人开发者完全无法使用。
    let displayName: string | null = null;
    let avatarUrl: string | null = null;

    try {
      const infoNode = await callGateway('alipay.user.info.share', {
        auth_token: accessToken,
      });
      displayName = readString(infoNode, 'nick_name');
      avatarUrl = readString(infoNode, 'avatar');
    } catch {
      // 资料获取失败时静默降级为「无资料」，登录本身仍然成立。
      // 这正是 capabilities 里把 providesDisplayName/Avatar 标为 false 的原因。
    }

    // 第三步：归一化完成，令牌在函数返回后即被丢弃 —— 绝不持久化。
    return {
      provider: 'alipay',
      subject,
      subjectStandard: openId ? 'open_id' : 'user_id',
      displayName,
      avatarUrl,
    };
  },
};
