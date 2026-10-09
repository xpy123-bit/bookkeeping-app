/**
 * OCR 路由。
 *
 * 服务端只做「图片 → 文本」。**字段抽取（金额/日期/商户）放在客户端** ——
 * 那里有完整的上下文（用户在核对页面可以即时修正），而且抽取规则改动
 * 不需要重新部署后端。
 */

import { Hono } from 'hono';
import { OcrError, isBaiduConfigured, isUmiAvailable, recognize, umiEndpoint } from '../ocr/index.ts';

export const ocrRoutes = new Hono();

/** 查询可用渠道。 */
ocrRoutes.get('/status', async (context) => {
  const umi = await isUmiAvailable();
  return context.json({
    providers: [
      { key: 'umi-ocr', displayName: '本地 Umi-OCR', available: umi, endpoint: umiEndpoint(), offline: true },
      { key: 'baidu', displayName: '百度 OCR', available: isBaiduConfigured(), offline: false },
    ],
    // 明确告知客户端：数电发票不要走 OCR。
    note:
      '数电发票（全电发票）应直接解析电子税务局导出的 XML，那是发票原件，' +
      '含号码/日期/购销方/金额/税额，无需 OCR。OCR 只用于纸质票照片与支付截图。',
  });
});

/** 识别一张图片。 */
ocrRoutes.post('/', async (context) => {
  let form: Record<string, unknown>;
  try {
    form = (await context.req.parseBody()) as Record<string, unknown>;
  } catch {
    return context.json({ error: 'invalid-form', message: '请以 multipart/form-data 上传图片' }, 400);
  }

  const file = form.image;
  if (!(file instanceof File)) {
    return context.json(
      { error: 'missing-image', message: '缺少 image 字段。请以 multipart/form-data 上传，字段名为 image。' },
      400,
    );
  }

  if (file.size > 8 * 1024 * 1024) {
    return context.json(
      {
        error: 'image-too-large',
        message: `图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 过大。请在客户端压缩到长边 2048px 以内再上传。`,
      },
      413,
    );
  }

  const preferred = typeof form.provider === 'string' ? form.provider : undefined;
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const result = await recognize(bytes, preferred);
    return context.json({
      text: result.text,
      provider: result.provider,
      confidence: result.confidence,
      // 明确提醒：OCR 结果只是建议值，金额必须由用户确认。
      requiresUserConfirmation: true,
    });
  } catch (error) {
    if (error instanceof OcrError) {
      return context.json({ error: 'ocr-failed', message: error.message, detail: error.detail }, 502);
    }
    return context.json(
      { error: 'ocr-failed', message: error instanceof Error ? error.message : String(error) },
      502,
    );
  }
});
