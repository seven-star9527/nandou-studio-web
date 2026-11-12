import { useEffect, useRef, useState } from 'react';
import { accountStorageKey } from '../account-storage';
import { createId } from '../id';
import { MAX_IMAGE_PIXELS } from '../image-upload-limits';
import { useModalDialog } from '../useModalDialog';
import { toolNames, uploadImage, workRequest, type QuickJob, type QuickTool, type WorkImage } from '../workbench-api';
import GlassTabs from './GlassTabs';
import ModalPortal from './ModalPortal';

const options = {
  cutout: [['transparent', '透明 PNG']],
  retouch: [['brush', '画笔'], ['paint', '颜料'], ['toy', '玩具']],
  upscale: [['2', '2×'], ['4', '4×']],
};

function pendingKey(tool: QuickTool) { return accountStorageKey('quick-job:' + tool); }
function remember(tool: QuickTool, id: string) {
  try { if (id) sessionStorage.setItem(pendingKey(tool), id); else sessionStorage.removeItem(pendingKey(tool)); } catch { /* Storage is optional. */ }
}

export default function QuickEdit({tool, switchTool, initial, close, compare}: {
  switchTool: (tool:QuickTool, source?:WorkImage) => void;
  tool: QuickTool; initial?: WorkImage; close: () => void; compare?: (image: WorkImage) => void;
}) {
  const [source, setSource] = useState(initial);
  const [option, setOption] = useState(options[tool][0][0]);
  const [job, setJob] = useState<QuickJob>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [backdrop, setBackdrop] = useState('棋盘');
  const [actualSize, setActualSize] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const [watch, setWatch] = useState('');
  useModalDialog(true, dialog, close);
  useEffect(() => {
    mounted.current = true;
    let saved = '';
    try { saved = sessionStorage.getItem(pendingKey(tool)) ?? ''; } catch { /* Optional. */ }
    if (!initial && saved) setWatch(saved); else setBusy(false);
    return () => { mounted.current = false; };
  }, [tool, initial]);
  useEffect(() => {
    if (!watch) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await workRequest<QuickJob>('jobs/' + watch, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setJob(current); setOption(current.option);
        setSource(old => old?.url === current.source ? old : {url:current.source, name:'原图'});
        if (current.status === 'processing') timer = setTimeout(poll, 800);
        else { setBusy(false); setWatch(''); }
      } catch (cause) {
        if (!controller.signal.aborted) { setBusy(false); setWatch(''); setError(String(cause)); }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [watch]);

  async function choose(files: File[]) {
    if (busy || working.current || !files.length) return;
    if (files.length !== 1) { setError('请一次选择一张图片。'); return; }
    working.current = true; setBusy(true); setError('');
    try {
      const uploaded = await uploadImage(files[0]);
      if (mounted.current) { setSource(uploaded); setJob(undefined); setActualSize(false); remember(tool,''); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  async function run() {
    if (!source || busy || working.current) return;
    working.current = true; setBusy(true); setError(''); setJob(undefined);
    const id = createId().replaceAll('-', '');
    remember(tool,id);
    try {
      const current = await workRequest<QuickJob>('jobs', {id, source:source.url, tool, option});
      if (mounted.current) { setJob(current); setWatch(id); }
    } catch (cause) {
      if (mounted.current) { setError(String(cause)); setWatch(id); }
    } finally { working.current = false; }
  }
  const result = job?.status === 'completed' ? job.result : undefined;
  const width = source?.width, height = source?.height;
  const factor = tool === 'upscale' ? Number(option) : 1;
  const tooLarge = Boolean(width && height && width * height * factor ** 2 > MAX_IMAGE_PIXELS);
  const sync = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (!actualSize || !to) return;
    for (const [offset, dimension, client] of [['scrollLeft','scrollWidth','clientWidth'],['scrollTop','scrollHeight','clientHeight']] as const) {
      const distance = from[dimension] - from[client];
      const target = distance > 0 ? from[offset] / distance * (to[dimension] - to[client]) : 0;
      if (Math.abs(to[offset] - target) > 1) to[offset] = target;
    }
  };
  return <ModalPortal><div className="modal-backdrop" onClick={close}><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={toolNames[tool]} className="modal work-dialog" onClick={e => e.stopPropagation()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void choose(Array.from(e.dataTransfer.files)); }}>
    <header className="work-heading"><h2>{toolNames[tool]}</h2><button className="quiet-button" onClick={close}>关闭</button></header>
    <GlassTabs className="segmented work-tabs" aria-label="修图工具">{(Object.keys(toolNames) as QuickTool[]).map(t => <button key={t} disabled={busy} className={tool===t?'selected':''} onClick={() => { if(t!==tool) switchTool(t,source); }}>{toolNames[t]}</button>)}</GlassTabs>
    <div className="work-controls">
      <button className="quiet-button" disabled={busy} onClick={() => file.current?.click()}>{source ? '更换图片' : '选择图片'}</button>
      <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void choose(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      {tool !== 'cutout' && <GlassTabs className="segmented work-tabs" aria-label={tool==='retouch'?'商品类目':'放大倍率'}>{options[tool].map(([value,label]) => <button key={value} className={option===value?'selected':''} disabled={busy} onClick={() => { if (option!==value) {setOption(value); setJob(undefined); remember(tool,'');} }}>{label}</button>)}</GlassTabs>}
      {source && <button className="quiet-button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? '适应窗口' : '查看 100%'}</button>}
    </div>
    <div className="work-pair">
      <figure><figcaption>原图 {width && height ? <small>{width} × {height}</small> : null}</figcaption><div ref={left} onScroll={e => sync(e.currentTarget,right.current)} className={'work-preview '+(actualSize?'actual':'')}>{source ? <img alt="原图" src={source.url} onLoad={e => { const img=e.currentTarget; if (!width) setSource({...source,width:img.naturalWidth,height:img.naturalHeight}); }} /> : <button disabled={busy} onClick={() => file.current?.click()}>拖入图片，或点击上传</button>}</div></figure>
      <figure><figcaption>处理结果 {result && <small>{result.width} × {result.height} · PNG</small>}</figcaption><div ref={right} onScroll={e => sync(e.currentTarget,left.current)} className={'work-preview '+(actualSize?'actual ':'')+(tool==='cutout'?({'棋盘':'checker','白色':'white','深色':'dark'}[backdrop]):'')}>{result ? <img alt="处理结果" src={result.url}/> : <span>{busy && source ? '正在处理…' : '等待处理'}</span>}</div></figure>
    </div>
    <div className="work-controls">{tool==='cutout' && <GlassTabs className="segmented work-tabs" aria-label="检查背景">{['棋盘','白色','深色'].map(v => <button key={v} className={backdrop===v?'selected':''} onClick={() => setBackdrop(v)}>{v}</button>)}</GlassTabs>}
    {tool==='retouch' && <small>{{brush:'轻微调整明暗与锐度，保留笔锋。',paint:'轻调明度，保留颜料色序和包装文字。',toy:'轻调对比和轮廓，保留零件和接缝。'}[option]}</small>}
    {tool==='upscale' && <small>{width && height ? `输出 ${width*factor} × ${height*factor} px` : '从原尺寸放大'} · 保真重采样</small>}</div>
    {(tooLarge || error || job?.error) && <p className="history-error" role="alert">{tooLarge ? '输出超过 6400 万像素，请降低倍率。' : job?.error || error}</p>}
    <footer className="work-controls">{result && <><a className="quiet-button" href={result.url} download={result.name}>下载 PNG</a>{compare && <button className="quiet-button" onClick={() => compare(result)}>加入对比画布</button>}</>}
    <button className="primary-button" disabled={!source || busy || tooLarge} onClick={() => void run()}>{busy ? '请稍候…' : result ? '重新处理' : '开始处理'}</button></footer>
  </section></div></ModalPortal>;
}
