export interface StudioUser {
  id: string;
  email: string;
  role: string;
  is_admin: boolean;
}

export interface AuthSnapshot { user: StudioUser | null; admin_entry: boolean }
export const AUTH_REQUIRED_EVENT = 'nandou-auth-required';
export const AUTH_CHANGE_KEY = 'nandou-studio:auth-change:v1';

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = 'AuthError'; this.status = status; }
}

export async function authRequest<T>(path: string, data?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/studio-auth/${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: data === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 401 && path !== 'me' && path !== 'login') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new AuthError('账号服务暂时无法响应，请稍后重试。', response.status); }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
    throw new AuthError(typeof error === 'string' ? error : `账号请求失败（HTTP ${response.status}）`, response.status);
  }
  return value as T;
}

/** Broadcast only an invalidation signal: account details and credentials stay out of storage. */
export function notifyAuthChanged() {
  try { localStorage.setItem(AUTH_CHANGE_KEY, `${Date.now()}:${Math.random()}`); }
  catch { /* A storage-restricted tab still clears its own workspace. */ }
}

export function isEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); }
