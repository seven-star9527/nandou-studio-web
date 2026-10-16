import { useEffect, useRef, useState } from 'react';
import { formatCredits, isCreditAmount, quoteExplanation, quoteLabel } from '../credit-contract';
import type { CloudQuote } from '../types';
import Icon from './Icon';

export default function GenerationQuote({ local, quote, loading, error, descriptionId }: { local: boolean; quote: CloudQuote | null; loading: boolean; error: string; descriptionId: string }) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const taskLabel = quote && quote.kind !== 'unknown' && isCreditAmount(quote.credits_total_reference)
    ? `${quote.kind === 'output_reference' ? '输出约' : '预留约'} ${formatCredits(quote.credits_total_reference)} 积分` : quoteLabel(quote);
  const label = local ? '0 积分 · 本地' : loading ? '积分读取中' : taskLabel;
  const detail = local ? '在本机生成，不消耗 APIMart 积分。' : quoteExplanation(quote);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!control.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus({ preventScroll: true }); } };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="quote-control" ref={control}>
    <button ref={trigger} className={`quote-button ${quote?.stale ? 'quote-stale' : ''}`} onClick={() => setOpen(value => !value)} title={detail} aria-label={`积分参考说明：${label}`} aria-expanded={open} aria-controls={`${descriptionId}-detail`}>
      <Icon name="spark" size={14} /><span id={descriptionId}>{label}</span>{!local && quote?.stale ? <small>旧参考</small> : null}
    </button>
    {open ? <div id={`${descriptionId}-detail`} className="quote-popover popover" role="dialog" aria-label="积分参考说明">
      <div className="quote-heading"><strong>{local ? '本地生成' : quote?.kind === 'output_reference' ? '输出积分参考' : quote?.kind === 'precharge_reference' ? '预留积分参考' : '积分待定'}</strong><button className="icon-button" onClick={() => { setOpen(false); trigger.current?.focus(); }} aria-label="关闭积分说明"><Icon name="close" size={14} /></button></div>
      <p>{detail}</p>
      {!local && quote ? <p>每张参考：{quoteLabel(quote)}。</p> : null}
      {!local && error ? <p className="quote-error">参考读取失败：{error}</p> : null}
      {!local && quote && quote.kind !== 'unknown' && isCreditAmount(quote.credits_total_reference) ? <p>当前数量的{quote.kind === 'output_reference' ? '输出' : '预留'}参考：约 {formatCredits(quote.credits_total_reference)} 积分。最终费用以整任务结算为准。</p> : null}
      {!local && quote?.source ? <small>来源：{quote.source}</small> : null}
      {!local && quote?.captured_at ? <small>参考采集：{quote.captured_at}</small> : null}
    </div> : null}
  </div>;
}
