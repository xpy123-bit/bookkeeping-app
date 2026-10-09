/**
 * OCR 渠道。
 *
 * 两条路线，按可用性自动选择：
 * - **百度云**：个人实名认证即享通用文字识别（高精度版）**1000 次/月长期发放**，
 *   是个人项目最现实的云端选择。图片要求 base64 后 ≤4MB、最长边 ≤4096px、最短边 ≥15px。
 * - **Umi-OCR**：本地运行（MIT，解压即用），`POST http://127.0.0.1:1224/api/ocr`。
 *   完全离线，票据不出本机 —— 记账应用里的发票含姓名、税号、金额，本地识别在
 *   隐私上是明显更优的选择。
 *
 * 注意：**数电发票不需要 OCR**。电子税务局提供的 XML 是发票原件，
 * 含号码/日期/购销方/金额/税额，直接解析即可。OCR 只用于纸质票照片、
 * 扫描件和支付截图。这条判断能消掉大部分脏数据问题。
 */

/** OCR 识别结果。 */
export interface OcrResult {
  /** 识别出的纯文本，按行拼接。 */
  text: string;
  /** 实际使用的渠道。 */
  provider: string;
  /** 平均置信度，渠道不提供时为 `null`。 */
  confidence: number | null;
}

/** OCR 失败。 */
export class OcrError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'OcrError';
    this.detail = detail;
  }
}

// ────────────────────────────────────────────────
// 百度云 OCR
// ────────────────────────────────────────────────

/** access_token 缓存。百度令牌有效期 30 天，每次请求都换取会浪费配额。 */
let baiduToken: { value: string; expiresAt: number } | null = null;

/** 百度 OCR 是否已配置。 */
export function isBaiduConfigured(): boolean {
  return Boolean(process.env.BAIDU_OCR_API_KEY && process.env.BAIDU_OCR_SECRET_KEY);
}

/**
 * 获取百度 access_token，命中缓存则直接返回。
 *
 * @returns 令牌字符串。
 * @throws {OcrError} 换取失败时。
 */
async function getBaiduToken(): Promise<string> {
  const now = Date.now();
  if (baiduToken && baiduToken.expiresAt > now + 60_000) {
    return baiduToken.value;
  }

  const apiKey = process.env.BAIDU_OCR_API_KEY;
  const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new OcrError('百度 OCR 未配置');
  }

  const url = new URL('https://aip.baidubce.com/oauth/2.0/token');
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', apiKey);
  url.searchParams.set('client_secret', secretKey);

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new OcrError('连接百度 OCR 失败', error instanceof Error ? error.message : String(error));
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const token = payload.access_token;

  if (typeof token !== 'string' || token === '') {
    throw new OcrError('百度未返回 access_token', JSON.stringify(payload).slice(0, 300));
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 2_592_000;
  baiduToken = { value: token, expiresAt: now + expiresIn * 1000 };

  return token;
}

/**
 * 用百度识别图片。
 *
 * @param image 图片字节。
 * @returns 识别结果。
 * @throws {OcrError} 识别失败时。
 */
