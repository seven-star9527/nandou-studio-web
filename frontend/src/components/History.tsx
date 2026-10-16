import GlassTabs from './GlassTabs';
import GlassSelect from './GlassSelect';
import { useEffect, useRef, useState } from 'react';
import type { Artwork, CloudTask, Job } from '../types';
import { useModalDialog } from '../useModalDialog';
import Icon from './Icon';
import { cloudDelivery } from '../cloud-contract';
import ModalPortal from './ModalPortal';
import { isCreditAmount, taskCostLabel } from '../credit-contract';
import { emptyHistoryState, filterArtworks, filterCloudTasks, INITIAL_HISTORY_FILTERS, isActiveJob, isTerminalTask, type HistoryFilters, type HistoryScope } from '../history-view-contract';
import '../history-refresh.css';
import { queueEstimateLabel } from '../queue-contract';

function historyModelLabel(model: string) {
  if (model.startsWith('qwen_image_2.1_turbo')) return 'Qwen-Image-2.1 · Turbo';
  if (model.startsWith('qwen_image_2.1')) return 'Qwen-Image-2.1 · 标准';
  return ({'gpt-image-2.5-flare':'GPT Image 2.5 Flare','gpt-image-2.5-sunburst':'GPT Image 2.5 Sunburst','gemini-nano-banana-2.1':'Nano Banana 2.1'} as Record<string,string>)[model] ?? model;
}

const PHASES: Record<Job['phase'], string> = {
  connecting: '正在提交', queued: '等待生成', loading: '正在准备模型', generating: '正在生成', stopping: '正在停止', complete: '生成完成', error: '生成未完成', interrupted: '已停止', background: '已停止等待', unknown: '结果待确认', delivery_pending: '本地缓存未完整',
};
export function isBusy(job: Job | null) { return Boolean(job && ['connecting', 'queued', 'loading', 'generating', 'stopping'].includes(job.phase)); }

function ArtworkImage({ artwork }: { artwork: Artwork }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [artwork.url]);
  return failed ? <span className="image-unavailable"><Icon name="image" size={30} /><span>图像暂时无法预览</span><small>{artwork.locallySaved === false ? '可尝试打开远程原图，或刷新记录重新转存。' : '请刷新记录或检查图像服务。'}</small></span>
    : <img src={artwork.url} alt={artwork.prompt || '生成图像'} loading="lazy" onError={() => setFailed(true)} />;
}

function DownloadLink({ artwork, compact = false }: { artwork: Artwork; compact?: boolean }) {
  const remote = artwork.source === 'cloud' && artwork.locallySaved === false;
  const label = remote ? '打开远程原图' : '下载原图';
  return <a className={compact ? 'icon-button' : 'primary-button'} href={artwork.url} download={remote ? undefined : true}
    target={remote ? '_blank' : undefined} rel={remote ? 'noopener noreferrer' : undefined} title={label} aria-label={label}>
    <Icon name="download" size={compact ? 16 : 17} />{compact ? null : label}
  </a>;
}

