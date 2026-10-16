import { useEffect, useRef, useState } from 'react';
import type { PromptTemplate } from '../types';
import { useModalDialog } from '../useModalDialog';
import Icon from './Icon';
import ModalPortal from './ModalPortal';

export default function PromptLibrary({ referenceCount, apply }: { referenceCount: number; apply: (prompt: string, minReferences: number) => void }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [selected, setSelected] = useState<PromptTemplate | null>(null);
  const [draft, setDraft] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(open, dialog, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    fetch(`${import.meta.env.BASE_URL}prompt-library.json`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('提示词库暂不可用。'); return response.json(); })
      .then((value: { version: number; templates: PromptTemplate[] }) => { if (value.version !== 1 || !Array.isArray(value.templates)) throw new Error('提示词库格式不受支持。'); setTemplates(value.templates); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);
  const categories = ['全部', ...new Set(templates.map(template => template.category))];
  const visible = templates.filter(template => (category === '全部' || template.category === category) && `${template.title} ${template.description} ${template.tags.join(' ')} ${template.prompt}`.toLowerCase().includes(search.toLowerCase()));
  const choose = (template: PromptTemplate) => { setSelected(template); setDraft(template.prompt); };
  return <>
    <button className="prompt-library-button scene-chip" onClick={() => setOpen(true)}><Icon name="poster" size={17} />提示词库</button>
    {open ? <ModalPortal><div className="modal-backdrop" onClick={() => setOpen(false)}><section ref={dialog} tabIndex={-1} className="prompt-library modal" role="dialog" aria-modal="true" aria-label="提示词库" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2>提示词库</h2><button className="icon-button" onClick={() => setOpen(false)} aria-label="关闭提示词库"><Icon name="close" /></button></div>
      <div className="library-search"><input aria-label="搜索提示词模板" placeholder="搜索主题、场景或关键词…" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="模板分类" value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></div>
      <div className="library-body"><div className="library-list">{loading ? <p className="panel-note">正在读取提示词库…</p> : error ? <p className="panel-note">{error}</p> : visible.length ? visible.map(template => <button className={`library-template ${selected?.id === template.id ? 'selected' : ''}`} key={template.id} onClick={() => choose(template)}><strong>{template.title}</strong><span>{template.category} · {template.minReferences ? `需要 ${template.minReferences} 张参考图` : '文生图'}</span></button>) : <p className="panel-note">没有匹配的模板。</p>}</div>
        <div className="library-detail">{selected ? <><h3>{selected.title}</h3><p>{selected.description}</p><label className="form-field">编辑提示词<textarea rows={8} value={draft} onChange={event => setDraft(event.target.value)} /></label><p className="panel-note">建议：{selected.recommended.ratio} · {selected.recommended.resolution}{selected.recommended.model ? ` · ${selected.recommended.model}` : ''}。应用时保留当前模型和尺寸选择。</p>{referenceCount < selected.minReferences ? <p className="reference-hint">还需添加 {selected.minReferences - referenceCount} 张参考图；应用模板不会自动上传图像。</p> : null}{selected.steps?.length ? <ol className="template-steps">{selected.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}<button className="primary-button" disabled={!draft.trim()} onClick={() => { apply(draft, selected.minReferences); setOpen(false); }}>应用到提示词</button>{selected.sources.length ? <div className="template-sources">{selected.sources.filter(source => /^https?:\/\//.test(source.url)).map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</div> : null}</> : <div className="library-empty"><Icon name="poster" size={34} /><p>选择模板，编辑后应用。</p><span>你的自建场景会保留。</span></div>}</div>
      </div>
    </section></div></ModalPortal> : null}
  </>;
}
