import type { CloudAccount, CloudQuote, CloudQuoteRequest, GenerationSettings } from './types.ts';

export const isCreditAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const creditDisplay = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatCredits = (value: number | null | undefined) => isCreditAmount(value) ? creditDisplay.format(value) : '—';
export function taskCostLabel(value: number | undefined, settled: boolean | undefined) {
  return isCreditAmount(value) ? `${settled ? '实际费用' : '当前费用（结算待确认）'} ${formatCredits(value)} 积分 · 整任务` : '费用待回读';
}

export function accountBalanceLabel(account: CloudAccount | null) {
  if (account && !account.configured) return '积分未配置';
  return account && isCreditAmount(account.remaining_credits) ? `剩余 ${formatCredits(account.remaining_credits)} 积分` : '积分暂不可用';
}
export function gifParameters(settings: GenerationSettings) {
  const width = settings.gifWidth ?? 512, height = settings.gifHeight ?? 512;
  return {output_format: 'gif' as const, size: `${width}x${height}`, frame_count: settings.frameCount ?? 9, frame_duration_ms: settings.frameDurationMs ?? 200};
}

export function quoteRequest(model: string, settings: GenerationSettings): CloudQuoteRequest {
  const size = settings.ratio === 'custom' ? `${settings.width}x${settings.height}` : settings.ratio;
  return { model,
    resolution: settings.resolution, n: settings.count, ...(settings.outputFormat === 'gif' ? gifParameters(settings) : settings.outputFormat === 'svg' ? {size, output_format:'svg' as const} : {size}), ...(settings.quality ? { quality: settings.quality } : {}) };
}
export function quoteKey(request: CloudQuoteRequest) {
  return JSON.stringify([request.model, request.size, request.resolution, request.quality ?? '', request.n, request.output_format, request.frame_count, request.frame_duration_ms]);
}
export function quoteForSelection(record: { key: string; quote: CloudQuote } | null, key: string, model: string) {
  return record?.key === key && record.quote.model === model ? record.quote : null;
}
export function quoteLabel(quote: CloudQuote | null) {
  if (!quote || quote.kind === 'unknown') return '积分待定';
  if (isCreditAmount(quote.credits_per_image)) return `约 ${formatCredits(quote.credits_per_image)} 积分/张`;
  if (isCreditAmount(quote.min_credits_per_image) && isCreditAmount(quote.max_credits_per_image) && quote.max_credits_per_image >= quote.min_credits_per_image)
    return `约 ${formatCredits(quote.min_credits_per_image)}–${formatCredits(quote.max_credits_per_image)} 积分/张`;
  return '积分待定';
}
export function quoteExplanation(quote: CloudQuote | null) {
  if (!quote) return '当前规格的积分参考暂不可用，最终以供应商结算记录为准。';
  const kind = quote.kind === 'output_reference' ? '输出参考：另有输入费用，此处不代表整任务总价。'
    : quote.kind === 'precharge_reference' ? '预留参考：最终按实际token结算，此处不保证最终总价。' : '当前规格没有可靠映射，积分待定。';
  return [quote.label, kind, quote.additional_input_cost_unknown ? '输入部分费用尚未确定。' : '', quote.stale ? '参考已过期，请刷新后核对。' : ''].filter(Boolean).join(' ');
}
