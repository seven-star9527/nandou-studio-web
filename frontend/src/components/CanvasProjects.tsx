import { useEffect, useRef, useState } from 'react';
import { createId } from '../id';
import { workRequest } from '../workbench-api';
import Icon from './Icon';

export interface CanvasProject { id:string; name:string; updated_at:number }

export default function CanvasProjects({open, adding}: {open:(project:CanvasProject)=>void; adding:boolean}) {
  const [projects,setProjects] = useState<CanvasProject[]>([]);
  const [name,setName] = useState(''), [busy,setBusy] = useState(false);
  const [error,setError] = useState(''), [loading,setLoading] = useState(true);
  const creating = useRef(false);
  const requestId = useRef('');
  useEffect(()=>{
    const controller=new AbortController();
    workRequest<CanvasProject[]>('projects',undefined,controller.signal).then(setProjects)
      .catch(e=>{if(!controller.signal.aborted)setError(String(e));})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[]);
  async function create() {
    if(creating.current || !name.trim()) return;
    creating.current=true;setBusy(true);setError('');
    requestId.current ||= createId();
    try {
      const {id}=await workRequest<{id:string}>('projects',{id:requestId.current,name:name.trim()});
      open({id,name:name.trim(),updated_at:Date.now()/1000});
    } catch(e){setError(String(e));} finally{creating.current=false;setBusy(false);}
  }
  return <section className="canvas-projects" aria-label="画布项目">
    <header><h2>{adding?'选择素材要加入的画布':'我的画布'}</h2></header>
    <form onSubmit={e=>{e.preventDefault();void create();}}>
      <input aria-label="新项目名称" placeholder="输入新画布名称" maxLength={80} disabled={busy} value={name} onChange={e=>{setName(e.target.value);requestId.current='';}}/>
      <button className="primary-button" disabled={!name.trim()||busy}><Icon name="plus" size={16}/>新建画布</button>
    </form>
    {error&&<p role="alert" className="history-error">{error}</p>}
    {loading?<p role="status">正在读取项目…</p>:<div className="project-grid">
      {projects.map(p=><button className="project-tile" key={p.id} disabled={busy} onClick={()=>open(p)}>
        <span className="project-symbol"><Icon name="poster" size={23}/></span><span><strong>{p.name}</strong>
        {p.updated_at>0&&<small>{new Date(p.updated_at*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small>}</span>
        <Icon name="arrow" size={17}/></button>)}
    </div>}
  </section>;
}
