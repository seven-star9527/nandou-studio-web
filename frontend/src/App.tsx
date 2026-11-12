import { useEffect, useRef, useState } from 'react';
import { animate as springAnimate, type AnimationPlaybackControls } from 'motion';
import GlassTabs from './components/GlassTabs';
import GlassDefs from './components/GlassDefs';
import DocumentReader from './components/DocumentReader';
import { ThemeToggle } from './theme';
import AgentWorkspace from './components/AgentWorkspace';
import { flushSync } from 'react-dom';
import { IMAGE_UPLOAD_HINT } from './image-upload-limits';
import CompareBoard from './components/CompareBoard';
import QuickEdit from './components/QuickEdit';
import type { Artwork } from './types';
import { workRequest, toolNames, type QuickTool, type WorkImage } from './workbench-api';
import Composer from './components/Composer';
import History, { isBusy } from './components/History';
import Icon from './components/Icon';
import ScenePresets from './components/ScenePresets';
import PromptLibrary from './components/PromptLibrary';
import CanvasProjects, { type CanvasProject } from './components/CanvasProjects';
import { useStudio } from './useStudio';
import CloudCreditsAccount from './components/CloudCreditsAccount';
import PromptPolisher from './components/PromptPolisher';
import ShowcaseGallery from './components/ShowcaseGallery';
import { loadStudioImage } from './task-references';
import { checkImageBatch } from './image-upload-limits';
import { RATIOS } from './resolution-policy';
import type { ChooseTemplate } from './components/TemplateActions';
import { referenceLimit } from './cloud-contract';
import AuthGate, { type AuthWorkspace } from './components/AuthGate';
import AdminUsage from './components/AdminUsage';
import './auth.css';
import './components/agent-workspace.css';


export default function App() {
  return <><GlassDefs/><AuthGate>{workspace => <DocumentReader><Studio {...workspace} /></DocumentReader>}</AuthGate></>;
}

