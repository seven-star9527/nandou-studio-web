import { useEffect, useRef, useState } from 'react';
import { authRequest } from '../auth';
import { useModalDialog } from '../useModalDialog';
import ModalPortal from './ModalPortal';
import Icon from './Icon';

type Metric = number | null;
type TimeValue = string | number | null;
interface UsageUser { id: string; email: string; created_at: TimeValue; last_seen: TimeValue; last_ip: string | null; tasks: Metric; images: Metric; credits: Metric }
interface UsageTask { id: string; owner_email: string; model: string | null; status: string; requested: Metric; completed: Metric; started_at: TimeValue; seconds: Metric; credits: Metric; hidden_at: TimeValue }
interface UsageOverview { summary: { users: Metric; tasks: Metric; images: Metric; credits: Metric }; users: UsageUser[]; tasks: UsageTask[] }

function metric(value: Metric | undefined, maximumFractionDigits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits }) : '—';
}
function time(value: TimeValue | undefined) {
  if (value == null || value === '') return '—';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
const taskStates: Record<string, string> = { queued: '排队中', processing: '生成中', generating: '生成中', complete: '已完成', completed: '已完成', succeeded: '已完成', failed: '失败', cancelled: '已取消', canceled: '已取消', delivery_pending: '等待交付', submitting: '提交中', submitted: '已提交', outcome_unknown: '待核对' };

function UsageDialog({ close }: { close: () => void }) {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [tab, setTab] = useState<'users' | 'tasks'>('users');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(true, dialog, close);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void authRequest<UsageOverview>('admin/overview', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '使用情况读取失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const query = search.trim().toLowerCase();
  const users = data?.users.filter(user => !query || user.email.toLowerCase().includes(query) || user.last_ip?.includes(query)) ?? [];
  const tasks = data?.tasks.filter(task => !query || `${task.owner_email} ${task.model ?? ''} ${task.id}`.toLowerCase().includes(query)) ?? [];
  return <ModalPortal><div className="modal-backdrop admin-usage-backdrop" onClick={close}><section className="admin-usage modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="usage-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
    <div className="admin-usage-heading"><div><p className="auth-eyebrow">ADMINISTRATION</p><h2 id="usage-title">访问与使用情况</h2><p>全账号统计，用户移除记录后仍保留。</p></div><div className="admin-heading-actions"><button className="icon-button" disabled={loading} aria-label="刷新使用情况" onClick={() => setRevision(previous => previous + 1)}><Icon name="refresh" size={18} /></button><button className="icon-button" aria-label="关闭使用情况" onClick={close}><Icon name="close" /></button></div></div>
    {error ? <p className="auth-message auth-error" role="alert">{error}</p> : null}
    <div className="usage-summary" aria-busy={loading}>{[['注册账号', data?.summary.users], ['任务总数', data?.summary.tasks], ['已交付图片', data?.summary.images], ['实际消耗积分', data?.summary.credits]].map(([label, value], index) => <div key={String(label)}><span>{label}</span><strong>{metric(value as Metric | undefined, index === 3 ? 5 : 0)}</strong></div>)}</div>
    <div className="usage-controls"><div className="usage-tabs" aria-label="使用情况视图"><button className={tab === 'users' ? 'selected' : ''} aria-pressed={tab === 'users'} onClick={() => setTab('users')}>账号与访问</button><button className={tab === 'tasks' ? 'selected' : ''} aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>任务明细</button></div><input aria-label={tab === 'users' ? '搜索邮箱或 IP' : '搜索邮箱、模型或任务'} type="search" value={search} placeholder={tab === 'users' ? '搜索邮箱或 IP' : '搜索邮箱、模型或任务'} onChange={event => setSearch(event.target.value)} /></div>
    <div className="usage-table-wrap" aria-busy={loading}>
      {tab === 'users' ? <table className="usage-table"><caption className="sr-only">账号访问和用量统计</caption><thead><tr><th>账号</th><th>最近访问</th><th>来源 IP</th><th className="numeric">任务</th><th className="numeric">交付图片</th><th className="numeric">实际积分</th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><strong>{user.email}</strong><small>注册于 {time(user.created_at)}</small></td><td>{time(user.last_seen)}</td><td>{user.last_ip ?? '—'}</td><td className="numeric">{metric(user.tasks)}</td><td className="numeric">{metric(user.images)}</td><td className="numeric">{metric(user.credits, 5)}</td></tr>)}</tbody></table> : <table className="usage-table usage-task-table"><caption className="sr-only">全账号任务使用明细</caption><thead><tr><th>账号 / 模型</th><th>任务状态</th><th className="numeric">交付 / 请求</th><th className="numeric">用时</th><th className="numeric">实际积分</th><th>开始时间</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td><strong>{task.owner_email}</strong><span>{task.model ?? '模型待记录'}</span><small title={task.id}>{task.id}</small></td><td><span className={`usage-state usage-state-${task.status}`}>{taskStates[task.status] ?? task.status}</span>{task.hidden_at ? <small className="usage-hidden">用户已移除<br />{time(task.hidden_at)}</small> : null}</td><td className="numeric">{metric(task.completed)} / {metric(task.requested)}</td><td className="numeric">{typeof task.seconds === 'number' ? `${metric(task.seconds, 1)} 秒` : '—'}</td><td className="numeric">{metric(task.credits, 5)}</td><td>{time(task.started_at)}</td></tr>)}</tbody></table>}
      {!loading && (tab === 'users' ? !users.length : !tasks.length) ? <div className="usage-empty">{query ? '没有匹配的记录' : tab === 'users' ? '暂无账号记录' : '暂无任务记录'}</div> : null}
      {loading ? <div className="usage-loading" role="status">正在读取使用情况…</div> : null}
    </div><p className="usage-note">“—”表示尚无可核对的数据；实际积分按任务记录汇总，待回填费用不会记为零。</p>
  </section></div></ModalPortal>;
}

export default function AdminUsage() {
  const [open, setOpen] = useState(false);
  return <><button className="account-usage-button" onClick={() => setOpen(true)}><Icon name="settings" size={15} />使用情况</button>{open ? <UsageDialog close={() => setOpen(false)} /> : null}</>;
}
