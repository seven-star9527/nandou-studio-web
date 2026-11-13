import { useEffect, useRef, useState } from 'react';
import { accountStorageKey } from '../account-storage';
import { createId } from '../id';
import { MAX_IMAGE_PIXELS } from '../image-upload-limits';
import { useModalDialog } from '../useModalDialog';
import { toolNames, uploadImage, workRequest, type QuickJob, type QuickTool, type WorkImage } from '../workbench-api';
import MaskBrush, { type MaskStroke } from './MaskBrush';
import Icon from './Icon';
import GlassTabs from './GlassTabs';
import ModalPortal from './ModalPortal';

const options = {
  cutout: [['transparent', '自动主体'], ['hands', '商品和手'], ['include', '补留主体'], ['pick', '仅留点选']],
  retouch: [['brush', '画笔'], ['paint', '颜料'], ['paper', '水彩本'], ['toy', '玩具']],
  upscale: [['2', '2×'], ['4', '4×']],
};

function pendingKey(tool: QuickTool) { return accountStorageKey('quick-job:' + tool); }
function remember(tool: QuickTool, id: string) {
  try { if (id) sessionStorage.setItem(pendingKey(tool), id); else sessionStorage.removeItem(pendingKey(tool)); } catch { /* Storage is optional. */ }
}

