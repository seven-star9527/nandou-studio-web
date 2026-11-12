import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createId } from '../id';
import { checkImageBatch } from '../image-upload-limits';
import { useModalDialog } from '../useModalDialog';
import { uploadImage, workRequest, type WorkImage } from '../workbench-api';
import ModalPortal from './ModalPortal';

interface Card extends WorkImage { id: string; x: number; y: number; available?: boolean }
interface View { x: number; y: number; zoom: number }
interface Board { cards: Card[]; preferred: string | null; view: View }
type SavedBoard = Board & { revision: number };
const width = 300, height = 242, gap = 24, maxCards = 60;
const empty: Board = {cards:[], preferred:null, view:{x:24,y:36,zoom:1}};
const imageUrl = (url:string, preview=false) => '/studio-agent/workbench/board-image?source='+encodeURIComponent(url)+(preview?'&preview=1':'');

function fit(cards: Card[], area: HTMLElement): View {
  if (!cards.length) return empty.view;
  const left = Math.min(...cards.map(c=>c.x)), top = Math.min(...cards.map(c=>c.y));
  const w = Math.max(...cards.map(c=>c.x+width))-left, h = Math.max(...cards.map(c=>c.y+height))-top;
  const zoom = Math.max(.05, Math.min(1.6,(area.clientWidth-56)/w,(area.clientHeight-68)/h));
  return {zoom, x:(area.clientWidth-w*zoom)/2-left*zoom, y:(area.clientHeight-h*zoom)/2-top*zoom};
}
function place(image:WorkImage, cards:Card[]): Card {
  const last = cards.at(-1);
  return {...image,name:image.name.trim().slice(0,160)||'图片',id:createId(),available:true,
    x:last ? last.x+width+gap : 0,y:last?.y ?? 0};
}

