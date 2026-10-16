import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReferenceImage } from '../types';
import Icon from './Icon';
import ModalPortal from './ModalPortal';
import { useModalDialog } from '../useModalDialog';

export default function ReferenceDock({ references, add, remove, maxReferences, disabled = false }: {
  references: ReferenceImage[]; add: () => void; remove: (id: string) => void; maxReferences: number; disabled?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [hover, setHover] = useState<{ id: string; left: number; top: number; width: number } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const selectedIndex = references.findIndex(item => item.id === selectedId);
  const selected = references[selectedIndex];
  const hovered = references.find(item => item.id === hover?.id);
  useEffect(() => {
    const hidePreview = () => setHover(null);
    window.addEventListener('scroll', hidePreview, true);
    window.addEventListener('resize', hidePreview);
    return () => {
      window.removeEventListener('scroll', hidePreview, true);
      window.removeEventListener('resize', hidePreview);
    };
  }, []);
  const close = () => { setSelectedId(null); setZoom('fit'); };
  useModalDialog(Boolean(selected), dialog, close);
  const fitScale = () => selected && stage.current ? Math.min(stage.current.clientWidth / selected.width, stage.current.clientHeight / selected.height, 1) : 1;
  const changeZoom = (amount: number) => setZoom(value => Math.max(.1, Math.min(4, Math.round(((value === 'fit' ? fitScale() : value) + amount) * 100) / 100)));
  const next = (offset: number) => { setSelectedId(references[(selectedIndex + offset + references.length) % references.length].id); setZoom('fit'); };
  const showHover = (id: string, target: HTMLElement) => {
    if (selected) return;
    const reference = references.find(item => item.id === id);
    if (!reference) return;
    const rect = (target.closest('.reference-dock') ?? target).getBoundingClientRect();
    const ratio = reference.width / reference.height;
    const availableAbove = Math.max(0, rect.top - 26);
    const availableBelow = Math.max(0, innerHeight - rect.bottom - 26);
    const placeAbove = availableAbove >= Math.min(224 / Math.max(1, ratio), 128) || availableAbove >= availableBelow;
    const maxHeight = Math.min(224, placeAbove ? availableAbove : availableBelow);
    if (maxHeight < 48) return;
    const width = Math.min(224, innerWidth - 24, maxHeight * ratio);
    const height = width / ratio;
    const top = placeAbove ? rect.top - height - 14 : rect.bottom + 14;
    setHover({ id, width, left: Math.max(12, Math.min(innerWidth - width - 12, rect.left - 12)), top });
  };
  return <>
    <div className={`reference-dock ${references.length ? 'has-references' : ''}`} style={{ '--reference-count': references.length, '--reference-expanded-width': `${(references.length + 1) * 44 + 16}px` } as CSSProperties} onMouseLeave={() => setHover(null)}>
      <div className="reference-cards">
        {references.map((reference, index) => <div className="reference-card" key={reference.id} style={{ '--reference-index': index, '--reference-angle': `${index === 0 ? -8 : index % 2 ? 5 : -5}deg` } as CSSProperties}>
          <button type="button" className="reference-thumbnail" aria-label={`查看参考图${index + 1}：${reference.name}`} title={`${reference.name} · ${reference.width}×${reference.height}px · 点击放大`}
            onMouseEnter={event => showHover(reference.id, event.currentTarget)} onFocus={event => showHover(reference.id, event.currentTarget)} onBlur={() => setHover(null)}
            onClick={() => { setHover(null); setZoom('fit'); setSelectedId(reference.id); }}>
            <img src={reference.dataUrl} alt={`参考图${index + 1}`} draggable={false} /><span>{index + 1}</span>
          </button>
          <button type="button" disabled={disabled} className="reference-card-remove" aria-label={`移除参考图${index + 1}`} title="移除参考图" onClick={() => { setHover(null); remove(reference.id); }}><Icon name="close" size={11} /></button>
        </div>)}
        <button type="button" className="reference-add" onClick={add} aria-label="上传参考图" disabled={disabled || references.length >= maxReferences} title={`添加参考图，最多${maxReferences}张`}><Icon name="plus" size={22} /></button>
      </div>
      {references.length > 1 ? <span className="reference-count" aria-hidden="true">{references.length} 张</span> : null}
    </div>
    {hovered && hover && !selected ? <ModalPortal><div className="reference-hover-preview" aria-hidden="true" style={{ left: hover.left, top: hover.top, width: hover.width }}><img src={hovered.dataUrl} width={hovered.width} height={hovered.height} alt="" /><span>参考图 · 点击放大</span></div></ModalPortal> : null}
    {selected ? <ModalPortal><div className="modal-backdrop reference-backdrop" onClick={close}>
      <section ref={dialog} className="reference-preview-modal modal" role="dialog" aria-modal="true" aria-label="参考图预览" tabIndex={-1} onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'ArrowRight' && references.length > 1) { event.preventDefault(); next(1); } if (event.key === 'ArrowLeft' && references.length > 1) { event.preventDefault(); next(-1); } }}>
        <header className="reference-preview-header"><div><strong>参考图 {selectedIndex + 1} / {references.length}</strong><span>{selected.name}</span></div><button className="icon-button" aria-label="关闭参考图预览" onClick={close}><Icon name="close" /></button></header>
        <div ref={stage} className={`reference-preview-stage ${zoom === 'fit' ? 'is-fit' : 'is-zoomed'}`} tabIndex={0} aria-label="参考图画布，可滚动查看放大图像">
          <div className={`reference-preview-canvas ${zoom === 'fit' ? 'is-fit' : ''}`}><img src={selected.dataUrl} alt={selected.name} draggable={false} onDoubleClick={() => setZoom(value => value === 'fit' ? 1 : 'fit')}
            style={zoom === 'fit' ? undefined : { width: selected.width * zoom, height: selected.height * zoom }} /></div>
        </div>
        <footer className="reference-preview-footer"><span className="reference-dimensions">{selected.width} × {selected.height} px</span><div className="reference-zoom-controls">
          <button className="icon-button" aria-label="缩小参考图" onClick={() => changeZoom(-.25)} disabled={zoom !== 'fit' && zoom <= .1}>−</button>
          <span className="reference-zoom-value" aria-live="polite">{zoom === 'fit' ? '适应' : `${Math.round(zoom * 100)}%`}</span>
          <button className="icon-button" aria-label="放大参考图" onClick={() => changeZoom(.25)} disabled={zoom !== 'fit' && zoom >= 4}>+</button>
          <button className="quiet-button" onClick={() => setZoom(1)}>1:1</button><button className="quiet-button" onClick={() => setZoom('fit')}>适应窗口</button>
        </div>{references.length > 1 ? <div className="reference-navigation"><button className="icon-button" aria-label="上一张参考图" onClick={() => next(-1)}>‹</button><button className="icon-button" aria-label="下一张参考图" onClick={() => next(1)}>›</button></div> : null}</footer>
      </section>
    </div></ModalPortal> : null}
  </>;
}
