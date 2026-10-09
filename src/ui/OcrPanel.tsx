/**
 * OCR / 发票识别面板。
 *
 * 两条输入路径，按文件类型自动分流：
 * - **XML / OFD 发票** → 客户端直接解析提取要素，**完全不需要 OCR**，也不经过服务端。
 * - **图片（支付截图、纸质小票、发票照片）** → 上传服务端走 OCR，再抽取字段。
 *
 * 无论哪条路径，抽出的金额都**只是建议值**，必须由用户在候选列表里确认。
 * 记错金额在记账里是不可接受的，而让用户点一下是廉价的。
 */

import { useState } from 'react';
import clsx from 'clsx';
import { FileText, ImageIcon, Loader2, ScanLine } from 'lucide-react';
import { OcrClientError, recognizeImage } from '../ocr/client.ts';
import { parseInvoiceXml, type InvoiceFields } from '../ocr/invoiceXml.ts';
import { classifyDocument, type ExtractedFields } from '../ocr/extract.ts';
import { formatCents } from '../domain/money.ts';

/** 识别结果，交给上层填入记账表单。 */
export interface OcrFillValues {
  amountCents?: number;
  occurredAt?: string;
  counterparty?: string;
  /** 给用户看的来源说明。 */
  note: string;
}

interface Props {
  /** 用户确认后回填表单。 */
  onApply: (values: OcrFillValues) => void;
}

/** 面板状态。 */
type PanelState =
  | { kind: 'idle' }
  | { kind: 'working'; label: string }
  | { kind: 'image'; text: string; provider: string; fields: ExtractedFields; docType: string }
  | { kind: 'invoice'; invoice: InvoiceFields; fileName: string }
  | { kind: 'error'; message: string; detail: string };

/**
 * OCR / 发票识别面板。
 *
 * @param props.onApply 用户确认后回填表单的回调。
 */