export default function CompareBoard({initial, close}: {initial?:WorkImage; close:()=>void}) {
  const dialog = useRef<HTMLElement>(null), plane = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null);
  const [board,setBoard] = useState<Board>(empty), [selected,choose] = useState('');
  const [ready,setReady] = useState(false), [adding,setAdding] = useState(false);
  const [error,setError] = useState(''), [status,setStatus] = useState('');
  const [broken,setBroken] = useState(new Set<string>());
  const current = useRef(board), revision = useRef(0), dirty = useRef(false);
  const writing = useRef<Promise<boolean>|null>(null), mounted = useRef(true), importing = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{id?:string; px:number; py:number; x:number; y:number} | null>(null);
  const active = board.cards.find(c=>c.id===selected);
  function change(value:Board) { current.current=value; dirty.current=true; setBoard(value); setStatus('待保存'); }
  function save():Promise<boolean> {
    clearTimeout(timeout.current);
    if (writing.current) return writing.current;
    if (!dirty.current) return Promise.resolve(true);
    const run = async () => {
      try {
        while (dirty.current) {
          const snapshot=current.current;
          dirty.current=false;
          if(mounted.current) setStatus('保存中…');
          const response=await workRequest<{revision:number}>('board',{...snapshot,revision:revision.current});
          revision.current=response.revision;
        }
        if(mounted.current) setStatus('已保存');
        return true;
      } catch(cause) {
        dirty.current=true;
        if(mounted.current){setStatus('未保存');setError(String(cause));}
        return false;
      } finally { writing.current=null; }
    };
    writing.current=run();
    return writing.current;
  }
  function schedule(){ clearTimeout(timeout.current); timeout.current=setTimeout(()=>void save(),250); }
  async function exit() { if (!importing.current && await save()) close(); }
  useModalDialog(true,dialog,()=>void exit());
  function append(images:WorkImage[]) {
    const next=current.current;
    const list=[...next.cards];
    let last='';
    for(const image of images){
      const known=list.find(item=>item.url===image.url);
      if(known){last=known.id;continue;}
      if(list.length>=maxCards) throw new Error('每块画布最多放 60 张图。');
      const card=place(image,list);list.push(card);last=card.id;
    }
    choose(last);change({...next,cards:list,view:fit(list,plane.current!)});
    void save();
  }
  useEffect(()=>{
    mounted.current=true;
    const controller=new AbortController();
    void workRequest<SavedBoard>('board',undefined,controller.signal).then(data=>{
      if(controller.signal.aborted)return;
      revision.current=data.revision;
      current.current={cards:data.cards,preferred:data.preferred,view:data.view};
      setBoard(current.current);choose(data.preferred ?? data.cards[0]?.id ?? '');setReady(true);
      if(initial)append([initial]);
    }).catch(cause=>{if(!controller.signal.aborted)setError(String(cause));});
    const leaving=(e:BeforeUnloadEvent)=>{if(dirty.current||writing.current){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',leaving);
    return ()=>{mounted.current=false;controller.abort();clearTimeout(timeout.current);window.removeEventListener('beforeunload',leaving);};
  },[initial]);
  async function addFiles(files:File[]) {
    if(!ready||importing.current||!files.length)return;
    importing.current=true;setAdding(true);setError('');
    const images:WorkImage[]=[];
    try {
      if(current.current.cards.length+files.length>maxCards)throw new Error('每块画布最多放 60 张图。');
      checkImageBatch(files,[]);
      for(const input of files)images.push(await uploadImage(input));
    }catch(cause){if(mounted.current)setError(String(cause));}
    finally{
      if(mounted.current&&images.length)append(images);
      importing.current=false;if(mounted.current)setAdding(false);
    }
  }
  function scale(multiplier:number, px?:number,py?:number){
    if(!plane.current || !ready)return;
    const b=current.current,v=b.view,zoom=Math.max(.05,Math.min(16,v.zoom*multiplier));
    const x=px??plane.current.clientWidth/2,y=py??plane.current.clientHeight/2;
    change({...b,view:{zoom,x:x-(x-v.x)*zoom/v.zoom,y:y-(y-v.y)*zoom/v.zoom}});schedule();
  }
  useEffect(()=>{
    const element=plane.current;
    if(!element||!ready)return;
    const wheel=(e:WheelEvent)=>{e.preventDefault();const rect=element.getBoundingClientRect();scale(Math.exp(-.0015*e.deltaY),e.clientX-rect.left,e.clientY-rect.top);};
    element.addEventListener('wheel',wheel,{passive:false});
    return ()=>element.removeEventListener('wheel',wheel);
  },[ready]);
  function start(e:PointerEvent<HTMLDivElement>){
    if(!ready||e.button!==0)return;
    const id=(e.target as HTMLElement).closest<HTMLElement>('[data-card]')?.dataset.card;
    const card=current.current.cards.find(c=>c.id===id);
    if(card)choose(card.id);
    const origin=card??current.current.view;
    drag.current={id,px:e.clientX,py:e.clientY,x:origin.x,y:origin.y};
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e:PointerEvent<HTMLDivElement>){
    const d=drag.current;if(!d)return;
    const b=current.current,dx=e.clientX-d.px,dy=e.clientY-d.py;
    if(!dx&&!dy)return;
    if(d.id)change({...b,cards:b.cards.map(c=>c.id===d.id?{...c,x:d.x+dx/b.view.zoom,y:d.y+dy/b.view.zoom}:c)});
    else change({...b,view:{...b.view,x:d.x+dx,y:d.y+dy}});
  }
  function arrange(){
    const b=current.current;
    const cols=Math.min(4,Math.max(2,Math.ceil(Math.sqrt(b.cards.length*1.4))));
    const cards=b.cards.map((c,i)=>({...c,x:(i%cols)*(width+gap),y:Math.floor(i/cols)*(height+gap)}));
    change({...b,cards,view:fit(cards,plane.current!)});void save();
  }
  function remove(){
    const b=current.current,cards=b.cards.filter(c=>c.id!==selected);
    choose(cards[0]?.id??'');change({...b,cards,preferred:b.preferred===selected?null:b.preferred});void save();
  }
  return <ModalPortal><div className="modal-backdrop" onClick={()=>void exit()}><section ref={dialog} tabIndex={-1} className="modal work-dialog compare-dialog" role="dialog" aria-modal="true" aria-label="方案对比画布" onClick={e=>e.stopPropagation()}>
    <header className="work-heading"><h2>方案对比画布</h2><button className="quiet-button" onClick={()=>void exit()} disabled={adding}>关闭</button></header>
    <div className="work-controls"><button className="quiet-button" disabled={!ready||adding} onClick={()=>file.current?.click()}>{adding?'正在添加…':'添加图片'}</button><input ref={file} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e=>{void addFiles(Array.from(e.target.files??[]));e.target.value='';}}/>
    <button className="quiet-button" disabled={!board.cards.length} onClick={arrange}>并排整理</button><span className="work-spacer"/>
    {active && <><button className="quiet-button" onClick={remove}>移出画布</button>{active.available!==false && !broken.has(active.id) && <><button className="quiet-button" onClick={()=>{const b=current.current;change({...b,preferred:b.preferred===selected?null:selected});void save();}}>{board.preferred===selected?'取消首选':'设为首选'}</button><a className="primary-button" href={imageUrl(active.url)} download={active.name}>下载选中原图</a></>}</>}</div>
    <div className="compare-plane" ref={plane} onPointerDown={start} onPointerMove={move} onPointerUp={()=>{drag.current=null;schedule();}} onPointerCancel={()=>{drag.current=null;schedule();}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void addFiles(Array.from(e.dataTransfer.files));}}>
      {!board.cards.length&&<p>{ready?'拖入图片开始对比':'正在打开画布…'}</p>}
      <div className="compare-world" style={{transform:`translate(${board.view.x}px,${board.view.y}px) scale(${board.view.zoom})`}}>
        {board.cards.map(c=><button key={c.id} data-card={c.id} className={'compare-card '+(c.id===selected?'active':'')} aria-pressed={c.id===selected} onClick={()=>choose(c.id)} style={{left:c.x,top:c.y,width,height,zIndex:c.id===selected?1:0}}>
        {c.available===false||broken.has(c.id)?<span className="missing-image">图片已不可用</span>:<img draggable={false} src={imageUrl(c.url,board.view.zoom<1.7)} alt={c.name} onError={()=>setBroken(s=>new Set(s).add(c.id))}/>}
        <span className="compare-caption"><span>{c.name}</span>{board.preferred===c.id&&<b>✓ 首选</b>}</span></button>)}
      </div>
    </div>
    <footer className="work-controls"><small>{board.cards.length} 张{status?' · '+status:''}</small><span className="work-spacer"/><button className="quiet-button" aria-label="缩小画布" onClick={()=>scale(.8)}>−</button><span>{Math.round(board.view.zoom*100)}%</span><button className="quiet-button" aria-label="放大画布" onClick={()=>scale(1.25)}>＋</button><button className="quiet-button" disabled={!board.cards.length} onClick={()=>{const b=current.current;change({...b,view:fit(b.cards,plane.current!)});void save();}}>适应全部</button></footer>
    {error&&<div className="history-error" role="alert">{error} <button className="quiet-button" onClick={close}>关闭此窗口</button></div>}
  </section></div></ModalPortal>;
}
