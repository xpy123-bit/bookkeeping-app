/**
 * 后端服务。
 *
 * 存在的唯一理由是承载**两个客户端无法完成的事**：
 * 1. OAuth 换取令牌 —— client_secret 绝不能下发到浏览器。
 * 2. 可选的 OCR / 大模型代理 —— 云服务的 API key 同理。
 *
 * 除此之外，记账数据完全留在用户设备的 IndexedDB 里，不上传。
 * 因此这个服务**挂掉也不影响记账、导入和报表**，只影响登录与云 OCR。
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

/** 服务监听端口，与 vite.config.ts 的代理目标一致。 */
const PORT = Number(process.env.PORT ?? 8787);

/**
 * 各登录渠道的配置。
 *
 * 关于端点地址的坑（调研已核实）：
 * 网上流传的支付宝沙箱网关 `openapi.alipaydev.com` / `openauth.alipaydev.com`
 * **已经失效**（网关直接 502）。当前正确地址带 `-sandbox.dl` 段。
 * 连支付宝官方文档里的一段 Java 示例都仍在用旧地址，因此这里显式标注。
 */
const AUTH_PROVIDERS = {
  mock: {
    displayName: '本地演示登录',
    configured: true,
    note: '无需任何凭据，用于开发和预览。生产环境必须关闭。',
  },
  alipay: {
    displayName: '支付宝登录',
    configured: Boolean(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY),
    endpoints: {
      productionAuthorize: 'https://openauth.alipay.com/oauth2/publicAppAuthorize.htm',
      productionGateway: 'https://openapi.alipay.com/gateway.do',
      // 已核实为当前有效地址；旧地址 openauth.alipaydev.com 已失效。
      sandboxAuthorize: 'https://openauth-sandbox.dl.alipaydev.com/oauth2/publicAppAuthorize.htm',
      sandboxGateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    },
    note:
      '个人账号可申请，但「获取会员信息」需企业认证；因此个人拿不到昵称与头像，' +
      '只能拿到稳定的 user_id / open_id。沙箱环境无需商业资质即可联调。',
  },
  wechat: {
    displayName: '微信登录',
    configured: Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET),
    endpoints: {
      authorize: 'https://open.weixin.qq.com/connect/qrconnect',
      token: 'https://api.weixin.qq.com/sns/oauth2/access_token',
      userinfo: 'https://api.weixin.qq.com/sns/userinfo',
    },
    note:
      '「网站应用微信登录」要求企业或个体工商户主体、公章与 ICP 备案域名，' +
      '个人主体无法通过应用审核。未取得资质前只能保留占位。',
  },
} as const;

const app = new Hono();

/** 健康检查与运行时配置概览。 */
app.get('/api/health', (context) =>
  context.json({
    ok: true,
    service: 'bookkeeping-api',
    providers: Object.entries(AUTH_PROVIDERS).map(([key, value]) => ({
      key,
      displayName: value.displayName,
      configured: value.configured,
      note: value.note,
      ...('endpoints' in value ? { endpoints: value.endpoints } : {}),
    })),
    aiCategorize: Boolean(process.env.DEEPSEEK_API_KEY),
    ocr: Boolean(process.env.BAIDU_OCR_API_KEY && process.env.BAIDU_OCR_SECRET_KEY),
  }),
);

/**
 * 发起登录。
 *
 * 未配置凭据时返回 501 并给出可操作的说明，而不是静默跳转到一个必然失败的页面。
 */
app.get('/api/auth/:provider/start', (context) => {
  const provider = context.req.param('provider');
  const config = AUTH_PROVIDERS[provider as keyof typeof AUTH_PROVIDERS];

  if (!config) {
    return context.json({ error: 'unknown-provider', provider }, 404);
  }

  if (!config.configured) {
    return context.json(
      {
        error: 'not-configured',
        provider,
        note: config.note,
        hint: `请在 .env 中配置 ${provider.toUpperCase()} 的凭据后重启服务。参见 README 的「登录接入」一节。`,
      },
      501,
    );
  }

  // 真实实现应在此生成一次性 state 记录（服务端保存，不可放 sessionStorage，
  // 因为 PWA 在 iOS 上被系统回收后会丢失），然后重定向到授权地址。
  return context.json({
    error: 'not-implemented',
    provider,
    note: '凭据已配置，但授权流程尚未接入。请参见 README 的接入步骤。',
  }, 501);
});

/** 授权回调占位。 */
app.get('/api/auth/callback/:provider', (context) =>
  context.json({ error: 'not-implemented', provider: context.req.param('provider') }, 501),
);

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] 监听 http://127.0.0.1:${info.port}`);
  console.log('[api] 记账数据不经过本服务，仅登录与云端 OCR/大模型需要它');
});
