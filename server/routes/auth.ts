/**
 * 登录路由。
 *
 * 落实的安全约束（每条都对应一个真实攻击面）：
 * - `redirect_uri` 由**服务端常量**构造，绝不从 `Host` / `X-Forwarded-Host` 推导
 *   —— 那是典型的开放重定向漏洞。
 * - `state` 服务端单次消费（`consumeOAuthState` 里立即标记 used）。
 * - 会话是服务端不透明令牌 + `HttpOnly` Cookie，**不用 JWT 放 localStorage**
 *   （XSS 可直接读走）。微信官方也明确要求 access_token 只保存在服务器。
 * - Cookie 用 `SameSite=Lax`：用 `Strict` 会破坏 OAuth 回跳（从外部站点跳回来时
 *   浏览器不会带上 Cookie，登录看起来像失败）。
 * - 渠道令牌**绝不返回客户端、绝不持久化**。
 * - 登录发起做滑动窗口限流。
 */

import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  allowAuthAttempt,
  cleanupExpired,
  consumeOAuthState,
  createOAuthState,
  createSession,
  deleteSession,
  getSessionUser,
  listIdentities,
  upsertIdentity,
} from '../db.ts';
import { activeProviders, describeProviders, getProvider } from '../auth/registry.ts';
import { AuthExchangeError } from '../auth/types.ts';

/** 会话 Cookie 名。 */
const SESSION_COOKIE = 'bk_session';

/**
 * 服务端自身的外部可访问地址。
 *
 * 用于构造 `redirect_uri`。**必须是服务端配置的常量**，不能从请求头推导。
 * 真实渠道联调时，这个值必须与开放平台后台登记的域名一致，且公网可达。
 */
function serverOrigin(): string {
  return process.env.SERVER_ORIGIN ?? 'http://127.0.0.1:8787';
}

/** 登录成功后要把用户送回的应用地址。 */
function appOrigin(): string {
  return process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
}

/**
 * 构造渠道回调地址。
 *
 * @param provider 渠道标识。
 * @returns 回调 URL。
 */
function callbackUrl(provider: string): string {
  return `${serverOrigin()}/api/auth/callback/${provider}`;
}

/**
 * 取出客户端 IP。
 *
 * 注意：只有在明确部署在可信反向代理之后才应信任 `X-Forwarded-For`，
 * 否则该头可被伪造从而绕过限流。这里默认不信任。
 *
 * @param context Hono 上下文。
 * @returns IP 字符串。
 */
function clientIp(context: { req: { header: (name: string) => string | undefined } }): string {
  return context.req.header('x-real-ip') ?? 'unknown';
}

export const authRoutes = new Hono();

/** 列出可用渠道及其状态（公开接口，不含任何密钥）。 */
authRoutes.get('/providers', (context) => context.json({ providers: describeProviders() }));

/** 当前登录用户。未登录返回 401。 */
authRoutes.get('/me', (context) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) {
    return context.json({ authenticated: false }, 401);
  }

  const user = getSessionUser(token);
  if (!user) {
    // 令牌失效时顺手清掉 Cookie，避免客户端反复用无效令牌。
    deleteCookie(context, SESSION_COOKIE, { path: '/' });
    return context.json({ authenticated: false }, 401);
  }

  return context.json({
    authenticated: true,
    user: {
      id: user.id,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    },
    identities: listIdentities(user.id),
  });
});

