import { describe, expect, it } from 'vitest';
import { parseInvoiceXml } from './invoiceXml.ts';

/** 一份贴近真实形态的数电发票 XML（字段名取自常见开票平台输出）。 */
const FULL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://www.chinatax.gov.cn/einv">
  <InvoiceNumber>24312000000012345678</InvoiceNumber>
  <IssueTime>2024-06-07 13:20:16</IssueTime>
  <SellerName>某某餐饮管理有限公司</SellerName>
  <BuyerName>张三</BuyerName>
  <TotalAmWithoutTax>100.00</TotalAmWithoutTax>
  <TotalTax>13.00</TotalTax>
  <TotalAmWithTax>113.00</TotalAmWithTax>
</Invoice>`;

/** 使用中文标签名的形态。 */
const CHINESE_TAGS = `<?xml version="1.0"?>
<发票>
  <发票号码>24312000000087654321</发票号码>
  <开票日期>2024年6月7日</开票日期>
  <销售方名称>某便利店</销售方名称>
  <价税合计>56.50</价税合计>
</发票>`;

/** 带命名空间前缀的形态。 */
const NAMESPACED = `<?xml version="1.0"?>
<ns:Invoice>
  <ns:InvoiceNumber>24312000000099999999</ns:InvoiceNumber>
  <ns:TotalAmWithTax>88.00</ns:TotalAmWithTax>
  <ns:SellerName>测试商户</ns:SellerName>
</ns:Invoice>`;

describe('parseInvoiceXml', () => {
  it('解析出全部要素（英文标签）', () => {
    const invoice = parseInvoiceXml(FULL_INVOICE);
    expect(invoice).not.toBeNull();

    expect(invoice?.invoiceNumber).toBe('24312000000012345678');
    expect(invoice?.issueDate).toBe('2024-06-07');
    expect(invoice?.sellerName).toBe('某某餐饮管理有限公司');
    expect(invoice?.buyerName).toBe('张三');
    // 金额一律转成整数分。
    expect(invoice?.amountWithoutTaxCents).toBe(10000);
    expect(invoice?.taxCents).toBe(1300);
    expect(invoice?.totalCents).toBe(11300);
    expect(invoice?.source).toBe('xml');
  });

  it('价税合计一致时不产生警告', () => {
    const invoice = parseInvoiceXml(FULL_INVOICE);
    expect(invoice?.warnings).toHaveLength(0);
  });

  it('价税合计与「金额 + 税额」不符时给出警告而不是静默接受', () => {
    // 把价税合计改成明显错误的数字。
    const broken = FULL_INVOICE.replace('<TotalAmWithTax>113.00</TotalAmWithTax>', '<TotalAmWithTax>999.00</TotalAmWithTax>');

    const invoice = parseInvoiceXml(broken);
    expect(invoice?.totalCents).toBe(99900);
    expect(invoice?.warnings.some((w) => w.includes('不一致'))).toBe(true);
  });

  it('1 分以内的舍入差不报警告', () => {
    const rounded = FULL_INVOICE.replace('<TotalAmWithTax>113.00</TotalAmWithTax>', '<TotalAmWithTax>113.01</TotalAmWithTax>');
    const invoice = parseInvoiceXml(rounded);
    expect(invoice?.warnings).toHaveLength(0);
  });

  it('兼容中文标签名', () => {
    const invoice = parseInvoiceXml(CHINESE_TAGS);
    expect(invoice?.invoiceNumber).toBe('24312000000087654321');
    expect(invoice?.issueDate).toBe('2024-06-07');
    expect(invoice?.sellerName).toBe('某便利店');
    expect(invoice?.totalCents).toBe(5650);
  });

  it('容忍命名空间前缀', () => {
    const invoice = parseInvoiceXml(NAMESPACED);
    expect(invoice?.invoiceNumber).toBe('24312000000099999999');
    expect(invoice?.totalCents).toBe(8800);
    expect(invoice?.sellerName).toBe('测试商户');
  });

  it('只有价税合计、没有发票号码时仍能解析，但提示缺金额以外的信息', () => {
    const partial = '<Invoice><TotalAmWithTax>20.00</TotalAmWithTax></Invoice>';
    const invoice = parseInvoiceXml(partial);
    expect(invoice?.totalCents).toBe(2000);
    expect(invoice?.invoiceNumber).toBeNull();
  });

  it('缺少价税合计时给出可操作提示', () => {
    const noTotal = '<Invoice><InvoiceNumber>123</InvoiceNumber></Invoice>';
    const invoice = parseInvoiceXml(noTotal);
    expect(invoice?.totalCents).toBeNull();
    expect(invoice?.warnings.some((w) => w.includes('手工填写'))).toBe(true);
  });

  it('不是发票的 XML 返回 null（让调用方回落到 OCR 路径）', () => {
    expect(parseInvoiceXml('<Root><Something>值</Something></Root>')).toBeNull();
    expect(parseInvoiceXml('这不是 XML')).toBeNull();
    expect(parseInvoiceXml('')).toBeNull();
  });

  it('解码 XML 实体', () => {
    const escaped = '<Invoice><TotalAmWithTax>10.00</TotalAmWithTax><SellerName>A&amp;B 商店</SellerName></Invoice>';
    expect(parseInvoiceXml(escaped)?.sellerName).toBe('A&B 商店');
  });
});
