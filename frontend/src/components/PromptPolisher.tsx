import { useEffect, useRef, useState } from 'react';
import type { SwarmClient } from '../api';
import { polishIdentity, validPolishResult } from '../commerce-contract';
import type { PolishCapabilities, PolishInput, PolishResult } from '../commerce-contract';
import { useModalDialog } from '../useModalDialog';
import ModalPortal from './ModalPortal';
import Icon from './Icon';

export default function PromptPolisher({ client, prompt, setPrompt, width, height, model, referenceIds, referenceCount, busy }: {
  client: SwarmClient; prompt: string; setPrompt: (value: string) => void; width: number; height: number;
  model: string; referenceIds: string; referenceCount: number; busy: boolean;
}) {
  const [caps, setCaps] = useState<PolishCapabilities | null>(null);
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
  const input: PolishInput = { prompt, facts, platform, category, scene, reference_count: referenceCount, width, height };
  const identity = polishIdentity(input, model, referenceIds);
  const stale = Boolean(source && source.identity !== identity);
  const polish = async () => {
    const snapshot = { prompt, identity };
    setLoading(true); setError(''); setResult(null); setSource(snapshot);
    try {
      const value = await client.request<PolishResult>('PolishStudioPrompt', input);
      if (!validPolishResult(value)) throw new Error('润色结果格式不正确，原提示词保留。');
      if (mounted.current) { setResult(value); setDraft(value.prompt); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '润色失败，原提示词保留。'); }
    finally { if (mounted.current) setLoading(false); }
  };
  return <div className="polish-control">
    <button className="polish-entry" aria-label="AI 润色" title="AI 润色 · 预览后手动应用" disabled={busy || !prompt.trim()} onClick={() => { setNotice(''); setOpen(true); }}><Icon name="spark" size={16} /><span>{loading ? '润色中' : 'AI 润色'}</span></button>
    {undo && prompt === undo.after ? <button className="icon-button polish-undo" title="撤销润色" aria-label="撤销润色" onClick={() => { setPrompt(undo.before); setUndo(null); setNotice('已恢复润色前的提示词。'); }}><Icon name="refresh" size={14} /></button> : null}
    {notice ? <span className="sr-only" role="status">{notice}</span> : null}
    {open ? <ModalPortal><div className="modal-backdrop" onClick={() => setOpen(false)}><section ref={dialog} tabIndex={-1} className="polish-modal modal" role="dialog" aria-modal="true" aria-label="电商提示词润色" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><div><h2>让商品表达更准确</h2><p className="panel-note">DeepSeek Flash · 只润色文字，不会自动生成图片</p></div><button className="icon-button" aria-label="关闭提示词润色" onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {caps ? <>
        <div className="commerce-selects">
          <label>平台<select aria-label="商品图片平台" value={platform} disabled={loading} onChange={event => setPlatform(event.target.value)}>{caps.commerce.platforms.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>品类<select aria-label="商品图片品类" value={category} disabled={loading} onChange={event => setCategory(event.target.value)}>{caps.commerce.categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>用途<select aria-label="商品图片用途" value={scene} disabled={loading} onChange={event => setScene(event.target.value)}>{caps.commerce.scenes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </div>
        <label className="form-field facts-field">已确认的产品事实（可选）<textarea aria-label="已确认产品事实" rows={3} maxLength={4000} value={facts} disabled={loading} onChange={event => setFacts(event.target.value)} placeholder="例如：实际支数、毛料、尺寸、克重、适龄、随盒配件。未知项留空，润色不会替你编造。" /></label>
        <p className="panel-note">当前画幅 {width} × {height}px · {referenceCount} 张参考图。仅发送提示词与上面的事实，不上传参考图。DeepSeek 单独计费，不消耗 APIMart 积分。</p>
        {!caps.configured ? <div className="polish-config-notice" role="status">请在服务端 .env 中填写 DEEPSEEK_API_KEY。<button className="quiet-button" onClick={() => void refreshCapabilities()}>刷新润色配置</button></div> : null}
        <div className="polish-request-actions"><button className="primary-button" disabled={loading || busy || !caps.configured || !prompt.trim()} onClick={() => void polish()}><Icon name="spark" size={16} />{loading ? '正在润色…' : result ? '重新润色' : '开始润色'}</button><span className="panel-note" role="status">{loading ? '原提示词保持不变，可以关闭窗口稍后查看。' : ''}</span></div>
      </> : !error ? <p className="panel-note" role="status">正在读取润色配置…</p> : null}
      {error ? <p className="polish-error" role="alert">{error}<button className="text-button" onClick={() => void refreshCapabilities()}>刷新配置</button></p> : null}
      {result && source ? <>
        <div className="polish-comparison"><div><h3>原始提示词</h3><pre>{source.prompt}</pre></div><label className="form-field">润色预览 · 可继续编辑<textarea aria-label="润色后提示词" rows={9} value={draft} onChange={event => setDraft(event.target.value)} /></label></div>
        <div className="polish-notes"><div><h3>改进内容</h3><ul>{result.changes.map((text, index) => <li key={index}>{text}</li>)}</ul></div>{result.missing_facts.length ? <div><h3>仍需确认的产品事实</h3><ul>{result.missing_facts.map((text, index) => <li key={index}>{text}</li>)}</ul></div> : null}{result.warnings.length ? <div><h3>本次稿件提示</h3><ul>{result.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul></div> : null}</div>
        {stale ? <p className="polish-error" role="status">输入、品类或规格已变化，请重新润色后应用。</p> : null}
        <div className="polish-footer"><span className="panel-note">{result.model}{result.usage.total_tokens != null ? ` · ${result.usage.total_tokens} tokens` : ''}</span><button className="primary-button" disabled={busy || loading || stale || !draft.trim()} onClick={() => { setUndo({ before: source.prompt, after: draft }); setPrompt(draft); setOpen(false); setNotice('已应用润色稿，可继续修改后生成。'); }}>应用润色稿</button></div>
      </> : null}
    </section></div></ModalPortal> : null}
  </div>;
}
