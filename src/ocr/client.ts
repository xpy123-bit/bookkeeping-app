/**
 * 客户端 OCR 调用。
 *
 * 上传前**先在浏览器里降采样**，原因有三个：
 * 1. 云端 OCR 有硬限制（百度要求 base64 后 ≤4MB、最长边 ≤4096px）。
 * 2. 手机原图数 MB，直接上传既慢又费流量。
 * 3. 降采样到合理尺寸后识别精度反而更好（噪点减少）。
 *
 * 顺带处理 EXIF 方向：手机竖拍的照片带 Orientation 标记，直接解码会横躺，
 * 而 OCR 对倒转文本的识别率会急剧下降。
 */

import type { ExtractedFields } from './extract.ts';
import { extractFields } from './extract.ts';

/** 压缩后图片的最长边。 */
const MAX_EDGE = 2048;

/** JPEG 质量。 */
const JPEG_QUALITY = 0.85;

/** OCR 调用结果。 */
export interface OcrOutcome {
  text: string;
  provider: string;
  fields: ExtractedFields;
}

/** OCR 调用失败。 */
export class OcrClientError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'OcrClientError';
    this.detail = detail;
  }
}

/**
 * 把图片压缩到适合上传的尺寸。
 *
 * 优先用 `createImageBitmap` 并声明 `imageOrientation: 'from-image'`，
 * 让浏览器直接按 EXIF 摆正；不支持时回落到 `<img>` 的默认解码行为。
 *
 * @param file 用户选择的图片。
 * @returns 压缩后的 JPEG Blob。
 */
export async function compressImage(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    // 非浏览器环境（例如测试）直接原样返回。
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return file;
  }

  // 白底：PNG 透明区域在转 JPEG 后会变黑，影响 OCR。
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', JPEG_QUALITY);
  });

  return blob ?? file;
}

/**
 * 调用服务端 OCR。
 *
 * @param file 图片文件。
 * @param provider 指定渠道；省略则由服务端按可用性自动选择。
 * @returns 识别文本与抽取出的字段。
 * @throws {OcrClientError} 服务端不可用或识别失败时。
 */
export async function recognizeImage(file: File, provider?: string): Promise<OcrOutcome> {
  const blob = await compressImage(file);

  const form = new FormData();
  form.append('image', blob, 'upload.jpg');
  if (provider !== undefined) {
    form.append('provider', provider);
  }

  let response: Response;
  try {
    response = await fetch('/api/ocr', { method: 'POST', body: form });
  } catch (error) {
    throw new OcrClientError(
      '无法连接 OCR 服务',
      '请确认后端已启动（pnpm dev 会同时启动前后端）。' +
        (error instanceof Error ? ` 原始错误：${error.message}` : ''),
    );
  }

  if (!response.ok) {
    let message = `OCR 服务返回 ${response.status}`;
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string; detail?: string };
      message = body.message ?? message;
      detail = body.detail ?? '';
    } catch {
      // 响应不是 JSON 时保留默认信息。
    }
    throw new OcrClientError(message, detail);
  }

  const body = (await response.json()) as { text?: string; provider?: string };
  const text = body.text ?? '';

  return {
    text,
    provider: body.provider ?? 'unknown',
    fields: extractFields(text),
  };
}

/**
 * 查询可用的 OCR 渠道。
 *
 * @returns 渠道列表；后端不可用时返回空列表而不是抛错
 *   —— OCR 是可选能力，不应让它阻塞整个界面。
 */
export async function fetchOcrProviders(): Promise<
  Array<{ key: string; displayName: string; available: boolean; offline: boolean }>
> {
  try {
    const response = await fetch('/api/ocr/status');
    if (!response.ok) return [];
    const body = (await response.json()) as {
      providers?: Array<{ key: string; displayName: string; available: boolean; offline: boolean }>;
    };
    return body.providers ?? [];
  } catch {
    return [];
  }
}
