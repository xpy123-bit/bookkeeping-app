/**
 * 容错 CSV 分词器。
 *
 * 刻意不使用第三方 CSV 库：微信/支付宝账单有若干必须兼容的脏数据特征，
 * 自己实现才能把它们显式表达并逐个测试。
 *
 * 已实测确认的脏数据特征：
 * 1. 含逗号的字段用双引号包裹，例如 `"总共消费:28.16"`。
 * 2. `交易单号` / `商户单号` 尾部带一个制表符 `\t`（平台为阻止 Excel 把长数字
 *    转成科学计数法）。必须 trim，否则去重键会带上不可见字符。
 * 3. 支付宝表头字段名尾部有大量填充空格（`交易时间            `），必须 trim 后
 *    才能按名匹配。
 * 4. 支付宝「备注」为空时，该行字段数会比表头多一个（多出一个尾随逗号）。
 *    因此不能要求每行字段数一致。
 * 5. 字段内含换行的可能性极低，但引号内允许逗号，需按状态机处理。
 */

/** 一行的分词结果，附带其在原文件中的行号。 */
export interface CsvRow {
  /** 行号，从 1 开始，与用户在 Excel/文本编辑器里看到的一致。 */
  line: number;
  /** 已 trim 的字段值。 */
  fields: string[];
}

/**
 * 把整段文本切成「行 → 字段」。
 *
 * 空行会被保留（`fields` 为 `['']`），因为定位表头行需要感知空行位置。
 *
 * @param text 已解码的账单文本。
 * @returns 每一行的分词结果。
 */
export function parseCsvText(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

  const pushField = (): void => {
    fields.push(trimField(field));
    field = '';
  };

  const pushRow = (): void => {
    pushField();
    rows.push({ line: rowStartLine, fields });
    fields = [];
    rowStartLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        // RFC 4180：引号内的连续两个双引号表示一个字面双引号。
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    switch (char) {
      case '"':
        inQuotes = true;
        break;
      case ',':
        pushField();
        break;
      case '\r':
        // 吞掉 CRLF 中的 CR，交由 \n 结束本行。
        break;
      case '\n':
        line += 1;
        pushRow();
        rowStartLine = line;
        break;
      default:
        field += char;
    }
  }

  // 处理没有以换行结尾的最后一行。
  if (field !== '' || fields.length > 0) {
    pushRow();
  }

  return rows;
}

/**
 * 规范化单个字段：去首尾空白（含制表符与全角空格）。
 *
 * @param value 原始字段。
 * @returns 规范化后的字段。
 */
function trimField(value: string): string {
  return value.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/**
 * 判断一行是否为「空行」——即所有字段都为空。
 *
 * @param row 分词结果。
 * @returns 全空时为 `true`。
 */
export function isEmptyRow(row: CsvRow): boolean {
  return row.fields.every((value) => value === '');
}

/**
 * 按字段名在一行中定位列下标，用于「按名而非按下标」解析。
 *
 * 这是应对外债式格式漂移的关键：平台随时可能调整列序或增删列，
 * 硬编码下标会在某次版本更新后静默解析错数据。
 *
 * @param header 表头行。
 * @returns 字段名到下标（首次出现）的映射。
 */
export function buildColumnIndex(header: CsvRow): Map<string, number> {
  const index = new Map<string, number>();
  header.fields.forEach((name, position) => {
    if (name !== '' && !index.has(name)) {
      index.set(name, position);
    }
  });
  return index;
}

/**
 * 从一个已建立索引的行中取值。
 *
 * @param row 数据行。
 * @param index 表头索引。
 * @param columnName 字段名；为空字符串时直接返回空串。
 * @returns 字段值，不存在时返回空串。
 */
export function readColumn(
  row: CsvRow,
  index: Map<string, number>,
  columnName: string,
): string {
  if (columnName === '') return '';
  const position = index.get(columnName);
  if (position === undefined) return '';
  return row.fields[position] ?? '';
}

/**
 * 判断表头是否包含全部必需列。
 *
 * @param index 表头索引。
 * @param required 必需字段名列表。
 * @returns 缺失的字段名列表，全部存在时为空数组。
 */
export function findMissingColumns(
  index: Map<string, number>,
  required: readonly string[],
): string[] {
  return required.filter((name) => !index.has(name));
}

/** 把账单里的「/」等占位符归一为空串。 */
export function normalizePlaceholder(value: string): string {
  return value === '/' || value === '-' || value === '——' ? '' : value;
}