export default function OcrPanel({ onApply }: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });

  /**
   * 处理用户选择的文件，按类型分流。
   *
   * @param file 选中的文件。
   */
  async function handleFile(file: File): Promise<void> {
    const isXml = /\.xml$/i.test(file.name);
    const isOfd = /\.ofd$/i.test(file.name);

    // 数电发票 XML：直接解析，零 OCR、零误差、不经过服务端。
    if (isXml) {
      setState({ kind: 'working', label: '正在解析发票 XML…' });
      try {
        const invoice = parseInvoiceXml(await file.text());
        if (!invoice) {
          setState({
            kind: 'error',
            message: '这个 XML 里没有找到发票要素',
            detail:
              '它可能不是数电发票原件。XML 发票应来自电子税务局或税务数字账户的下载，' +
              '含发票号码、开票日期、购销方、价税合计等要素。',
          });
          return;
        }
        setState({ kind: 'invoice', invoice, fileName: file.name });
      } catch (error) {
        setState({
          kind: 'error',
          message: '读取 XML 失败',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (isOfd) {
      setState({
        kind: 'error',
        message: 'OFD 格式暂不支持直接解析',
        detail:
          'OFD 本身是「ZIP + XML」容器，可以用压缩软件打开后取出里面的 XML 再导入，' +
          '效果完全相同。或者直接上传发票截图走 OCR。',
      });
      return;
    }

    // 图片：走 OCR。
    setState({ kind: 'working', label: '正在识别图片…（首次可能较慢）' });
    try {
      const outcome = await recognizeImage(file);
      setState({
        kind: 'image',
        text: outcome.text,
        provider: outcome.provider,
        fields: outcome.fields,
        docType: classifyDocument(outcome.text),
      });
    } catch (error) {
      if (error instanceof OcrClientError) {
        setState({ kind: 'error', message: error.message, detail: error.detail });
      } else {
        setState({
          kind: 'error',
          message: '识别失败',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-800/40 p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
        <ScanLine size={16} aria-hidden />
        拍照 / 发票识别
      </h2>
      <p className="text-[11px] leading-relaxed text-slate-500">
        支持支付截图、纸质小票、发票照片（走 OCR），以及<b className="text-slate-400">数电发票 XML</b>
        （直接解析，不需要 OCR，也不会上传）。
      </p>

      <div className="flex gap-2">
        <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-xs text-slate-300 active:bg-slate-800">
          <ImageIcon size={15} aria-hidden />
          选择图片
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 清空 value，让用户能重复选择同一个文件。
              event.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </label>

        <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-xs text-slate-300 active:bg-slate-800">
          <FileText size={15} aria-hidden />
          发票 XML
          <input
            type="file"
            accept=".xml,.ofd"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </label>
      </div>

      {state.kind === 'working' && (
        <p className="flex items-center gap-2 text-[11px] text-sky-300">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {state.label}
        </p>
      )}

      {state.kind === 'error' && (
        <div className="rounded-lg bg-rose-950/40 px-3 py-2">
          <p className="text-[11px] font-medium text-rose-300">{state.message}</p>
          {state.detail !== '' && (
            <p className="mt-1 text-[11px] leading-relaxed text-rose-200/70">{state.detail}</p>
          )}
        </div>
      )}

      {state.kind === 'invoice' && (
        <InvoiceResult
          invoice={state.invoice}
          fileName={state.fileName}
          onApply={onApply}
          onDismiss={() => setState({ kind: 'idle' })}
        />
      )}

      {state.kind === 'image' && (
        <ImageResult
          text={state.text}
          provider={state.provider}
          fields={state.fields}
          docType={state.docType}
          onApply={onApply}
          onDismiss={() => setState({ kind: 'idle' })}
        />
      )}
    </section>
  );
}

/** 发票 XML 的解析结果。 */
function InvoiceResult({
  invoice,
  fileName,
  onApply,
  onDismiss,
}: {
  invoice: InvoiceFields;
  fileName: string;
  onApply: (values: OcrFillValues) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3">
      <p className="text-[11px] font-medium text-emerald-300">
        已解析发票（{fileName}）—— 无需 OCR
      </p>

      <dl className="space-y-1 text-[11px]">
        <Row label="发票号码" value={invoice.invoiceNumber ?? '—'} />
        <Row label="开票日期" value={invoice.issueDate ?? '—'} />
        <Row label="销售方" value={invoice.sellerName ?? '—'} />
        <Row label="购买方" value={invoice.buyerName ?? '—'} />
        <Row
          label="价税合计"
          value={invoice.totalCents !== null ? formatCents(invoice.totalCents) : '未找到'}
        />
        {invoice.amountWithoutTaxCents !== null && (
          <Row label="不含税金额" value={formatCents(invoice.amountWithoutTaxCents)} />
        )}
        {invoice.taxCents !== null && <Row label="税额" value={formatCents(invoice.taxCents)} />}
      </dl>

      {invoice.warnings.length > 0 && (
        <ul className="rounded bg-amber-950/40 px-2 py-1.5">
          {invoice.warnings.map((warning) => (
            <li key={warning} className="text-[11px] leading-relaxed text-amber-300">
              · {warning}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={invoice.totalCents === null}
          onClick={() =>
            onApply({
              ...(invoice.totalCents !== null ? { amountCents: invoice.totalCents } : {}),
              ...(invoice.issueDate !== null ? { occurredAt: `${invoice.issueDate} 12:00:00` } : {}),
              ...(invoice.sellerName !== null ? { counterparty: invoice.sellerName } : {}),
              note: `来自数电发票 XML（${invoice.invoiceNumber ?? '无号码'}）`,
            })
          }
          className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white enabled:active:bg-emerald-700 disabled:opacity-40"
        >
          填入表单
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400"
        >
          忽略
        </button>
      </div>
    </div>
  );
}

/** 图片 OCR 的结果。 */
function ImageResult({
  text,
  provider,
  fields,
  docType,
  onApply,
  onDismiss,
}: {
  text: string;
  provider: string;
  fields: ExtractedFields;
  docType: string;
  onApply: (values: OcrFillValues) => void;
  onDismiss: () => void;
}) {
  const [selectedAmount, setSelectedAmount] = useState<number | undefined>(
    fields.amounts[0]?.value,
  );

  const docLabel: Record<string, string> = {
    'payment-screenshot': '支付截图',
    invoice: '发票',
    receipt: '小票',
    unknown: '未识别类型',
  };

  const hasAnything =
    fields.amounts.length > 0 || fields.dates.length > 0 || fields.merchants.length > 0;

  return (
    <div className="space-y-2.5 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <p className="text-[11px] text-slate-400">
        识别来源：{provider} · 判定为「{docLabel[docType] ?? docType}」
      </p>

      {!hasAnything && (
        <p className="rounded bg-amber-950/40 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300">
          没能自动抽出字段。下面是识别到的原文，请手工核对填写。
        </p>
      )}

      {fields.amounts.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-slate-400">
            金额候选（请确认，识别可能有误）
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {fields.amounts.map((candidate) => (
              <button
                key={`${candidate.value}-${candidate.source}`}
                type="button"
                onClick={() => setSelectedAmount(candidate.value)}
                className={clsx(
                  'rounded-lg border px-2.5 py-1.5 text-xs tabular-nums transition-colors',
                  selectedAmount === candidate.value
                    ? 'border-sky-600 bg-sky-950/60 text-sky-300'
                    : 'border-slate-700 bg-slate-800/40 text-slate-400',
                )}
                title={candidate.source}
              >
                {formatCents(candidate.value)}
              </button>
            ))}
          </div>
        </div>
      )}

      {fields.dates.length > 0 && (
        <p className="text-[11px] text-slate-400">
          日期：<span className="text-slate-300">{fields.dates[0]?.value}</span>
        </p>
      )}

      {fields.merchants.length > 0 && (
        <p className="text-[11px] text-slate-400">
          商户：<span className="text-slate-300">{fields.merchants[0]?.value}</span>
        </p>
      )}

      <details className="rounded border border-slate-700 bg-slate-950/40 px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] text-slate-500">
          查看识别原文（{fields.lines.length} 行）
        </summary>
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-slate-500">
          {text === '' ? '（识别结果为空）' : text}
        </pre>
      </details>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={selectedAmount === undefined}
          onClick={() =>
            onApply({
              ...(selectedAmount !== undefined ? { amountCents: selectedAmount } : {}),
              ...(fields.dates[0] !== undefined ? { occurredAt: fields.dates[0].value } : {}),
              ...(fields.merchants[0] !== undefined
                ? { counterparty: fields.merchants[0].value }
                : {}),
              note: '来自图片 OCR，金额请务必核对',
            })
          }
          className="flex-1 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white enabled:active:bg-sky-700 disabled:opacity-40"
        >
          填入表单
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400"
        >
          忽略
        </button>
      </div>
    </div>
  );
}

/** 一行键值。 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="truncate text-slate-300">{value}</dd>
    </div>
  );
}