export async function recognizeWithBaidu(image: Uint8Array): Promise<OcrResult> {
  // 百度要求 base64 后 ≤4MB。base64 会让体积膨胀约 1/3，因此这里按原始大小预检。
  if (image.byteLength > 3_000_000) {
    throw new OcrError(
      '图片过大，百度 OCR 要求 base64 后不超过 4MB',
      `当前原始大小 ${(image.byteLength / 1024 / 1024).toFixed(1)}MB。请在客户端先压缩到长边 2048px 以内。`,
    );
  }

  const token = await getBaiduToken();
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${encodeURIComponent(token)}`;

  const body = new URLSearchParams();
  // 百度的 image 字段是 urlencode 过的 base64。
  body.set('image', Buffer.from(image).toString('base64'));

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OcrError('调用百度 OCR 失败', error instanceof Error ? error.message : String(error));
  }

  const payload = (await response.json()) as Record<string, unknown>;

  if (payload.error_code) {
    throw new OcrError(
      `百度 OCR 报错 ${String(payload.error_code)}`,
      typeof payload.error_msg === 'string' ? payload.error_msg : '',
    );
  }

  const words = payload.words_result;
  if (!Array.isArray(words)) {
    throw new OcrError('百度 OCR 返回缺少 words_result', JSON.stringify(payload).slice(0, 300));
  }

  const lines = words
    .map((item) => (item as { words?: unknown }).words)
    .filter((value): value is string => typeof value === 'string');

  return { text: lines.join('\n'), provider: 'baidu', confidence: null };
}

// ────────────────────────────────────────────────
// 本地 Umi-OCR
// ────────────────────────────────────────────────

/** Umi-OCR 的地址。 */
export function umiEndpoint(): string {
  return process.env.UMI_OCR_ENDPOINT ?? 'http://127.0.0.1:1224/api/ocr';
}

/**
 * 探测本地 Umi-OCR 是否在运行。
 *
 * @returns 可达时为 `true`。
 */
export async function isUmiAvailable(): Promise<boolean> {
  try {
    const response = await fetch(umiEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 空图片会被 Umi-OCR 拒绝，但只要服务在跑就会有 HTTP 响应，
      // 这足以判断可达性，且不会消耗识别资源。
      body: JSON.stringify({ base64: '' }),
      signal: AbortSignal.timeout(1_500),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * 用本地 Umi-OCR 识别图片。
 *
 * @param image 图片字节。
 * @returns 识别结果。
 * @throws {OcrError} 识别失败时。
 */
export async function recognizeWithUmi(image: Uint8Array): Promise<OcrResult> {
  const body = {
    // Umi-OCR 要的是不含 `data:` 前缀的裸 base64。
    base64: Buffer.from(image).toString('base64'),
    options: { 'data.format': 'text' },
  };

  let response: Response;
  try {
    response = await fetch(umiEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new OcrError(
      '连接本地 Umi-OCR 失败',
      `请确认 Umi-OCR 已启动并开启了 HTTP 服务（${umiEndpoint()}）。` +
        (error instanceof Error ? ` 原始错误：${error.message}` : ''),
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;

  if (payload.code !== undefined && payload.code !== 100 && payload.code !== 200) {
    throw new OcrError(`Umi-OCR 返回错误码 ${String(payload.code)}`, JSON.stringify(payload).slice(0, 300));
  }

  // data 可能是字符串，也可能是含 text/score/box 的行数组。
  const data = payload.data;
  let text = '';

  if (typeof data === 'string') {
    text = data;
  } else if (Array.isArray(data)) {
    text = data
      .map((line) => (line as { text?: unknown }).text)
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }

  return { text, provider: 'umi-ocr', confidence: null };
}

/**
 * 按可用性自动选择渠道识别。
 *
 * 顺序：本地 Umi-OCR 优先（离线、隐私更好、不消耗云配额），
 * 其次百度云，都没有时明确报错并提示如何启用。
 *
 * @param image 图片字节。
 * @param preferred 强制指定的渠道；省略则自动选择。
 * @returns 识别结果。
 * @throws {OcrError} 无可用渠道或识别失败时。
 */
export async function recognize(
  image: Uint8Array,
  preferred?: string,
): Promise<OcrResult> {
  if (preferred === 'baidu') {
    if (!isBaiduConfigured()) throw new OcrError('百度 OCR 未配置', '请设置 BAIDU_OCR_API_KEY 与 BAIDU_OCR_SECRET_KEY。');
    return recognizeWithBaidu(image);
  }

  if (preferred === 'umi-ocr') {
    return recognizeWithUmi(image);
  }

  if (await isUmiAvailable()) {
    return recognizeWithUmi(image);
  }

  if (isBaiduConfigured()) {
    return recognizeWithBaidu(image);
  }

  throw new OcrError(
    '没有可用的 OCR 渠道',
    '两种启用方式：① 本地运行 Umi-OCR 并开启 HTTP 服务（免费、离线、票据不出本机）；' +
      '② 在 .env 配置百度 OCR 的 BAIDU_OCR_API_KEY 与 BAIDU_OCR_SECRET_KEY' +
      '（个人认证 1000 次/月免费）。另外请注意：数电发票应直接解析 XML，不需要 OCR。',
  );
}
