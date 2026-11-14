import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReferenceImage } from '../types';
import { referenceDragType } from '../reference-mentions';
import Icon from './Icon';
import ModalPortal from './ModalPortal';
import { useModalDialog } from '../useModalDialog';
import { IMAGE_UPLOAD_HINT } from '../image-upload-limits';
import { ownImageUrl, workRequest, type WorkImage } from '../workbench-api';

export default function ReferenceDock({ references, add, paste, reorder, remove, maxReferences, openBoard, disabled = false }: {
  references: ReferenceImage[]; add: () => void; paste: (files: File[]) => Promise<void>; reorder: (images: ReferenceImage[]) => void;
  remove: (id: string) => void; maxReferences: number; disabled?: boolean;
  openBoard?: (image: WorkImage) => void;
}) {
  const dock = useRef<HTMLDivElement>(null);
  const dragged = useRef<string | null>(null);
  const [targetSlot, setTargetSlot] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [hover, setHover] = useState<{ id: string; left: number; top: number; width: number } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const selectedIndex = references.findIndex(item => item.id === selectedId);
  const selected = references[selectedIndex];
  const pending = useRef<AbortController | null>(null);
  const [adding, setAdding] = useState(false);
  const [boardError, setBoardError] = useState('');
  useEffect(() => {
    setBoardError('');
    setAdding(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [selected?.id]);
  async function addCurrentToBoard() {
    if (!selected || !openBoard || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setAdding(true);
    setBoardError('');
    try {
      const image = ownImageUrl(selected.dataUrl)
        ? {url: selected.dataUrl, name: selected.name}
        : await workRequest<WorkImage>('upload', {name: selected.name, data_url: selected.dataUrl}, controller.signal);
      if (!controller.signal.aborted) openBoard(image);
    } catch (cause) {
      if (!controller.signal.aborted) setBoardError(cause instanceof Error ? cause.message : '添加失败，请重试。');
    } finally {
      if (pending.current === controller) { pending.current = null; setAdding(false); }
    }
  }
  const hovered = references.find(item => item.id === hover?.id);
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (disabled || selected || event.defaultPrevented || !event.clipboardData ||
          document.querySelector('[aria-modal="true"]') || !dock.current?.getClientRects().length) return;
      const composer = dock.current.closest('.composer, .agent-composer');
      if (target instanceof Element && target.closest('input,textarea,[contenteditable="true"]') && !composer?.contains(target)) return;
      const data = event.clipboardData;
      const files = Array.from(data.files).filter(file => file.type.startsWith('image/'));
      if (!files.length) {
        for (const item of Array.from(data.items)) {
          const file = item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null;
          if (file) files.push(file);
        }
      }
      if (!files.length) return;
      event.preventDefault();
      void paste(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [disabled, selected, paste]);
  const move = (from: number, to: number) => {
    if (disabled || from < 0 || to < 0 || to >= references.length || from === to) return;
    const next = [...references];
    next.splice(to, 0, next.splice(from, 1)[0]);
    reorder(next);
  };
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
    if (selected || dragged.current) return;
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
  const from = references.findIndex(item => item.id === dragged.current);
  function previewSlot(index: number) {
    if (from < 0 || targetSlot == null) return index;
    if (index === from) return targetSlot;
    if (from < index && index <= targetSlot) return index - 1;
    if (targetSlot <= index && index < from) return index + 1;
    return index;
  }
  function endSort() { dragged.current = null; setTargetSlot(null); }
  function slotAt(event: React.DragEvent<HTMLDivElement>) {
    const strip = event.currentTarget;
    const left = event.clientX - strip.getBoundingClientRect().left;
    if (left > strip.clientWidth - 18) strip.scrollLeft += 10;
    if (left < 18) strip.scrollLeft -= 10;
    return Math.max(0, Math.min(references.length - 1, Math.round((left + strip.scrollLeft - 32) / 44)));
  }
  return <>
    <div ref={dock} className={`reference-dock ${references.length ? 'has-references' : ''} ${targetSlot != null ? 'is-sorting' : ''}`} style={{ '--reference-count': references.length, '--reference-expanded-width': `${(references.length + 1) * 44 + 16}px` } as CSSProperties} onMouseLeave={() => setHover(null)}>
      <div className="reference-cards" onDragOver={event => {
        if (from < 0) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTargetSlot(slotAt(event));
      }} onDrop={event => {
        if (from < 0) return;
        event.preventDefault(); event.stopPropagation(); move(from, slotAt(event)); endSort();
      }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setTargetSlot(null); }}>
        {references.map((reference, index) => <div className={`reference-card${from === index ? ' is-lifted' : ''}`} key={reference.id} style={{ '--reference-index': previewSlot(index), '--reference-angle': `${index === 0 ? -8 : index % 2 ? 5 : -5}deg` } as CSSProperties}>
          <button type="button" className="reference-thumbnail" aria-label={`查看参考图${index + 1}：${reference.name}`} title={`${reference.name} · ${reference.width}×${reference.height}px · 点击放大，左右拖动排序`}
            draggable={!disabled}
            onDragStart={event => {
              dragged.current = reference.id; setHover(null); setTargetSlot(index);
              event.dataTransfer.effectAllowed = 'copyMove';
              event.dataTransfer.setData(referenceDragType, reference.id);
            }}
            onDragEnd={endSort}
            onKeyDown={e => { if (e.altKey && ['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); move(index, index + (e.key === 'ArrowLeft' ? -1 : 1)); } }}
            onMouseEnter={event => showHover(reference.id, event.currentTarget)} onFocus={event => showHover(reference.id, event.currentTarget)} onBlur={() => setHover(null)}
            onClick={() => { setHover(null); setZoom('fit'); setSelectedId(reference.id); }}>
            <img src={reference.dataUrl} alt={`参考图${index + 1}`} draggable={false} /><span>{index + 1}</span>
          </button>
          <button type="button" disabled={disabled} className="reference-card-remove" aria-label={`移除参考图${index + 1}`} title="移除参考图" onClick={() => { setHover(null); remove(reference.id); }}><Icon name="close" size={11} /></button>
        </div>)}
        <button type="button" className="reference-add" onClick={add} aria-label="上传参考图" disabled={disabled || references.length >= maxReferences} title={`添加参考图（Ctrl+V 粘贴），最多${maxReferences}张；${IMAGE_UPLOAD_HINT}`}><Icon name="plus" size={22} /></button>
      </div>
      {references.length > 1 ? <span className="reference-count" aria-hidden="true">{references.length} 张</span> : null}
    </div>
    {hovered && hover && !selected ? <ModalPortal><div className="reference-hover-preview" aria-hidden="true" style={{ left: hover.left, top: hover.top, width: hover.width }}><img src={hovered.dataUrl} width={hovered.width} height={hovered.height} alt="" /><span>参考图 · 点击放大</span></div></ModalPortal> : null}
    {selected ? <ModalPortal><div className="modal-backdrop reference-backdrop" onClick={close}>
      <section ref={dialog} className="reference-preview-modal modal" role="dialog" aria-modal="true" aria-label="参考图预览" tabIndex={-1} onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'ArrowRight' && references.length > 1) { event.preventDefault(); next(1); } if (event.key === 'ArrowLeft' && references.length > 1) { event.preventDefault(); next(-1); } }}>
        <header className="reference-preview-header"><div><strong>参考图 {selectedIndex + 1} / {references.length}</strong><span>{selected.name}</span></div>
          {openBoard && <button type="button" className="quiet-button reference-to-board" disabled={adding} onClick={() => void addCurrentToBoard()}>{adding ? '正在添加…' : '添加到画布'}</button>}
          <button type="button" className="icon-button" aria-label="关闭参考图预览" onClick={close}><Icon name="close" /></button></header>
        <div ref={stage} className={`reference-preview-stage ${zoom === 'fit' ? 'is-fit' : 'is-zoomed'}`} tabIndex={0} aria-label="参考图画布，可滚动查看放大图像">
          <div className={`reference-preview-canvas ${zoom === 'fit' ? 'is-fit' : ''}`}><img src={selected.dataUrl} alt={selected.name} draggable={false} onDoubleClick={() => setZoom(value => value === 'fit' ? 1 : 'fit')}
            style={zoom === 'fit' ? undefined : { width: selected.width * zoom, height: selected.height * zoom }} /></div>
        </div>
        <footer className="reference-preview-footer">{boardError ? <span role="alert" className="history-error">{boardError}</span> : <span className="reference-dimensions">{selected.width} × {selected.height} px</span>}<div className="reference-zoom-controls">
          <button className="icon-button" aria-label="缩小参考图" onClick={() => changeZoom(-.25)} disabled={zoom !== 'fit' && zoom <= .1}>−</button>
          <span className="reference-zoom-value" aria-live="polite">{zoom === 'fit' ? '适应' : `${Math.round(zoom * 100)}%`}</span>
          <button className="icon-button" aria-label="放大参考图" onClick={() => changeZoom(.25)} disabled={zoom !== 'fit' && zoom >= 4}>+</button>
          <button className="quiet-button" onClick={() => setZoom(1)}>1:1</button><button className="quiet-button" onClick={() => setZoom('fit')}>适应窗口</button>
        </div>{references.length > 1 ? <div className="reference-navigation"><button className="icon-button" aria-label="上一张参考图" onClick={() => next(-1)}>‹</button><button className="icon-button" aria-label="下一张参考图" onClick={() => next(1)}>›</button></div> : null}</footer>
      </section>
    </div></ModalPortal> : null}
  </>;
}
