import { createId } from './id';
import { useDraft } from './useDraft';
import { accountStorageKey } from './account-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDeployment, parseArtwork, SwarmClient } from './api';
import { availableModes, buildGenerationRequest, configurationIssue, modelDefaults } from './generation-contract';
import { dimensions } from './resolution-policy';
import { buildCloudRequest, cloudArtworkSettings, cloudDimensions, mergeArtwork, referenceLimit, taskArtworks } from './cloud-contract';
import { useCloudStudio } from './useCloudStudio';
import { useCloudQuote } from './useCloudQuote';
import { localProgress, mergeJobProgress } from './job-progress';
import { isActiveJob, reconcileHistory } from './history-view-contract';
import { queueJobPatch, restoreQueuedJob, restoredTaskPatch } from './queue-contract';
import type { Artwork, BackendStatus, DeploymentConfig, GenerationSettings, Job, Model, ParamSchema, RatioId, ReferenceImage, ResolutionId } from './types';

const INITIAL: GenerationSettings = { ratio: '1:1', resolution: '1K', width: 1024, height: 1024, count: 1, model: '', steps: 20, cfg: 7, seed: '-1' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useStudio() {
  const client = useRef(new SwarmClient()).current;
  const socket = useRef<WebSocket | null>(null);
  const activeJob = useRef<Job | null>(null);
  const paramsRef = useRef<ParamSchema[]>([]);
  const configRef = useRef<DeploymentConfig>({});
  const mounted = useRef(true);
  const hiddenTasks = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [status, setStatus] = useState<BackendStatus>({});
  const [params, setParams] = useState<ParamSchema[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [config, setConfig] = useState<DeploymentConfig>({});
  const [settings, setSettings] = useState<GenerationSettings>(INITIAL);
  const [draft, setDraft, draftReady, draftError] = useDraft(accountStorageKey('draft:studio'), { prompt: '', references: [] as ReferenceImage[], editing: false });
  const {prompt, references, editing} = draft;
  const setPrompt = useCallback((prompt: string) => setDraft(d => ({...d, prompt})), [setDraft]);
  const setReferences = useCallback((action: ReferenceImage[] | ((old: ReferenceImage[]) => ReferenceImage[])) => setDraft(d => ({...d, references: typeof action === 'function' ? action(d.references) : action})), [setDraft]);
  const setEditing = useCallback((editing: boolean) => setDraft(d => ({...d, editing})), [setDraft]);
  const [history, setHistory] = useState<Artwork[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [cloudModelId, setCloudModelId] = useState<string | null>(null);
  const receiveArtwork = useCallback((artwork: Artwork) => {
    if (!artwork.taskId || !hiddenTasks.current.has(artwork.taskId)) setHistory(previous => mergeArtwork(previous, artwork));
  }, []);
  const cloud = useCloudStudio(client, receiveArtwork);
  const loadCloudCapabilities = cloud.loadCapabilities;
  const refreshCloudTasks = cloud.refreshTasks;
  const cloudModel = cloud.capabilities?.models.find(model => model.id === cloudModelId);
  const creditQuote = useCloudQuote(client, connected, cloudModel, settings);
  const displayJob = cloud.job && (!job || cloud.job.started > job.started) ? cloud.job : job;
  const backendReady = ['running', 'some_loading'].includes(status.backend_status?.status ?? '');
  const localReady = cloud.capabilities?.localReadiness?.[settings.model] === true;
  const configurationError = configurationIssue(settings.model, params, config);

  const refreshHistory = useCallback(async () => {
    setLoadingHistory(true); setHistoryError('');
    try {
      const result = await Promise.allSettled([client.history(), refreshCloudTasks()]);
      if (!mounted.current) return;
      const images = result[0].status === 'fulfilled' ? result[0].value : undefined;
      const cloudImages = result[1].status === 'fulfilled' ? result[1].value.flatMap(task => taskArtworks(task)) : undefined;
      setHistory(previous => reconcileHistory(previous, images, cloudImages, isActiveJob(activeJob.current) ? activeJob.current?.id : undefined, hiddenTasks.current));
      if (result[0].status === 'rejected') setHistoryError(errorText(result[0].reason));
      if (result[1].status === 'rejected') { const cause = result[1].reason; setHistoryError(previous => `${previous ? `${previous}；` : ''}云记录：${errorText(cause)}`); }
      return images;
    } catch (e) { if (mounted.current) setHistoryError(errorText(e)); }
    finally { if (mounted.current) setLoadingHistory(false); }
  }, [client, refreshCloudTasks]);

  const acceptBackendStatus = useCallback((value: BackendStatus) => {
    if (!mounted.current) return;
    setStatus(value);
    let current = activeJob.current;
    const restored = restoreQueuedJob(value.studio_task, value.studio_queue);
    if (restored && (!current || (!isActiveJob(current) && current.id !== restored.id && restored.started >= current.started))) current = restored;
    if (!current) return;
    const queuePatch = value.studio_queue ? queueJobPatch(current, value.studio_queue) : {};
    const terminalPatch = value.studio_task ? restoredTaskPatch(current, value.studio_task) : null;
    if (current !== activeJob.current || Object.keys(queuePatch).length || terminalPatch) {
      current = mergeJobProgress(current, { ...queuePatch, ...terminalPatch });
      activeJob.current = current; setJob(current);
    }
    if (current.restored && value.studio_task?.task_id === current.id && value.studio_task.status === 'completed' && current.phase !== 'complete') {
      const snapshot = value.studio_task;
      void refreshHistory().then(images => {
        const latest = activeJob.current;
        if (!mounted.current || !latest || latest.id !== snapshot.task_id || !images) return;
        const patch = restoredTaskPatch(latest, snapshot, images);
        if (patch) { activeJob.current = mergeJobProgress(latest, patch); setJob(activeJob.current); }
      });
    }
  }, [refreshHistory]);

  const connect = useCallback(async () => {
    setConnecting(true); setError('');
    try {
      const configPromise = loadDeployment().catch(() => ({} as DeploymentConfig));
      await client.connect();
      const [schema, deployment, currentStatus] = await Promise.all([client.schema(), configPromise, client.status(), loadCloudCapabilities()]);
      if (!mounted.current) return;
      paramsRef.current = schema.params; configRef.current = deployment;
      setParams(schema.params); setConfig(deployment); setModels(schema.models); acceptBackendStatus(currentStatus); setConnected(true);
      const modes = availableModes(schema.models, deployment);
      setSettings(previous => {
        const preferred = modes.find(mode => mode.model === previous.model) ?? modes.find(mode => mode.label === '标准') ?? modes[0];
        if (!preferred) return { ...previous, model: '' };
        if (previous.model === preferred.model) return previous;
        const defaults = modelDefaults(preferred.model, deployment);
        const defaultNumber = (id: string, fallback: number) => Number(defaults[id] ?? schema.params.find(param => param.id === id)?.default ?? fallback);
        return { ...previous, model: preferred.model, steps: defaultNumber('steps', 20), cfg: defaultNumber('cfgscale', 7) };
      });
      void refreshHistory();
    } catch (e) { if (mounted.current) { setError(errorText(e)); setConnected(false); } }
    finally { if (mounted.current) setConnecting(false); }
  }, [client, refreshHistory, loadCloudCapabilities, acceptBackendStatus]);

  useEffect(() => {
    mounted.current = true;
    void connect();
    return () => { mounted.current = false; socket.current?.close(); };
  }, [connect]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      client.status().then(value => { if (!cancelled) acceptBackendStatus(value); }).catch(() => { /* Generation transport reports failures separately. */ });
    }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connected, client, acceptBackendStatus]);

  const setGeometry = useCallback((ratio: RatioId, resolution: ResolutionId, useReferences = true) => {
    setSettings(previous => ({ ...previous, ratio, resolution, ...(cloudModel ? cloudDimensions(cloudModel, ratio, resolution) : dimensions(ratio, resolution, useReferences ? references[0] : undefined)) }));
  }, [references, cloudModel]);

  const addReferences = useCallback(async (files: FileList | File[]) => {
    setError('');
    try {
      const max = cloudModel ? referenceLimit(cloudModel) : config.maxReferences ?? 3;
      if (files.length + references.length > max) throw new Error(`最多添加 ${max} 张参考图。`);
      const additions = await Promise.all(Array.from(files).map(file => new Promise<ReferenceImage>((resolve, reject) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { reject(new Error('参考图支持 PNG、JPEG 和 WebP。')); return; }
        if (file.size > 15 * 1024 * 1024) { reject(new Error('单张参考图需小于15MB。')); return; }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`读取 ${file.name} 失败。`));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error(`${file.name} 不是可读取的图像。`));
          image.onload = () => resolve({ id: createId(), name: file.name, dataUrl: String(reader.result), width: image.naturalWidth, height: image.naturalHeight });
          image.src = String(reader.result);
        };
        reader.readAsDataURL(file);
      })));
      setReferences(previous => [...previous, ...additions]);
      const first = references[0] ?? additions[0];
      if (!cloudModel && settings.ratio === 'smart') setSettings(previous => ({ ...previous, ...dimensions('smart', previous.resolution, first) }));
    } catch (e) { setError(errorText(e)); }
  }, [config.maxReferences, references, settings.ratio, cloudModel]);

  const removeReference = (id: string) => {
    const next = references.filter(image => image.id !== id);
    setReferences(next);
    if (!cloudModel && settings.ratio === 'smart') setSettings(previous => ({ ...previous, ...dimensions('smart', previous.resolution, next[0]) }));
  };

  const selectModel = (model: string) => {
    setCloudModelId(null);
    const defaults = modelDefaults(model, config);
    const defaultNumber = (id: string, fallback: number) => Number(defaults[id] ?? params.find(param => param.id === id)?.default ?? fallback);
    setSettings(previous => ({ ...previous, ...(cloudModelId ? { ratio: '1:1', resolution: '1K', ...dimensions('1:1', '1K'), quality: '' } : {}), model, steps: defaultNumber('steps', 20), cfg: defaultNumber('cfgscale', 7) }));
  };
  const selectCloudModel = (id: string) => {
    const model = cloud.capabilities?.models.find(item => item.id === id);
    if (!model) return;
    setCloudModelId(id);
    const ratio = model.ratios.includes('1:1') ? '1:1' : model.ratios[0];
    const resolution = model.resolutions[0];
    setSettings(previous => ({ ...previous, ratio, resolution, ...cloudDimensions(model, ratio, resolution), count: Math.min(previous.count, model.maxImages), quality: model.qualities.includes('medium') ? 'medium' : model.qualities[0] ?? '' }));
  };
  const selectLocal = () => {
    setCloudModelId(null);
    setSettings(previous => ({ ...previous, ratio: '1:1', resolution: '1K', ...dimensions('1:1', '1K'), count: Math.min(4, previous.count) }));
  };

  const updateJob = (patch: Partial<Job>) => {
    if (!activeJob.current) return;
    activeJob.current = mergeJobProgress(activeJob.current, patch);
    setJob(activeJob.current);
  };

  const generate = (includeReferences: boolean) => {
    setError('');
    if (socket.current && socket.current.readyState < WebSocket.CLOSING) return;
    try {
      if (!connected) throw new Error('请先连接图像服务。');
      if (cloudModel) {
        const request = buildCloudRequest(cloudModel, settings, includeReferences ? 'edit' : 'generate', prompt, includeReferences ? references : [], Boolean(cloud.capabilities?.configured));
        void cloud.generate(request);
        return;
      }
      if (!backendReady) throw new Error('图像服务尚未就绪，请稍后刷新连接。');
      if (!localReady) throw new Error('模型组件正在下载或尚未就绪，请稍后刷新连接。');
      if (configurationError) throw new Error(configurationError);
      const request = buildGenerationRequest(settings, prompt, includeReferences ? references : [], paramsRef.current, configRef.current);
      const newJob: Job = { id: createId(), started: Date.now(), requested: settings.count, completed: 0, phase: 'connecting', source: 'local' };
      request.studio_task_id = newJob.id;
      activeJob.current = newJob; setJob(newJob);
      const completedIndices = new Set<number>();
      socket.current = client.generate(request, message => {
        if (!mounted.current) return;
        if (message.studio_cancelled) {
          updateJob({ phase: 'interrupted', queue: undefined, percent: undefined, error: undefined });
          socket.current?.close(); return;
        }
        if (message.error) {
          updateJob({ phase: 'error', queue: undefined, error: message.error }); setError(message.error);
          socket.current?.close();
          return;
        }
        if (message.studio_queue && activeJob.current) updateJob(queueJobPatch(activeJob.current, message.studio_queue));
        if (message.status || message.backend_status) {
          setStatus(message);
          if (activeJob.current?.queue?.state !== 'queued' && activeJob.current?.phase !== 'stopping' && !['complete', 'error', 'interrupted'].includes(activeJob.current?.phase ?? '')) {
            if (message.status?.loading_models || message.backend_status?.any_loading) updateJob({ phase: 'loading' });
            else if (message.status?.live_gens) updateJob({ phase: 'generating' });
            else if (message.status?.waiting_gens || message.status?.waiting_backends) updateJob({ phase: 'queued' });
          }
        }
        if (message.gen_progress && activeJob.current && !['stopping', 'complete', 'error', 'interrupted'].includes(activeJob.current.phase)) {
          updateJob(localProgress(activeJob.current, message.gen_progress));
        }
        if (message.image && Number(message.batch_index) >= 0) {
          const index = Number(message.batch_index);
          completedIndices.add(index);
          const artwork = parseArtwork(message.image, message.metadata, client.user, client.appendUser);
          artwork.id = `${newJob.id}-${index}`; artwork.current = true; artwork.batchIndex = index;
          artwork.taskId = message.studio_task_id ?? newJob.id; artwork.source = 'local';
          artwork.ownerId = message.studio_owner_id; artwork.ownerEmail = message.studio_owner_email;
          artwork.prompt ||= prompt; artwork.width ??= settings.width; artwork.height ??= settings.height;
          artwork.model ??= settings.model; artwork.steps ??= settings.steps;
          artwork.generatedAt = new Date().toISOString(); artwork.duration = (Date.now() - newJob.started) / 1000;
          setHistory(previous => [artwork, ...previous.filter(item => item.url !== artwork.url)]);
          updateJob({ completed: completedIndices.size, percent: Math.min(.98, completedIndices.size / newJob.requested * .98) });
        }
        if (message.discard_indices) {
          for (const index of message.discard_indices) completedIndices.delete(index);
          setHistory(previous => previous.filter(item => !item.id.startsWith(newJob.id) || !message.discard_indices?.includes(item.batchIndex ?? -1)));
          updateJob({ completed: completedIndices.size });
        }
        if (message.socket_intention === 'close') {
          const phase = activeJob.current?.phase === 'stopping' ? 'interrupted' : completedIndices.size >= newJob.requested ? 'complete' : 'error';
          updateJob({ phase, queue: undefined, percent: phase === 'complete' ? 1 : undefined,
            error: phase === 'error' ? `请求已结束，返回 ${completedIndices.size}/${newJob.requested} 张图像。请检查服务状态。` : undefined });
          socket.current?.close();
        }
      }, intentional => {
        if (!mounted.current) return;
        const phase = activeJob.current?.phase;
        if (!intentional && phase && !['complete', 'error', 'interrupted'].includes(phase)) {
          updateJob({ phase: phase === 'stopping' ? 'interrupted' : 'error', error: phase === 'stopping' ? undefined : '连接已关闭，结果可能未知。请刷新创作记录确认。' });
        }
        socket.current = null;
      });
    } catch (e) { setError(errorText(e)); }
  };

  const stop = async () => {
    if (displayJob?.source === 'cloud') { cloud.stopWaiting(); return; }
    updateJob({ phase: 'stopping' });
    try {
      const result = await client.interrupt(activeJob.current?.id);
      if (result.success && result.studio_cancelled && result.studio_task_id === activeJob.current?.id) { updateJob({ phase: 'interrupted', queue: undefined, percent: undefined, error: undefined }); socket.current?.close(); }
    }
    catch (e) { setError(`停止请求未确认：${errorText(e)}`); }
  };

  const hideTask = async (taskId: string) => {
    await client.hideTask(taskId);
    hiddenTasks.current.add(taskId);
    setHistory(previous => previous.filter(item => item.taskId !== taskId));
    cloud.dismissTask(taskId);
    if (activeJob.current?.id === taskId) { activeJob.current = null; setJob(null); }
  };

  const reuse = (artwork: Artwork) => {
    setPrompt(artwork.prompt);
    const cloudChoice = cloud.capabilities?.models.find(model => model.id === artwork.model);
    if (cloudChoice) {
      setCloudModelId(cloudChoice.id);
      setSettings(previous => cloudArtworkSettings(artwork, cloudChoice, previous).settings);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return cloudArtworkSettings(artwork, cloudChoice, settings).operation;
    }
    else if (models.some(model => model.name === artwork.model)) setCloudModelId(null);
    setSettings(previous => ({ ...previous,
      ...(!cloudChoice && artwork.width && artwork.height ? { width: artwork.width, height: artwork.height, ratio: 'custom' as const } : {}),
      ...(artwork.seed != null ? { seed: artwork.seed } : {}),
      ...(artwork.steps != null ? { steps: artwork.steps } : {}),
      ...(models.some(model => model.name === artwork.model) ? { model: artwork.model! } : {}),
    }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return undefined;
  };

  return { client, connected, connecting, error, setError, historyError, status, params, models, config, configurationError, backendReady, localReady,
    ready: connected && (cloudModel ? Boolean(cloud.capabilities?.configured) : Boolean(settings.model) && backendReady && localReady && !configurationError),
    settings, setSettings, references, prompt, setPrompt, editing, setEditing, draftReady, draftError, history, job: displayJob, loadingHistory,
    cloudModel, cloudModels: cloud.capabilities?.models ?? [], cloudConfigured: Boolean(cloud.capabilities?.configured), cloudCapabilityError: cloud.capabilityError, cloudTasks: cloud.tasks,
    cloudAccount: cloud.account, accountLoading: cloud.accountLoading, accountError: cloud.accountError, refreshAccount: cloud.loadAccount, creditQuote,
    connect, refreshHistory, hideTask, setGeometry, addReferences, removeReference, selectModel, selectCloudModel, selectLocal, generate, stop, reuse,
    modes: availableModes(models, config),
  };
}
