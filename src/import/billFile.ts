/**
 * 账单文件加载流水线：把「用户选中的文件」变成「可入库的交易」。
 *
 * 实测确认的完整形态：微信/支付宝导出的都是**加密 ZIP**，内层才是 CSV。
 * 微信的解压密码通过「微信支付」服务通知下发（每人不同）；支付宝的密码是
 * 实名认证身份证号后 6 位（末位 X 大写）。因此 UI 必须提供密码输入框，
 * 而不是假定用户能直接拖入 CSV。
 */

import { BlobReader, TextWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import {
  BillParseError,
  type BillSource,
  type ParseResult,
} from '../domain/types.ts';
import { decodeBill, hasReplacementChars } from './encoding.ts';
import { parseWechatBill } from './wechat.ts';
import { parseAlipayBill } from './alipay.ts';

/** ZIP 解压后的载荷。 */
export interface ExtractedBill {
  /** 内层文件名，用于在界面上显示「已从 xxx.csv 读取」。 */
  fileName: string;
  text: string;
  /** ZIP 内层文件的原始字节，XLSX 检测需要用到。 */
  bytes: Uint8Array;
}

/** 判断文件名是否为 ZIP。 */
export function isZipFile(fileName: string): boolean {
  return /\.zip$/i.test(fileName);
}

/** 判断文件名是否为 Excel。 */
export function isExcelFile(fileName: string): boolean {
  return /\.xlsx?$/i.test(fileName);
}

/**
 * 从加密或未加密的 ZIP 中取出第一个账单文件。
 *
 * @param file 用户选中的 ZIP 文件。
 * @param password 解压密码；未加密时传空字符串。
 * @returns 解压结果。
 * @throws {BillParseError} 密码错误、ZIP 损坏或包内没有可识别文件时。
 */
export async function extractBillFromZip(
  file: File | Blob,
  password: string,
): Promise<ExtractedBill> {
  const reader = new ZipReader(new BlobReader(file), {
    password: password === '' ? undefined : password,
  });

  try {
    const entries = await reader.getEntries();

    const candidate = entries.find(
      (entry): entry is FileEntry =>
        !entry.directory &&
        (/\.csv$/i.test(entry.filename) || /\.xlsx?$/i.test(entry.filename)),
    );

    if (!candidate) {
      const names = entries.map((entry) => entry.filename).join('、');
      throw new BillParseError(
        '压缩包里没有找到账单文件',
        `包内文件：${names || '（空）'}。期望是 .csv 或 .xlsx。`,
      );
    }

    const text = await candidate.getData(new TextWriter());

    return {
      fileName: candidate.filename,
      text,
      // TextWriter 已按 UTF-8 解出文本；这里把文本重新编码，供 XLSX 分支使用。
      bytes: new TextEncoder().encode(text),
    };
  } catch (error) {
    if (error instanceof BillParseError) throw error;
    const message = error instanceof Error ? error.message : String(error);

    // zip.js 在密码错误与 AES 不兼容时都抛错，这里统一给出可操作提示。
    if (/password|encrypted|invalid/i.test(message)) {
      throw new BillParseError(
        '解压密码不正确，或这个压缩包用了不支持的加密方式',
        '微信账单的密码在「微信支付」公众号的「账单文件发送成功通知」里；' +
          '支付宝账单的密码是实名认证身份证号后 6 位（末位 X 请大写）。',
      );
    }

    throw new BillParseError('压缩包读取失败', message);
  } finally {
    await reader.close();
  }
}

/**
 * 从文本内容判断账单来源。
 *
 * @param text 已解码文本。
 * @returns 识别到的来源，无法判断时返回 `null`。
 */
export function detectSource(text: string): BillSource | null {
  if (text.includes('微信支付账单明细')) return 'wechat';
  if (text.includes('支付宝') || text.includes('电子客户回单')) return 'alipay';
  return null;
}

/**
 * 解析账单文本，自动识别来源。
 *
 * @param text 已解码文本。
 * @returns 解析结果。
 * @throws {BillParseError} 无法识别来源时。
 */
export function parseBill(text: string): ParseResult {
  const source = detectSource(text);

  if (source === 'wechat') return parseWechatBill(text);
  if (source === 'alipay') return parseAlipayBill(text);

  throw new BillParseError(
    '无法识别这个账单文件',
    '目前支持微信支付账单与支付宝账单。请确认文件来自官方导出，' +
      '且没有被其他软件改写过内容。',
  );
}

/** 加载账单文件的完整结果。 */
export interface LoadBillOutcome {
  result: ParseResult;
  /** 内层文件名。 */
  fileName: string;
  /** 实际使用的解码方式，用于在界面上透明展示。 */
  encoding: string;
  /** 文件中出现了解码替换字符（可能已损坏）。 */
  suspicious: boolean;
}

/**
 * 加载用户选中的账单文件并解析。
 *
 * 同时支持直接选择 CSV、以及选择加密 ZIP（推荐路径）。
 *
 * @param file 用户选中的文件。
 * @param password ZIP 解压密码。
 * @returns 加载与解析结果。
 * @throws {BillParseError} 各阶段的失败。
 */
export async function loadBillFile(
  file: File,
  password: string,
): Promise<LoadBillOutcome> {
  let rawBytes: Uint8Array;
  let fileName = file.name;

  if (isZipFile(file.name)) {
    const extracted = await extractBillFromZip(file, password);
    fileName = extracted.fileName;

    if (isExcelFile(extracted.fileName)) {
      throw new BillParseError(
        '这个账单是 Excel（.xlsx）格式，暂不支持',
        '微信近期的导出可能是 .xlsx。请在微信里改用「账单 → 常见问题 → 下载账单 → ' +
          '用于个人对账」并确保拿到的是 CSV；或在 Excel 中另存为「CSV UTF-8」后再导入。',
      );
    }

    rawBytes = extracted.bytes;
  } else if (isExcelFile(file.name)) {
    throw new BillParseError(
      '暂不支持 Excel（.xlsx）格式的账单',
      '请在 Excel 中另存为「CSV UTF-8」后再导入；支付宝账单请另存为「CSV」。',
    );
  } else {
    rawBytes = new Uint8Array(await file.arrayBuffer());
  }

  const decoded = decodeBill(rawBytes);
  const result = parseBill(decoded.text);

  return {
    result,
    fileName,
    encoding: decoded.encoding,
    suspicious: hasReplacementChars(decoded.text),
  };
}

/**
 * 用账单自带的统计块与解析结果比对，生成面向用户的自检提示。
 *
 * 这是最便宜的正确性护栏：若解析器漏读或误判了行，账单自己声明的笔数会不一致。
 *
 * @param result 解析结果。
 * @returns 提示文本列表；全部一致时返回空数组。
 */
export function buildSelfCheckNotes(result: ParseResult): string[] {
  const notes: string[] = [];
  const { declared, actual } = result;

  if (declared.totalCount !== undefined && actual.totalCount !== undefined) {
    if (declared.totalCount !== actual.totalCount) {
      notes.push(
        `账单声明共 ${declared.totalCount} 笔，实际解析出 ${actual.totalCount} 笔` +
          `（跳过 ${result.skipped.length} 笔）。若差值较大，请检查是否有未支持的格式变体。`,
      );
    }
  }

  const compare: Array<[string, number | undefined, number | undefined]> = [
    ['收入笔数', declared.incomeCount, actual.incomeCount],
    ['支出笔数', declared.expenseCount, actual.expenseCount],
  ];

  for (const [label, expected, got] of compare) {
    if (expected !== undefined && got !== undefined && expected !== got) {
      notes.push(`${label}：账单声明 ${expected} 笔，实际 ${got} 笔`);
    }
  }

  return notes;
}
