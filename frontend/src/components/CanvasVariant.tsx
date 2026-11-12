import { useRef, useState } from 'react';
import { createId } from '../id';
import { loadStudioImage } from '../task-references';
import { useCloudQuote } from '../useCloudQuote';
import type { useStudio } from '../useStudio';
import { cloudDimensions } from '../cloud-contract';
import { dimensions, RATIOS } from '../resolution-policy';
import Icon from './Icon';
import GlassSelect from './GlassSelect';
import GenerationQuote from './GenerationQuote';

export type StudioSession = ReturnType<typeof useStudio>;
export default function CanvasVariant({studio, source, reserve, discard, done}: {
  studio:StudioSession; source?:{url:string;name:string;aspect?:number};
  reserve:(id:string,name:string)=>Promise<void>; discard:(id:string)=>void; done:()=>void;
}) {
  const [prompt,setPrompt]=useState('');
  const model=studio.cloudModel;
  const options=(model?.ratios ?? RATIOS.map(r=>r.id)).filter(r=>/^\d+:\d+$/.test(r));
  const [ratio,setRatio]=useState(()=>{
    const aspect=source?.aspect;
    if(!aspect)return options.includes(studio.settings.ratio)?studio.settings.ratio:options[0];
    const distance=(value:string)=>{const [w,h]=value.split(':').map(Number);return Math.abs(Math.log(w/h/aspect));};
    return options.reduce((best,r)=>distance(r)<distance(best)?r:best,options[0]);
  });
  const [working,setWorking]=useState(false), [error,setError]=useState('');
  const lock=useRef(false);
  const settings={...studio.settings, ratio, count:1, ...(model?cloudDimensions(model,ratio,studio.settings.resolution):dimensions(ratio,studio.settings.resolution))};
  const quote=useCloudQuote(studio.client,studio.connected,model,settings);
  const busy=studio.job && ['connecting','queued','loading','generating','stopping'].includes(studio.job.phase);
  const supported=!model || model.operations.includes(source ? 'edit' : 'generate');
  async function submit() {
    if (lock.current || !prompt.trim() || busy || !studio.ready || !supported) return;
    lock.current=true; setWorking(true); setError('');
    const id=createId();
    let reserved=false;
    try {
      const references=source ? [await loadStudioImage(source.url,source.name)] : [];
      await reserve(id,prompt.trim().slice(0,60));
      reserved=true;
      studio.generate(Boolean(source),{id,prompt,references,settings});
      done();
    } catch(cause) {
      if (reserved) discard(id);
      setError(cause instanceof Error?cause.message:String(cause));
    } finally {lock.current=false;setWorking(false);}
  }
  return <div className="canvas-variant">
    <header>{source ? <><img src={source.url} alt="参考图"/><strong>{source.name}</strong></> : <strong>生成图片</strong>}<button className="icon-button" title="关闭输入框" aria-label="关闭输入框" disabled={working} onClick={done}><Icon name="close" size={16}/></button></header>
    {source && <div className="retouch-directions">{Object.entries({
      '画笔精修':'沿用原照片的机位和商品像素。每支笔的外轮廓、笔尖粗细与长度、杆身原有纹理保持原样。已有字样照原图保留，空白处保持空白。只轻微压低金属高光，清理背景浮尘，维持原有接触阴影。',
      '颜料盒精修':'只清理背景浮尘并轻微柔化原有反光。盒盖每一格、原有表面和空白区域原样保留，图中没有的文字、标志、贴纸一律不添加。保持色块数量、色序、色相、铰链与配件位置，沿用原机位和接触阴影。',
      '玩具精修':'按原图保留每个部件、接缝、图案、配色和位置。使用柔和主光与弱补光分开相邻轮廓，保留真实表面纹理和接触阴影，清理背景杂点。'
    }).map(([title,text])=><button key={title} type="button" disabled={working} onClick={()=>setPrompt(old=>old.trim()?old.trim()+'\n'+text:text)}>{title}</button>)}</div>}
    <textarea aria-label={source?'修改要求':'画面描述'} autoFocus maxLength={8000} disabled={working} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key==='Enter'){e.preventDefault();void submit();}}} placeholder={source?'描述要修改的地方…':'描述想要生成的画面…'} />
    <div className="variant-controls"><small>{model?.label || (studio.settings.model.includes('qwen_image_2.1')?'Qwen-Image-2.1':studio.settings.model) || '本地模型'}</small>
    <GlassSelect label="新图比例" value={ratio} options={options.map(value=>({value,label:value}))} onChange={setRatio} disabled={working}/>
    <small>{settings.resolution} · 1 张</small><GenerationQuote local={!model} {...quote} descriptionId="variant-price"/>
    <button className="primary-button" title="生成到当前画布" aria-label="生成到当前画布" disabled={!prompt.trim() || working || !!busy || !studio.ready || !supported} onClick={()=>void submit()}><Icon name="arrow" size={17}/></button></div>
    {(!studio.ready || !supported || busy) && <small role="status">{busy?'当前任务进行中':!supported?(source?'当前模型不支持参考图编辑。':'当前模型不支持文生图。'):'图像服务尚未就绪，可先编辑要求。'}</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
