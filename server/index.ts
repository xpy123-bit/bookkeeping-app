/**
 * 后端进程入口。
 *
 * 只做两件事：装配应用、监听端口。业务逻辑都在 `app.ts` 与 `routes/` 里，
 * 这样测试可以绕过端口直接走 `app.request()`。
 */

import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { activeProviders } from './auth/registry.ts';
import { cleanupExpired } from './db.ts';

/** 服务监听端口，与 vite.config.ts 的代理目标一致。 */
const PORT = Number(process.env.PORT ?? 8787);

// 每小时清理过期的 state 与会话。unref 让定时器不阻止进程退出。
setInterval(cleanupExpired, 60 * 60 * 1000).unref();

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[api] 监听 http://127.0.0.1:${info.port}`);
  console.log('[api] 账本数据不经过本服务；这里只处理登录与可选的云端 OCR / 大模型');

  const providers = activeProviders();
  console.log(
    `[api] 登录渠道：${providers
      .map((provider) => `${provider.displayName}${provider.isConfigured() ? '' : '(未配置)'}`)
      .join('、')}`,
  );

  if (!providers.some((provider) => provider.isConfigured())) {
    console.log(
      '[api] 提示：当前没有任何已配置的登录渠道，应用会以本地模式运行（无需登录）。' +
        '想体验完整登录流程可设置 ENABLE_MOCK_LOGIN=true 后重启。',
    );
  }
});
