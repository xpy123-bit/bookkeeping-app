import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeBill, hasReplacementChars } from './encoding.ts';

/** 读取测试夹具的原始字节。 */
function fixtureBytes(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

describe('decodeBill', () => {
  it('把微信账单识别为 UTF-8', () => {
    const result = decodeBill(fixtureBytes('wechat-real.csv'));
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toContain('微信支付账单明细');
  });

  it('把支付宝账单识别为 GB18030', () => {
    // 这是最关键的编码判据：支付宝账单不是合法 UTF-8，
    // 若按 UTF-8 解码会得到乱码，导致所有中文字段无法匹配。
    const result = decodeBill(fixtureBytes('alipay-real.csv'));
    expect(result.encoding).toBe('gb18030');
    expect(result.text).toContain('支付宝');
    expect(result.text).toContain('交易时间');
  });

  it('GB18030 解码结果无替换字符', () => {
    const result = decodeBill(fixtureBytes('alipay-real.csv'));
    expect(hasReplacementChars(result.text)).toBe(false);
  });

  it('识别 UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad]);
    const result = decodeBill(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.hadBom).toBe(true);
    // BOM 字符必须剥离，否则第一个字段名会带不可见字符而匹配失败。
    expect(result.text).toBe('中');
  });

  it('识别 UTF-16LE BOM', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e]);
    const result = decodeBill(bytes);
    expect(result.encoding).toBe('utf-16le');
    expect(result.hadBom).toBe(true);
    expect(result.text).toBe('中');
  });

  it('纯 ASCII 走 UTF-8 分支', () => {
    const bytes = new TextEncoder().encode('hello,world');
    const result = decodeBill(bytes);
    expect(result.encoding).toBe('utf-8');
  });

  it('回退到 GB18030 而非产生乱码', () => {
    // 0xBD 0xBB 0xD2 0xD7 是 "交易" 的 GBK 编码。
    const bytes = new Uint8Array([0xbd, 0xbb, 0xd2, 0xd7]);
    const result = decodeBill(bytes);
    expect(result.encoding).toBe('gb18030');
    expect(result.text).toBe('交易');
  });
});