function Studio({ user, adminEntry, logout }: AuthWorkspace) {
  const studio = useStudio();
  const [workspace, selectWorkspace] = useState<'studio' | 'agent'>(() => { try { return sessionStorage.getItem(`nandou-mode:${user.id}`) === 'agent' ? 'agent' : 'studio'; } catch { return 'studio'; } });
  const motion = useRef<Array<Animation | AnimationPlaybackControls>>([]);
  const switchSequence = useRef(0);
  useEffect(() => () => { ++switchSequence.current; motion.current.forEach(animation => animation.cancel()); }, []);
  const setWorkspace = (value: 'studio' | 'agent', animate: boolean) => {
    if (value === workspace) return;
    const sequence = ++switchSequence.current;
    const previous = document.querySelector('.agent-composer, .composer')?.getBoundingClientRect();
    motion.current.forEach(animation => animation.cancel());
    flushSync(() => selectWorkspace(value));
    try { sessionStorage.setItem(`nandou-mode:${user.id}`, value); } catch { /* Optional tab preference. */ }
    if (!animate || !previous || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const selector = value === 'agent' ? '.agent-composer' : '.composer';
    const move = () => {
      if (sequence !== switchSequence.current) return true;
      const composer = document.querySelector<HTMLElement>(selector);
      if (!composer) return false;
      const next = composer.getBoundingClientRect();
      if (!next.width || !next.height) return true;
      // FLIP preserves the input's spatial origin and retargets from its current frame.
      motion.current = [springAnimate(composer, {
        transform: [`translate3d(${previous.left-next.left}px,${previous.top-next.top}px,0) scale(${previous.width/next.width},${previous.height/next.height})`, 'translate3d(0px,0px,0px) scale(1,1)'],
      }, {type: 'spring', duration: .5, bounce: .2, onComplete: () => { if (sequence === switchSequence.current) composer.style.transform = ''; }})];
      const scene = document.querySelector(value === 'agent' ? '.agent-messages' : '.creation-section h1');
      if (scene) motion.current.push(scene.animate([{opacity: 0},{opacity: 1}], {duration: 200, easing: 'cubic-bezier(.23,1,.32,1)'}));
      return true;
    };
    if (!move()) {
      const observer = new MutationObserver(() => { if (move()) observer.disconnect(); });
      observer.observe(document.getElementById('root')!, {childList: true, subtree: true});
      setTimeout(() => observer.disconnect(), 1000);
    }
  };
  const editing = studio.references.length > 0;
  const [surface,setSurface] = useState<'image'|'canvas'>('image');
  const [project,setProject] = useState<CanvasProject|null>(null);
  const [edits, setEdits] = useState<Artwork[]>([]);
  const [editHistoryError, setEditHistoryError] = useState('');
  const refreshEdits = async () => {
    try { setEdits(await workRequest<Artwork[]>('history')); setEditHistoryError(''); }
    catch (cause) { setEditHistoryError(String(cause)); }
  };
  useEffect(() => { void refreshEdits(); }, []);
  const [board, setBoard] = useState<{initial?:WorkImage} | null>(null);
  const openBoard = (initial?:WorkImage) => { setQuick(null); void refreshEdits(); setBoard({initial});selectWorkspace('studio');setSurface('canvas');setProject(null);window.scrollTo(0,0); };
  const [quick, setQuick] = useState<{tool:QuickTool; source?:WorkImage} | null>(null);
  const [historyOpen, setHistoryOpen] = useState(() => window.innerWidth >= 1150);
  const [previousPrompt,setPreviousPrompt] = useState<{before:string;minimum:number;applied:string; added?:string; ratio?:string; appliedRatio?:string}|null>(null);
  const [templateNotice,setTemplateNotice] = useState('');
  const applyTemplate = (text:string,minimum=0) => {
    setTemplateNotice('');
    setPreviousPrompt({before:studio.prompt,minimum:studio.minReferences,applied:text});
    studio.setTemplate(text,minimum);
    requestAnimationFrame(()=>{
      const field=document.querySelector<HTMLTextAreaElement>('.composer textarea');
      const slot=/【[^】]+】/.exec(text);
      field?.focus({preventScroll:true});
      if(slot)field?.setSelectionRange(slot.index,slot.index+slot[0].length);
    });
  };
  const chooseTemplate: ChooseTemplate = async (choice, onlyImage, signal) => {
    const reference = choice.image ? await loadStudioImage(choice.image, choice.title + ' · 样图') : undefined;
    if (signal.aborted) return;
    if (reference) {
      const limit = studio.cloudModel ? referenceLimit(studio.cloudModel) : studio.config.maxReferences ?? 3;
      if (studio.references.length >= limit) throw new Error(`当前最多使用 ${limit} 张参考图，请先移除一张。`);
      checkImageBatch([], [...studio.references.map(r=>r.dataUrl), reference.dataUrl]);
      studio.appendReference(reference);
    }
    let note = '已添加参考图';
    if (!onlyImage) {
      applyTemplate(choice.prompt,choice.minimum);
      const supportsRatio = studio.cloudModel ? studio.cloudModel.ratios.includes(choice.ratio)
        : RATIOS.some(r=>r.id===choice.ratio);
      if (supportsRatio) studio.setGeometry(choice.ratio, studio.settings.resolution);
      const ratio = supportsRatio ? choice.ratio : studio.settings.ratio;
      setPreviousPrompt({before:studio.prompt, minimum:studio.minReferences, applied:choice.prompt, added:reference?.id, ratio:studio.settings.ratio, appliedRatio:ratio});
      note = `已套用「${choice.title}」 · ${ratio}${supportsRatio?'':'（沿用当前比例）'}${reference?' · 已带入样图':''}`;
    }
    setTemplateNotice(note);
    requestAnimationFrame(()=>{
      const field=document.querySelector<HTMLTextAreaElement>('.composer textarea');
      field?.focus({preventScroll:true});field?.scrollIntoView({block:'center',behavior:'instant'});
    });
  };
  const busy = isBusy(studio.job);
  const connectedLabel = studio.connecting ? '连接中' : studio.connected ? '已连接' : '未连接';
  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="/studio/" aria-label="Nandou Studio 首页"><img className="brand-logo" src={`${import.meta.env.BASE_URL}brand/nandou-mark-on-dark.svg`} width="34" height="34" alt="" /><span>Nandou Studio</span></a>
      <GlassTabs className="workspace-mode-switch" role="navigation" aria-label="创作模式"><button className={workspace === 'studio' ? 'active' : ''} onClick={event => void setWorkspace('studio', event.detail > 0)}>图片创作</button><button className={workspace === 'agent' ? 'active' : ''} onClick={event => void setWorkspace('agent', event.detail > 0)}>Agent 创作</button></GlassTabs>
      <div className="header-actions"><ThemeToggle/><CloudCreditsAccount account={studio.cloudAccount} loading={studio.accountLoading} error={studio.accountError} refresh={() => void studio.refreshAccount()} /><button className={`connection ${studio.connected ? 'connected' : ''}`} onClick={() => { if (!busy) void studio.connect(); }} disabled={studio.connecting || busy} title="重新连接图像服务"><span className={`connection-dot ${studio.connecting ? 'spinning' : ''}`} />{connectedLabel}</button><div className="studio-account"><span className="studio-account-identity" title={user.email}><span>{user.email}</span>{user.is_admin ? <small>管理员</small> : null}</span>{user.is_admin && adminEntry ? <AdminUsage /> : null}<button className="account-logout-button" onClick={() => void logout()}>退出</button></div></div>
    </header>
    {workspace === 'agent' ? <AgentWorkspace onQuick={source=>setQuick({tool:'cutout',source})} compare={openBoard} user={user} client={studio.client} refreshAccount={studio.refreshAccount} /> : !studio.draftReady ? <div className="service-notice">正在恢复创作草稿…</div> : <div className={`studio-layout ${historyOpen ? '' : 'rail-closed'}`}>
      <aside className="creation-rail" aria-label="创作记录侧栏"><button className="quiet-button rail-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? '收起记录' : '创作记录'}</button>
      {historyOpen && <History compare={openBoard} onQuick={source => setQuick({tool:'cutout',source})} isAdmin={user.is_admin || user.role === 'admin'} hideTask={async id => { await studio.hideTask(id,user.is_admin); await refreshEdits(); }} currentUserId={user.id} artworks={[...edits,...studio.history].sort((a,b) => (Date.parse(b.generatedAt ?? '')||0)-(Date.parse(a.generatedAt ?? '')||0))} cloudTasks={studio.cloudTasks} job={studio.job} loading={studio.loadingHistory} error={studio.historyError || editHistoryError} refresh={() => { void studio.refreshHistory(); void refreshEdits(); }} stop={() => void studio.stop()} reuse={studio.reuse} />}</aside>
      <main className="studio-content"><section className="creation-section" aria-labelledby="creation-title">
        {studio.draftError ? <div className="service-notice" role="status">{studio.draftError}</div> : null}
        <div className="title-pattern" aria-hidden="true" />
        <h1 id="creation-title">你好，今天想要创作什么？</h1>
        <GlassTabs className="creation-tabs segmented" role="tablist" aria-label="创作方式" onKeyDown={e=>{
          if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;
          e.preventDefault();
          const next = e.key==='Home'?'image':e.key==='End'?'canvas':surface==='image'?'canvas':'image';
          const target=e.currentTarget.querySelectorAll('button')[next==='image'?0:1];
          target.click();target.focus();
        }}>
          {(['image','canvas'] as const).map(t=><button key={t} role="tab" aria-selected={surface===t} className={surface===t?'selected':''} onClick={()=>{setSurface(t);if(t==='image')setBoard(null);}}>{t==='image'?'图片生成':'画布'}</button>)}
        </GlassTabs>
        {surface==='canvas' ? <CanvasProjects key={project?.id??'projects'} adding={Boolean(board?.initial)} open={setProject}/> : <>
        <Composer settings={studio.settings} config={studio.config} params={studio.params} models={studio.models} prompt={studio.prompt} references={studio.references}
          editing={editing} setPrompt={studio.setPrompt} update={changes => studio.setSettings(previous => ({ ...previous, ...changes }))}
          setGeometry={(ratio, resolution) => studio.setGeometry(ratio, resolution, editing)} addReferences={studio.addReferences} removeReference={studio.removeReference} selectModel={studio.selectModel}
          selectLocal={studio.selectLocal} selectCloud={studio.selectCloudModel} cloudModel={studio.cloudModel} cloudModels={studio.cloudModels} cloudConfigured={studio.cloudConfigured} cloudCapabilityError={studio.cloudCapabilityError}
          creditQuote={studio.creditQuote}
          polisher={<PromptPolisher client={studio.client} prompt={studio.prompt} setPrompt={studio.setPrompt} width={studio.settings.width} height={studio.settings.height} model={studio.cloudModel?.id ?? studio.settings.model} referenceCount={editing ? studio.references.length : 0} referenceIds={editing ? studio.references.map(reference => reference.id).join(',') : ''} busy={busy} />}
          generate={() => studio.generate(editing)} busy={busy} ready={studio.ready && studio.references.length>=studio.minReferences} />
        {studio.references.length<studio.minReferences && <p className="panel-note">此提示词还需 {studio.minReferences-studio.references.length} 张参考图。</p>}
        {editing && studio.references.length > 0 ? <p className="edit-notice">{IMAGE_UPLOAD_HINT}。较大原图会另建缩图作为生图参考；原尺寸精修请使用修图 Agent。</p> : null}
        {studio.error ? <div className="error-banner" role="alert"><span>{studio.error}</span><button className="icon-button" onClick={() => studio.setError('')} aria-label="关闭错误提示"><Icon name="close" size={15} /></button></div> : null}
        {!studio.cloudModel && studio.connected && !studio.settings.model ? <div className="service-notice" role="status">服务已连接，正在等待 Qwen-Image-2.1 模型就绪。<button onClick={() => void studio.connect()}>刷新模型</button></div> : null}
        {!studio.cloudModel && studio.connected && studio.settings.model && (studio.configurationError || !studio.backendReady || !studio.localReady) ? <div className="service-notice" role="status"><span>{studio.configurationError || (!studio.localReady ? '模型组件正在下载或尚未就绪，请稍后刷新连接。' : '图像服务尚未就绪，请稍后刷新连接。')}</span><button onClick={() => void studio.connect()}>刷新连接</button></div> : null}
        {studio.cloudModel && !studio.cloudConfigured ? <div className="service-notice" role="status"><span>APIMart 云模型待配置。请在服务端配置密钥后刷新连接。</span><button onClick={() => void studio.connect()}>刷新连接</button></div> : null}
        <ScenePresets currentPrompt={studio.prompt} apply={applyTemplate} />
        <div className="library-entry"><PromptLibrary referenceCount={studio.references.length} apply={chooseTemplate} /></div>
        {templateNotice && <p className="panel-note" role="status">{templateNotice}</p>}
        {previousPrompt && previousPrompt.applied===studio.prompt && <button className="scene-add" onClick={()=>{studio.setTemplate(previousPrompt.before,previousPrompt.minimum);if(previousPrompt.added)studio.removeReference(previousPrompt.added);if(previousPrompt.ratio && previousPrompt.appliedRatio===studio.settings.ratio)studio.setGeometry(previousPrompt.ratio,studio.settings.resolution);setPreviousPrompt(null);setTemplateNotice('');}}>撤销套用</button>}</>}
      </section>
      {surface==='image' && <><section className="work-entry" aria-label="快捷修图"><div className="work-heading"><h2>快捷修图</h2></div><div className="work-tiles">{(Object.keys(toolNames) as QuickTool[]).map(tool =>
        <button className="quiet-button" key={tool} onClick={() => setQuick({tool})}><Icon name={tool==='cutout'?'image':tool==='retouch'?'brush':'expand'} />{toolNames[tool]}<Icon name="arrow" size={16}/></button>)}</div></section>
      <ShowcaseGallery apply={chooseTemplate} hasReferences={editing} /></>}
    </main></div>}
    {quick && <QuickEdit compare={openBoard} switchTool={(tool,source) => setQuick({tool,source})} tool={quick.tool} initial={quick.source} close={() => {setQuick(null);void refreshEdits();}} />}
    {project && <CompareBoard key={project.id} project={project} initial={board?.initial} close={() => {setProject(null);setBoard(null);}} />}
  </div>;
}
