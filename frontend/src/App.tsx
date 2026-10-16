import { lazy, Suspense, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import Composer from './components/Composer';
import History, { isBusy } from './components/History';
import Icon from './components/Icon';
import ScenePresets from './components/ScenePresets';
import PromptLibrary from './components/PromptLibrary';
import { dimensions } from './resolution-policy';
import { useStudio } from './useStudio';
import CloudCreditsAccount from './components/CloudCreditsAccount';
import PromptPolisher from './components/PromptPolisher';
import ShowcaseGallery from './components/ShowcaseGallery';
import { referenceLimit } from './cloud-contract';
import AuthGate, { type AuthWorkspace } from './components/AuthGate';
import AdminUsage from './components/AdminUsage';
import './auth.css';
import './components/agent-workspace.css';

const loadAgent = () => import('./components/AgentWorkspace');
const AgentWorkspace = lazy(loadAgent);

export default function App() {
  return <AuthGate>{workspace => <Studio {...workspace} />}</AuthGate>;
}

function Studio({ user, adminEntry, logout }: AuthWorkspace) {
  const studio = useStudio();
  const [workspace, selectWorkspace] = useState<'studio' | 'agent'>(() => { try { return sessionStorage.getItem(`nandou-mode:${user.id}`) === 'agent' ? 'agent' : 'studio'; } catch { return 'studio'; } });
  const motion = useRef<Animation[]>([]);
  const switchSequence = useRef(0);
  const setWorkspace = async (value: 'studio' | 'agent', animate: boolean) => {
    const sequence = ++switchSequence.current;
    if (value === workspace) return;
    if (value === 'agent') { try { await loadAgent(); } catch { return; } }
    if (sequence !== switchSequence.current) return;
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
      motion.current = [composer.animate([
        {transform: `translate3d(${previous.left-next.left}px,${previous.top-next.top}px,0) scale(${previous.width/next.width},${previous.height/next.height})`, opacity: .8},
        {transform: 'translate3d(0,0,0) scale(1)', opacity: 1},
      ], {duration: 280, easing: 'cubic-bezier(.77,0,.175,1)'} )];
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
  const { editing, setEditing } = studio;
  const busy = isBusy(studio.job);
  const connectedLabel = studio.connecting ? '连接中' : studio.connected ? '已连接' : '未连接';
  const changeEditing = (value: boolean) => {
    setEditing(value);
    if (!studio.cloudModel && studio.settings.ratio === 'smart') studio.setSettings(previous => ({ ...previous, ...dimensions('smart', previous.resolution, value ? studio.references[0] : undefined) }));
  };
  const chooseCloud = (id: string) => { studio.selectCloudModel(id); setEditing(studio.cloudModels.find(model => model.id === id)?.preferredOperation === 'edit'); };
  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="/studio/" aria-label="Nandou Studio 首页"><img className="brand-logo" src={`${import.meta.env.BASE_URL}brand/nandou-mark-on-dark.svg`} width="34" height="34" alt="" /><span>Nandou Studio</span></a>
      <nav className="workspace-mode-switch" aria-label="创作模式"><button className={workspace === 'studio' ? 'active' : ''} onClick={event => void setWorkspace('studio', event.detail > 0)}>图片创作</button><button className={workspace === 'agent' ? 'active' : ''} onPointerEnter={() => void loadAgent().catch(() => undefined)} onClick={event => void setWorkspace('agent', event.detail > 0)}>Agent 创作</button></nav>
      <div className="header-actions"><CloudCreditsAccount account={studio.cloudAccount} loading={studio.accountLoading} error={studio.accountError} refresh={() => void studio.refreshAccount()} /><button className={`connection ${studio.connected ? 'connected' : ''}`} onClick={() => { if (!busy) void studio.connect(); }} disabled={studio.connecting || busy} title="重新连接图像服务"><span className={`connection-dot ${studio.connecting ? 'spinning' : ''}`} />{connectedLabel}</button><div className="studio-account"><span className="studio-account-identity" title={user.email}><span>{user.email}</span>{user.is_admin ? <small>管理员</small> : null}</span>{user.is_admin && adminEntry ? <AdminUsage /> : null}<button className="account-logout-button" onClick={() => void logout()}>退出</button></div></div>
    </header>
    {workspace === 'agent' ? <Suspense fallback={<div className="service-notice">正在打开创作空间…</div>}><AgentWorkspace user={user} client={studio.client} refreshAccount={studio.refreshAccount} /></Suspense> : !studio.draftReady ? <div className="service-notice">正在恢复创作草稿…</div> : <main>
      <section className="creation-section" aria-labelledby="creation-title">
        {studio.draftError ? <div className="service-notice" role="status">{studio.draftError}</div> : null}
        <div className="title-pattern" aria-hidden="true" />
        <h1 id="creation-title">让想象，成为图像</h1>
        <Composer settings={studio.settings} config={studio.config} params={studio.params} models={studio.models} prompt={studio.prompt} references={studio.references}
          editing={editing} setEditing={changeEditing} setPrompt={studio.setPrompt} update={changes => studio.setSettings(previous => ({ ...previous, ...changes }))}
          setGeometry={(ratio, resolution) => studio.setGeometry(ratio, resolution, editing)} addReferences={studio.addReferences} removeReference={studio.removeReference} selectModel={studio.selectModel}
          selectLocal={studio.selectLocal} selectCloud={chooseCloud} cloudModel={studio.cloudModel} cloudModels={studio.cloudModels} cloudConfigured={studio.cloudConfigured} cloudCapabilityError={studio.cloudCapabilityError}
          creditQuote={studio.creditQuote}
          polisher={<PromptPolisher client={studio.client} prompt={studio.prompt} setPrompt={studio.setPrompt} width={studio.settings.width} height={studio.settings.height} model={studio.cloudModel?.id ?? studio.settings.model} referenceCount={editing ? studio.references.length : 0} referenceIds={editing ? studio.references.map(reference => reference.id).join(',') : ''} busy={busy} />}
          generate={() => studio.generate(editing)} busy={busy} ready={studio.ready} />
        {studio.error ? <div className="error-banner" role="alert"><span>{studio.error}</span><button className="icon-button" onClick={() => studio.setError('')} aria-label="关闭错误提示"><Icon name="close" size={15} /></button></div> : null}
        {!studio.cloudModel && studio.connected && !studio.settings.model ? <div className="service-notice" role="status">服务已连接，正在等待 Qwen-Image-2.1 模型就绪。<button onClick={() => void studio.connect()}>刷新模型</button></div> : null}
        {!studio.cloudModel && studio.connected && studio.settings.model && (studio.configurationError || !studio.backendReady || !studio.localReady) ? <div className="service-notice" role="status"><span>{studio.configurationError || (!studio.localReady ? '模型组件正在下载或尚未就绪，请稍后刷新连接。' : '图像服务尚未就绪，请稍后刷新连接。')}</span><button onClick={() => void studio.connect()}>刷新连接</button></div> : null}
        {studio.cloudModel && !studio.cloudConfigured ? <div className="service-notice" role="status"><span>APIMart 云模型待配置。请在服务端配置密钥后刷新连接。</span><button onClick={() => void studio.connect()}>刷新连接</button></div> : null}
        <ScenePresets currentPrompt={studio.prompt} apply={text => { studio.setPrompt(text); if (text.includes('参考图')) changeEditing(true); }} />
        <div className="library-entry"><PromptLibrary referenceCount={studio.references.length} apply={(text, minReferences) => { studio.setPrompt(text); if (minReferences > 0) changeEditing(true); }} /></div>
      </section>
      <ShowcaseGallery apply={(prompt, referenceEdit) => { studio.setPrompt(prompt); changeEditing(referenceEdit); window.scrollTo({ top: 0, behavior: 'smooth' }); }} addReference={async file => {
        const limit = studio.cloudModel ? referenceLimit(studio.cloudModel) : studio.config.maxReferences ?? 3;
        if (studio.references.length >= limit) throw new Error(`最多添加${limit}张参考图，请先移除一张。`);
        changeEditing(true); await studio.addReferences([file]);
      }} />
      <History isAdmin={user.is_admin || user.role === 'admin'} hideTask={studio.hideTask} artworks={studio.history} cloudTasks={studio.cloudTasks} job={studio.job} loading={studio.loadingHistory} error={studio.historyError} refresh={() => void studio.refreshHistory()} stop={() => void studio.stop()} reuse={artwork => { const operation = studio.reuse(artwork); if (operation) setEditing(operation === 'edit'); }} />
    </main>}
  </div>;
}
