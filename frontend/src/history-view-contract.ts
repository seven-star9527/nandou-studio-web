import type { Artwork, CloudTask, Job } from './types.ts';

export type HistoryScope = 'all' | 'current';
export type HistoryStatus = 'all' | 'completed' | 'active' | 'failed';
export interface HistoryFilters { owner: string; model: string; days: number; status: HistoryStatus; }
export const INITIAL_HISTORY_FILTERS: HistoryFilters = { owner: '', model: '', days: 0, status: 'all' };
export const isActiveJob = (job: Job | null) => Boolean(job && ['connecting', 'queued', 'loading', 'generating', 'stopping', 'background', 'unknown', 'delivery_pending'].includes(job.phase));
export const isTerminalTask = (task: CloudTask) => ['completed', 'failed', 'cancelled'].includes(task.status);

function matches(owner: string | undefined, model: string | undefined, created: string | undefined, status: Exclude<HistoryStatus, 'all'>, filters: HistoryFilters, now: number) {
  return (!filters.owner || owner === filters.owner) && (!filters.model || model === filters.model)
    && (!filters.days || Boolean(created && Date.parse(created) >= now - filters.days * 86400000))
    && (filters.status === 'all' || filters.status === status);
}
export function filterArtworks(artworks: Artwork[], scope: HistoryScope, filters: HistoryFilters, now = Date.now()) {
  return artworks.filter(item => (scope !== 'current' || item.current) && matches(item.ownerId, item.model, item.generatedAt, 'completed', filters, now));
}
export function filterCloudTasks(tasks: CloudTask[], scope: HistoryScope, job: Job | null, filters: HistoryFilters, now = Date.now()) {
  return tasks.filter(task => (scope !== 'current' || task.request_id === job?.id)
    && matches(task.studio_owner_id, task.model, task.created_utc, task.status === 'completed' ? 'completed' : task.status === 'failed' || task.status === 'cancelled' ? 'failed' : 'active', filters, now));
}

export function emptyHistoryState(input: { scope: HistoryScope; loading: boolean; error: string; job: Job | null; allCount: number; visibleCount: number; attentionCount: number; filtered: boolean }) {
  if (input.visibleCount || input.attentionCount) return null;
  if (input.loading) return { kind: 'loading', title: '正在读取创作记录', description: '请稍候，作品和任务状态正在同步。' } as const;
  if (input.error) return { kind: 'error', title: '暂时无法读取记录', description: '现有作品不会因此丢失，请稍后刷新。' } as const;
  if (isActiveJob(input.job)) return { kind: 'active', title: input.job?.phase === 'queued' ? '正在等待生成' : '作品正在生成中', description: input.job?.phase === 'queued' ? '任务已进入队列，轮到后会自动开始，无需重复提交。' : '完成后的图片会直接出现在这里，无需重复提交。' } as const;
  if (input.filtered) return { kind: 'filtered', title: '没有符合条件的记录', description: '调整筛选条件，查看其他创作。' } as const;
  if (input.scope === 'current') return { kind: input.allCount ? 'current-with-history' : 'current', title: '本次尚未生成作品', description: '这里仅展示本页面打开后生成的作品；历史作品保留在“全部”中。' } as const;
  return { kind: 'all', title: '开始你的第一次创作', description: '输入提示词或添加参考图，生成后会保存在这里。' } as const;
}

/** Refreshes are authoritative for successful sources, retaining only an in-flight task absent from the response. */
export function reconcileHistory(previous: Artwork[], local: Artwork[] | undefined, cloud: Artwork[] | undefined, activeTaskId?: string, hidden = new Set<string>()) {
  const incoming = [...(cloud ?? previous.filter(item => item.source === 'cloud')), ...(local ?? previous.filter(item => item.source !== 'cloud'))];
  const oldByUrl = new Map(previous.map(item => [item.url, item]));
  const seen = new Set(incoming.map(item => item.url));
  const active = previous.filter(item => activeTaskId && item.taskId === activeTaskId && !seen.has(item.url));
  return [...active, ...incoming.map(item => ({ ...oldByUrl.get(item.url), ...item, current: item.current || oldByUrl.get(item.url)?.current }))]
    .filter(item => !item.taskId || !hidden.has(item.taskId));
}
