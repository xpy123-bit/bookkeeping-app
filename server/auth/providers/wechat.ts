/**
 * 微信登录渠道（网站应用微信登录 / 扫码）。
 *
 * ⚠️ 资质现实（已核实微信官方审核规范，请先读完）：
 * 「网站应用微信登录」的应用审核要求**公章**（且需与认证主体一致）、
 * **ICP 备案号**（且备案主体需与认证主体一致）。**个人主体无法通过审核。**
 * 另有针对本站形态的坑：审核规范明确「官网不支持提供手机端小程序、公众号和
 * **H5 等页面类型**」—— 一个移动优先的 PWA 恰好就是会被拒的那类。
 *
 * 因此本渠道代码完整、协议正确，但在个人主体下**无法启用**。
 * 唯一解锁路径是注册「个体工商户」（只需营业执照）。
 *
 * 协议实现里处理了两个容易踩的坑：
 * 1. **用户在授权页拒绝时会完全不跳转** —— 不会带 error 参数回来，
 *    因此 UI 必须能处理「用户走开了、再也没回来」这一情况。
 * 2. **快照页模式**：自 2022 年起异常使用 `snsapi_userinfo` 会触发快照页，
 *    返回 `is_snapshotuser: 1` 的**虚拟账号**。必须拒绝，
 *    否则会给临时虚拟用户建出真实账号。
 */

import {
  AuthExchangeError,
  type IdentityProvider,
  type NormalizedIdentity,
} from '../types.ts';

const AUTHORIZE = 'https://open.weixin.qq.com/connect/qrconnect';
const TOKEN = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const USERINFO = 'https://api.weixin.qq.com/sns/userinfo';

/**
 * 带诊断信息的 GET。
 *
 * @param url 完整地址。
 * @returns 解析后的 JSON。
 * @throws {AuthExchangeError} 网络失败或响应不是 JSON 时。
 */
async function getJson(url: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new AuthExchangeError(
      '连接微信接口失败',
      error instanceof Error ? error.message : String(error),
    );
  }

  const text = await response.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AuthExchangeError(
      '微信返回了无法解析的响应',
      `HTTP ${response.status}：${text.slice(0, 200)}`,
    );
  }

  // 微信用 `errcode` 表达错误，且 HTTP 状态码仍是 200。
  const errcode = payload.errcode;
  if (typeof errcode === 'number' && errcode !== 0) {
    const errmsg = typeof payload.errmsg === 'string' ? payload.errmsg : '';
    const hints: Record<number, string> = {
      40029: '授权码无效或已过期（授权码仅单次有效，且 10 分钟内必须使用）',
      40030: 'refresh_token 无效',
      40003: 'appid 无效',
      40163: '授权码已被使用过',
      41008: '缺少授权码',
    };
    throw new AuthExchangeError(
      `微信接口报错 ${errcode}`,
      `${errmsg}${hints[errcode] ? ` —— ${hints[errcode]}` : ''}`,
    );
  }

  return payload;
}

/** 从响应里安全地取字符串。 */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

export const wechatProvider: IdentityProvider = {
  key: 'wechat',
  displayName: '微信登录',
  capabilities: {
    // 微信未文档化 PKCE。
    supportsPkce: false,
    // 桌面端扫码，手机浏览器体验差但可用（移动端走的是另一套授权页）。
    worksInMobileBrowser: true,
    // 网站应用 /sns/userinfo 仍返回昵称与头像。
    // 注意：2021-10-20 的变更只移除了**性别与地区**，昵称头像未受影响。
    providesDisplayName: true,
    providesAvatar: true,
  },
  note:
    '「网站应用微信登录」要求企业或个体工商户主体、公章、以及 ICP 备案域名，' +
    '个人主体无法通过应用审核。代码与协议已实现完整，取得资质后填入 ' +
    'WECHAT_APP_ID / WECHAT_APP_SECRET 即可启用。',

  isConfigured(): boolean {
    return Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
  },

  configurationHint(): string {
    return (
      '请在 .env 中设置 WECHAT_APP_ID 与 WECHAT_APP_SECRET。' +
      '注意：需要企业或个体工商户主体并完成 ICP 备案，个人主体无法通过应用审核。'
    );
  },

  buildAuthorizeUrl({ state, redirectUri }): string {
    const appId = process.env.WECHAT_APP_ID;
    if (!appId) {
      throw new AuthExchangeError('WECHAT_APP_ID 未配置');
    }

    const url = new URL(AUTHORIZE);
    url.searchParams.set('appid', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    // 网站应用只能用 snsapi_login；这是硬约束。
    url.searchParams.set('scope', 'snsapi_login');
    url.searchParams.set('state', state);
    // 微信要求 URL 以 #wechat_redirect 结尾。
    return `${url.toString()}#wechat_redirect`;
  },

  async exchangeCode({ code }): Promise<NormalizedIdentity> {
    const appId = process.env.WECHAT_APP_ID;
    const appSecret = process.env.WECHAT_APP_SECRET;
    if (!appId || !appSecret) {
      throw new AuthExchangeError('微信凭据未配置');
    }

    // 第一步：授权码换令牌。
    const tokenUrl = new URL(TOKEN);
    tokenUrl.searchParams.set('appid', appId);
    tokenUrl.searchParams.set('secret', appSecret);
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');

    const tokenNode = await getJson(tokenUrl.toString());

    const accessToken = readString(tokenNode, 'access_token');
    const openId = readString(tokenNode, 'openid');

    if (!accessToken || !openId) {
      throw new AuthExchangeError(
        '微信未返回 access_token 或 openid',
        JSON.stringify(tokenNode).slice(0, 300),
      );
    }

    // 第二步：取用户信息。
    const infoUrl = new URL(USERINFO);
    infoUrl.searchParams.set('access_token', accessToken);
    infoUrl.searchParams.set('openid', openId);
    infoUrl.searchParams.set('lang', 'zh_CN');

    const info = await getJson(infoUrl.toString());

    // 快照页模式返回的是**虚拟账号**。必须拒绝：放进来会给临时虚拟用户
    // 建出真实账号，而这些账号下次登录就再也对不上了。
    if (readString(info, 'is_snapshotuser') === '1') {
      throw new AuthExchangeError(
        '微信返回了快照虚拟账号，已拒绝登录',
        '这是微信对异常 snsapi_userinfo 调用的限制模式。请让用户改用微信客户端内的正常入口重试。',
      );
    }

    // identity 用 unionid（「微信用户 + 开放平台账号」维度）。
    // openid 是「微信用户 + 单个 AppID」维度，换了应用就变了，不能作为主键。
    // 注意：refresh_token 换取的结果**不含 unionid**，所以这里必须从
    // token 响应或 userinfo 里取。此处取 info 优先，回落到 token 响应。
    const unionId = readString(info, 'unionid') ?? readString(tokenNode, 'unionid');

    if (!unionId) {
      throw new AuthExchangeError(
        '微信未返回 unionid，无法建立稳定的账号关联',
        '请确认该网站应用已绑定到微信开放平台账号（未绑定时不返回 unionid）。',
      );
    }

    const nickname = readString(info, 'nickname');
    const headImage = readString(info, 'headimgurl');

    // 归一化完成，令牌在此丢弃，绝不持久化。
    return {
      provider: 'wechat',
      subject: unionId,
      subjectStandard: 'unionid',
      displayName: nickname,
      // 微信头像 URL 会失效，正式环境应下载后自行转存。
      avatarUrl: headImage,
    };
  },
};
