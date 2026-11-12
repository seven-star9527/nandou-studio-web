import { useRef, useState } from 'react';
import { createId } from '../id';
import { loadStudioImage } from '../task-references';
import { useCloudQuote } from '../useCloudQuote';
import type { useStudio } from '../useStudio';
import { cloudDimensions } from '../cloud-contract';
import { dimensions, RATIOS } from '../resolution-policy';
import GlassSelect from './GlassSelect';
import GenerationQuote from './GenerationQuote';

export type StudioSession = ReturnType<typeof useStudio>;
export default function CanvasVariant({studio, source, reserve, discard, done}: {
  studio:StudioSession; source:{url:string;name:string};
  reserve:(id:string,name:string)=>Promise<void>; discard:(id:string)=>void; done:()=>void;
}) {
  const [prompt,setPrompt]=useState('');
  const model=studio.cloudModel;
  const options=(model?.ratios ?? RATIOS.map(r=>r.id)).filter(r=>/^\d+:\d+$/.test(r));
  const [ratio,setRatio]=useState(options.includes(studio.settings.ratio)?studio.settings.ratio:options[0]);
  const [working,setWorking]=useState(false), [error,setError]=useState('');
  const lock=useRef(false);
  const settings={...studio.settings, ratio, count:1, ...(model?cloudDimensions(model,ratio,studio.settings.resolution):dimensions(ratio,studio.settings.resolution))};
  const quote=useCloudQuote(studio.client,studio.connected,model,settings);
  const busy=studio.job && ['connecting','queued','loading','generating','stopping'].includes(studio.job.phase);
  const supported=!model || model.operations.includes('edit');
  async function submit() {
    if (lock.current || !prompt.trim()) return;
    lock.current=true; setWorking(true); setError('');
    const id=createId();
    let reserved=false;
    try {
      const reference=await loadStudioImage(source.url,source.name);
      await reserve(id,prompt.trim().slice(0,60));
      reserved=true;
      studio.generate(true,{id,prompt,references:[reference],settings});
      done();
    } catch(cause) {
      if (reserved) discard(id);
      setError(cause instanceof Error?cause.message:String(cause));
    } finally {lock.current=false;setWorking(false);}
  }
  return <div className="canvas-variant">
    <label>修改要求<textarea autoFocus maxLength={8000} disabled={working} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="例如：将三支画笔竖直平铺，右侧留白。" /></label>
    <GlassSelect label="新图比例" value={ratio} options={options.map(value=>({value,label:value}))} onChange={setRatio} disabled={working}/>
    <small>{model?.label || studio.settings.model || '本地模型'} · {settings.resolution} · 1 张</small>
    <GenerationQuote local={!model} {...quote} descriptionId="variant-price"/>
    <button className="primary-button" disabled={!prompt.trim() || working || !!busy || !studio.ready || !supported} onClick={()=>void submit()}>{working?'正在提交…':'生成到当前画布'}</button>
    <button className="quiet-button" disabled={working} onClick={done}>取消</button>
    {(!studio.ready || !supported || busy) && <small role="status">{busy?'当前任务进行中':!supported?'当前模型不支持参考图编辑，请在图片生成中切换模型。':'图像服务尚未就绪，可先编辑要求。'}</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
