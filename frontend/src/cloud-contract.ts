import { createId } from './id.ts';
import type { CloudModelCapability, CloudOperation, CloudRequest, CloudTask, GenerationSettings, ReferenceImage, Artwork, Job } from './types.ts';
import { gifParameters, isCreditAmount } from './credit-contract.ts';

export function currentCloudModel(id: string) {
  return id.replace(/^gpt-image-2[.]5-(flare|sunburst)$/, 'gpt-image-2.6-$1');
}

export function cloudDimensions(model: CloudModelCapability, ratio: string, resolution: string) {
  const pair = model.sizeMap[resolution]?.[ratio];
  return pair ? { width: pair[0], height: pair[1] } : { width: 0, height: 0 };
}
export function referenceLimit(model: CloudModelCapability) {
  return model.maxReferences == null ? model.appMaxReferences : Math.min(model.maxReferences, model.appMaxReferences);
}
export function buildCloudRequest(model: CloudModelCapability, settings: GenerationSettings, operation: CloudOperation, prompt: string, references: ReferenceImage[], configured: boolean): CloudRequest {
  if (!configured) throw new Error('APIMart 尚未配置密钥，请完成服务端配置后刷新连接。');
  if (!model.operations.includes(operation)) throw new Error('当前模型不支持所选创作方式。');
  if (!prompt.trim()) throw new Error('请填写提示词。');
  if (operation === 'edit' && !references.length) throw new Error('参考图编辑需要至少一张参考图。');
  if (references.length > referenceLimit(model)) throw new Error(`当前模型最多可添加 ${referenceLimit(model)} 张参考图。`);
  if (!Number.isInteger(settings.count) || settings.count < 1 || settings.count > model.maxImages) throw new Error(`生成数量需为1至${model.maxImages}张。`);
  if (!model.resolutions.includes(settings.resolution)) throw new Error('当前模型不支持所选分辨率。');
  let size = settings.ratio;
  const gif = settings.outputFormat === 'gif';
  const svg = settings.outputFormat === 'svg';
  if (svg && (!model.id.startsWith('gpt-image-2.6-') || settings.count !== 1)) throw new Error('SVG 需要 GPT Image 2.6，每次一张。');
  if (gif) {
    if (!model.id.startsWith('gpt-image-2.6-')) throw new Error('GIF 需要 GPT Image 2.6 模型。');
    const {frame_count: frames, frame_duration_ms: duration} = gifParameters(settings);
    const w = settings.gifWidth ?? 512, h = settings.gifHeight ?? 512;
    if (!Number.isInteger(frames) || frames < 2 || frames > 16) throw new Error('GIF 帧数需为 2 至 16 的整数。');
    if (!Number.isInteger(duration) || duration < 20 || duration > 655350 || duration % 10) throw new Error('每帧时长需为 20 至 655350 毫秒，并按 10 毫秒对齐。');
    const [cols, rows] = frames <= 8 ? [4,2] : frames === 9 ? [3,3] : frames <= 12 ? [4,3] : [4,4];
    const a = Math.min(w,h) * cols, b = Math.max(w,h) * rows;
    if (![w,h].every(v => Number.isInteger(v) && v > 0 && v % 16 === 0) || Math.max(a,b) > 3840 || a*b > 8294400 || Math.max(a,b) > 3*Math.min(a,b)) throw new Error('GIF 单帧尺寸或拼图超限，请减少帧数或缩小尺寸。');
  } else if (size === 'custom') {
    const exact = model.exactSize;
    if (!exact?.supported) throw new Error('当前模型不支持自定义像素尺寸。');
    const { width, height } = settings;
    const pixels = width * height;
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value % exact.multiple === 0)) throw new Error(`自定义尺寸需按${exact.multiple}像素对齐。`);
    if (Math.max(width, height) > exact.maxSide || pixels < exact.minPixels || pixels > exact.maxPixels || Math.max(width / height, height / width) > exact.maxAspect) throw new Error('自定义尺寸超出当前模型的像素或宽高比限制。');
    size = `${width}x${height}`;
  } else if (!model.ratios.includes(size)) throw new Error('当前模型不支持所选比例。');
  if (/^gpt-image-2[.][56]-/.test(model.id) && settings.quality === 'max') throw new Error('GPT Image 2.6 已禁用 max 档位，请重新选择图像质量。');
  if (settings.quality && !model.qualities.includes(settings.quality)) throw new Error('当前模型不支持所选质量参数。');
  return { request_id: createId(), model: model.id, operation, prompt: prompt.trim(),
    resolution: settings.resolution, n: settings.count, ...(settings.quality ? { quality: settings.quality } : {}),
    ...(gif ? gifParameters(settings) : svg ? {size, output_format:'svg' as const, ...(settings.svgTransparent ? {background:'transparent' as const} : {})} : {size}), reference_images: references.map(image => image.dataUrl) };
}

