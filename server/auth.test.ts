/**
 * 登录链路的集成测试。
 *
 * 用 `app.request()` 直接走 Hono 的完整路由与中间件，**不监听真实端口**，
 * 因此可以作为常规测试进 CI。覆盖的是真实协议路径，而不是桩函数。
 *
 * 重点验证的是安全属性，而不是「能不能登录」：
 * state 单次使用、伪造 state 被拒、Cookie 属性、未配置渠道的失败方式、
 * 以及「无昵称账号」这一真实情况不会被当成错误。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

/** 测试用数据库路径。 */
const TEST_DB = `data/test-auth-${process.pid}.sqlite`;

/** 装配好的应用。 */
let app: { request: (input: string, init?: RequestInit) => Promise<Response> };

beforeAll(async () => {
  // 必须在导入 app 之前设置：数据库路径在模块加载时就被读取。
  process.env.DB_PATH = TEST_DB;
  process.env.ENABLE_MOCK_LOGIN = 'true';
  process.env.NODE_ENV = 'development';
  process.env.SERVER_ORIGIN = 'http://127.0.0.1:8787';
  process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  // 确保支付宝/微信渠道处于「未配置」状态，用它们验证失败路径。
  delete process.env.ALIPAY_APP_ID;
  delete process.env.ALIPAY_PRIVATE_KEY;
  delete process.env.WECHAT_APP_ID;
  delete process.env.WECHAT_APP_SECRET;

  const module = await import('./app.ts');
  app = module.app as unknown as typeof app;
});

afterAll(async () => {
  // Windows 不允许删除仍被打开的文件，必须先关闭连接，否则得到 EPERM。
  // 这个失败在 Linux CI 上不会出现，因此这里显式关闭。
  const { closeDb } = await import('./db.ts');
  closeDb();

  // WAL 模式会额外产生 -wal 与 -shm 文件，一并清理。
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${TEST_DB}${suffix}`, { force: true });
  }
});

/**
 * 从响应里取出会话 Cookie 的键值对。
 *
 * @param response 响应对象。
 * @returns `Cookie` 请求头内容，无 Cookie 时返回空串。
 */
function sessionCookie(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  const match = /bk_session=([^;]+)/.exec(raw);
  return match ? `bk_session=${match[1] as string}` : '';
}

/**
 * 从 302 响应的 Location 里取出 state。
 *
 * @param location Location 头。
 * @returns state 字符串。
 */
function extractState(location: string): string {
  const url = new URL(location);
  return url.searchParams.get('state') ?? '';
}

describe('健康检查', () => {
  it('声明服务端不存账本数据，并列出渠道配置状态', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      storesLedgerData: boolean;
      auth: { mockEnabled: boolean; providers: Array<{ key: string; configured: boolean }> };
    };

    expect(body.storesLedgerData).toBe(false);
    expect(body.auth.mockEnabled).toBe(true);

    const keys = body.auth.providers.map((provider) => provider.key);
    expect(keys).toContain('mock');
    expect(keys).toContain('alipay');
    expect(keys).toContain('wechat');

    // 真实渠道未配置，必须如实反映。
    const alipay = body.auth.providers.find((provider) => provider.key === 'alipay');
    expect(alipay?.configured).toBe(false);
  });

  it('不下发任何密钥的值（但如实反映是否已配置）', async () => {
    // 注入可识别的哨兵值，断言它绝不出现在响应里。
    // 只检查「响应里没有 secret 这个词」是没用的 —— 提示文案本来就要提环境变量名。
    const marker = 'zz-SENTINEL-DO-NOT-LEAK-zz';
    process.env.ALIPAY_APP_ID = 'sentinel-app-id';
    process.env.ALIPAY_PRIVATE_KEY = marker;
    process.env.WECHAT_APP_ID = 'sentinel-wechat-id';
    process.env.WECHAT_APP_SECRET = marker;

    try {
      const response = await app.request('/api/health');
      const text = await response.text();

      expect(text).not.toContain(marker);
      expect(text).not.toContain('sentinel-app-id');
      expect(text).not.toContain('sentinel-wechat-id');

      // 同时确认确实读到了配置 —— 否则上面的断言可能只是因为环境变量没生效。
      const body = JSON.parse(text) as {
        auth: { providers: Array<{ key: string; configured: boolean }> };
      };
      expect(body.auth.providers.find((p) => p.key === 'wechat')?.configured).toBe(true);
      expect(body.auth.providers.find((p) => p.key === 'alipay')?.configured).toBe(true);
    } finally {
      delete process.env.ALIPAY_APP_ID;
      delete process.env.ALIPAY_PRIVATE_KEY;
      delete process.env.WECHAT_APP_ID;
      delete process.env.WECHAT_APP_SECRET;
    }
  });
});

describe('未登录状态', () => {
  it('/api/auth/me 返回 401', async () => {
    const response = await app.request('/api/auth/me');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
  });
});

describe('发起登录', () => {
  it('重定向到授权页并携带 state', async () => {
    const response = await app.request('/api/auth/mock/start', { redirect: 'manual' });

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/api/auth/mock/authorize');

    const state = extractState(location);
    expect(state.length).toBeGreaterThan(20);
  });

  it('未配置的渠道返回 501 并给出补救说明，而不是静默跳转', async () => {
    const response = await app.request('/api/auth/alipay/start', { redirect: 'manual' });
    expect(response.status).toBe(501);

    const body = (await response.json()) as { error: string; hint: string; note: string };
    expect(body.error).toBe('not-configured');
    expect(body.hint).toContain('ALIPAY_APP_ID');
    // 必须如实告知个人主体的限制，否则用户会白花时间。
    expect(body.note).toContain('企业认证');
  });

  it('未知渠道返回 404 而不泄露可用渠道以外的信息', async () => {
    const response = await app.request('/api/auth/nonexistent/start', { redirect: 'manual' });
    expect(response.status).toBe(404);
  });

  it('微信渠道未配置时同样返回 501，并说明资质要求', async () => {
    const response = await app.request('/api/auth/wechat/start', { redirect: 'manual' });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { note: string };
    expect(body.note).toContain('个人主体无法通过应用审核');
  });
});

describe('演示授权页', () => {
  it('可以渲染，且包含两个真实场景的入口', async () => {
    const start = await app.request('/api/auth/mock/start', { redirect: 'manual' });
    const state = extractState(start.headers.get('location') ?? '');

    const response = await app.request(
      `/api/auth/mock/authorize?state=${state}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8787/api/auth/callback/mock')}`,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('模拟第三方授权页');
    // 「无昵称无头像」入口是刻意提供的，用来暴露上层对可空资料的处理缺陷。
    expect(html).toContain('无昵称无头像');
  });

  it('缺少 state 时拒绝', async () => {
    const response = await app.request('/api/auth/mock/authorize');
    expect(response.status).toBe(400);
  });
});