/** 发起登录：校验渠道 → 限流 → 建 state → 重定向到授权页。 */
authRoutes.get('/:provider/start', (context) => {
  const key = context.req.param('provider');
  const provider = getProvider(key);

  if (!provider) {
    return context.json(
      { error: 'unknown-provider', provider: key, available: activeProviders().map((p) => p.key) },
      404,
    );
  }

  if (!allowAuthAttempt(clientIp(context), key)) {
    return context.json({ error: 'rate-limited', message: '登录请求过于频繁，请稍后再试' }, 429);
  }

  if (!provider.isConfigured()) {
    // 未配置时明确报错，而不是静默跳到一个必然失败的页面。
    return context.json(
      {
        error: 'not-configured',
        provider: key,
        note: provider.note,
        hint: provider.configurationHint(),
      },
      501,
    );
  }

  const returnTo = context.req.query('return_to') ?? '/';
  const codeVerifier = provider.capabilities.supportsPkce ? 'unused' : null;
  const state = createOAuthState(key, returnTo, codeVerifier);
  const redirectUri = callbackUrl(key);

  let authorizeUrl: string;
  try {
    authorizeUrl = provider.buildAuthorizeUrl({ state, redirectUri });
  } catch (error) {
    return context.json(
      {
        error: 'authorize-url-failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  return context.redirect(authorizeUrl, 302);
});

/**
 * 演示渠道的授权页。
 *
 * 这是一个真实的授权页 —— 它接收 state、让用户做选择、再把授权码回传给
 * 回调地址，与第三方授权页的行为一致。刻意提供「不提供昵称」这个选项，
 * 用来暴露上层对可空资料处理的缺陷（支付宝个人账号就属于这种情况）。
 */
authRoutes.get('/mock/authorize', (context) => {
  if (!activeProviders().some((provider) => provider.key === 'mock')) {
    return context.json({ error: 'mock-disabled' }, 404);
  }

  const state = context.req.query('state') ?? '';
  const redirectUri = context.req.query('redirect_uri') ?? '';

  if (state === '' || redirectUri === '') {
    return context.html('<h1>缺少 state 或 redirect_uri</h1>', 400);
  }

  // 刻意做最简实现：不引模板引擎。这里的 HTML 不面向生产。
  const escape = (value: string): string =>
    value.replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
    );

  return context.html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>演示授权页</title>
<style>
  body{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f172a;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;max-width:380px;width:100%}
  h1{font-size:16px;margin:0 0 6px}
  p{font-size:12px;color:#94a3b8;line-height:1.6;margin:0 0 16px}
  label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #475569;
        background:#0f172a;color:#e2e8f0;font-size:14px;margin-bottom:12px}
  button{width:100%;padding:11px;border:0;border-radius:10px;background:#0284c7;color:#fff;
         font-size:14px;font-weight:500;cursor:pointer;margin-bottom:8px}
  button.ghost{background:transparent;border:1px solid #475569;color:#94a3b8}
  code{background:#0f172a;padding:1px 5px;border-radius:4px;font-size:11px}
</style></head><body>
<div class="card">
  <h1>演示授权页</h1>
  <p>这是本服务自己提供的<b>模拟第三方授权页</b>，用于在没有任何凭据的情况下验证完整登录链路。
     它会像真实渠道一样带回授权码，因此 state 校验、会话创建、身份绑定都会被真实执行。</p>
  <form method="get" action="${escape(redirectUri)}">
    <input type="hidden" name="state" value="${escape(state)}">
    <label>显示昵称（留空可模拟「渠道未提供资料」）</label>
    <input name="code" value="nick:" placeholder="nick:你的昵称">
    <button type="submit">同意授权并返回</button>
  </form>
  <form method="get" action="${escape(redirectUri)}">
    <input type="hidden" name="state" value="${escape(state)}">
    <input type="hidden" name="code" value="anon">
    <button class="ghost" type="submit">模拟「无昵称无头像」的账号</button>
  </form>
  <p style="margin-top:14px">回调地址：<code>${escape(redirectUri)}</code></p>
</div></body></html>`);
});

/** 渠道回调：校验 state → 换取身份 → upsert → 建会话 → 送回应用。 */
authRoutes.get('/callback/:provider', async (context) => {
  const key = context.req.param('provider');
  const provider = getProvider(key);

  if (!provider) {
    return context.json({ error: 'unknown-provider', provider: key }, 404);
  }

  const state = context.req.query('state') ?? '';
  const code = context.req.query('code') ?? '';

  // 微信用 `code`；支付宝用 `auth_code`。两者都接受。
  const authCode = code !== '' ? code : (context.req.query('auth_code') ?? '');

  // 微信在用户拒绝授权时**完全不跳转**，因此这里拿不到 error 参数。
  // 若浏览器真带回了 error（其他渠道可能），如实转达。
  const providerError = context.req.query('error');
  if (providerError !== undefined && authCode === '') {
    return context.json(
      { error: 'authorization-denied', provider: key, detail: providerError },
      400,
    );
  }

  if (state === '') {
    return context.json({ error: 'missing-state', message: '回调缺少 state 参数' }, 400);
  }

  // 单次消费：重复使用会被拒绝，这是 CSRF 防护的承重点。
  const stored = consumeOAuthState(state, key);
  if (!stored) {
    return context.json(
      {
        error: 'invalid-state',
        message: 'state 无效、已过期或已被使用过。请重新发起登录。',
      },
      400,
    );
  }

  if (authCode === '') {
    return context.json(
      { error: 'missing-code', message: '回调缺少授权码。若你在微信里点了「取消」，这是预期结果。' },
      400,
    );
  }

  let identity;
  try {
    identity = await provider.exchangeCode({
      code: authCode,
      redirectUri: callbackUrl(key),
      ...(stored.codeVerifier !== null ? { codeVerifier: stored.codeVerifier } : {}),
    });
  } catch (error) {
    if (error instanceof AuthExchangeError) {
      return context.json({ error: 'exchange-failed', message: error.message, detail: error.detail }, 502);
    }
    return context.json(
      {
        error: 'exchange-failed',
        message: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }

  const userId = upsertIdentity(identity);
  const token = createSession(userId);

  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    // Strict 会在从外部站点跳回时不带 Cookie，导致登录看起来失败。
    sameSite: 'Lax',
    // 生产必须开 Secure；本地 http 调试时关闭。
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });

  cleanupExpired();

  // 回到应用。只允许站内相对路径，避免被构造成开放重定向。
  const safeReturnTo = stored.returnTo.startsWith('/') && !stored.returnTo.startsWith('//')
    ? stored.returnTo
    : '/';

  return context.redirect(`${appOrigin()}${safeReturnTo}`, 302);
});

/** 注销。 */
authRoutes.post('/logout', (context) => {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) {
    deleteSession(token);
  }
  deleteCookie(context, SESSION_COOKIE, { path: '/' });
  return context.json({ ok: true });
});
