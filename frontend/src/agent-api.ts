import { AUTH_REQUIRED_EVENT } from './auth';

export interface AgentSettings { model: string; quality: string; resolution: string; ratio: string; count: string; platform: string; scene: string; style: string; }
export interface AgentChat { id: string; title: string; owner_id: string; owner_email: string; hidden_at?: number; status?: string; updated_at: number; }
export interface AgentAsset { id: string; name: string; url: string; task_id?: string; width?: number; height?: number; }
export interface AgentEvent { id: number; turn_id: string; kind: string; at: number; data: {
  text?: string; summary?: string; steps?: string[]; options?: string[]; title?: string; id?: string;
  ref_ids?: string[]; prompt?: string; ratio?: string; request_id?: string; status?: string;
  images?: { ref_id: string; url: string }[]; credits?: number | null; hidden?: boolean; error?: string;
  streaming?: boolean; seconds?: number; examples?: string[];
}; }
export interface AgentView { chat: AgentChat; turns: { id: string; status: string; created_at: number; ended_at?: number }[]; events: AgentEvent[]; assets: AgentAsset[]; context?: {summary: string; through_event_id: number; updated_at: number} | null; }
export interface AgentConfig { configured: boolean; defaults: AgentSettings; skills: { id: string; title: string; description: string }[]; sources: { title: string; url: string }[]; }
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { model: 'gpt-image-2.5-flare', quality: 'medium', resolution: '1K', ratio: 'auto', count: 'auto', platform: 'auto', scene: 'auto', style: 'natural' };

export async function agentRequest<T>(path: string, data?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/studio-agent/${path}`, { method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    headers: data ? { 'Content-Type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined });
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `创作助手请求失败（HTTP ${response.status}）`);
  return value as T;
}

export function agentStatus(status?: string) {
  return ({ running: '创作中', waiting_user: '等待补充', awaiting_feedback: '等待反馈', completed: '已完成', stopped: '已停止', failed: '需要处理', interrupted: '已中断' } as Record<string, string>)[status ?? ''] ?? '新对话';
}