export default function QuickEdit({tool, switchTool, initial, close, compare, compareLabel='加入对比画布'}: {
  switchTool: (tool:QuickTool, source?:WorkImage) => void;
  tool: QuickTool; initial?: WorkImage; close: () => void; compare?: (image: WorkImage) => void; compareLabel?:string;
}) {
  const [source, setSource] = useState(initial);
  const [option, setOption] = useState(options[tool][0][0]);
  const [background,setBackground] = useState('original'), [exposure,setExposure] = useState('0');
  const [points,setPoints]=useState<[number,number][]>([]);
  const [framing,setFraming]=useState('frame');
  const picking=tool==='cutout' && (option==='include'||option==='pick');
  const [job, setJob] = useState<QuickJob>();
  const [error, setError] = useState('');
  const [watch, setWatch] = useState(() => {
    try { return initial ? '' : sessionStorage.getItem(pendingKey(tool)) ?? ''; } catch { return ''; }
  });
  const [busy, setBusy] = useState(Boolean(watch));
  const [backdrop, setBackdrop] = useState('棋盘');
  const [correcting,setCorrecting] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  useModalDialog(true, dialog, close);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!watch) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await workRequest<QuickJob>('jobs/' + watch, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setJob(current);
        if(current.tool==='retouch'){
          const [category,bg='original',ev='0',frame='frame']=current.option.split('|');
          setOption(category);setBackground(bg);setExposure(ev);setFraming(frame);
        } else {setOption(current.option);setPoints(current.include ?? []);}
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
      if (mounted.current) { setSource(uploaded); setPoints([]); setJob(undefined); setActualSize(false); remember(tool,''); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  async function run(strokes?:MaskStroke[]) {
    if (!source || busy || working.current) return;
    const mask = strokes && job ? {base:job.id,strokes} : undefined;
    setCorrecting(false); working.current = true; setBusy(true); setError(''); setJob(undefined);
    const id = createId().replaceAll('-', '');
    remember(tool,id);
    try {
      const current = await workRequest<QuickJob>('jobs', {id, source:source.url, tool, option:tool==='retouch'?[option,background,exposure,...(framing==='center' && background==='white'?['center']:[])].join('|'):option, mask, include:picking?points:undefined});
      if (mounted.current) { setJob(current); setWatch(id); }
    } catch (cause) {
      if (mounted.current) {
        setError(String(cause));
        if (cause instanceof TypeError) setWatch(id);
        else { remember(tool,''); setBusy(false); }
      }
    } finally { working.current = false; }
  }
  function selectTool(next: QuickTool, nextSource=source) {
    if (next === tool || working.current || busy) return;
    let previous = '';
    if (!nextSource) {
      try { previous = sessionStorage.getItem(pendingKey(next)) ?? ''; } catch { /* Storage is optional. */ }
    }
    setOption(options[next][0][0]);setPoints([]);setFraming('frame');
    setWatch(previous);
    setBusy(Boolean(previous));
    setJob(undefined);
    setError('');
    setCorrecting(false);
    setSource(nextSource);
    switchTool(next, nextSource);
  }
  const result = job?.status === 'completed' ? job.result : undefined;
  const width = source?.width, height = source?.height;
  const factor = tool === 'upscale' ? Number(option) : 1;
  const fits = tool==='upscale' && option==='fit';
  const outputWidth = width && height ? (fits ? Math.min(width*4,Math.floor(Math.sqrt(MAX_IMAGE_PIXELS*width/height))) : width*factor) : 0;
  const outputHeight = width && height ? (fits ? Math.min(height*4,Math.floor(Math.sqrt(MAX_IMAGE_PIXELS*height/width))) : height*factor) : 0;
  const tooLarge = tool==='upscale' && (outputWidth*outputHeight>MAX_IMAGE_PIXELS || (fits && width===outputWidth && height===outputHeight));
  const offerFit = tool==='upscale' && width && height && width*height*16>MAX_IMAGE_PIXELS;
  const choices = offerFit || fits ? [...options[tool], ['fit','上限内放大']] : options[tool];
  const sync = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (!actualSize || !to) return;
    for (const [offset, dimension, client] of [['scrollLeft','scrollWidth','clientWidth'],['scrollTop','scrollHeight','clientHeight']] as const) {
      const distance = from[dimension] - from[client];
      const target = distance > 0 ? from[offset] / distance * (to[dimension] - to[client]) : 0;
      if (Math.abs(to[offset] - target) > 1) to[offset] = target;
    }
  };
  return <ModalPortal><div className="modal-backdrop" onClick={close}><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={toolNames[tool]} className="modal work-dialog" onClick={e => e.stopPropagation()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!correcting) void choose(Array.from(e.dataTransfer.files)); }}>
    <header className="work-heading quick-heading"><h2>{toolNames[tool]}</h2><button className="icon-button" title="关闭" aria-label="关闭" onClick={close}><Icon name="close" size={18}/></button></header>
    {correcting && source && result ? <MaskBrush heal={tool==='retouch'} original={source.url} result={result.url} cancel={()=>setCorrecting(false)} apply={strokes=>void run(strokes)} /> : <>
    <GlassTabs className="segmented work-tabs" aria-label="修图工具">{(Object.keys(toolNames) as QuickTool[]).map(t => <button key={t} disabled={busy} className={tool===t?'selected':''} aria-pressed={tool===t} onClick={() => selectTool(t)}>{toolNames[t]}</button>)}</GlassTabs>
    <div className="work-controls">
      <button className="quiet-button" disabled={busy} onClick={() => file.current?.click()}>{source ? '更换图片' : '选择图片'}</button>
      <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void choose(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <GlassTabs className="segmented work-tabs" aria-label={tool==='cutout'?'保留主体':tool==='retouch'?'商品类目':'放大倍率'}>{choices.map(([value,label]) => <button key={value} className={option===value?'selected':''} disabled={busy} onClick={() => { if (option!==value) {setOption(value);setPoints([]);if(tool==='cutout')setActualSize(false); setJob(undefined); remember(tool,'');} }}>{label}</button>)}</GlassTabs>
      {tool==='retouch' && <>
        <GlassTabs className="segmented work-tabs" aria-label="主图背景">{[['original','保留背景'],['white','纯白背景']].map(([v,t])=><button key={v} disabled={busy} className={v===background?'selected':''} onClick={()=>{setBackground(v);setJob(undefined);remember(tool,'');}}>{t}</button>)}</GlassTabs>
        <GlassTabs className="segmented work-tabs" aria-label="曝光调整">{[['-0.5','压暗'],['0','原曝光'],['0.5','提亮']].map(([v,t])=><button key={v} disabled={busy} className={v===exposure?'selected':''} onClick={()=>{setExposure(v);setJob(undefined);remember(tool,'');}}>{t}</button>)}</GlassTabs>
      </>}
      {tool==='retouch' && background==='white' && <label><input type="checkbox" checked={framing==='center'} disabled={busy} onChange={e=>{setFraming(e.target.checked?'center':'frame');setJob(undefined);remember(tool,'');}}/> 主体居中放大</label>}
      {picking && <><small>在原图点选要保留的物体，例如手背。</small><button className="quiet-button" disabled={busy||!points.length} onClick={()=>{setPoints(points.slice(0,-1));setJob(undefined);remember(tool,'');}}>撤销选点</button></>}
      {source && !picking && <button className="quiet-button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? '适应窗口' : '查看 100%'}</button>}
    </div>
    <div className="work-pair">
      <figure><figcaption>原图 {width && height ? <small>{width} × {height}</small> : null}</figcaption><div ref={left} onScroll={e => sync(e.currentTarget,right.current)} className={'work-preview '+(actualSize?'actual':'')}>{source && picking ? <div className="subject-pick" style={{aspectRatio:(width||1)/(height||1),width:`min(100cqw, ${100*(width||1)/(height||1)}cqh)`}}>
        <img alt="点选要保留的主体" src={source.url} draggable={false} onLoad={e=>{if(!width)setSource({...source,width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight});}} onClick={e=>{
          if(busy)return;
          if(points.length>=8){setError('最多可选 8 个位置，请撤销一个点后继续。');return;}
          const r=e.currentTarget.getBoundingClientRect();
          setPoints([...points,[(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height]]);
          setError('');setJob(undefined);remember(tool,'');
        }}/>
        {points.map(([x,y],i)=><span key={i} style={{left:x*100+'%',top:y*100+'%'}}>{i+1}</span>)}</div> : source ? <img alt="原图" src={source.url} onLoad={e => { const img=e.currentTarget; if (!width) setSource({...source,width:img.naturalWidth,height:img.naturalHeight}); }} /> : <button disabled={busy} onClick={() => file.current?.click()}>拖入图片，或点击上传</button>}</div></figure>
      <figure><figcaption>处理结果 {result && <small>{result.width} × {result.height} · PNG</small>}</figcaption><div ref={right} onScroll={e => sync(e.currentTarget,left.current)} className={'work-preview '+(actualSize?'actual ':'')+(tool==='cutout'?({'棋盘':'checker','白色':'white','深色':'dark'}[backdrop]):'')}>{result ? <img alt="处理结果" src={result.url}/> : <span>{busy && source ? '正在处理…' : '等待处理'}</span>}</div></figure>
    </div>
    <div className="work-controls">{tool==='cutout' && <GlassTabs className="segmented work-tabs" aria-label="检查背景">{['棋盘','白色','深色'].map(v => <button key={v} className={backdrop===v?'selected':''} onClick={() => setBackdrop(v)}>{v}</button>)}</GlassTabs>}
    {tool==='retouch' && <small>{{brush:'轻微调整明暗与锐度，保留笔锋。',paint:'轻调明度，保留颜料色序和包装文字。',paper:'校正棚拍底色，保留纸纹和装订细节。',toy:'轻调对比和轮廓，保留零件和接缝。'}[option]}</small>}
    {tool==='upscale' && <small>{width && height ? `输出 ${outputWidth} × ${outputHeight} px` : '从原尺寸放大'} · 保真重采样</small>}</div>
    {(tooLarge || error || job?.error) && <p className="history-error" role="alert">{tooLarge ? (width && height && width*height>=MAX_IMAGE_PIXELS ? '原图已达 6400 万像素上限。' : '所选倍率超过 6400 万像素，请选择「上限内放大」。') : job?.error || error}</p>}
    <footer className="work-controls">{result && <>{tool==='cutout' && <button className="quiet-button" onClick={()=>{setBackground('white');selectTool('retouch',result);}}>用此蒙版精修</button>}{tool==='retouch' && background==='white' && <button className="quiet-button" onClick={()=>selectTool('cutout')}>修正主体范围</button>}{tool!=='upscale' && <button className="quiet-button" onClick={()=>setCorrecting(true)}>{tool==='cutout'?'调整边缘':'局部去瑕'}</button>}<a className="quiet-button" href={result.url} download={result.name}>下载 PNG</a>{compare && <button className="quiet-button" onClick={() => compare(result)}>{compareLabel}</button>}</>}
    <button className="primary-button" disabled={!source || busy || tooLarge || (picking && !points.length)} onClick={() => void run()}>{busy ? '请稍候…' : result ? '重新处理' : '开始处理'}</button></footer></>}
  </section></div></ModalPortal>;
}
