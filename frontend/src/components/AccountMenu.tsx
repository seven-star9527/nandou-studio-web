import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AuthError, authRequest, type StudioUser } from '../auth';
import { useDismissibleLayer } from '../useDismissibleLayer';
import { useModalDialog } from '../useModalDialog';
import Icon from './Icon';
import ModalPortal from './ModalPortal';

function ChangePassword({ user, close }: { user: StudioUser; close: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const current = useRef<HTMLInputElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const title = useId();
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ message: string; field?: 'current' | 'confirm' } | null>(null);
  const dismiss = () => { if (!busy) close(); };
  useModalDialog(true, dialog, dismiss);
  useEffect(() => { if (saved) done.current?.focus(); }, [saved]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get('password') !== data.get('confirmation')) {
      setError({ message: '两次输入的新密码不一致。', field: 'confirm' });
      confirmation.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authRequest('change-password', {
        account: user.id, current_password: data.get('current_password'), password: data.get('password'),
      });
      form.reset();
      setSaved(true);
    } catch (cause) {
      const incorrect = cause instanceof AuthError && cause.code === 'incorrect_current_password';
      setError({ message: cause instanceof AuthError ? cause.message : '无法确认修改结果，请用新密码核对登录。', field: incorrect ? 'current' : undefined });
      if (incorrect) {
        current.current?.focus();
        current.current?.select();
      }
    } finally {
      setBusy(false);
    }
  }

  return <ModalPortal><div className="modal-backdrop" onClick={dismiss}>
    <section className="scene-dialog modal account-password-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={title} onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2 id={title}>修改密码</h2><button type="button" className="icon-button" aria-label="关闭修改密码" disabled={busy} onClick={dismiss}><Icon name="close" /></button></div>
      <p role="status" className={saved ? 'auth-message auth-success' : 'sr-only'}>{saved ? '密码已更新，其他设备已退出。' : ''}</p>
      {saved ? <button ref={done} type="button" className="primary-button" onClick={close}>完成</button> :
        <form aria-labelledby={title} method="post" action="/studio-auth/change-password" onSubmit={event => void submit(event)} onInput={() => { if (error) setError(null); }}>
          <input hidden name="username" autoComplete="username" value={user.email} readOnly />
          <label className="form-field">当前密码<input ref={current} data-autofocus type="password" name="current_password" autoComplete="current-password" required maxLength={256} readOnly={busy} aria-invalid={error?.field === 'current' || undefined} aria-describedby={error?.field === 'current' ? errorId : undefined} /></label>
          <label className="form-field">新密码<input type="password" name="password" autoComplete="new-password" required minLength={6} maxLength={256} readOnly={busy} placeholder="至少 6 个字符" /></label>
          <label className="form-field">确认新密码<input ref={confirmation} type="password" name="confirmation" autoComplete="new-password" required minLength={6} maxLength={256} readOnly={busy} aria-invalid={error?.field === 'confirm' || undefined} aria-describedby={error?.field === 'confirm' ? errorId : undefined} /></label>
          {error && <p id={errorId} className="auth-message auth-error" role="alert">{error.message}</p>}
          <div className="account-password-actions"><button type="button" className="quiet-button" disabled={busy} onClick={dismiss}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</button></div>
        </form>}
    </section>
  </div></ModalPortal>;
}

export default function AccountMenu({ user, logout }: { user: StudioUser; logout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const boundary = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useId();
  useDismissibleLayer(open, boundary, () => setOpen(false));

  return <div className="account-menu" ref={boundary} onKeyDown={event => { if (event.key === 'Escape' && open) trigger.current?.focus(); }}>
    <button ref={trigger} type="button" className="studio-account-identity" title={user.email} aria-label={`账号菜单 ${user.email}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panel : undefined} data-layer-trigger onClick={() => setOpen(previous => !previous)}>
      <span>{user.email}</span>{user.is_admin && <small>管理员</small>}<Icon name="chevron" size={13} />
    </button>
    {open && <div id={panel} className="account-menu-panel popover" role="dialog" aria-label="账号操作">
      <button type="button" onClick={() => { trigger.current?.focus(); setOpen(false); setChanging(true); }}>修改密码</button>
      <button type="button" onClick={() => { setOpen(false); void logout(); }}>退出</button>
    </div>}
    {changing && <ChangePassword user={user} close={() => setChanging(false)} />}
  </div>;
}
