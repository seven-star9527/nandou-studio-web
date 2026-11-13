import { useEffect, useRef, useState } from 'react';
import { accountStorageKey } from '../account-storage';
import { createId } from '../id';
import { MAX_IMAGE_PIXELS } from '../image-upload-limits';
import { useModalDialog } from '../useModalDialog';
import { toolNames, uploadImage, workRequest, type QuickJob, type SubjectMark, type QuickTool, type WorkImage } from '../workbench-api';
import QuickPreview from './QuickPreview';
import MaskBrush, { type MaskStroke } from './MaskBrush';
import Icon from './Icon';
import GlassTabs from './GlassTabs';
import ModalPortal from './ModalPortal';

const options = {
  cutout: [['transparent', '自动主体'], ['include', '补留主体'], ['remove', '移除主体']],
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
  const [marks,setMarks]=useState<SubjectMark[]>([]);
  const [framing,setFraming]=useState('frame');
  const picking=tool==='cutout' && (option==='include'||option==='remove');
  const [job, setJob] = useState<QuickJob>();
  const [error, setError] = useState('');
  const [watch, setWatch] = useState(() => {
    try { return initial ? '' : sessionStorage.getItem(pendingKey(tool)) ?? ''; } catch { return ''; }
  });
  const [uploading,setUploading]=useState(false);
  const [busy, setBusy] = useState(Boolean(watch));
  const [backdrop, setBackdrop] = useState('棋盘');
  const [correcting,setCorrecting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
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
        } else if(current.tool==='cutout'){
          const saved=current.marks?.length ? current.marks : (current.include ?? []).map(([x,y])=>({mode:'keep' as const,x,y}));
          setMarks(saved);
          setOption(old=>current.option==='subjects' && ['include','remove'].includes(old) ? old :
            saved.at(-1)?.mode==='remove' ? 'remove' : saved.length ? 'include' : 'transparent');
        } else setOption(current.option);
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
    working.current = true; setUploading(true); setBusy(true); setError('');
    try {
      const uploaded = await uploadImage(files[0]);
      if (mounted.current) { setSource(uploaded); setMarks([]); setJob(undefined); remember(tool,''); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { working.current = false; if (mounted.current) {setUploading(false);setBusy(false);} }
  }
  async function run(strokes?:MaskStroke[]) {
    if (!source || busy || working.current) return;
    const mask = strokes && job ? {base:job.id,strokes} : undefined;
    const recipe=tool==='retouch'?[option,background,exposure,...(framing==='center' && background==='white'?['center']:[])].join('|'):
      tool==='cutout'?marks.length?'subjects':'transparent':option;
    // A saved legacy matte keeps its original recipe when used as the base for a manual stroke.
    const selected=mask && job ? job.option : recipe;
    setCorrecting(false); working.current = true; setBusy(true); setError(''); setJob(undefined);
    const id = createId().replaceAll('-', '');
    remember(tool,id);
    try {
      const current = await workRequest<QuickJob>('jobs', {id, source:source.url, tool, option:selected, mask, marks:selected==='subjects'?marks:undefined, include:mask && ['include','pick'].includes(selected)?job?.include:undefined});
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
    setOption(options[next][0][0]);setMarks([]);setFraming('frame');
    setWatch(previous);
    setBusy(Boolean(previous));
    setJob(undefined);
    setError('');
    setCorrecting(false);
    setSource(nextSource);
    switchTool(next, nextSource);
  }
  const result = job?.status === 'completed' ? job.result : undefined;
  const activity=uploading?'正在上传图片':({cutout:'正在抠图',retouch:'正在精修',upscale:'正在放大'})[tool];
  const width = source?.width, height = source?.height;
  const factor = tool === 'upscale' ? Number(option) : 1;
  const fits = tool==='upscale' && option==='fit';
  const outputWidth = width && height ? (fits ? Math.min(width*4,Math.floor(Math.sqrt(MAX_IMAGE_PIXELS*width/height))) : width*factor) : 0;
  const outputHeight = width && height ? (fits ? Math.min(height*4,Math.floor(Math.sqrt(MAX_IMAGE_PIXELS*height/width))) : height*factor) : 0;
  const tooLarge = tool==='upscale' && (outputWidth*outputHeight>MAX_IMAGE_PIXELS || (fits && width===outputWidth && height===outputHeight));
  const offerFit = tool==='upscale' && width && height && width*height*16>MAX_IMAGE_PIXELS;
  const choices = offerFit || fits ? [...options[tool], ['fit','上限内放大']] : options[tool];
  function chooseOption(value:string){
    if(option===value)return;
    setOption(value);
    if(tool==='cutout' && value!=='transparent')return;
    setMarks([]);setJob(undefined);remember(tool,'');
  }
  function pick(point:{x:number;y:number}){
    if(busy)return;
    if(marks.length>=8){setError('最多可选 8 个位置，请撤销一个点后继续。');return;}
    setMarks([...marks,{...point,mode:option==='remove'?'remove':'keep'}]);
    setError('');setJob(undefined);remember(tool,'');
  }
  return <ModalPortal><div className="modal-backdrop" onClick={close}><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={toolNames[tool]} className="modal work-dialog" onClick={e => e.stopPropagation()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!correcting) void choose(Array.from(e.dataTransfer.files)); }}>
    <header className="work-heading quick-heading"><h2>{toolNames[tool]}</h2><button className="icon-button" title="关闭" aria-label="关闭" onClick={close}><Icon name="close" size={18}/></button></header>
    {correcting && source && result ? <MaskBrush heal={tool==='retouch'} original={source.url} result={result.url} cancel={()=>setCorrecting(false)} apply={strokes=>void run(strokes)} /> : <>
    <GlassTabs className="segmented work-tabs" aria-label="修图工具">{(Object.keys(toolNames) as QuickTool[]).map(t => <button key={t} disabled={busy} className={tool===t?'selected':''} aria-pressed={tool===t} onClick={() => selectTool(t)}>{toolNames[t]}</button>)}</GlassTabs>
    <div className="work-controls">
      <button className="quiet-button" disabled={busy} onClick={() => file.current?.click()}>{source ? '更换图片' : '选择图片'}</button>
      <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void choose(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <GlassTabs className="segmented work-tabs" aria-label={tool==='cutout'?'保留主体':tool==='retouch'?'商品类目':'放大倍率'}>{choices.map(([value,label]) => <button key={value} className={option===value?'selected':''} disabled={busy} aria-pressed={option===value} onClick={()=>chooseOption(value)}>{label}</button>)}</GlassTabs>
      {tool==='retouch' && <>
        <GlassTabs className="segmented work-tabs" aria-label="主图背景">{[['original','保留背景'],['white','纯白背景']].map(([v,t])=><button key={v} disabled={busy} className={v===background?'selected':''} onClick={()=>{setBackground(v);setJob(undefined);remember(tool,'');}}>{t}</button>)}</GlassTabs>
        <GlassTabs className="segmented work-tabs" aria-label="曝光调整">{[['-0.5','压暗'],['0','原曝光'],['0.5','提亮']].map(([v,t])=><button key={v} disabled={busy} className={v===exposure?'selected':''} onClick={()=>{setExposure(v);setJob(undefined);remember(tool,'');}}>{t}</button>)}</GlassTabs>
      </>}
      {tool==='retouch' && background==='white' && <label><input type="checkbox" checked={framing==='center'} disabled={busy} onChange={e=>{setFraming(e.target.checked?'center':'frame');setJob(undefined);remember(tool,'');}}/> 主体居中放大</label>}
      {picking && <><small>在原图点选要{option==='remove'?'移除':'保留'}的物体，选好后一起处理。</small>
        <button className="quiet-button" disabled={busy||!marks.length} onClick={()=>{setMarks(marks.slice(0,-1));setJob(undefined);setError('');remember(tool,'');}}>撤销选点</button></>}
    </div>
    <QuickPreview key={source?.url || 'empty'} source={source} result={result} busy={busy} activity={activity} marks={marks}
      backdrop={tool==='cutout'?({'棋盘':'checker','白色':'white','深色':'dark'}[backdrop]):''}
      onPick={picking&&!busy?pick:undefined} choose={()=>file.current?.click()}
      onSize={(w,h)=>{if(source && !width)setSource({...source,width:w,height:h});}}/>
    <div className="work-controls">{tool==='cutout' && <GlassTabs className="segmented work-tabs" aria-label="检查背景">{['棋盘','白色','深色'].map(v => <button key={v} className={backdrop===v?'selected':''} onClick={() => setBackdrop(v)}>{v}</button>)}</GlassTabs>}
    {tool==='retouch' && <small>{{brush:'轻微调整明暗与锐度，保留笔锋。',paint:'轻调明度，保留颜料色序和包装文字。',paper:'校正棚拍底色，保留纸纹和装订细节。',toy:'轻调对比和轮廓，保留零件和接缝。'}[option]}</small>}
    {tool==='upscale' && <small>{width && height ? `输出 ${outputWidth} × ${outputHeight} px` : '从原尺寸放大'} · 保真重采样</small>}</div>
    {(tooLarge || error || job?.error) && <p className="history-error" role="alert">{tooLarge ? (width && height && width*height>=MAX_IMAGE_PIXELS ? '原图已达 6400 万像素上限。' : '所选倍率超过 6400 万像素，请选择「上限内放大」。') : job?.error || error}</p>}
    <footer className="work-controls">{result && <>{tool==='cutout' && <button className="quiet-button" onClick={()=>{setBackground('white');selectTool('retouch',result);}}>用此蒙版精修</button>}{tool==='retouch' && background==='white' && <button className="quiet-button" onClick={()=>selectTool('cutout')}>修正主体范围</button>}{tool!=='upscale' && <button className="quiet-button" onClick={()=>setCorrecting(true)}>{tool==='cutout'?'调整边缘':'局部去瑕'}</button>}<a className="quiet-button" href={result.url} download={result.name}>下载 PNG</a>{compare && <button className="quiet-button" onClick={() => compare(result)}>{compareLabel}</button>}</>}
    <button className="primary-button" disabled={!source || busy || tooLarge || (picking && !marks.length && !result)} onClick={() => void run()}>{busy ? activity : result ? '重新处理' : '开始处理'}</button></footer></>}
  </section></div></ModalPortal>;
}
