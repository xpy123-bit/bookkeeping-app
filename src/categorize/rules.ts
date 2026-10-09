/**
 * 自动分类引擎。
 *
 * 规则模型借鉴 double-entry-generator（Apache-2.0）的声明式 matcher 设计：
 * 按优先级依次匹配「商户/商品关键词」，首个命中即决定分类。
 *
 * 设计取舍：**默认完全离线可用**。内置中文商户词典覆盖绝大多数日常消费，
 * 因此没有配置任何大模型 API key 也能开箱自动分类。大模型是可选增强，
 * 不是前置依赖 —— 否则「高度自动化」会退化成「先申请一个 key」。
 */

import type { ParsedTransaction } from '../domain/types.ts';
import type { RuleRecord } from '../db/db.ts';

/** 一条待匹配的规则（内置或用户自定义）。 */
export interface MatchRule {
  priority: number;
  keywords: readonly string[];
  matchOn: 'counterparty' | 'description' | 'both';
  categoryName: string;
  enabled?: boolean;
}

/** 分类结果。 */
export interface CategorizeResult {
  categoryName: string;
  /** 命中的规则关键词，便于在界面上解释「为什么归到这一类」。 */
  matchedKeyword?: string;
  /** 是否为兜底结果（没有任何规则命中）。 */
  fallback: boolean;
}

/**
 * 内置中文商户词典。
 *
 * 关键词按「消费场景」组织。匹配用的是**包含**而非全等 —— 真实账单里的商户名
 * 带后缀，例如「美团平台商户」「东莞肯德基有限公司」「招商银行信用卡(7449)」。
 */
export const BUILTIN_RULES: readonly MatchRule[] = [
  {
    priority: 100,
    categoryName: '餐饮',
    matchOn: 'both',
    keywords: [
      '美团', '饿了么', '肯德基', '麦当劳', '星巴克', '瑞幸', '海底捞', '沙县',
      '兰州拉面', '蜜雪冰城', '喜茶', '奈雪', '餐饮', '饭店', '餐厅', '小吃',
      '烧烤', '火锅', '咖啡', '奶茶', '面包', '蛋糕', '食品', '食堂', '云膳',
      '米线', '快餐', '汉堡', '披萨', '茶饮', '酒楼', '烘焙',
    ],
  },
  {
    priority: 200,
    categoryName: '交通',
    matchOn: 'both',
    keywords: [
      '滴滴', '嘀嘀', '高德', '地铁', '公交', '出租', '12306', '铁路', '火车',
      '加油', '中国石油', '中国石化', '中石化', '中石油', '停车', '高速', 'ETC',
      '共享单车', '哈啰', '青桔', '单车', '航空', '机票', '打车', '网约车',
    ],
  },
  {
    priority: 300,
    categoryName: '购物',
    matchOn: 'both',
    keywords: [
      '淘宝', '天猫', '京东', '拼多多', '唯品会', '苏宁', '亚马逊', '商场',
      '超市', '便利店', '全家', '罗森', '永辉', '沃尔玛', '山姆', '盒马',
      '电子商务', '特约商户', '优衣库', '无印良品', '小米', '苹果', '华为',
    ],
  },
  {
    priority: 400,
    categoryName: '日用',
    matchOn: 'both',
    keywords: ['名创优品', '屈臣氏', '日用', '洗护', '纸巾', '日用百货'],
  },
  {
    priority: 500,
    categoryName: '居住',
    matchOn: 'both',
    keywords: [
      '物业', '房租', '租金', '水费', '电费', '燃气', '网上国网', '取暖',
      '供暖', '自来水', '住房',
    ],
  },
  {
    priority: 600,
    categoryName: '通讯',
    matchOn: 'both',
    keywords: ['中国移动', '中国联通', '中国电信', '话费', '流量', '宽带', '移动通信'],
  },
  {
    priority: 700,
    categoryName: '娱乐',
    matchOn: 'both',
    keywords: [
      '电影', '影院', '腾讯视频', '爱奇艺', '优酷', '哔哩哔哩', 'Steam',
      '网易云音乐', 'QQ音乐', '游戏', 'KTV', '剧本杀', '健身房', '旅游', '景区',
    ],
  },
  {
    priority: 800,
    categoryName: '医疗',
    matchOn: 'both',
    keywords: ['医院', '药房', '药店', '诊所', '挂号', '门诊', '体检', '医疗'],
  },
  {
    priority: 900,
    categoryName: '教育',
    matchOn: 'both',
    keywords: ['学费', '培训', '书店', '图书', '课程', '教育', '网校', '考试'],
  },
  {
    priority: 1000,
    categoryName: '人情',
    matchOn: 'both',
    keywords: ['红包', '礼金', '份子', '随礼', '公益', '捐赠', '分分捐'],
  },
  {
    priority: 1100,
    categoryName: '投资',
    matchOn: 'both',
    keywords: ['基金', '股票', '理财', '黄金', '证券', '保险', '相互宝'],
  },
  // ——— 收入类规则 ———
  {
    priority: 2000,
    categoryName: '工资',
    matchOn: 'both',
    keywords: ['工资', '薪资', '薪酬', '代发', '劳务', '奖金'],
  },
  {
    priority: 2100,
    categoryName: '退款',
    matchOn: 'both',
    keywords: ['退款', '退货'],
  },
  {
    priority: 2200,
    categoryName: '理财收益',
    matchOn: 'both',
    keywords: ['收益', '利息', '分红', '余额宝', '零钱通'],
  },
  {
    priority: 2300,
    categoryName: '红包',
    matchOn: 'both',
    keywords: ['红包', '收款', '扫码收款', '转账'],
  },
];

