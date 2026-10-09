/**
 * 大模型辅助分类（客户端）。
 *
 * 定位：**规则引擎的补充，不是替代，也不是前置依赖**。
 * 内置的中文商户词典覆盖绝大多数日常消费且完全离线；这里只处理规则未命中的长尾商户。
 *
 * 三条硬约束：
 * 1. **不阻塞**：任何失败（后端未起、无 API key、超时、返回不合规）都静默降级，
 *    保留规则引擎给出的兜底分类，而不是让导入失败。
 * 2. **不自创分类**：只接受候选分类集合内的结果。模型返回集合外的分类一律丢弃 ——
 *    宁可不建议，也不能让模型造出的分类进账本。
 * 3. **有上限**：只对未命中规则的条目发起请求，且单批不超过服务端上限。
 */

import type { ParsedTransaction } from '../domain/types.ts';
import type { CategorizeResult } from './rules.ts';

/** 单批发送给大模型的条目上限，与服务端 `MAX_ITEMS` 保持一致。 */
const BATCH_SIZE = 60;

/** 大模型是否可用。 */
export async function isAiCategorizeAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/ai/status');
    if (!response.ok) return false;
    const body = (await response.json()) as { categorize?: boolean };
    return body.categorize === true;
  } catch {
    // 后端未运行属于正常情况（应用是本地优先的），静默降级。
    return false;
  }
}

/**
 * 对规则引擎未命中的条目请求大模型建议。
 *
 * @param transactions 全部交易（与 `initial` 等长且同序）。
 * @param initial 规则引擎给出的分类结果。
 * @param categories 允许的分类集合。
 * @returns 改进后的分类结果；失败时原样返回 `initial`。
 */
export async function refineWithAi(
  transactions: readonly ParsedTransaction[],
  initial: readonly CategorizeResult[],
  categories: readonly string[],
): Promise<{ results: CategorizeResult[]; askedCount: number; improvedCount: number }> {
  const results = [...initial];

  // 只处理「兜底」的支出条目 —— 转账不需要分类，收入类兜底也少。
  const targets: Array<{ index: number; text: string }> = [];
  transactions.forEach((tx, index) => {
    const decision = initial[index];
    if (decision === undefined || !decision.fallback) return;
    if (tx.direction !== 'expense') return;

    const text = tx.counterparty !== '' ? tx.counterparty : tx.description;
    if (text === '') return;

    targets.push({ index, text });
  });

  if (targets.length === 0 || categories.length === 0) {
    return { results, askedCount: 0, improvedCount: 0 };
  }

  let improvedCount = 0;

  // 分批请求，避免超出服务端上限与模型上下文。
  for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
    const batch = targets.slice(offset, offset + BATCH_SIZE);

    try {
      const response = await fetch('/api/ai/categorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: batch.map((target) => target.text),
          categories,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      // 任何非 2xx 都直接放弃这一批 —— 501 表示未配置，也是预期情况。
      if (!response.ok) break;

      const body = (await response.json()) as {
        results?: Array<{ index?: unknown; category?: unknown }>;
      };

      if (!Array.isArray(body.results)) break;

      const allowed = new Set(categories);

      for (const entry of body.results) {
        const localIndex = entry.index;
        const category = entry.category;

        if (typeof localIndex !== 'number' || !Number.isInteger(localIndex)) continue;
        if (typeof category !== 'string' || !allowed.has(category)) continue;

        const target = batch[localIndex];
        if (target === undefined) continue;

        // 模型可能给出与兜底相同的分类，那不算改进。
        const current = results[target.index];
        if (current === undefined || current.categoryName === category) continue;

        results[target.index] = {
          categoryName: category,
          fallback: false,
          matchedKeyword: '大模型建议',
        };
        improvedCount += 1;
      }
    } catch {
      // 超时或网络失败：保留规则引擎结果，继续处理下一批。
      break;
    }
  }

  return { results, askedCount: targets.length, improvedCount };
}