describe('回调换取身份', () => {
  /** 完整走一遍授权，返回回调响应。 */
  async function completeLogin(code: string): Promise<Response> {
    const start = await app.request('/api/auth/mock/start', { redirect: 'manual' });
    const state = extractState(start.headers.get('location') ?? '');
    return app.request(
      `/api/auth/callback/mock?state=${state}&code=${encodeURIComponent(code)}`,
      { redirect: 'manual' },
    );
  }

  it('建立会话并跳回应用', async () => {
    const response = await completeLogin('nick:小鹏');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:5173/');

    const cookie = sessionCookie(response);
    expect(cookie).not.toBe('');

    // 会话 Cookie 必须不可被脚本读取。
    const raw = response.headers.get('set-cookie') ?? '';
    expect(raw).toContain('HttpOnly');
    // SameSite=Strict 会破坏 OAuth 回跳，必须是 Lax。
    expect(raw).toContain('SameSite=Lax');
  });

  it('会话可用，并能取回昵称与已绑定渠道', async () => {
    const login = await completeLogin('nick:小鹏');
    const cookie = sessionCookie(login);

    const response = await app.request('/api/auth/me', { headers: { cookie } });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      authenticated: boolean;
      user: { displayName: string | null };
      identities: Array<{ provider: string; subjectStandard: string }>;
    };

    expect(body.authenticated).toBe(true);
    expect(body.user.displayName).toBe('小鹏');
    expect(body.identities[0]?.provider).toBe('mock');
  });

  it('无昵称的账号也能正常登录（支付宝个人账号就是这种情况）', async () => {
    // 这是关键回归点：若上层假设昵称非空，支付宝用户首次登录就会崩。
    const login = await completeLogin('anon');
    expect(login.status).toBe(302);

    const cookie = sessionCookie(login);
    const response = await app.request('/api/auth/me', { headers: { cookie } });
    const body = (await response.json()) as { authenticated: boolean; user: { displayName: string | null } };

    expect(body.authenticated).toBe(true);
    expect(body.user.displayName).toBeNull();
  });

  it('同一渠道的同一身份重复登录不会建出第二个用户', async () => {
    const first = await completeLogin('nick:重复用户');
    const second = await completeLogin('nick:重复用户');

    const cookieA = sessionCookie(first);
    const cookieB = sessionCookie(second);

    const meA = (await (await app.request('/api/auth/me', { headers: { cookie: cookieA } })).json()) as {
      user: { id: number };
    };
    const meB = (await (await app.request('/api/auth/me', { headers: { cookie: cookieB } })).json()) as {
      user: { id: number };
    };

    // UNIQUE(provider, subject) 是承重约束，两次登录必须落到同一个用户。
    expect(meA.user.id).toBe(meB.user.id);
  });
});