/**
 * 判断一条规则是否命中某笔交易。
 *
 * @param rule 规则。
 * @param tx 交易。
 * @returns 命中的关键词，未命中时返回 `null`。
 */
function matchRule(rule: MatchRule, tx: ParsedTransaction): string | null {
  const targets: string[] = [];
  switch (rule.matchOn) {
    case 'counterparty':
      targets.push(tx.counterparty);
      break;
    case 'description':
      targets.push(tx.description);
      break;
    case 'both':
      targets.push(tx.counterparty, tx.description, tx.rawCategory);
      break;
  }

  for (const keyword of rule.keywords) {
    if (keyword === '') continue;
    if (targets.some((target) => target.includes(keyword))) {
      return keyword;
    }
  }
  return null;
}

/**
 * 对一笔交易自动分类。
 *
 * 匹配顺序：用户自定义规则（按优先级）→ 内置词典 → 兜底分类。
 *
 * @param tx 交易。
 * @param userRules 用户自定义规则。
 * @returns 分类结果。
 */
export function categorize(
  tx: ParsedTransaction,
  userRules: readonly RuleRecord[] = [],
): CategorizeResult {
  const custom: MatchRule[] = userRules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      priority: rule.priority,
      keywords: rule.keywords,
      matchOn: rule.matchOn,
      categoryName: rule.categoryName,
      enabled: rule.enabled,
    }));

  const ordered = [...custom, ...BUILTIN_RULES].sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    const keyword = matchRule(rule, tx);
    if (keyword !== null) {
      return { categoryName: rule.categoryName, matchedKeyword: keyword, fallback: false };
    }
  }

  return {
    categoryName: tx.direction === 'income' ? '其他收入' : '其他支出',
    fallback: true,
  };
}

/**
 * 批量分类。
 *
 * @param transactions 交易列表。
 * @param userRules 用户自定义规则。
 * @returns 与输入等长的分类结果列表。
 */
export function categorizeAll(
  transactions: readonly ParsedTransaction[],
  userRules: readonly RuleRecord[] = [],
): CategorizeResult[] {
  return transactions.map((tx) =>
    tx.direction === 'transfer'
      ? { categoryName: '转账', fallback: false }
      : categorize(tx, userRules),
  );
}
