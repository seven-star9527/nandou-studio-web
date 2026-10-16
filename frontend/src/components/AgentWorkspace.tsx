import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { agentRequest, agentStatus, DEFAULT_AGENT_SETTINGS, type AgentAsset, type AgentChat, type AgentConfig, type AgentEvent, type AgentSettings, type AgentView } from '../agent-api';
import type { SwarmClient } from '../api';
import type { StudioUser } from '../auth';
import { createId } from '../id';
import Icon from './Icon';
import ModalPortal from './ModalPortal';
import { useModalDialog } from '../useModalDialog';
import './agent-workspace.css';
import ReferenceDock from './ReferenceDock';
import AgentPreferences from './AgentPreferences';
import { useDraft } from '../useDraft';
import { useDismissibleLayer } from '../useDismissibleLayer';
import { accountStorageKey } from '../account-storage';

const STARTERS = [
  { icon: 'brush' as const, title: '把产品，拍得更有质感', detail: '上传实拍，制作干净自然的商业摄影图', prompt: '我想为这款商品制作一张商业摄影场景图。请保留实物外观，商品全新干净，光线自然。' },
  { icon: 'poster' as const, title: '为一套商品，讲好故事', detail: '主图、卖点、A+，让每张图各有任务', prompt: '帮我策划一套艺术用品的亚马逊主副图，先和我确认必要的商品信息，再逐张制作。' },
  { icon: 'flower' as const, title: '从一个灵感，开始设计', detail: '海报与独立站横幅，一起探索视觉方向', prompt: '生成一张水彩艺术品牌的独立站横幅概念图，柔和自然光，整洁的画室，画面左侧留出文案空间，不添加文字。' },
];

type Upload = { id: string; name: string; data_url: string; width: number; height: number };
type AgentDraft = { text: string; uploads: Upload[]; refs: AgentAsset[]; skills?: {id: string; title: string}[]; submission?: { chatId: string; requestId: string } };
const EMPTY_DRAFT: AgentDraft = {text: '', uploads: [], refs: []};

async function readUpload(file: File): Promise<Upload> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) throw new Error('请使用 12MB 以内的 JPG、PNG 或 WebP 图片。');
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio);
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法读取图片。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { id: createId(), name: file.name, width: canvas.width, height: canvas.height, data_url: canvas.toDataURL('image/jpeg', .94) };
  } finally { bitmap.close(); }
}

function ImagePreview({ image, close }: { image: { url: string; name: string }; close: () => void }) {
  const dialog = useRef<HTMLDivElement>(null); useModalDialog(true, dialog, close);
  return <ModalPortal><div className="modal-backdrop agent-image-backdrop" onClick={close}><div className="agent-image-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="查看图片" tabIndex={-1} onClick={e => e.stopPropagation()}>
    <button className="icon-button" onClick={close} aria-label="关闭图片"><Icon name="close" /></button><img src={image.url} alt={image.name} /><a href={image.url} download="nandou-image.jpg"><Icon name="download" />下载图片</a>
  </div></div></ModalPortal>;
}

