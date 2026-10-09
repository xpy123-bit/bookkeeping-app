/**
 * 账单文件的字符编码检测与解码。
 *
 * 实测事实（已用真实账单文件逐字节核对）：
 * - 微信支付账单：UTF-8。
 * - 支付宝账单：GBK / CP936（GB18030 是其超集，用它解码 GBK 内容是安全的）。
 *
 * 这里刻意不使用 `chardet` / `jschardet` 这类统计式检测器：GBK、GB2312、GB18030
 * 在统计特征上高度相似，误判率很高。改用确定性判据 —— 「UTF-8 严格解码是否抛错」。
 * 只要一段字节不是合法 UTF-8，它就不可能是 UTF-8，这是可靠的二值判断。
 */

/** 支持的账单编码。 */
export type BillEncoding = 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';

/** 解码结果及所使用的编码。 */
export interface DecodeResult {
  text: string;
  encoding: BillEncoding;
  /** 是否命中 BOM。 */
  hadBom: boolean;
}

/**
 * 按确定性判据解码账单字节。
 *
 * 判定顺序：
 * 1. BOM 命中则直接采用（`EF BB BF` → UTF-8，`FF FE` → UTF-16LE，`FE FF` → UTF-16BE）。
 * 2. 严格 UTF-8 解码成功 → UTF-8。
 * 3. 否则 → GB18030。
 *
 * @param bytes 账单文件的原始字节。
 * @returns 解码后的文本与实际使用的编码。
 */
export function decodeBill(bytes: Uint8Array): DecodeResult {
  const bom = detectBom(bytes);
  if (bom) {
    const decoder = new TextDecoder(bom.encoding);
    return {
      text: stripBomChar(decoder.decode(bytes)),
      encoding: bom.encoding,
      hadBom: true,
    };
  }

  const utf8 = tryDecodeStrict(bytes, 'utf-8');
  if (utf8 !== null) {
    return { text: utf8, encoding: 'utf-8', hadBom: false };
  }

  const gb = tryDecodeStrict(bytes, 'gb18030');
  if (gb !== null) {
    return { text: gb, encoding: 'gb18030', hadBom: false };
  }

  // 两种候选都失败时，用非严格 GB18030 兜底，并把替换字符暴露给上层以便提示用户。
  return {
    text: new TextDecoder('gb18030').decode(bytes),
    encoding: 'gb18030',
    hadBom: false,
  };
}

/**
 * 检测字节序标记。
 *
 * @param bytes 原始字节。
 * @returns 命中的编码，或 `null`。
 */
function detectBom(bytes: Uint8Array): { encoding: BillEncoding } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be' };
  }
  return null;
}

/**
 * 用严格模式解码，非法字节序列会抛错。
 *
 * @param bytes 原始字节。
 * @param encoding 目标编码。
 * @returns 解码文本，或 `null` 表示该编码不成立。
 */
function tryDecodeStrict(bytes: Uint8Array, encoding: BillEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 去掉 BOM 解码后残留的零宽字符。
 *
 * @param text 已解码文本。
 * @returns 去除 `U+FEFF` 的文本。
 */
function stripBomChar(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 判断解码结果中是否含有替换字符，用于提示用户文件可能损坏。
 *
 * @param text 已解码文本。
 * @returns 含 `U+FFFD` 时为 `true`。
 */
export function hasReplacementChars(text: string): boolean {
  return text.includes('\uFFFD');
}