function GenerationStatus({ job, stop, remove }: { job: Job; stop: () => void; remove?: () => void }) {
  const [now, setNow] = useState(Date.now());
  const busy = isBusy(job);
  const queueWaiting = job.queue?.state === 'queued' && ['queued', 'stopping'].includes(job.phase);
  const phaseLabel = queueWaiting ? job.phase === 'stopping' ? '正在取消排队' : '等待本地生成'
    : job.phase === 'queued' && job.source === 'cloud' ? '云端等待生成'
    : job.phase === 'generating' && job.source !== 'cloud'
      ? job.restored ? '后台正在生成' : job.progressStage === 'finalizing' ? '正在解码与保存' : `正在生成第 ${Math.min(job.requested, (job.progressBatch ?? job.completed) + 1)} 张`
      : PHASES[job.phase];
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  return <div className={`generation-status ${job.phase === 'error' ? 'job-error' : ''}`} role="status" aria-live="polite">
    {job.preview && busy ? <img className="job-preview" src={job.preview} alt="当前生成预览" /> : <div className={`status-symbol ${busy ? 'spinning' : ''}`}><Icon name={busy ? 'spark' : job.phase === 'complete' ? 'check' : 'stop'} size={21} /></div>}
    <div className="status-text"><strong>{phaseLabel}<span>{job.completed} / {job.requested} 张</span></strong>
      <p>{job.error ?? (queueWaiting && job.queue ? `前方 ${job.queue.ahead} 个任务 · 队列第 ${job.queue.position} 位 · 已等待 ${Math.floor(job.queue.waited_seconds)} 秒`
        : busy ? `已用时 ${Math.max(0, Math.floor((now - job.started) / 1000))} 秒${job.percent != null ? ` · 整任务 ${Math.floor(job.percent * 100)}%` : ''}` : job.phase === 'background' ? '后台任务继续，可刷新创作记录确认结果。' : job.phase === 'complete' ? '图像已保存到创作记录。' : '已返回的图像保留在创作记录中。')}</p>
      {queueWaiting && job.queue ? <p className="queue-estimate">{queueEstimateLabel(job.queue)}</p> : null}
      {job.source === 'cloud' && job.phase === 'queued' ? <p className="queue-estimate">由云端处理，暂未提供可核实的队列位置或预计等待时间。</p> : null}
      {job.restored && busy ? <p className="queue-estimate">已恢复后台任务，完成后自动同步作品。</p> : null}
      {job.source === 'cloud' && isCreditAmount(job.taskCreditsCost) ? <p className="actual-task-cost">{taskCostLabel(job.taskCreditsCost, job.taskCostSettled)}</p> : null}
      {busy && !queueWaiting && job.percent != null ? <div className="job-progress"><span style={{ width: `${job.percent * 100}%` }} /></div> : null}
    </div>
    {busy && job.phase !== 'stopping' ? <button className="quiet-button stop-button" onClick={stop}><Icon name="stop" size={15} />{job.source === 'cloud' ? '停止等待' : queueWaiting ? '取消排队' : '停止'}</button> : null}
    {!busy && remove ? <button className="icon-button" onClick={remove} title="从我的记录中移除此任务" aria-label="移除任务记录"><Icon name="trash" size={16} /></button> : null}
  </div>;
}

