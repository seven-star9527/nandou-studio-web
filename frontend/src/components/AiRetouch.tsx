import { useEffect, useRef, useState } from 'react';
import { accountStorageKey } from '../account-storage';
import { createId } from '../id';
import type { CloudTask } from '../types';
import { workRequest, type WorkImage } from '../workbench-api';
import QuickPreview from './QuickPreview';
import { formatCredits, isCreditAmount } from '../credit-contract';

export default function AiRetouch({source, category, choose, compare}: {
  source?:WorkImage; category:string; choose:()=>void; compare?:(...images:WorkImage[])=>void;
}) {
  const [note,setNote]=useState('');
  const [submitting,setSubmitting]=useState(false);
  const [quote,setQuote]=useState('');
  const [id,setId]=useState('');
  const [task,setTask]=useState<CloudTask>();
  const [error,setError]=useState('');
  const sending=useRef(false);
  const key=accountStorageKey('ai-retouch:'+source?.url);
  useEffect(()=>{
    setTask(undefined);setError('');setQuote('');
    setId(sessionStorage.getItem(key)||'');
  },[key]);
  useEffect(()=>{
    setQuote('');
    if(!source)return;
    const abort=new AbortController();
    workRequest<{label:string;credits_total_reference?:number}>('ai-retouch',{source:source.url,instruction:note,quote_only:true},abort.signal)
      .then(q=>{if(!abort.signal.aborted)setQuote(isCreditAmount(q.credits_total_reference)?'参考 '+formatCredits(q.credits_total_reference)+' 积分':'参考积分暂不可用');})
      .catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:String(e));});
    return ()=>abort.abort();
  },[source?.url,note]);
  useEffect(()=>{
    if(!id)return;
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>; let missing=0;
    const poll=async()=>{
      try {
        const value=await workRequest<CloudTask>('ai-retouch/'+id,undefined,abort.signal);
        if(abort.signal.aborted)return;
        setTask(value);setError('');
        if(!['completed','failed','cancelled'].includes(value.status))timer=setTimeout(poll,2000);
      } catch(e){if(!abort.signal.aborted){if((e as {status?:number}).status===404 && ++missing>=4){setError('未找到这笔任务，请先核对创作记录。');return;}setError(String(e));timer=setTimeout(poll,5000);}}
    };
    void poll();return ()=>{abort.abort();clearTimeout(timer);};
  },[id]);
  const active=submitting || Boolean(id && !['completed','failed','cancelled'].includes(task?.status||''));
  async function run(){
    if(!source||active||sending.current)return;
    sending.current=true;setSubmitting(true);const request=createId();
    sessionStorage.setItem(key,request);setTask(undefined);setError('');
    try{
      const value=await workRequest<CloudTask>('ai-retouch',{id:request,source:source.url,category,instruction:note});
      setTask(value);setId(request);
    }catch(e){setError(String(e));if([400,403,413,422].includes((e as {status?:number}).status??0)){sessionStorage.removeItem(key);setId('');}else setId(request);}
    finally{sending.current=false;setSubmitting(false);}
  }
  const art=task?.images?.[0] as (NonNullable<CloudTask['images']>[number] & {model_original?:string})|undefined;
  const completed=task?.status==='completed';
  const failed=task?.status==='failed';
  const result=art && (completed||failed) ? {url:art.url,width:art.width,height:art.height,name:failed?'模型原稿.png':'AI精修.png'} : undefined;
  return <>
    <label className="retouch-requirements">
      <span>精修要求</span>
      <textarea aria-label="精修要求" value={note} disabled={active} rows={2} maxLength={2000} onChange={e=>setNote(e.target.value)} placeholder="描述想调整的细节，例如：纯白背景，保留真实材质、颜色和槽壁反光"/>
    </label>
    {(error||task?.error)&&<p role="alert" className="history-error">{error||task?.error}</p>}
    <QuickPreview comparison={completed} resultLabel={failed?'模型原稿（未完成精修）':'处理结果'} source={source} result={result} busy={active} activity="正在精修、去纹并输出原尺寸图片" marks={[]} choose={choose} onSize={()=>{}}/>
    <footer className="work-controls">
      <small>{quote}</small>
      {result && <><a className="quiet-button" href={result.url} download={result.name}>下载{task?.status==='failed'?'模型原稿':'原尺寸 PNG'}</a>
        {completed && art?.model_original && <a className="quiet-button" href={art.model_original} download={'模型原稿.'+art.model_original.split('.').pop()}>下载模型原稿</a>}
        {completed && compare && <button className="quiet-button" onClick={()=>compare(...(source?[source,result]:[result]))}>加入对比画布</button>}</>}
      <button className="primary-button" disabled={!source||active||!quote} onClick={()=>void run()}>{active?'处理中':failed?'重新精修（付费）':result?'再次精修':'开始 AI 精修'}</button>
    </footer>
  </>;
}
