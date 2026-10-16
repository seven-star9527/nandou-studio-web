import type { Artwork, BackendStatus, CloudAccount, CloudCapabilities, CloudQuote, CloudQuoteRequest, CloudRequest, CloudTask, DeploymentConfig, GenerationMessage, Model, ParamMap, ParamSchema } from './types';

export class SwarmError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.name = 'SwarmError'; this.code = code; }
}

export function imageUrl(path: string, user: string, appendUser = true): string {
  if (path.startsWith('data:image/')) return path;
  if (/^\/?(?:View|Output)\//.test(path)) return `/${path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')}`;
  // ListImages returns paths relative to the user's output directory.
  const prefix = appendUser ? `/View/${encodeURIComponent(user)}` : '/Output';
  return `${prefix}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function parseArtwork(path: string, metadata: string | undefined, user: string, appendUser = true): Artwork {
  let parsed: { sui_image_params?: Record<string, unknown>; sui_extra_data?: Record<string, unknown> } = {};
  try { parsed = JSON.parse(metadata ?? '{}'); } catch { /* Metadata is not guaranteed to be JSON. */ }
  const p = parsed.sui_image_params ?? {};
  return {
    id: path, url: imageUrl(path, user, appendUser), prompt: String(p.prompt ?? ''),
    width: typeof p.width === 'number' ? p.width : undefined,
    height: typeof p.height === 'number' ? p.height : undefined,
    seed: p.seed == null ? undefined : String(p.seed), model: p.model == null ? undefined : String(p.model),
    steps: typeof p.steps === 'number' ? p.steps : undefined, metadata,
  };
}

export class SwarmClient {
  session = ''; user = 'local'; appendUser = true;
  private sessionPromise?: Promise<void>;

  private async post<T>(endpoint: string, data: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/API/${endpoint}`, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nandou-auth-required'));
    if (!response.ok) throw new SwarmError(`服务请求失败（HTTP ${response.status}）`);
    const value = await response.json();
    const isCloudTaskRecord = ['GetStudioCloudTask', 'SubmitStudioCloudImage'].includes(endpoint) && value.request_id && value.status;
    const isAccountRecord = endpoint === 'GetStudioCloudAccount' && typeof value.configured === 'boolean' && value.state;
    if (value.error && !isCloudTaskRecord && !isAccountRecord) throw new SwarmError(typeof value.error === 'string' ? value.error : JSON.stringify(value.error), value.error_id);
    return value as T;
  }

  async connect() {
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = this.post<{ session_id: string; user_id: string; output_append_user: boolean }>('GetNewSession', {}).then(value => {
      if (!value.session_id) throw new SwarmError('服务没有返回有效会话。');
      this.session = value.session_id; this.user = value.user_id; this.appendUser = value.output_append_user;
    }).finally(() => { this.sessionPromise = undefined; });
    return this.sessionPromise;
  }

  async request<T>(endpoint: string, data: object = {}, signal?: AbortSignal): Promise<T> {
    if (!this.session) await this.connect();
    try { return await this.post<T>(endpoint, { ...data, session_id: this.session }, signal); }
    catch (error) {
      // Retry only the read request after an explicit invalid-session rejection.
      if (error instanceof SwarmError && error.code === 'invalid_session_id' && !['InterruptAll', 'SubmitStudioCloudImage'].includes(endpoint)) {
        await this.connect();
        return this.post<T>(endpoint, { ...data, session_id: this.session }, signal);
      }
      throw error;
    }
  }

  async schema() {
    const result = await this.request<{ list: ParamSchema[]; models: Record<string, [string, string][]> }>('ListT2IParams');
    return { params: result.list, models: (result.models['Stable-Diffusion'] ?? []).map(([name, architecture]) => ({ name, architecture } as Model)) };
  }
  status() { return this.request<BackendStatus>('GetCurrentStatus'); }
  async history() {
    const result = await this.request<{ files: { src: string; metadata?: string; studio_task_id?: string; studio_owner_id?: string; studio_owner_email?: string; studio_hidden_at?: string; studio_created_utc?: string }[] }>('ListImages', {
      path: '', depth: 10, sortBy: 'Date', sortReverse: false,
    });
    return result.files.filter(f => /\.(?:png|jpe?g|webp)$/i.test(f.src))
      .slice(0, 100).map(f => ({ ...parseArtwork(f.src, f.metadata, this.user, this.appendUser), source: 'local' as const,
        taskId: f.studio_task_id, ownerId: f.studio_owner_id, ownerEmail: f.studio_owner_email, hiddenAt: f.studio_hidden_at,
        generatedAt: f.studio_created_utc }));
  }
  async hideTask(taskId: string) {
    const response = await fetch('/studio-auth/tasks/hide', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) });
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nandou-auth-required'));
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value.ok !== true) throw new SwarmError(value.message ?? value.error ?? `移除记录失败（HTTP ${response.status}）`);
  }
  interrupt(taskId?: string) { return this.request<{ success: boolean; studio_cancelled?: boolean; studio_task_id?: string }>('InterruptAll', { other_sessions: false, ...(taskId ? { studio_task_id: taskId } : {}) }); }
  async cloudCapabilities() {
    const value = await this.request<CloudCapabilities>('GetStudioCloudCapabilities');
    return { ...value, models: value.models.map(model => ({ ...model, qualities: (model.qualities ?? []).filter(quality => !model.id.startsWith('gpt-image-2.5-') || !['max', 'auto'].includes(quality)) })) };
  }
  submitCloud(input: CloudRequest) { return this.request<{ request_id: string; status: string; task_id?: string }>('SubmitStudioCloudImage', input); }
  cloudTask(requestId: string) { return this.request<CloudTask>('GetStudioCloudTask', { request_id: requestId }); }
  async cloudTasks() { return (await this.request<{ tasks: CloudTask[] }>('ListStudioCloudTasks')).tasks; }
  cloudAccount(signal?: AbortSignal) { return this.request<CloudAccount>('GetStudioCloudAccount', {}, signal); }
  cloudQuote(input: CloudQuoteRequest, signal?: AbortSignal) { return this.request<CloudQuote>('GetStudioCloudQuote', input, signal); }

  generate(params: ParamMap, onMessage: (message: GenerationMessage) => void, onClose: (intentional: boolean) => void) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/API/GenerateText2ImageWS`);
    let intentional = false;
    socket.onopen = () => socket.send(JSON.stringify({ ...params, session_id: this.session }));
    socket.onmessage = event => {
      try {
        const message: GenerationMessage = JSON.parse(event.data);
        if (message.socket_intention === 'close') intentional = true;
        onMessage(message);
      } catch { onMessage({ error: '无法解析服务返回的进度信息。' }); }
    };
    socket.onerror = () => onMessage({ error: '生成连接中断。请求结果可能未知，请刷新创作记录确认；不要直接重复提交。' });
    socket.onclose = event => {
      if (event.code === 1008) window.dispatchEvent(new CustomEvent('nandou-auth-required'));
      onClose(intentional);
    };
    return socket;
  }
}

export async function loadDeployment(): Promise<DeploymentConfig> {
  const base = import.meta.env.BASE_URL;
  const response = await fetch(`${base}runtime-config.json`, { cache: 'no-store' });
  if (!response.ok) return {};
  return response.json();
}
