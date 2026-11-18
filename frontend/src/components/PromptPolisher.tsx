import { useEffect, useRef, useState } from 'react';
import type { SwarmClient } from '../api';
import { polishIdentity, validPolishResult } from '../commerce-contract';
import type { PolishCapabilities, PolishInput, PolishResult } from '../commerce-contract';
import { useModalDialog } from '../useModalDialog';
import ModalPortal from './ModalPortal';
import Icon from './Icon';
import GlassTabs from './GlassTabs';
import GlassSelect from './GlassSelect';
import { createId } from '../id';
import type { ReferenceImage } from '../types';

export default function PromptPolisher({ client, prompt, setPrompt, applyPrompt, width, height, aspectRatio, model, referenceIds, referenceCount, references, busy }: {
  client: SwarmClient; prompt: string; setPrompt: (value: string) => void; applyPrompt: (value: string) => void; width: number; height: number;
  model: string; aspectRatio: string; referenceIds: string; referenceCount: number; references: ReferenceImage[]; busy: boolean;
}) {
  const [caps, setCaps] = useState<PolishCapabilities | null>(null);
  const [scope, setScope] = useState<'general' | 'commerce'>('general');
  const [platform, setPlatform] = useState('amazon');
  const [category, setCategory] = useState('other');
  const [scene, setScene] = useState('main');
  const [facts, setFacts] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PolishResult | null>(null);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<{ prompt: string; identity: string } | null>(null);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const requestLock = useRef(false);
  useModalDialog(open, dialog, () => setOpen(false));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refreshCapabilities = async () => {
    setError('');
    try { const value = await client.request<PolishCapabilities>('GetStudioPolishCapabilities'); if (mounted.current) setCaps(value); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '润色配置读取失败'); }
  };
  useEffect(() => {
    if (open && !caps) void refreshCapabilities();
  }, [open, caps]);
  const input: PolishInput = { scope, prompt, facts, platform, category, scene, reference_count: referenceCount, width, height, aspect_ratio:aspectRatio };
  const identity = polishIdentity(input, model, referenceIds);
  const stale = Boolean(source && source.identity !== identity);
  const generalAvailable = Boolean(caps?.scopes?.includes('general'));
  const polish = async () => {
    if (requestLock.current) return;
    if (scope === 'general' && !generalAvailable) { setError('当前服务尚未加载通用润色更新，请更新服务后再试。'); return; }
    const snapshot = { prompt, identity };
    requestLock.current = true;
    setLoading(true); setError(''); setResult(null); setSource(snapshot);
    try {
      const value = await client.request<PolishResult>('PolishStudioPrompt', {...input, request_id: createId(), reference_images: references.map(ref => ref.dataUrl)});
      if (!validPolishResult(value)) throw new Error('润色结果格式不正确，原提示词保留。');
      if (mounted.current) { setResult(value); setDraft(value.prompt); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '润色失败，原提示词保留。'); }
    finally { requestLock.current = false; if (mounted.current) setLoading(false); }
  };
  return <div className="polish-control">
    <button className="polish-entry" aria-label="AI 润色" title="AI 润色 · 预览后手动应用" disabled={busy || !prompt.trim()} onClick={() => { setNotice(''); setOpen(true); }}><Icon name="spark" size={16} /><span>{loading ? '润色中' : 'AI 润色'}</span></button>
    {undo && prompt === undo.after ? <button className="icon-button polish-undo" title="撤销润色" aria-label="撤销润色" onClick={() => { setPrompt(undo.before); setUndo(null); setNotice('已恢复润色前的提示词。'); }}><Icon name="refresh" size={14} /></button> : null}
    {notice ? <span className="sr-only" role="status">{notice}</span> : null}
    {open ? <ModalPortal><div className="modal-backdrop" onClick={() => setOpen(false)}><section ref={dialog} tabIndex={-1} className="polish-modal modal" role="dialog" aria-modal="true" aria-label="提示词润色" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><div><h2>让创作表达更准确</h2><p className="panel-note">结合参考图整理英文提示词，画面文案保留原语言。预览后应用。</p></div><button className="icon-button" aria-label="关闭提示词润色" onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {caps ? <>
        <GlassTabs className="segmented" role="group" aria-label="润色方向"><button className={scope === 'general' ? 'selected' : ''} aria-pressed={scope === 'general'} disabled={loading} onClick={() => setScope('general')}>通用创作</button><button className={scope === 'commerce' ? 'selected' : ''} aria-pressed={scope === 'commerce'} disabled={loading} onClick={() => setScope('commerce')}>电商商品图</button></GlassTabs>
        {scope === 'commerce' ? <div className="commerce-selects">
          <GlassSelect label="平台" value={platform} disabled={loading} onChange={setPlatform} options={caps.commerce.platforms.map(item => ({ value: item.id, label: item.label }))} />
          <GlassSelect label="品类" value={category} disabled={loading} onChange={setCategory} options={caps.commerce.categories.map(item => ({ value: item.id, label: item.label }))} />
          <GlassSelect label="用途" value={scene} disabled={loading} onChange={setScene} options={caps.commerce.scenes.map(item => ({ value: item.id, label: item.label }))} />
        </div> : <p className="panel-note">直接按提示词理解封面、海报、插画或其他场景，无需选择预设。</p>}
        {references.length > 0 ? <div className="polish-references" aria-label="本次读取的参考图">{references.map((ref, i) => <figure key={ref.id}><img src={ref.dataUrl} alt={`参考图${i + 1}：${ref.name}`} /><figcaption>参考图 {i + 1}</figcaption></figure>)}</div> : null}
        <label className="form-field facts-field">{scope === 'general' ? '补充要求（可选）' : '已确认的产品事实（可选）'}<textarea aria-label="润色补充要求" rows={3} maxLength={4000} value={facts} disabled={loading} onChange={event => setFacts(event.target.value)} placeholder={scope === 'general' ? '例如：图1保留商品，图2只参考构图；标题只写“秋日水彩”，不添加其他文字。' : '例如：实际支数、毛料、尺寸、克重、适龄、随盒配件。未知项留空，润色不会替你编造。'} /></label>
        <p className="panel-note">{width > 0 && height > 0 ? `${width} × ${height}px` : aspectRatio === 'auto' ? '自动画幅' : `画幅 ${aspectRatio}`} · {referenceCount ? `读取 ${referenceCount} 张参考图` : '按文字描述润色'}。DeepSeek 看图与润色单独计费，不消耗 APIMart 积分。</p>
        {!caps.configured ? <div className="polish-config-notice" role="status">AI 润色服务尚未配置。<button className="quiet-button" onClick={() => void refreshCapabilities()}>刷新配置</button></div> : null}
        {scope === 'general' && !generalAvailable ? <p className="polish-error" role="status">当前服务尚未加载通用润色更新。更新服务后可用，不会提交不兼容的润色请求。</p> : null}
        <div className="polish-request-actions"><button className="primary-button" disabled={loading || busy || !caps.configured || !prompt.trim() || scope === 'general' && !generalAvailable} onClick={() => void polish()}><Icon name="spark" size={16} />{loading ? '正在润色…' : result ? '重新润色' : '开始润色'}</button><span className="panel-note" role="status">{loading ? '原提示词保持不变，可以关闭窗口稍后查看。' : ''}</span></div>
      </> : !error ? <p className="panel-note" role="status">正在读取润色配置…</p> : null}
      {error ? <p className="polish-error" role="alert">{error}<button className="text-button" onClick={() => void refreshCapabilities()}>刷新配置</button></p> : null}
      {result && source ? <>
        <div className="polish-comparison"><div><h3>原始提示词</h3><pre>{source.prompt}</pre></div><label className="form-field">润色预览 · 可继续编辑<textarea aria-label="润色后提示词" rows={9} value={draft} onChange={event => setDraft(event.target.value)} /></label></div>
        <div className="polish-notes"><div><h3>改进内容</h3><ul>{result.changes.map((text, index) => <li key={index}>{text}</li>)}</ul></div>{result.missing_facts.length ? <div><h3>仍需确认的信息</h3><ul>{result.missing_facts.map((text, index) => <li key={index}>{text}</li>)}</ul></div> : null}{result.warnings.length ? <div><h3>本次稿件提示</h3><ul>{result.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul></div> : null}</div>
        {stale ? <p className="polish-error" role="status">输入、润色方向或规格已变化，请重新润色后应用。</p> : null}
        {result.blocking_questions?.length ? <p className="polish-error" role="status">请先补充：{result.blocking_questions.join('；')}</p> : null}
        <div className="polish-footer"><span className="panel-note">{result.model}{result.usage.total_tokens != null ? ` · ${result.usage.total_tokens} tokens` : ''}</span><button className="primary-button" disabled={busy || loading || stale || !draft.trim() || Boolean(result.blocking_questions?.length)} onClick={() => { setUndo({ before: source.prompt, after: draft }); applyPrompt(draft); setOpen(false); setNotice('已应用润色稿，可继续修改后生成。'); }}>应用润色稿</button></div>
      </> : null}
    </section></div></ModalPortal> : null}
  </div>;
}
