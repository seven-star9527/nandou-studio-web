import { useEffect, useRef, useState } from 'react';
import type { PromptTemplate } from '../types';
import { useModalDialog } from '../useModalDialog';
import Icon from './Icon';
import GlassSelect from './GlassSelect';
import TemplateActions, { type ChooseTemplate } from './TemplateActions';
import ModalPortal from './ModalPortal';

export default function PromptLibrary({ referenceCount, apply }: { referenceCount: number; apply: ChooseTemplate }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [selected, setSelected] = useState<PromptTemplate | null>(null);
  const [missingPreviews,setMissingPreviews] = useState<Set<string>>(()=>new Set());
  const preview = (item:PromptTemplate) => item.preview && !missingPreviews.has(item.id) ? import.meta.env.BASE_URL+item.preview : undefined;
  const unavailable = (id:string) => setMissingPreviews(previous=>new Set(previous).add(id));
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
  useEffect(()=>{
    if(!open || !visible.length || visible.some(item=>item.id===selected?.id))return;
    setSelected(visible[0]);setDraft(visible[0].prompt);
  },[open,templates,search,category,selected]);
  const choose = (template: PromptTemplate) => { setSelected(template); setDraft(template.prompt); };
  return <>
    <div className="library-shortcuts" aria-label="快捷模板">{['商品图','构图','YouTube 封面','TikTok 封面'].map(group=><button className="scene-chip" key={group} onClick={()=>{setCategory(group);setSearch('');setSelected(null);setOpen(true);}}>{group}</button>)}
    <button className="prompt-library-button scene-chip" onClick={() => {setCategory('全部');setSearch('');setSelected(null);setOpen(true);}}><Icon name="poster" size={17} />全部模板</button></div>
    {open ? <ModalPortal><div className="modal-backdrop" onClick={() => setOpen(false)}><section ref={dialog} tabIndex={-1} className="prompt-library modal" role="dialog" aria-modal="true" aria-label="提示词库" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2>提示词库</h2><button className="icon-button" onClick={() => setOpen(false)} aria-label="关闭提示词库"><Icon name="close" /></button></div>
      <div className="library-search"><input aria-label="搜索提示词模板" placeholder="搜索主题、场景或关键词…" value={search} onChange={event => setSearch(event.target.value)} /><GlassSelect label="模板分类" value={category} options={categories.map(value=>({value,label:value}))} onChange={setCategory}/></div>
      <div className="library-body"><div className={"library-list"+(visible.length && visible.every(item=>item.preview)?" visual-list":"")}>{loading ? <p className="panel-note">正在读取提示词库…</p> : error ? <p className="panel-note">{error}</p> : visible.length ? visible.map(template => <button aria-pressed={selected?.id===template.id} className={`library-template ${selected?.id === template.id ? 'selected' : ''}`} key={template.id} onClick={() => choose(template)}>{preview(template) && <img onError={()=>unavailable(template.id)} className="library-thumb" src={preview(template)} alt="" loading="lazy" />}<strong>{template.title}</strong><span>{template.preview ? template.recommended.ratio : template.category} · {template.minReferences ? `需要 ${template.minReferences} 张参考图` : template.preview ? template.description : template.operations.includes('edit') ? '可附参考图' : '文生图'}</span></button>) : <p className="panel-note">没有匹配的模板。</p>}</div>
        <div className="library-detail">{selected && visible.some(item=>item.id===selected.id) ? <>{preview(selected) && <figure className="template-preview"><img onError={()=>unavailable(selected.id)} src={preview(selected)} alt={selected.title+"实测样图"} /></figure>}<h3>{selected.title}</h3>{!selected.preview && <p>{selected.description}</p>}<label className="form-field">编辑提示词<textarea rows={4} value={draft} onChange={event => setDraft(event.target.value)} /></label><p className="panel-note">建议比例 {selected.recommended.ratio} · 保留当前模型和分辨率</p>{referenceCount < selected.minReferences ? <p className="reference-hint">还需添加 {selected.minReferences - referenceCount} 张参考图。</p> : null}{selected.steps?.length ? <ol className="template-steps">{selected.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}<TemplateActions key={selected.id} choice={{title:selected.title, prompt:draft, minimum:selected.minReferences, ratio:selected.recommended.ratio, image:preview(selected)}} hasReferences={referenceCount>0} choose={apply} close={()=>setOpen(false)} />{selected.sources.length ? <div className="template-sources">{selected.sources.filter(source => /^https?:\/\//.test(source.url)).map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</div> : null}</> : <div className="library-empty"><Icon name="poster" size={34} /><p>选择模板，编辑后应用。</p><span>你的自建场景会保留。</span></div>}</div>
      </div>
    </section></div></ModalPortal> : null}
  </>;
}
