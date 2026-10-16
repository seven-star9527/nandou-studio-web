import type { Artwork, Job, StudioQueue, StudioTaskSnapshot } from './types.ts';

const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const terminal = (phase: Job['phase']) => ['complete', 'error', 'interrupted'].includes(phase);

export function queueJobPatch(job: Job, incoming: StudioQueue): Partial<Job> {
  if (job.source === 'cloud' || incoming.task_id !== job.id || terminal(job.phase)) return {};
  if (!['queued', 'running'].includes(incoming.state) || ![incoming.ahead, incoming.waited_seconds].every(nonnegative)) return {};
  if (job.queue?.state === 'running' && incoming.state === 'queued') return {};
  const ahead = incoming.state === 'running' ? 0 : Math.floor(Math.min(incoming.ahead, job.queue?.ahead ?? incoming.ahead));
  const samples = nonnegative(incoming.estimate_samples) ? Math.floor(incoming.estimate_samples) : 0;
  const queue: StudioQueue = { ...incoming, ahead, position: ahead + 1,
    waited_seconds: Math.max(incoming.waited_seconds, job.queue?.waited_seconds ?? 0), estimate_samples: samples,
    estimated_wait_seconds: ahead === 0 ? 0 : samples >= 2 && nonnegative(incoming.estimated_wait_seconds) ? incoming.estimated_wait_seconds : null };
  return { queue, ...(job.restored && nonnegative(incoming.completed) ? { completed: Math.min(job.requested, Math.max(job.completed, incoming.completed!)) } : {}),
    ...(job.phase === 'stopping' ? {} : { phase: incoming.state === 'queued' ? 'queued' : job.restored ? 'generating' : ['connecting', 'queued'].includes(job.phase) ? 'loading' : job.phase }) };
}

export function queueEstimateLabel(queue: StudioQueue) {
  if (queue.ahead === 0) return queue.state === 'running' ? '已进入本地生成' : '即将开始生成';
  const seconds = queue.estimated_wait_seconds;
  if (seconds == null || !nonnegative(seconds)) return queue.estimate_samples >= 2 ? '预计等待时间正在重新估算' : '预计等待时间正在估算（历史样本不足）';
  const duration = seconds < 60 ? `${Math.max(1, Math.ceil(seconds))} 秒` : seconds < 3600 ? `${Math.ceil(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
  return `预计等待约 ${duration}（基于历史任务动态估算）`;
}

export function restoreQueuedJob(snapshot: StudioTaskSnapshot | null | undefined, queue: StudioQueue | null | undefined): Job | null {
  if (!snapshot || !['queued', 'processing'].includes(snapshot.status) || !snapshot.task_id || !Number.isInteger(snapshot.requested) || snapshot.requested < 1) return null;
  const started = Date.parse(snapshot.created_utc);
  if (!Number.isFinite(started)) return null;
  const job: Job = { id: snapshot.task_id, started, requested: snapshot.requested,
    completed: Math.max(0, Math.min(snapshot.requested, snapshot.completed || 0)), phase: snapshot.status === 'queued' ? 'queued' : 'generating', source: 'local', restored: true, model: snapshot.model };
  return queue ? { ...job, ...queueJobPatch(job, queue) } : job;
}

/** A ledger completion triggers readback; only delivered task images confirm success. */
export function restoredTaskPatch(job: Job, snapshot: StudioTaskSnapshot, artworks?: Artwork[]): Partial<Job> | null {
  if (!job.restored || job.id !== snapshot.task_id || terminal(job.phase)) return null;
  if (snapshot.status === 'cancelled') return { phase: 'interrupted', queue: undefined, percent: undefined, error: undefined };
  if (snapshot.status === 'failed') return { phase: 'error', queue: undefined, error: '本地任务未完成，请查看任务记录。' };
  if (snapshot.status === 'outcome_unknown') return { phase: 'unknown', queue: undefined, error: '后台任务结果尚未确认，请刷新创作记录。' };
  if (snapshot.status !== 'completed') return null;
  const delivered = artworks ? new Set(artworks.filter(item => item.taskId === job.id).map(item => item.url)).size : job.completed;
  const complete = Boolean(artworks && delivered >= job.requested);
  return { phase: complete ? 'complete' : 'delivery_pending', completed: Math.min(job.requested, delivered), queue: undefined,
    percent: complete ? 1 : undefined, error: complete ? undefined : '后台任务已结束，正在核对已保存的图片。' };
}
