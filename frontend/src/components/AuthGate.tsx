import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AUTH_CHANGE_KEY, AUTH_REQUIRED_EVENT, AuthError, authRequest, isEmail, notifyAuthChanged, type AuthSnapshot, type StudioUser } from '../auth';
import { setAccountStorageUser } from '../account-storage';
import Icon from './Icon';
import GlassTabs from './GlassTabs';
import { ThemeToggle } from '../theme';
import { AnimatePresence, motion, useReducedMotion, useIsPresent } from 'motion/react';
const AuthOrbit = lazy(() => import('./AuthOrbit'));

type AuthMode = 'login' | 'register' | 'reset';
export interface AuthWorkspace { user: StudioUser; adminEntry: boolean; logout: () => Promise<void> }

function Brand() {
  return <a className="brand" href="/studio/" aria-label="Nandou Studio 首页"><img className="brand-logo" src={`${import.meta.env.BASE_URL}brand/nandou-mark-on-dark.svg`} width="34" height="34" alt="" /><span>Nandou Studio</span></a>;
}

function ConfirmPassword({value, change, busy, reduced}: {value: string; change: (value: string) => void; busy: boolean; reduced: boolean}) {
  const present = useIsPresent();
  return <motion.div className="auth-confirm-reveal" inert={!present} initial={{height: 0, opacity: 0}} animate={{height: 'auto', opacity: 1}} exit={{height: 0, opacity: 0}} transition={{duration: reduced ? 0 : .24, ease: [.23,1,.32,1]}}><label className="auth-field">确认密码<input name="confirm-password" type="password" autoComplete="new-password" required={present} minLength={6} maxLength={256} placeholder="再次输入密码" value={value} disabled={busy || !present} onChange={event => change(event.target.value)} /></label></motion.div>;
}

