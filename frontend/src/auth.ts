export interface StudioUser {
  id: string;
  email: string;
  name: string;
  role: string;
  is_admin: boolean;
  hosted?: boolean;
}

export interface AuthSnapshot { user: StudioUser | null; admin_entry: boolean }
export const AUTH_REQUIRED_EVENT = 'nandou-auth-required';
export const AUTH_CHANGE_KEY = 'nandou-studio:auth-change:v1';

export class AuthError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'AuthError'; this.status = status; this.code = code; }
}

export async function authRequest<T>(path: string, data?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/studio-auth/${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: data === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 401 && path !== 'me' && path !== 'login' && path !== 'nandou-sso') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new AuthError('账号服务暂时无法响应，请稍后重试。', response.status); }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
    const code = value && typeof value === 'object' && 'error_id' in value ? value.error_id : undefined;
    throw new AuthError(typeof error === 'string' ? error : `账号请求失败（HTTP ${response.status}）`, response.status, typeof code === 'string' ? code : undefined);
  }
  return value as T;
}

// A launch ticket can be redeemed once. Auth checks and React remounts share
// the exchange, and never render the previous account while it is in flight.
let hostedExchange: Promise<void> | undefined;
export function checkHostedLaunch(): Promise<void> | undefined {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const keys = ['nandou_ticket', 'nandou_org', 'nandou_app'];
  if (!keys.some(key => fragment.has(key))) {
    if (!hostedExchange && url.searchParams.has('nandou_launch_pending')) throw new Error('请从南斗重新打开 Studio。');
    return hostedExchange;
  }

  const ticket = fragment.get('nandou_ticket');
  const organization_id = fragment.get('nandou_org');
  const app = fragment.get('nandou_app');
  for (const key of keys) fragment.delete(key);
  url.hash = fragment.toString();
  // Keep a non-secret marker until redemption succeeds so reload cannot fall
  // back to a different existing Studio session after an interrupted exchange.
  url.searchParams.set('nandou_launch_pending', '1');
  window.history.replaceState(window.history.state, '', url);

  hostedExchange = (async () => {
    if (!ticket || !organization_id || app !== 'nandou-studio') throw new Error('请从南斗重新打开 Studio。');
    await authRequest('nandou-sso', { ticket, organization_id });
    const current = new URL(window.location.href);
    current.searchParams.delete('nandou_launch_pending');
    window.history.replaceState(window.history.state, '', current);
  })();
  return hostedExchange;
}

/** Broadcast only an invalidation signal: account details and credentials stay out of storage. */
export function notifyAuthChanged() {
  try { localStorage.setItem(AUTH_CHANGE_KEY, `${Date.now()}:${Math.random()}`); }
  catch { /* A storage-restricted tab still clears its own workspace. */ }
}

export function isEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); }