export default function AgentWorkspace({ user, client, refreshAccount }: { user: StudioUser; client: SwarmClient; refreshAccount: () => Promise<unknown> }) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [chats, setChats] = useState<AgentChat[]>([]);
  const [cid, setCid] = useState(() => { try { return sessionStorage.getItem(`nandou-agent-chat:${user.id}`) ?? ''; } catch { return ''; } });
  const [view, setView] = useState<AgentView | null>(null);
  const [draft, setDraft, draftReady, draftError] = useDraft<AgentDraft>(accountStorageKey(`draft:agent:${cid || 'new'}`), EMPTY_DRAFT);
  const {text, uploads, refs, skills = []} = draft;
  const reducedMotion = useReducedMotion();
  const setText = (action: string | ((old:string)=>string)) => setDraft(d=>({...d, text: typeof action === 'function' ? action(d.text) : action}));
  const setUploads = (action: Upload[] | ((old:Upload[])=>Upload[])) => setDraft(d=>({...d, uploads: typeof action === 'function' ? action(d.uploads) : action}));
  const setRefs = (action: AgentAsset[] | ((old:AgentAsset[])=>AgentAsset[])) => setDraft(d=>({...d, refs: typeof action === 'function' ? action(d.refs) : action}));
  const [opts, setOpts, optsReady, optsError] = useDraft<AgentSettings>(accountStorageKey('agent:preferences'), DEFAULT_AGENT_SETTINGS);
  const [quote, setQuote] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [all, setAll] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const form = useRef<HTMLFormElement>(null);
  useDismissibleLayer(settingsOpen || skillsOpen, form, () => { setSettingsOpen(false); setSkillsOpen(false); });
  useLayoutEffect(() => {
    const resize = () => form.current?.style.setProperty('--agent-popover-space', `${Math.max(160, (form.current?.getBoundingClientRect().top ?? 444) - (document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 70) - 24)}px`);
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [skillsOpen, settingsOpen]);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const selection = useRef(cid);
  const follow = useRef(true);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latest = view?.turns.at(-1);
  const running = latest?.status === 'running';
  const readOnly = Boolean(view && view.chat.owner_id !== user.id);
  const active = running || sending || !draftReady || !optsReady;
  const asset = (id: string) => view?.assets.find(a => a.id === id);
  const currentEvents = view?.events.filter(e => e.turn_id === latest?.id) ?? [];
  const plan = currentEvents.filter(e => e.kind === 'plan').at(-1);
  const status = currentEvents.filter(e => e.kind === 'status').at(-1)?.data.text;
  const count = currentEvents.filter(e => e.kind === 'result' && e.data.status === 'completed').length;
  const reviewing = currentEvents.some(e => e.kind === 'tool' && e.data.title === '查看并检查图片');
  const stage = reviewing ? 2 : currentEvents.some(e => e.kind === 'generation') ? 1 : 0;
  const streamTextLength = view?.events.reduce((n, e) => n + (e.kind === 'assistant' ? e.data.text?.length ?? 0 : 0), 0);

  async function loadList() {
    const value = await agentRequest<{ chats: AgentChat[] }>(`chats${all ? '?all=1' : ''}`);
    if (mounted.current) setChats(value.chats);
  }
  function selectChat(id: string) {
    selection.current = id; setCid(id); setView(null); setError(''); setPendingId(null); follow.current = true;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { try { sessionStorage.setItem(`nandou-agent-chat:${user.id}`, cid); } catch { /* Server still owns the conversation. */ } }, [cid, user.id]);
  useEffect(() => { void agentRequest<AgentConfig>('config').then(setConfig).catch(e => setError(e.message)); }, []);
  useEffect(() => { void loadList().catch(e => setError(e.message)); }, [all]);
  useEffect(() => {
    if (!cid) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await agentRequest<AgentView>(`chats/${cid}`);
        if (alive && selection.current === cid) setView(value);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : '同步对话失败'); }
      if (alive) timer = setTimeout(poll, 2500);
    };
    const stream = new EventSource(`/studio-agent/chats/${cid}/events`);
    stream.onmessage = event => {
      if (alive && selection.current === cid) {
        try { setView(JSON.parse(event.data) as AgentView); } catch { /* Reconnect/fallback fetch preserves the journal. */ }
      }
    };
    stream.onopen = () => clearTimeout(timer);
    stream.onerror = () => { clearTimeout(timer); void poll(); };
    stream.addEventListener('expired', () => { stream.close(); void poll(); });
    return () => { alive = false; clearTimeout(timer); stream.close(); };
  }, [cid]);
  useEffect(() => {
    if (view?.events.length && follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [view?.events.length, streamTextLength]);
  useEffect(() => { if (!running) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  useEffect(() => { if (latest && latest.status !== 'running') { void loadList(); void refreshAccount(); } }, [latest?.id, latest?.status]);
  useEffect(() => {
    const abort = new AbortController(); setQuote(null);
    void client.cloudQuote({ model: opts.model, quality: opts.quality, resolution: opts.resolution, size: opts.ratio === 'auto' ? '1:1' : opts.ratio, n: 1 }, abort.signal).then(q => setQuote(q.credits_total_reference)).catch(() => {});
    return () => abort.abort();
  }, [opts, client]);

  async function send(override?: string) {
    const request = (override ?? text).trim();
    const input = [skills.length ? `请使用${skills.map(s => `「${s.title}」`).join('、')}技能。` : '', request].filter(Boolean).join('\n');
    if (input.length > 8000) { setError('需求与技能合计超过 8000 字，请缩短后再发送。'); return; }
    if (!input || active || readOnly || inFlight.current || uploading) return;
    inFlight.current = true; setSending(true); setError(''); follow.current = true;
    const requestId = draft.submission?.requestId ?? pendingId ?? createId(); setPendingId(requestId);
    try {
      let chatId = draft.submission?.chatId ?? cid;
      if (!chatId) {
        chatId = (await agentRequest<{ id: string }>('chats', {})).id;
      }
      // Keep the original draft visible until accepted; retries reuse the same turn,
      // including after switching modes or refreshing during an uncertain response.
      setDraft(d => ({...d, submission: {chatId, requestId}}));
      await agentRequest(`chats/${chatId}/messages`, { request_id: requestId, text: input, settings: opts, ref_ids: refs.map(r => r.id), images: uploads.map(({ name, data_url }) => ({ name, data_url })) });
      setPendingId(null); setDraft(EMPTY_DRAFT); setSkillsOpen(false); setSettingsOpen(false);
      selection.current = chatId; setCid(chatId);
      setView(await agentRequest<AgentView>(`chats/${chatId}`)); await loadList();
    } catch (e) { setError(`${e instanceof Error ? e.message : '发送未确认'}。可重试发送，同一编号不会重复执行。`); }
    finally { inFlight.current = false; setSending(false); }
  }
  async function addFiles(files: FileList | File[]) {
    if (uploads.length + refs.length + files.length > 8) { setError('每轮最多使用 8 张参考图。'); return; }
    setUploading(true); setError('');
    try { const items = await Promise.all(Array.from(files).map(readUpload)); setUploads(old => [...old, ...items].slice(0, 8 - refs.length)); }
    catch (e) { setError(e instanceof Error ? e.message : '读取图片失败'); } finally { setUploading(false); }
  }
  async function hideChat(chat: AgentChat) {
    try { await agentRequest(`chats/${chat.id}/hide`, {}); if (cid === chat.id) selectChat(''); await loadList(); }
    catch (e) { setError(e instanceof Error ? e.message : '移除失败'); }
  }
  function reuse(id: string) {
    const image = asset(id); if (!image || readOnly || active) return;
    if (refs.length + uploads.length >= 8) { setError('每轮最多 8 张参考图。'); return; }
    setRefs(old => old.some(r => r.id === id) ? old : [...old, image]); composer.current?.focus();
  }
  const renderEvent = (e: AgentEvent) => {
    const d = e.data;
    const displayText = (config?.skills ?? []).reduce((value, skill) => value.replaceAll(skill.id, skill.title), d.text ?? '');
    if (d.hidden) return <p className="agent-note">此任务记录已删除</p>;
    if (e.kind === 'user') return <div className="agent-user-message"><div>{d.text}</div>{d.ref_ids?.length ? <div className="agent-message-refs">{d.ref_ids.map(id => { const a = asset(id); return a ? <button key={id} onClick={() => setPreview(a)}><img src={a.url} alt={a.name} /></button> : null; })}</div> : null}</div>;
    if (e.kind === 'assistant') return <div className={`agent-assistant-message agent-markdown ${d.streaming ? 'is-streaming' : ''}`}><Markdown skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{displayText}</Markdown>{d.streaming ? <span className="agent-stream-cursor" aria-label="正在输出" /> : null}</div>;
    if (e.kind === 'tool') return <div className={`agent-tool-event ${d.status}`}><span className="agent-tool-dot" /><span>{d.title}</span><small>{({ running: '执行中', completed: '已完成', failed: '未完成', interrupted: '已中断' } as Record<string, string>)[d.status ?? '']}{d.seconds != null ? ` · ${d.seconds}秒` : ''}</small></div>;
    if (e.kind === 'question') return <div className="agent-assistant-message"><p>{d.text}</p><div className="agent-question-options">{d.options?.map(option => <button disabled={active || readOnly} key={option} onClick={() => void send(option)}>{option}<Icon name="arrow" size={15} /></button>)}</div></div>;
    if (e.kind === 'skill') return <div className="agent-skill-event"><Icon name="spark" size={14} /><span>{d.title}{d.examples?.length ? <small className="agent-example-titles">{d.examples.join(' · ')}</small> : null}</span></div>;
    if (e.kind === 'plan') return <details className="agent-plan-message"><summary><Icon name="settings" size={16} />创作方案<span>{d.summary}</span><Icon name="chevron" size={14} /></summary><ol>{d.steps?.map(s => <li key={s}>{s}</li>)}</ol></details>;
    if (e.kind === 'generation') return <div className="agent-generation-label"><Icon name="image" size={16} /><span>{d.title}</span><details><summary>查看提示词</summary><p>{d.prompt}</p></details></div>;
    if (e.kind === 'result') return <div className="agent-result"><div className="agent-result-grid">{d.images?.map(image => <figure key={image.ref_id}><button className="agent-result-image" onClick={() => setPreview({ url: image.url, name: '生成图片' })}><img src={image.url} alt="生成作品，点击放大" loading="lazy" /></button><figcaption><button disabled={active || readOnly} onClick={() => reuse(image.ref_id)}><Icon name="brush" size={15} />以此图继续修改</button><a href={image.url} download="nandou-image.jpg" aria-label="下载图片"><Icon name="download" size={16} /></a></figcaption></figure>)}</div>{d.error ? <p className="agent-note">{d.error}</p> : null}{d.credits != null ? <small>本任务消耗 {d.credits} 积分</small> : null}</div>;
    if (e.kind === 'context') return <p className="agent-context-note"><Icon name="spark" size={13}/>{d.text}</p>;
    if (e.kind === 'notice') return <p className="agent-note" role="status">{d.text}</p>;
    if (e.kind === 'quote') return <p className="agent-quote-event">本任务预估 {d.credits == null ? '暂不可用' : `${d.credits} 积分`} · 以实际结算为准</p>;
    return null;
  };

  return <div className="agent-workspace">
    <aside className="agent-sidebar"><div className="agent-sidebar-label">创意空间<span>AGENT</span></div><button className="agent-new" onClick={() => selectChat('')} disabled={sending}><Icon name="plus" size={17} />开启新创作</button>
      <div className="agent-history-heading">对话记录{user.is_admin ? <label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />全部用户</label> : null}</div>
      <div className="agent-chat-list">{chats.length ? chats.map(c => <div key={c.id} className={`agent-chat-item ${cid === c.id ? 'selected' : ''}`}><button onClick={() => selectChat(c.id)} disabled={sending}><span>{c.title}</span><small>{all ? `${c.owner_email} · ` : ''}{agentStatus(c.status)}{c.hidden_at ? ' · 用户已删除' : ''}</small></button>{c.owner_id === user.id && !c.hidden_at ? <button className="agent-chat-delete" title="从我的记录中删除" aria-label={`删除对话 ${c.title}`} onClick={() => void hideChat(c)}><Icon name="trash" size={14} /></button> : null}</div>) : <p className="agent-sidebar-empty">每一个灵感，都在这里继续。</p>}</div>
      <a className="agent-guide-link" href="/studio/agent-guide.html" target="_blank" rel="noreferrer">Agent 使用指南 <Icon name="arrow" size={14} /></a>
      <a className="agent-guide-link agent-model-guide-link" href="/studio/model-guide.html" target="_blank" rel="noreferrer">模型怎么选 <Icon name="arrow" size={14} /></a>
    </aside>
    <section className="agent-conversation" aria-label="Agent 创作对话">
      <div className="agent-conversation-heading"><span>{view?.chat.title ?? '新的创作'}</span><small>{readOnly ? `查看 ${view?.chat.owner_email} 的创作` : latest ? agentStatus(latest.status) : '一起把灵感变成图像'}</small></div>
      {view?.context ? <details className="agent-context-summary"><summary>会话摘要 · 已保留早期要求</summary><p>{view.context.summary}</p></details> : null}
      <div className="agent-messages" ref={scroller} onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
        {!view?.events.length ? <div className="agent-welcome"><div className="agent-welcome-mark"><Icon name="spark" size={32} /></div><p className="agent-eyebrow">NANDOU CREATIVE AGENT</p><h1>说出想法，<br />我们一起把它做好。</h1><p>从理解需求到成图，再到每一次细节调整。</p><div className="agent-starters">{STARTERS.map(s => <button key={s.title} onClick={() => { setText(s.prompt); composer.current?.focus(); }}><Icon name={s.icon} size={22} /><strong>{s.title}</strong><span>{s.detail}</span><Icon name="arrow" size={16} /></button>)}</div></div>
          : <div className="agent-message-column">{view.events.filter(e => !['usage', 'status'].includes(e.kind)).map(e => <div key={e.id} className={`agent-event agent-event-${e.kind}`}>{renderEvent(e)}</div>)}{running ? <div className="agent-thinking" role="status"><span />{status ?? '正在创作'}<small>已用 {Math.max(0, Math.floor(clock / 1000 - (latest?.created_at ?? 0)))} 秒</small></div> : null}</div>}
      </div>
      <div className="agent-composer-wrap">
        {plan && running ? <details className="agent-live-plan"><summary><Icon name="settings" size={17} /><span>{count ? `已交付 ${count} 张` : '任务执行中'}</span><div className="agent-stage-track">{['理解与规划', '生成图片', '检查与交付'].map((label, i) => <span key={label} className={i < stage ? 'done' : i === stage ? 'current' : ''}>{label}</span>)}</div><Icon name="chevron" size={15} /></summary><ol>{plan.data.steps?.map(s => <li key={s}>{s}</li>)}</ol></details> : null}
        {draftError || optsError ? <p className="agent-note" role="status">{draftError || optsError}</p> : null}
        {error ? <div className="agent-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" size={14} /></button></div> : null}
        {config && !config.configured ? <p className="agent-note">创作助手尚未配置，请联系管理员。</p> : null}
        <form ref={form} className={`agent-composer ${readOnly ? 'readonly' : ''}`} onSubmit={e => { e.preventDefault(); void send(); }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!active && !readOnly) void addFiles(e.dataTransfer.files); }}>
          <div className="agent-input-row"><ReferenceDock references={[...uploads.map(u=>({id:u.id,name:u.name,dataUrl:u.data_url,width:u.width,height:u.height})), ...refs.map(r=>({id:r.id,name:r.name,dataUrl:r.url,width:r.width??1024,height:r.height??1024}))]} add={()=>fileInput.current?.click()} remove={id=>{setUploads(items=>items.filter(x=>x.id!==id));setRefs(items=>items.filter(x=>x.id!==id));}} maxReferences={8} disabled={active || readOnly || uploading}/><div className="agent-prompt-content"><AnimatePresence initial={false}>{skills.length > 0 && <motion.div key="skills" className="agent-selected-skills" role="group" aria-label="已选创作技能" initial={{opacity:0,height:0}} animate={{opacity:1,height:"auto"}} exit={{opacity:0,height:0}} transition={{duration:reducedMotion ? 0 : .22}}><span className="agent-selected-skills-label">创作技能</span>{skills.map(s => <span className="agent-skill-token" key={s.id} title={config?.skills.find(item => item.id === s.id)?.description}><span className="agent-skill-token-icon"><Icon name="brush" size={14}/></span><span>{s.title}</span><button type="button" disabled={active || readOnly} aria-label={`移除技能 ${s.title}`} onClick={() => { setDraft(d => ({...d, skills:(d.skills ?? []).filter(item => item.id !== s.id)})); setPendingId(null); composer.current?.focus(); }}><Icon name="close" size={12}/></button></span>)}</motion.div>}</AnimatePresence><textarea ref={composer} aria-label="Agent需求" value={text} maxLength={8000} disabled={readOnly || sending || !draftReady} rows={3} placeholder={readOnly ? '管理员仅查看其他用户的对话' : '描述你的想法，或上传产品图，让 Agent 帮你完成创作…'} onChange={e => { setText(e.target.value); setPendingId(null); }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} onPaste={e => { if (e.clipboardData.files.length && !active && !readOnly) { e.preventDefault(); void addFiles(e.clipboardData.files); } }} /></div></div>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
          <div className="agent-composer-toolbar"><span className="agent-mode-label"><Icon name="spark" size={17} />Agent 模式</span><button type="button" data-layer-trigger aria-label="生成偏好" onClick={() => { setSettingsOpen(!settingsOpen); setSkillsOpen(false); }} aria-expanded={settingsOpen}><Icon name="settings" size={16} /><span>生成偏好</span></button><button type="button" data-layer-trigger aria-label="技能" onClick={() => { setSkillsOpen(!skillsOpen); setSettingsOpen(false); }} aria-expanded={skillsOpen}><Icon name="brush" size={16} /><span>技能</span></button><div className="agent-send-area"><span>{uploading ? '读取图片中' : quote == null ? '出图时估算积分' : `约 ${Number(quote.toFixed(4))} 积分/张`}</span>{running ? <button type="button" className="agent-send" aria-label="停止 Agent" onClick={() => void agentRequest(`chats/${cid}/stop`, {}).catch(e => setError(e.message))}><Icon name="stop" size={17} /></button> : <button className="agent-send" type="submit" aria-label="发送需求" disabled={active || uploading || (!text.trim() && !skills.length) || readOnly || !config?.configured}><Icon name="arrow" size={22} /></button>}</div></div>
          {settingsOpen ? <AgentPreferences value={opts} update={changes=>setOpts(s=>({...s,...changes}))} disabled={active || readOnly} close={()=>setSettingsOpen(false)}/> : null}
          <AnimatePresence>{skillsOpen && <motion.div className="agent-skill-picker" data-motion-layer role="dialog" aria-label="创作技能" initial={{opacity:0,y:12,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:8,scale:.97}} transition={{duration:reducedMotion ? 0 : .24, ease:[.23,1,.32,1]}}><header><span className="agent-skill-heading-icon"><Icon name="spark" size={20}/></span><div><strong>创作技能</strong><p>选一个方向，把想法变成更好的画面。</p></div><button type="button" className="icon-button" aria-label="关闭技能" onClick={() => setSkillsOpen(false)}><Icon name="close" size={16}/></button></header><div className="agent-skill-list">{config?.skills.map(s => <button type="button" disabled={active || readOnly} key={s.id} aria-pressed={skills.some(item => item.id === s.id)} onClick={() => { setDraft(d => ({...d, skills:(d.skills ?? []).some(item => item.id === s.id) ? d.skills : [...(d.skills ?? []), {id:s.id,title:s.title}]})); setPendingId(null); setSkillsOpen(false); composer.current?.focus(); }}><span className="agent-skill-row-icon"><Icon name="brush" size={18}/></span><span className="agent-skill-copy"><strong>{s.title}</strong><small>{s.description}</small></span><Icon name={skills.some(item => item.id === s.id) ? 'check' : 'plus'} size={16}/></button>)}</div></motion.div>}</AnimatePresence>
        </form><p className="agent-composer-hint">需求明确直接创作 · 保留产品细节 · 反馈后继续调整</p>
      </div>
    </section>{preview ? <ImagePreview image={preview} close={() => setPreview(null)} /> : null}
  </div>;
}
