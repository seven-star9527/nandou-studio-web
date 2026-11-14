import { useEffect, useRef, useState } from 'react';
import { authRequest } from '../auth';
import { useModalDialog } from '../useModalDialog';
import Icon from './Icon';
import ModalPortal from './ModalPortal';

interface Report {
  keys: { key: string; tasks: number; pending: number; usd: number }[];
  tasks: { id: string; key: string; model: string; at: string; tokens: number | null; usd: number | null }[];
}

const dollars = (value: number | null) => value === null ? '待核对' : value.toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 5});

function OfficialUsageDialog({close}: {close: () => void}) {
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(true, dialog, close);
  const [report, setReport] = useState<Report>();
  const [message, setMessage] = useState('读取中…');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setMessage('读取中…');
    authRequest<Report>('admin/official-usage', undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) { setReport(data); setMessage(''); }
    }).catch(() => { if (!controller.signal.aborted) setMessage('读取失败，请刷新重试。'); });
    return () => controller.abort();
  }, [revision]);
  const tasks = report?.tasks.filter(t => !selected || selected === t.key) ?? [];
  return <ModalPortal><div className="modal-backdrop admin-usage-backdrop" onClick={close}>
    <section className="admin-usage modal" role="dialog" aria-modal="true" ref={dialog} aria-labelledby="official-usage-heading" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <div className="admin-usage-heading"><div><h2 id="official-usage-heading">OpenAI 官方用量</h2>
        <p>仅统计 Studio 生图。美元费用按回执用量和标准单价估算，账单可核对实际抵扣。</p></div>
        <div className="admin-heading-actions"><a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">官方账单 ↗</a>
          <button className="icon-button" aria-label="刷新官方用量" onClick={() => setRevision(n => n + 1)}><Icon name="refresh"/></button>
          <button className="icon-button" aria-label="关闭官方用量" onClick={close}><Icon name="close"/></button></div></div>
      <div className="official-key-list"><button className="quiet-button" aria-pressed={!selected} onClick={() => setSelected('')}>全部任务</button>
        {report?.keys.map(k => <button key={k.key} className="quiet-button" aria-pressed={selected === k.key} onClick={() => setSelected(k.key)}>
          {k.key} · {k.tasks} 笔 · {k.pending === k.tasks && k.tasks > 0 ? '待核对' : dollars(k.usd)}{k.pending > 0 && k.pending < k.tasks ? `（另有 ${k.pending} 笔待核对）` : ''}
        </button>)}</div>
      {message && <p role="status">{message}</p>}
      <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>任务 / 模型</th><th>时间</th><th>Key</th><th>Token</th><th>估算费用</th></tr></thead>
        <tbody>{tasks.map(t => <tr key={t.id}><td>{t.model}<small>{t.id}</small></td><td>{new Date(t.at).toLocaleString('zh-CN', {hour12: false})}</td><td>{t.key}</td><td>{t.tokens?.toLocaleString() ?? '—'}</td><td>{dollars(t.usd)}</td></tr>)}</tbody></table>
        {report && !tasks.length && <div className="usage-empty">暂无官方生图记录</div>}</div>
    </section></div></ModalPortal>;
}

export default function OfficialUsage() {
  const [open, setOpen] = useState(false);
  return <><button className="official-billing-link" onClick={() => setOpen(true)}>官方用量</button>
    {open && <OfficialUsageDialog close={() => setOpen(false)}/>}</>;
}