export default function History({ artworks, cloudTasks, job, loading, error, refresh, stop, reuse, hideTask, currentUserId, isAdmin = false }: {
  artworks: Artwork[]; job: Job | null; loading: boolean; error: string;
  cloudTasks: CloudTask[];
  refresh: () => void; stop: () => void; reuse: (artwork: Artwork) => void;
  hideTask: (taskId: string) => Promise<void>; isAdmin?: boolean; currentUserId: string;
}) {
  const [showRemoved, setShowRemoved] = useState(false);
  const [filter, setFilter] = useState<HistoryScope>('all');
  const [filters, setFilters] = useState<HistoryFilters>(INITIAL_HISTORY_FILTERS);
  const [selected, setSelected] = useState<Artwork | null>(null);
  const [removing, setRemoving] = useState<{ id: string; count: number } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const removeDialog = useRef<HTMLElement>(null);
  useModalDialog(Boolean(selected), dialog, () => setSelected(null));
  useModalDialog(Boolean(removing), removeDialog, () => { if (!removeBusy) setRemoving(null); });
  const appliedFilters = isAdmin ? filters : INITIAL_HISTORY_FILTERS;
  const displayedArtworks = artworks.filter(item => showRemoved || item.ownerId !== currentUserId || !item.hiddenAt);
  const displayedTasks = cloudTasks.filter(item => showRemoved || item.studio_owner_id !== currentUserId || !item.studio_hidden_at);
  const visible = filterArtworks(displayedArtworks, filter, appliedFilters);
  const attentionTasks = filterCloudTasks(displayedTasks, filter, job, appliedFilters).filter(task => task.request_id !== job?.id && (['uploading', 'submitting', 'submitted', 'pending', 'processing', 'outcome_unknown', 'failed', 'cancelled'].includes(task.status) || (task.status === 'completed' && !cloudDelivery(task).complete)));
  const hasFilters = Object.entries(appliedFilters).some(([key, value]) => value !== INITIAL_HISTORY_FILTERS[key as keyof HistoryFilters]);
  const empty = emptyHistoryState({ scope: filter, loading, error, job, allCount: artworks.length, visibleCount: visible.length, attentionCount: attentionTasks.length, filtered: hasFilters });
  const owners = new Map<string, string>();
  for (const item of artworks) if (item.ownerId) owners.set(item.ownerId, item.ownerEmail ?? item.ownerId);
  for (const task of cloudTasks) if (task.studio_owner_id) owners.set(task.studio_owner_id, task.studio_owner_email ?? task.studio_owner_id);
  const modelOptions = [...new Set([...artworks.map(item => item.model), ...cloudTasks.map(task => task.model)].filter((model): model is string => Boolean(model)))];
  const canHide = (taskId: string | undefined) => {
    if (!taskId || (job?.id === taskId && isActiveJob(job))) return false;
    const artwork = artworks.find(item => item.taskId === taskId);
    const task = cloudTasks.find(item => (item.studio_task_id ?? item.request_id) === taskId);
    if (task && !isTerminalTask(task)) return false;
    const owner = artwork?.ownerId ?? task?.studio_owner_id;
    return (!isAdmin || owner === currentUserId || (!owner && job?.id === taskId)) && !artwork?.hiddenAt && !task?.studio_hidden_at;
  };
  const askRemove = (id: string) => {
    setSelected(null); setRemoveError('');
    setRemoving({ id, count: artworks.filter(item => item.taskId === id).length });
  };
  const confirmRemove = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true); setRemoveError('');
    try { await hideTask(removing.id); setRemoving(null); }
    catch (cause) { setRemoveError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRemoveBusy(false); }
  };
  useEffect(() => {
    if (!selected) return;
    const latest = artworks.find(item => item.id === selected.id);
    if (latest && latest !== selected) setSelected(latest);
  }, [artworks, selected]);
  return <section className="history-section" aria-labelledby="history-title">
    <div className="history-toolbar"><div className="history-heading"><h2 id="history-title">创作记录</h2><span className="history-count">{isAdmin ? '全部账号' : '仅自己可见'} · {visible.length} 张</span></div>
    <GlassTabs className="history-tabs segmented" role="tablist" aria-label="创作记录范围">
      <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>{isAdmin ? '全部作品' : '全部'}</button>
      <button role="tab" aria-selected={filter === 'current'} className={filter === 'current' ? 'selected' : ''} onClick={() => setFilter('current')} title="仅展示本页面打开后生成的作品">本次生成</button>
    </GlassTabs>
    <button className="history-refresh-button" onClick={refresh} disabled={loading} aria-label="刷新创作记录" title="刷新创作记录"><Icon name="refresh" size={16} className={loading ? 'spinning' : ''} /><span>{loading ? '读取中' : '刷新'}</span></button></div>
    {isAdmin ? <div className="history-admin-filters" aria-label="作品筛选"><label className="history-audit-toggle"><input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)}/>显示我已删除的记录</label>
      <GlassSelect label="账号" value={filters.owner} onChange={owner => setFilters(previous => ({...previous, owner}))} options={[{value:'',label:'全部账号'}, ...[...owners].map(([value,label]) => ({value,label}))]} />
      <GlassSelect label="模型" value={filters.model} onChange={model => setFilters(previous => ({...previous, model}))} options={[{value:'',label:'全部模型'}, ...modelOptions.map(value => ({value,label:historyModelLabel(value)}))]} />
      <GlassSelect label="时间" value={String(filters.days)} onChange={days => setFilters(previous => ({...previous, days:Number(days)}))} options={[{value:'0',label:'全部时间'},{value:'1',label:'最近 24 小时'},{value:'7',label:'最近 7 天'},{value:'30',label:'最近 30 天'}]} />
      <GlassSelect label="状态" value={filters.status} onChange={status => setFilters(previous => ({...previous, status:status as HistoryFilters['status']}))} options={[{value:'all',label:'全部状态'},{value:'completed',label:'已生成'},{value:'active',label:'进行中 / 待确认'},{value:'failed',label:'失败 / 已取消'}]} />
      {hasFilters ? <button className="text-button" onClick={() => setFilters(INITIAL_HISTORY_FILTERS)}>清除筛选</button> : null}
    </div> : null}
    {job ? <GenerationStatus job={job} stop={stop} remove={canHide(job.id) ? () => askRemove(job.id) : undefined} /> : null}
    {attentionTasks.length ? <div className="cloud-task-list">{attentionTasks.map(task => <div key={task.request_id}><span>{task.model}{isAdmin && task.studio_owner_email ? ` · ${task.studio_owner_email}` : ''}{isAdmin && task.studio_hidden_at ? ' · 用户已移除' : ''}</span><strong>{({ uploading: '上传参考图中', submitting: '提交结果待确认', submitted: '已提交', pending: '后台等待中', processing: '后台生成中', outcome_unknown: '结果待确认', failed: '历史任务失败', cancelled: '已取消', completed: '本地缓存未完整' } as Record<string, string>)[task.status]}</strong>{canHide(task.studio_task_id ?? task.request_id) && isTerminalTask(task) ? <button onClick={() => askRemove(task.studio_task_id ?? task.request_id)}>移除记录</button> : <button onClick={refresh} disabled={loading}>刷新记录</button>}{task.error || task.poll_error || cloudDelivery(task).message ? <p>{task.error ?? cloudDelivery(task).message ?? task.poll_error}</p> : null}{isTerminalTask(task) ? <small>刷新不会重试生成。{taskCostLabel(task.credits_cost ?? undefined, true)}</small> : null}</div>)}</div> : null}
    {error ? <p className="history-error" role="alert">创作记录读取失败：{error}</p> : null}
    {visible.length ? <div className="artwork-grid">
      {visible.map(artwork => <article className="artwork" key={artwork.id}>
        <button className="artwork-open" onClick={() => setSelected(artwork)} aria-label={`查看图像 ${artwork.prompt.slice(0, 30) || '创作记录'}`}>
          <ArtworkImage artwork={artwork} />
          <span className="artwork-expand"><Icon name="expand" size={20} /></span>
        </button>
        <div className="artwork-info"><p>{artwork.prompt || '生成图像'}</p>{isAdmin ? <span className="artwork-owner">{artwork.ownerEmail ?? '历史管理员作品'}{artwork.hiddenAt ? <em>用户已移除</em> : null}</span> : null}<div><span>{artwork.width && artwork.height ? `${artwork.width} × ${artwork.height}` : '图像'}</span><span className="artwork-card-actions"><DownloadLink artwork={artwork} compact />{canHide(artwork.taskId) ? <button onClick={() => askRemove(artwork.taskId!)} title="从我的记录中移除整个任务" aria-label="删除任务记录" className="history-delete-button"><Icon name="trash" size={15} /><span>删除</span></button> : null}</span></div>{artwork.source === 'cloud' ? <p className="task-cost">{taskCostLabel(artwork.taskCreditsCost, artwork.taskCostSettled)}</p> : null}{artwork.source === 'cloud' && artwork.locallySaved === false ? <p className="delivery-warning">{artwork.downloadError ?? '本地缓存未完成；远程原图可能到期，请及时保存。'}</p> : null}</div>
      </article>)}
    </div> : null}
    {empty ? <div className={`empty-history empty-${empty.kind}`} role="status"><div className="empty-history-art"><Icon name={empty.kind === 'loading' ? 'refresh' : empty.kind === 'active' ? 'spark' : 'emptyImage'} size={46} className={empty.kind === 'loading' ? 'spinning' : ''} /></div>
      <h3>{empty.title}</h3><p>{empty.description}</p>
      {empty.kind === 'current-with-history' ? <button className="quiet-button" onClick={() => setFilter('all')}>查看全部作品 <Icon name="arrow" size={15} /></button> : empty.kind === 'error' ? <button className="quiet-button" onClick={refresh}>重新读取</button> : empty.kind === 'filtered' ? <button className="quiet-button" onClick={() => setFilters(INITIAL_HISTORY_FILTERS)}>清除筛选</button> : null}
    </div> : null}
    {selected ? <ModalPortal><div className="modal-backdrop artwork-backdrop" onClick={() => setSelected(null)}>
      <section ref={dialog} tabIndex={-1} className="artwork-modal modal" role="dialog" aria-modal="true" aria-label="图像详情" onClick={event => event.stopPropagation()}>
        <button className="icon-button artwork-modal-close" onClick={() => setSelected(null)} aria-label="关闭图像详情"><Icon name="close" /></button>
        <div className="artwork-full"><ArtworkImage artwork={selected} /></div>
        <div className="artwork-detail"><h2>图像详情</h2><p className="detail-prompt">{selected.prompt || '此图像没有提示词记录。'}</p>
          <dl>{selected.width && selected.height ? <><dt>尺寸</dt><dd>{selected.width} × {selected.height} px</dd></> : null}{selected.seed != null ? <><dt>种子</dt><dd>{selected.seed}</dd></> : null}{selected.steps != null ? <><dt>步数</dt><dd>{selected.steps}</dd></> : null}{selected.duration != null ? <><dt>请求耗时</dt><dd>{selected.duration.toFixed(1)} 秒</dd></> : null}{selected.model ? <><dt>模型</dt><dd>{selected.model}</dd></> : null}{selected.source === 'cloud' ? <><dt>任务积分</dt><dd>{taskCostLabel(selected.taskCreditsCost, selected.taskCostSettled)}</dd></> : null}</dl>
          {selected.source === 'cloud' ? <p className={selected.locallySaved ? 'delivery-saved' : 'delivery-warning'}>{selected.locallySaved ? '原图已保存到本地。' : selected.downloadError ?? '本地缓存未完成；远程结果可能到期。可刷新创作记录重试转存。'}</p> : null}
          {isAdmin ? <p className="artwork-owner">所属账号：{selected.ownerEmail ?? '历史管理员作品'}{selected.hiddenAt ? ' · 用户已移除' : ''}</p> : null}
          <div className="detail-actions"><DownloadLink artwork={selected} /><button className="quiet-button" onClick={() => { reuse(selected); setSelected(null); }}>复用参数</button>{canHide(selected.taskId) ? <button className="quiet-button" onClick={() => askRemove(selected.taskId!)}><Icon name="trash" size={15} />移除任务</button> : null}</div>
          {selected.metadata ? <details><summary>生成信息</summary><pre>{selected.metadata}</pre></details> : null}
        </div>
      </section>
    </div></ModalPortal> : null}
    {removing ? <ModalPortal><div className="modal-backdrop" onClick={() => { if (!removeBusy) setRemoving(null); }}><section className="history-remove-dialog modal" ref={removeDialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="history-remove-title" onClick={event => event.stopPropagation()}>
      <h2 id="history-remove-title">删除我的任务记录？</h2><p>仅从你的常规记录中隐藏，图片文件与管理员审计记录仍保留。{removing.count > 1 ? `此任务的 ${removing.count} 张图片会一并移除。` : ''}</p>
      {removeError ? <p className="history-error" role="alert">{removeError}</p> : null}
      <div><button className="quiet-button" data-autofocus onClick={() => setRemoving(null)} disabled={removeBusy}>取消</button><button className="primary-button" onClick={() => void confirmRemove()} disabled={removeBusy}>{removeBusy ? '正在删除' : '确认删除'}</button></div>
    </section></div></ModalPortal> : null}
  </section>;
}
