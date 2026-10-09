import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * `VITE_BASE` 让同一份代码既能在本地根路径运行，也能部署到
 * GitHub Pages 的子路径（https://<user>.github.io/<repo>/）。
 */
const base = process.env.VITE_BASE ?? '/';

/**
 * 内容安全策略。
 *
 * 只注入到生产构建：开发模式下 Vite 需要内联脚本做 HMR，严格策略会直接打断开发。
 *
 * 各条目的取舍：
 * - `script-src 'self'` —— 不允许内联脚本与 eval。记账是本地优先应用，
 *   账本在 IndexedDB 里，XSS 的后果是账本被读走或篡改，因此这条是核心。
 * - `style-src 'self' 'unsafe-inline'` —— Tailwind 输出的是外部样式表，
 *   但组件里用了 React 的 `style` 属性（进度条宽度），需要放行内联样式。
 * - `img-src` 需允许 `blob:` 与 `data:`：OCR 上传前会在 canvas 里压缩图片。
 * - `connect-src 'self'` —— 应用只与自身后端通信。这条同时是一道防线：
 *   任何被注入的脚本都无法把账本外传到第三方地址。
 * - `frame-ancestors 'none'` 与 `object-src 'none'` —— 禁止被嵌入与插件加载。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // 刻意不放 `frame-ancestors`：该指令在 meta 形式下会被浏览器忽略并产生
  // 控制台警告。它只能由响应头下发，需要托管方（如 Nginx / CDN）自行配置
  // `Content-Security-Policy: frame-ancestors 'none'`。
].join('; ');

/**
 * 往生产构建的 HTML 里注入 CSP。
 *
 * 用 meta 标签而不是响应头，是因为部署目标是 GitHub Pages —— 它不允许自定义
 * 响应头。
 *
 * @returns Vite 插件。
 */
function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'bookkeeping-inject-csp',
    apply: 'build',
    transformIndexHtml(html: string) {
      const tag = `    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;
      return html.replace('  </head>', `${tag}\n  </head>`);
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    contentSecurityPolicyPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: '记账本',
        short_name: '记账本',
        description: '本地优先的记账应用：账单导入、自动分类、预算预警',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        lang: 'zh-CN',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // 认证路由绝不能进缓存：被缓存的回调可能重放 code/state 组合。
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // 前端始终用同源 /api 调后端，避免 CORS 与 Cookie SameSite 问题。
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
    proxy: {
      // `preview` 不会继承 `server.proxy`，必须单独声明，
      // 否则本地验证生产构建时所有 /api 请求都会打到静态服务器而失败。
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
