import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import ModalPortal from './ModalPortal';
import { useModalDialog } from '../useModalDialog';

interface ShowcaseItem {
  id: string; title: string; category: string; description: string; model: string;
  mode: 'generate' | 'edit'; prompt: string; url: string; width: number; height: number;
  seconds: number; credits?: number; concept: boolean; referenceImageUrl?: string;
}

export default function ShowcaseGallery({ apply, addReference }: { apply: (prompt: string, editing: boolean) => void; addReference: (file: File) => Promise<void> }) {
  const [items, setItems] = useState<ShowcaseItem[]>([]);
  const [selected, setSelected] = useState<ShowcaseItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(Boolean(selected), dialog, () => setSelected(null));
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${import.meta.env.BASE_URL}showcase.json`, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Showcase unavailable');
      return response.json();
    }).then(value => { if (Array.isArray(value.items)) setItems(value.items); }).catch(() => { /* Optional samples must not prevent creation. */ });
    return () => controller.abort();
  }, []);
  const loadReference = async (item: ShowcaseItem) => {
    if (!item.referenceImageUrl) return;
    setAdding(true); setNotice('');
    try {
      const response = await fetch(item.referenceImageUrl);
      if (!response.ok) throw new Error('示例参考图读取失败，请稍后再试。');
      const blob = await response.blob();
      await addReference(new File([blob], '示例画笔参考.webp', { type: blob.type }));
      setNotice('已添加示例参考图，可复用提示词后继续修改。');
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '参考图读取失败。'); }
    finally { setAdding(false); }
  };
  if (!items.length) return null;
  return <section className="showcase-section" aria-labelledby="showcase-title">
    <div className="showcase-heading"><div><h2 id="showcase-title">电商创作样张</h2><p>从一个画面，开始你的下一次创作</p></div><a className="guide-link" href={`${import.meta.env.BASE_URL}model-guide.html`} target="_blank" rel="noreferrer">模型怎么选 <Icon name="arrow" size={14} /></a></div>
    <div className="showcase-grid">{items.map(item => <article className="showcase-card" key={item.id}>
      <button className="showcase-open" onClick={() => { setNotice(''); setSelected(item); }} aria-label={`查看样张 ${item.title}`}><img src={item.url} alt={item.title} width={item.width} height={item.height} loading="lazy" /><span className="showcase-category">{item.category}</span><span className="showcase-hover"><Icon name="expand" size={19} />查看样张</span></button>
      <div className="showcase-caption"><h3>{item.title}</h3><p>{item.model}</p><button onClick={() => apply(item.prompt, item.mode === 'edit')} aria-label={`复用提示词 ${item.title}`}>复用提示词 <Icon name="arrow" size={14} /></button></div>
    </article>)}</div>
    <p className="showcase-footnote">概念商品研究样张 · 正式商品请以实物和参考图为准</p>
    {selected ? <ModalPortal><div className="modal-backdrop" onClick={() => { if (!adding) setSelected(null); }}><section ref={dialog} className="showcase-modal modal" role="dialog" aria-modal="true" aria-label="电商样张详情" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <button className="icon-button showcase-close" aria-label="关闭样张详情" onClick={() => setSelected(null)}><Icon name="close" /></button>
      <div className="showcase-full"><img src={selected.url} alt={selected.title} /></div><div className="showcase-detail"><span className="showcase-detail-category">{selected.category}</span><h2>{selected.title}</h2><p>{selected.description}</p><dl><dt>模型</dt><dd>{selected.model}</dd><dt>尺寸</dt><dd>{selected.width} × {selected.height} px</dd><dt>本次交付</dt><dd>{selected.seconds.toFixed(1)} 秒</dd></dl><p className="panel-note">单次实际样张，耗时含准备与交付，各场景不作为模型速度排名。</p><label className="showcase-prompt-label">提示词<textarea aria-label="样张提示词" readOnly value={selected.prompt} rows={6} /></label>
      <div className="showcase-detail-actions"><button className="primary-button" onClick={() => { apply(selected.prompt, selected.mode === 'edit'); setSelected(null); }}>复用提示词</button>{selected.referenceImageUrl ? <button className="quiet-button" disabled={adding} onClick={() => void loadReference(selected)}>{adding ? '读取中…' : '添加示例参考图'}</button> : null}</div>{selected.mode === 'edit' ? <p className="panel-note">此样张通过参考图编辑完成，复用时请添加商品图，也可先试用示例参考图。</p> : null}{notice ? <p className="panel-note" role="status">{notice}</p> : null}<p className="showcase-concept-note">概念商品研究样张，不对应真实在售SKU。</p></div>
    </section></div></ModalPortal> : null}
  </section>;
}
