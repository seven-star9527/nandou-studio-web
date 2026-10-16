import type { GenerationMessage, Job } from './types.ts';

const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;

// Node progress resets during decode and for each image. Only the workflow
// fraction belongs in the task bar; delivery is the only 100% signal.
export function localProgress(job: Job, progress: NonNullable<GenerationMessage['gen_progress']>): Partial<Job> {
  const rawIndex = Number(progress.batch_index);
  const index = Number.isInteger(rawIndex) && rawIndex >= 0 ? Math.min(job.requested - 1, rawIndex) : Math.min(job.requested - 1, job.completed);
  const workflow = unit(progress.overall_percent) ?? (unit(progress.current_percent) ?? 0) * .8;
  const percent = Math.max(job.percent ?? 0, Math.min(.98, (index + workflow) / job.requested * .98), job.completed / job.requested * .98);
  if (job.progressBatch != null && index < job.progressBatch) return { percent };
  const finalizing = (job.progressBatch === index && job.progressStage === 'finalizing') || workflow >= .9;
  return { phase: 'generating', percent, progressBatch: index, progressStage: finalizing ? 'finalizing' : 'sampling', preview: progress.preview ?? job.preview };
}

export function mergeJobProgress(job: Job, patch: Partial<Job>): Job {
  if (job.phase === 'complete' && patch.phase && ['connecting', 'queued', 'loading', 'generating', 'delivery_pending'].includes(patch.phase)) return job;
  const next = { ...job, ...patch };
  if (next.phase === 'complete') next.percent = 1;
  else if (['connecting', 'queued', 'loading', 'generating', 'stopping', 'delivery_pending'].includes(next.phase)) {
    const values = [unit(job.percent), unit(patch.percent)].filter((value): value is number => value != null);
    next.percent = values.length ? Math.min(.98, Math.max(...values)) : undefined;
  }
  return next;
}