describe('安全属性', () => {
  it('state 只能使用一次（重放被拒绝）', async () => {
    const start = await app.request('/api/auth/mock/start', { redirect: 'manual' });
    const state = extractState(start.headers.get('location') ?? '');
    const url = `/api/auth/callback/mock?state=${state}&code=anon`;

    const first = await app.request(url, { redirect: 'manual' });
    expect(first.status).toBe(302);

    // 重放同一个 state 必须失败，否则 CSRF 防护形同虚设。
    const replay = await app.request(url, { redirect: 'manual' });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid-state');
  });

  it('伪造的 state 被拒绝', async () => {
    const response = await app.request(
      '/api/auth/callback/mock?state=deadbeefdeadbeefdeadbeef&code=anon',
      { redirect: 'manual' },
    );
    expect(response.status).toBe(400);
  });

  it('缺少 state 被拒绝', async () => {
    const response = await app.request('/api/auth/callback/mock?code=anon', { redirect: 'manual' });
    expect(response.status).toBe(400);
  });

  it('回跳地址被限制为站内相对路径，防止开放重定向', async () => {
    // 用外部地址作为 return_to 发起登录。
    const start = await app.request(
      `/api/auth/mock/start?return_to=${encodeURIComponent('https://evil.example.com/steal')}`,
      { redirect: 'manual' },
    );
    const state = extractState(start.headers.get('location') ?? '');

    const response = await app.request(
      `/api/auth/callback/mock?state=${state}&code=anon`,
      { redirect: 'manual' },
    );

    const location = response.headers.get('location') ?? '';
    expect(location.startsWith('http://127.0.0.1:5173/')).toBe(true);
    expect(location).not.toContain('evil.example.com');
  });

  it('伪造的会话令牌不被接受', async () => {
    const response = await app.request('/api/auth/me', {
      headers: { cookie: 'bk_session=forged-token-value' },
    });
    expect(response.status).toBe(401);
  });
});

describe('注销', () => {
  it('注销后会话立即失效', async () => {
    const start = await app.request('/api/auth/mock/start', { redirect: 'manual' });
    const state = extractState(start.headers.get('location') ?? '');
    const login = await app.request(`/api/auth/callback/mock?state=${state}&code=anon`, {
      redirect: 'manual',
    });
    const cookie = sessionCookie(login);

    expect((await app.request('/api/auth/me', { headers: { cookie } })).status).toBe(200);

    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });

    expect((await app.request('/api/auth/me', { headers: { cookie } })).status).toBe(401);
  });
});

describe('可选能力的失败方式', () => {
  it('未配置大模型时明确返回 501，并说明规则引擎仍然可用', async () => {
    const response = await app.request('/api/ai/categorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: ['某商户'], categories: ['餐饮'] }),
    });

    expect(response.status).toBe(501);
    const body = (await response.json()) as { message: string };
    // 必须让调用方知道「这不是致命问题，可以降级」。
    expect(body.message).toContain('规则引擎');
  });

  it('OCR 状态接口即使没有任何渠道也返回 200 并给出说明', async () => {
    const response = await app.request('/api/ocr/status');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { providers: unknown[]; note: string };
    expect(Array.isArray(body.providers)).toBe(true);
    // 数电发票不需要 OCR，这一点必须显式告诉客户端。
    expect(body.note).toContain('XML');
  });

  it('OCR 缺少图片字段时返回 400 而不是 500', async () => {
    const form = new FormData();
    const response = await app.request('/api/ocr', { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('missing-image');
  });
});