export function cloudImageUrl(path: string): string | null {
  if (/[\u0000-\u0020\\]/.test(path)) return null;
  if (/^https:\/\//i.test(path)) {
    try { const url = new URL(path); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  // Cached files are the only relative image paths emitted by the cloud API.
  if (/^\/?studio-results\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(path)) return path.startsWith('/') ? path : `/${path}`;
  return null;
}

export function mergeArtwork(previous: Artwork[], artwork: Artwork): Artwork[] {
  const earlier = previous.find(item => item.id === artwork.id || item.url === artwork.url);
  return [{ ...artwork, current: artwork.current || earlier?.current }, ...previous.filter(item => item.id !== artwork.id && item.url !== artwork.url)];
}

export function cloudDelivery(task: CloudTask, requested = Number(task.parameters?.n) || 1) {
  const locallySaved = (task.images ?? []).filter(image => cloudImageUrl(image.url)?.startsWith('/studio-results/') && !image.download_error).length;
  const delivered = Math.max(0, Math.min(requested, task.delivered_images ?? locallySaved));
  const complete = task.status === 'completed' && delivered >= requested && (!task.delivery_status || task.delivery_status === 'complete');
  const error = (task.images ?? []).find(image => image.download_error)?.download_error;
  return { delivered, requested, complete, message: task.status === 'completed' && !complete
    ? `云端生成已结束，本地已保存 ${delivered}/${requested} 张。${error ?? task.result_warning ?? '缓存尚未完整，可刷新记录重试转存。远程结果可能到期，请及时保存。'}` : undefined };
}

export function cloudJobUpdate(task: CloudTask, requested: number, waiting: boolean): Pick<Job, 'phase' | 'completed' | 'percent' | 'error' | 'taskCreditsCost' | 'taskCostSettled'> {
  const delivery = cloudDelivery(task, requested);
  const phases: Record<CloudTask['status'], Job['phase']> = { uploading: 'connecting', submitting: 'connecting', submitted: 'queued', pending: 'queued', processing: 'generating', completed: delivery.complete ? 'complete' : 'delivery_pending', failed: 'error', cancelled: 'interrupted', outcome_unknown: 'unknown' };
  const terminal = ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(task.status);
  return { phase: !waiting && !terminal ? 'background' : phases[task.status], completed: delivery.delivered,
    percent: typeof task.progress === 'number' && task.status !== 'completed' ? Math.max(0, Math.min(1, task.progress / 100)) : undefined,
    taskCreditsCost: isCreditAmount(task.credits_cost) ? task.credits_cost : undefined,
    taskCostSettled: ['completed', 'failed', 'cancelled'].includes(task.status),
    error: task.error ?? delivery.message ?? task.poll_error ?? (task.status === 'outcome_unknown' ? '结果尚未确认，请刷新记录读回，不要重复提交。' : undefined) };
}

export function cloudTaskNeedsReadback(task: CloudTask) {
  return ['uploading', 'submitting', 'submitted', 'pending', 'processing', 'outcome_unknown'].includes(task.status) || (task.status === 'completed' && !cloudDelivery(task).complete);
}

export function cloudArtworkSettings(artwork: Artwork, model: CloudModelCapability, previous: GenerationSettings) {
  let info: { parameters?: Record<string, unknown>; operation?: CloudOperation } = {};
  try { info = JSON.parse(artwork.metadata ?? '{}').studio_cloud ?? {}; } catch { /* Old history may not include structured parameters. */ }
  const p = info.parameters ?? {};
  const resolution = model.resolutions.find(value => value.toLowerCase() === String(p.resolution).toLowerCase()) ?? model.resolutions[0];
  const size = String(p.size ?? '');
  const exact = size.match(/^(\d+)x(\d+)$/);
  const ratio = exact && model.exactSize?.supported ? 'custom' : model.ratios.includes(size) ? size : model.ratios.includes('1:1') ? '1:1' : model.ratios[0];
  const pixels = ratio === 'custom' && exact ? { width: Number(exact[1]), height: Number(exact[2]) } : cloudDimensions(model, ratio, resolution);
  const quality = model.qualities.includes(String(p.quality)) && !['auto', 'max'].includes(String(p.quality)) ? String(p.quality) : model.qualities.includes('medium') ? 'medium' : model.qualities[0] ?? '';
  return { settings: { ...previous, ratio: p.output_format === 'gif' ? '1:1' : ratio, resolution, ...(p.output_format === 'gif' ? cloudDimensions(model, '1:1', resolution) : pixels),
      svgTransparent: p.output_format === 'svg' && p.background === 'transparent',
      outputFormat: p.output_format === 'gif' ? 'gif' as const : p.output_format === 'svg' ? 'svg' as const : 'png' as const,
      gifWidth: p.output_format === 'gif' && exact ? Number(exact[1]) : 512, gifHeight: p.output_format === 'gif' && exact ? Number(exact[2]) : 512,
      frameCount: Number(p.frame_count) || 9, frameDurationMs: Number(p.frame_duration_ms) || 200, count: Math.max(1, Math.min(model.maxImages, Number(p.n) || 1)), quality },
    operation: info.operation && model.operations.includes(info.operation) ? info.operation : model.preferredOperation };
}

export function taskArtworks(task: CloudTask, current = false): Artwork[] {
  const safeParameters = Object.fromEntries(Object.entries(task.parameters ?? {}).filter(([key]) => ['operation', 'size', 'resolution', 'n', 'quality', 'reference_count', 'background', 'output_format', 'frame_count', 'frame_duration_ms'].includes(key)));
  return (task.images ?? []).flatMap(image => { const url = cloudImageUrl(image.url); return url ? [{ id: `${task.request_id}-${image.index}`, url,
    prompt: task.prompt, width: image.width, height: image.height, model: task.model, current,
    taskId: task.studio_task_id ?? task.request_id, ownerId: task.studio_owner_id, ownerEmail: task.studio_owner_email, ownerName: task.studio_owner_name, hiddenAt: task.studio_hidden_at,
    generatedAt: task.created_utc, completedAt: task.completed_utc,
    duration: typeof task.actual_time === 'number' && Number.isFinite(task.actual_time) && task.actual_time >= 0 ? task.actual_time : undefined,
    batchIndex: image.index, batchSize: Math.max(task.images.length, Number(task.parameters?.n) || 0), source: 'cloud' as const, locallySaved: url.startsWith('/studio-results/') && !image.download_error,
    downloadError: image.download_error, mimeType: image.mime_type,
    taskCreditsCost: isCreditAmount(task.credits_cost) ? task.credits_cost : undefined,
    taskCostSettled: ['completed', 'failed', 'cancelled'].includes(task.status),
    metadata: JSON.stringify({ studio_cloud: { request_id: task.request_id, model: task.model, status: task.status,
      provider_status: task.provider_status, delivery_status: task.delivery_status, delivered_images: task.delivered_images,
      operation: task.operation, reference_count: task.reference_count,
      credits_cost: isCreditAmount(task.credits_cost) ? task.credits_cost : undefined,
      mime_type: image.mime_type, parameters: safeParameters } }, null, 2) }] : []; });
}
