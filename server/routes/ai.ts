/**
 * 大模型辅助分类路由。
 *
 * 定位：**可选增强，不是前置依赖**。客户端内置的规则引擎（中文商户词典）
 * 完全离线可用，没有 API key 也能自动分类。这里只处理规则未命中的长尾商户。
 *
 * 因此接口设计成「批量、可失败、可降级」：调用方传一批未分类的商户名，
 * 拿回建议分类；任何失败都应被调用方吞掉并回落到「其他支出」，而不是阻塞导入。
 */

import { Hono } from 'hono';

export const aiRoutes = new Hono();

/** 请求体上限，避免被塞入超大数组拖垮延迟与成本。 */
const MAX_ITEMS = 60;

/** 大模型是否已配置。 */
function isConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

aiRoutes.get('/status', (context) =>
  context.json({
    categorize: isConfigured(),
    note:
      '大模型分类是可选的。客户端内置的中文商户词典规则引擎完全离线可用，' +
      '没有 API key 也能自动分类；这里只用于规则未命中的长尾商户。',
  }),
);

/**
 * 批量建议分类。
 *
 * 请求体：`{ items: string[], categories: string[] }`
 * 响应：`{ results: Array<{ index, category, reason }> }`
 */
aiRoutes.post('/categorize', async (context) => {
  if (!isConfigured()) {
    return context.json(
      {
        error: 'not-configured',
        message: '未配置 DEEPSEEK_API_KEY。规则引擎仍可离线工作，无需此项。',
      },
      501,
    );
  }

  let body: { items?: unknown; categories?: unknown };
  try {
    body = (await context.req.json()) as typeof body;
  } catch {
    return context.json({ error: 'invalid-json' }, 400);
  }

  const items = Array.isArray(body.items)
    ? body.items.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  const categories = Array.isArray(body.categories)
    ? body.categories.filter((item): item is string => typeof item === 'string')
    : [];

  if (items.length === 0) {
    return context.json({ error: 'empty-items', message: 'items 不能为空' }, 400);
  }
  if (categories.length === 0) {
    return context.json({ error: 'empty-categories', message: 'categories 不能为空' }, 400);
  }
  if (items.length > MAX_ITEMS) {
    return context.json(
      { error: 'too-many-items', message: `单次最多 ${MAX_ITEMS} 条，请分批调用`, count: items.length },
      400,
    );
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';

  // 提示词刻意要求「只输出 JSON 数组」，并在下面做严格解析。
  // 分类结果直接决定账目归属，静默接受自由文本会导致错分类无声入库。
  const systemPrompt =
    '你是一个中文消费记账分类助手。给定商户名或商品说明，从候选分类中选出最合适的一个。' +
    '只输出 JSON 数组，不要任何解释文字、不要 Markdown 代码块。' +
    '数组每个元素形如 {"index": 数字, "category": "分类名"}。' +
    '必须为每个 index 都给出结果；无法判断时选最后一项（通常是「其他支出」）。';

  const userPrompt =
    `候选分类（必须从中选择，不得自创）：${JSON.stringify(categories)}\n\n` +
    `待分类条目：\n${items.map((item, index) => `${index}. ${item}`).join('\n')}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        // 要求 JSON 输出，减少解析失败。
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    return context.json(
      { error: 'upstream-unreachable', message: error instanceof Error ? error.message : String(error) },
      502,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    return context.json(
      { error: 'upstream-error', status: response.status, detail: text.slice(0, 300) },
      502,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? '';

  const parsed = parseSuggestions(content, items.length, categories);

  if (parsed === null) {
    return context.json(
      {
        error: 'unparseable-response',
        message: '大模型返回的内容无法解析为分类结果，已放弃本次建议（不影响账本）',
        detail: content.slice(0, 300),
      },
      502,
    );
  }

  return context.json({ results: parsed });
});

/**
 * 解析大模型返回的分类建议。
 *
 * 校验严格：必须是数组、index 在范围内、category 属于候选集合。
 * 任何不合规的条目直接丢弃 —— 宁可不建议，也不能让模型自创的分类入库。
 *
 * @param content 模型返回的原始文本。
 * @param itemCount 待分类条目数。
 * @param categories 允许的分类集合。
 * @returns 建议列表，完全无法解析时返回 `null`。
 */
function parseSuggestions(
  content: string,
  itemCount: number,
  categories: readonly string[],
): Array<{ index: number; category: string }> | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  // 模型可能包一层对象（因为用了 json_object 格式），兼容 `{ results: [...] }`。
  const array = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown }).results)
      ? ((parsed as { results: unknown[] }).results)
      : null;

  if (!array) return null;

  const allowed = new Set(categories);
  const results: Array<{ index: number; category: string }> = [];

  for (const entry of array) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { index, category } = entry as { index?: unknown; category?: unknown };

    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= itemCount) continue;
    if (typeof category !== 'string' || !allowed.has(category)) continue;

    results.push({ index, category });
  }

  return results.length > 0 ? results : null;
}
