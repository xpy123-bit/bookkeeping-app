/**
 * Hono 应用装配。
 *
 * 与 `index.ts` 分离是为了可测试性：测试可以直接 `app.request(...)` 走完整
 * 中间件与路由链路，**不需要监听真实端口**，因此能作为常规单元测试进 CI。
 */

import { Hono } from 'hono';
import { authRoutes } from './routes/auth.ts';
import { ocrRoutes } from './routes/ocr.ts';
import { aiRoutes } from './routes/ai.ts';
import { activeProviders, describeProviders } from './auth/registry.ts';

/** 装配好的应用。 */
export const app = new Hono();

/** 健康检查与运行时配置概览。不含任何密钥。 */
app.get('/api/health', (context) =>
  context.json({
    ok: true,
    service: 'bookkeeping-api',
    // 服务端不存账本数据，这一点值得在接口里明示。
    storesLedgerData: false,
    auth: {
      providers: describeProviders(),
      mockEnabled: activeProviders().some((provider) => provider.key === 'mock'),
    },
    ai: { categorize: Boolean(process.env.DEEPSEEK_API_KEY) },
    ocr: {
      baidu: Boolean(process.env.BAIDU_OCR_API_KEY && process.env.BAIDU_OCR_SECRET_KEY),
      umiOcrEndpoint: process.env.UMI_OCR_ENDPOINT ?? null,
    },
  }),
);

app.route('/api/auth', authRoutes);
app.route('/api/ocr', ocrRoutes);
app.route('/api/ai', aiRoutes);

app.notFound((context) => context.json({ error: 'not-found', path: context.req.path }, 404));