function AccountForm({ adminEntry, accept }: { adminEntry: boolean; accept: (user: StudioUser) => void }) {
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const changeMode = (next: AuthMode) => { setMode(next); setPassword(''); setConfirm(''); setError(''); setNotice(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    if (mode === 'login' && address === 'admin' && !adminEntry) { setError('管理员仅可在部署电脑的本机入口登录，请打开 localhost:7801/studio/。'); return; }
    if (!isEmail(address) && !(mode === 'login' && adminEntry && address === 'admin')) { setError('请输入有效的邮箱地址。'); return; }
    if (password.length < 6) { setError('密码至少需要 6 个字符。'); return; }
    if (mode !== 'login' && password !== confirm) { setError('两次输入的密码不一致。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'reset') {
        await authRequest<{ ok: boolean }>('reset', { email: address, password });
        notifyAuthChanged();
        if (mounted.current) { setMode('login'); setPassword(''); setConfirm(''); setNotice('密码已更新，请使用新密码登录。'); }
      } else {
        const value = await authRequest<{ user: StudioUser }>(mode, { email: address, password });
        if (!value.user?.id) throw new Error('账号服务未返回有效账号，请重新登录。');
        if (mounted.current) { setPassword(''); setConfirm(''); notifyAuthChanged(); accept(value.user); }
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const title = mode === 'register' ? '创建你的创作空间' : mode === 'reset' ? '重置密码' : '欢迎回来';
  return <div className="auth-shell">
    <Suspense fallback={null}><AuthOrbit /></Suspense>
    <header className="auth-header"><Brand /><ThemeToggle/></header>
    <main className="auth-main"><section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-card-mark" aria-hidden="true"><Icon name="spark" size={28} /></div>
      <p className="auth-eyebrow">NANDOU STUDIO</p><motion.h1 id="auth-title" key={mode} initial={{opacity: .5, transform: reduced ? 'none' : 'translateY(4px)'}} animate={{opacity: 1, transform: 'translateY(0px)'}} transition={{duration: .2}}>{title}</motion.h1>
      <p className="auth-intro">{mode === 'reset' ? '填写已注册邮箱，设置新的登录密码。' : '登录后开始创作，任务与作品保存在你的账号中。'}</p>
      {mode !== 'reset' ? <GlassTabs className="auth-tabs" aria-label="账号操作"><button type="button" className={mode === 'login' ? 'selected' : ''} aria-pressed={mode === 'login'} disabled={busy} onClick={() => changeMode('login')}>登录</button><button type="button" className={mode === 'register' ? 'selected' : ''} aria-pressed={mode === 'register'} disabled={busy} onClick={() => changeMode('register')}>注册账号</button></GlassTabs> : null}
      <form onSubmit={event => void submit(event)}>
        <label className="auth-field">{adminEntry && mode === 'login' ? '邮箱 / 管理员账号' : '邮箱'}<input name="email" type={mode === 'login' ? 'text' : 'email'} inputMode={mode === 'login' ? 'text' : 'email'} autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} placeholder={adminEntry && mode === 'login' ? '邮箱或 admin' : 'name@example.com'} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
        <label className="auth-field">{mode === 'reset' ? '新密码' : '密码'}<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={6} maxLength={256} placeholder="至少 6 个字符" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        <AnimatePresence initial={false}>{mode !== 'login' ? <ConfirmPassword key="confirm" value={confirm} change={setConfirm} busy={busy} reduced={Boolean(reduced)}/> : null}</AnimatePresence>
        {mode === 'reset' ? <p className="auth-reset-note">内部过渡方式：仅核对注册邮箱，无需邮件验证；管理员账号不支持此方式。</p> : null}
        {error ? <p className="auth-message auth-error" role="alert">{error}</p> : null}
        {error && mode === 'login' && email.trim().toLowerCase() === 'admin' && !adminEntry ? <a className="auth-local-link" href="http://localhost:7801/studio/">在部署电脑打开本机入口 →</a> : null}
        {notice ? <p className="auth-message auth-success" role="status">{notice}</p> : null}
        <button className="auth-submit" type="submit" disabled={busy}>{busy ? '正在处理…' : mode === 'register' ? '注册并进入创意工坊' : mode === 'reset' ? '保存新密码' : '进入创意工坊'}{!busy ? <Icon name="arrow" size={18} /> : null}</button>
        <div className="auth-form-footer">{mode === 'login' ? <button type="button" disabled={busy} onClick={() => changeMode('reset')}>忘记密码？</button> : <button type="button" disabled={busy} onClick={() => changeMode('login')}>返回登录</button>}</div>
      </form>
      <div className="auth-privacy"><span /><p>每个账号独立保存创作记录</p></div>
    </section><p className="auth-footnote">让想象，成为图像</p></main>
  </div>;
}

export default function AuthGate({ children }: { children: (workspace: AuthWorkspace) => ReactNode }) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [retry, setRetry] = useState<'check' | 'logout'>('check');
  const revision = useRef(0);
  const mounted = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  const clearWorkspace = useCallback(() => { setAccountStorageUser(null); setSnapshot(previous => previous ? { ...previous, user: null } : null); setEpoch(previous => previous + 1); }, []);
  const check = useCallback(async () => {
    const current = ++revision.current;
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    clearWorkspace(); setChecking(true); setError(''); setRetry('check');
    try {
      const value = await authRequest<AuthSnapshot>('me', undefined, controller.signal);
      if (mounted.current && revision.current === current) {
        if (value.user?.is_admin && !value.admin_entry) value.user = null;
        setAccountStorageUser(value.user?.id ?? null); setSnapshot(value);
      }
    } catch (cause) {
      if (mounted.current && revision.current === current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法连接账号服务。');
    } finally { if (mounted.current && revision.current === current) setChecking(false); }
  }, [clearWorkspace]);
  useEffect(() => {
    mounted.current = true; void check();
    const required = () => { ++revision.current; requestController.current?.abort(); clearWorkspace(); setChecking(false); setError(''); notifyAuthChanged(); };
    const changed = (event: StorageEvent) => { if (event.key === AUTH_CHANGE_KEY) void check(); };
    window.addEventListener(AUTH_REQUIRED_EVENT, required); window.addEventListener('storage', changed);
    return () => { mounted.current = false; ++revision.current; requestController.current?.abort(); setAccountStorageUser(null); window.removeEventListener(AUTH_REQUIRED_EVENT, required); window.removeEventListener('storage', changed); };
  }, [check, clearWorkspace]);
  const accept = (user: StudioUser) => { ++revision.current; requestController.current?.abort(); setAccountStorageUser(user.id); setSnapshot(previous => ({ admin_entry: previous?.admin_entry ?? false, user })); setEpoch(previous => previous + 1); setChecking(false); };
  const logout = async () => {
    ++revision.current; requestController.current?.abort(); clearWorkspace(); setChecking(true); setError(''); setRetry('logout');
    try { await authRequest<{ ok: boolean }>('logout', {}); notifyAuthChanged(); }
    catch (cause) { if (cause instanceof AuthError && cause.status === 401) notifyAuthChanged(); else if (mounted.current) setError(cause instanceof Error ? cause.message : '退出请求失败，请重试。'); }
    finally { if (mounted.current) setChecking(false); }
  };
  if (checking) return <div className="auth-shell"><header className="auth-header"><Brand /></header><main className="auth-pending" role="status"><span className="auth-spinner" />正在确认登录状态…</main></div>;
  if (error) return <div className="auth-shell"><header className="auth-header"><Brand /></header><main className="auth-pending"><p role="alert">{error}</p><button className="auth-submit" onClick={() => { if (retry === 'logout') void logout(); else void check(); }}>{retry === 'logout' ? '重试退出' : '重新连接'}</button></main></div>;
  if (!snapshot?.user) return <AccountForm adminEntry={snapshot?.admin_entry ?? false} accept={accept} />;
  return <div key={`${snapshot.user.id}:${epoch}`}>{children({ user: snapshot.user, adminEntry: snapshot.admin_entry, logout })}</div>;
}
