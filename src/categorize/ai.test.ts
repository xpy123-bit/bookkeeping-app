import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAiCategorizeAvailable, refineWithAi } from './ai.ts';
import type { ParsedTransaction } from '../domain/types.ts';
import type { CategorizeResult } from './rules.ts';

/**
 * 造一笔交易。
 *
 * @param overrides 需要覆盖的字段。
 * @returns 交易对象。
 */
function makeTx(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    occurredAt: '2024-06-07 13:20:16',
    direction: 'expense',
    amountCents: 1000,
    counterparty: '某商户',
    description: '',
    rawCategory: '',
    method: '零钱',
    status: '支付成功',
    orderId: '',
    merchantOrderId: '',
    remark: '',
    source: 'wechat',
    rawRow: [],
    ...overrides,
  };
}

/** 造一个规则引擎的兜底结果。 */
function fallback(): CategorizeResult {
  return { categoryName: '其他支出', fallback: true };
}

/** 造一个规则引擎命中的结果。 */
function matched(categoryName: string): CategorizeResult {
  return { categoryName, fallback: false, matchedKeyword: '测试' };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isAiCategorizeAvailable', () => {
  it('后端未运行时返回 false 而不是抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(isAiCategorizeAvailable()).resolves.toBe(false);
  });

  it('后端返回 categorize: false 时为 false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ categorize: false }), { status: 200 }),
      ),
    );
    await expect(isAiCategorizeAvailable()).resolves.toBe(false);
  });

  it('后端返回 categorize: true 时为 true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ categorize: true }), { status: 200 }),
      ),
    );
    await expect(isAiCategorizeAvailable()).resolves.toBe(true);
  });
});

describe('refineWithAi', () => {
  const CATEGORIES = ['餐饮', '交通', '其他支出'];

  it('改进规则未命中的条目', async () => {
    const transactions = [makeTx({ counterparty: '某某面馆' })];
    const initial = [fallback()];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ index: 0, category: '餐饮' }] }), {
          status: 200,
        }),
      ),
    );

    const outcome = await refineWithAi(transactions, initial, CATEGORIES);

    expect(outcome.improvedCount).toBe(1);
    expect(outcome.results[0]?.categoryName).toBe('餐饮');
    expect(outcome.results[0]?.fallback).toBe(false);
  });

  it('丢弃候选集合之外的分类（不允许模型自创）', async () => {
    const transactions = [makeTx({ counterparty: '某商户' })];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{ index: 0, category: '模型自创的分类' }] }),
          { status: 200 },
        ),
      ),
    );

    const outcome = await refineWithAi(transactions, [fallback()], CATEGORIES);

    // 未被采纳，保留兜底分类。
    expect(outcome.improvedCount).toBe(0);
    expect(outcome.results[0]?.categoryName).toBe('其他支出');
    expect(outcome.results[0]?.fallback).toBe(true);
  });

  it('丢弃越界的 index', async () => {
    const transactions = [makeTx()];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ index: 99, category: '餐饮' }] }), {
          status: 200,
        }),
      ),
    );

    const outcome = await refineWithAi(transactions, [fallback()], CATEGORIES);
    expect(outcome.improvedCount).toBe(0);
  });

  it('网络失败时保留规则引擎结果，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const initial = [fallback()];
    const outcome = await refineWithAi([makeTx()], initial, CATEGORIES);

    expect(outcome.improvedCount).toBe(0);
    expect(outcome.results[0]?.categoryName).toBe('其他支出');
  });

  it('后端返回 501（未配置）时静默降级', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not-configured' }), { status: 501 }),
      ),
    );

    const outcome = await refineWithAi([makeTx()], [fallback()], CATEGORIES);
    expect(outcome.improvedCount).toBe(0);
    expect(outcome.results[0]?.fallback).toBe(true);
  });

  it('返回不合规的 JSON 时静默降级', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('这不是 JSON', { status: 200 })),
    );

    const outcome = await refineWithAi([makeTx()], [fallback()], CATEGORIES);
    expect(outcome.improvedCount).toBe(0);
  });

  it('只请求兜底的支出条目，不打扰已命中的、收入的、转账的', async () => {
    const transactions = [
      makeTx({ counterparty: '已命中规则的商户' }),
      makeTx({ counterparty: '未知商户' }),
      makeTx({ counterparty: '工资', direction: 'income' }),
      makeTx({ counterparty: '提现', direction: 'transfer' }),
    ];
    const initial = [matched('餐饮'), fallback(), fallback(), { categoryName: '转账', fallback: false }];

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await refineWithAi(transactions, initial, CATEGORIES);

    // 只有那一条未知支出需要询问。
    expect(outcome.askedCount).toBe(1);

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as { items: string[] };

    expect(body.items).toEqual(['未知商户']);
  });

  it('没有兜底条目时完全不发起请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await refineWithAi([makeTx()], [matched('餐饮')], CATEGORIES);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.askedCount).toBe(0);
  });

  it('候选分类为空时不发起请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await refineWithAi([makeTx()], [fallback()], []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.askedCount).toBe(0);
    expect(outcome.results[0]?.categoryName).toBe('其他支出');
  });

  it('超过单批上限时自动分批', async () => {
    const transactions = Array.from({ length: 130 }, (_, index) =>
      makeTx({ counterparty: `商户${index}` }),
    );
    const initial = transactions.map(() => fallback());

    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await refineWithAi(transactions, initial, CATEGORIES);

    expect(outcome.askedCount).toBe(130);
    // 130 条按每批 60 条应分成 3 批。
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('商户与商品说明都为空时跳过该条目', async () => {
    const transactions = [makeTx({ counterparty: '', description: '' })];

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await refineWithAi(transactions, [fallback()], CATEGORIES);
    expect(outcome.askedCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
