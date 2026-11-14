import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { SubjectMark, WorkImage } from '../workbench-api';

type Camera = { zoom:number; x:number; y:number };
type Box = { width:number; height:number };
type Point = { x:number; y:number };
const initialView:Camera = {zoom:1, x:.5, y:.5};
const clamp=(value:number, lo:number, hi:number)=>Math.min(hi,Math.max(lo,value));

function geometry(box:Box, image:WorkImage | undefined, view:Camera, fitLimit:number){
  const w=image?.width || 1, h=image?.height || 1;
  const fit=Math.min(fitLimit,box.width/w,box.height/h);
  const width=w*fit*view.zoom,height=h*fit*view.zoom;
  const left=width<=box.width ? (box.width-width)/2 : clamp(box.width/2-view.x*width,box.width-width,0);
  const top=height<=box.height ? (box.height-height)/2 : clamp(box.height/2-view.y*height,box.height-height,0);
  return {width,height,left,top,fit};
}

interface PaneProps {
  label:string; image?:WorkImage; backdrop?:string; view:Camera; empty:ReactNode;
  update:(v:Camera)=>void; marks?:SubjectMark[]; onPick?:(p:Point)=>void;
  onSize?:(width:number,height:number)=>void;
  onFitScale?:(scale:number)=>void; maxZoom:number; fitLimit?:number; actualZoom:number;
}

function Pane({label,image,backdrop='',view,empty,update,marks,onPick,onSize,onFitScale,maxZoom,fitLimit=1,actualZoom}:PaneProps){
  const frame=useRef<HTMLDivElement>(null);
  const gesture=useRef<{id:number; start:Point; left:number; top:number; moved:boolean; select:boolean}|null>(null);
  const [space,setSpace]=useState(false),[dragging,setDragging]=useState(false);
  const [box,setBox]=useState<Box>({width:1,height:1});
  useLayoutEffect(()=>{
    const node=frame.current!;
    const resize=()=>setBox({width:Math.max(1,node.clientWidth),height:Math.max(1,node.clientHeight)});
    resize();const observer=new ResizeObserver(resize);observer.observe(node);
    return ()=>observer.disconnect();
  },[]);
  const g=geometry(box,image,view,fitLimit);
  useLayoutEffect(()=>{if(image?.width && image.height)onFitScale?.(g.fit);},[g.fit,image?.width,image?.height,onFitScale]);
  function local(x:number,y:number){const r=frame.current!.getBoundingClientRect();return {x:x-r.left,y:y-r.top};}
  function zoomAt(zoom:number,p:Point){
    if(!image || gesture.current)return;
    const next=clamp(zoom,1,maxZoom);
    // Keep the original image pixel under the cursor, including when the image is letterboxed.
    const ux=clamp((p.x-g.left)/g.width,0,1),uy=clamp((p.y-g.top)/g.height,0,1);
    const ratio=next/view.zoom;
    update({zoom:next,x:clamp(ux+(.5*box.width-p.x)/(g.width*ratio),0,1),y:clamp(uy+(.5*box.height-p.y)/(g.height*ratio),0,1)});
  }
  const wheelFrame=useRef(0);
  const pendingWheel=useRef({delta:0,x:0,y:0});
  const applyWheel=useRef(()=>{});
  useLayoutEffect(()=>{applyWheel.current=()=>{
    const {delta,x,y}=pendingWheel.current;
    pendingWheel.current.delta=0;
    wheelFrame.current=0;
    zoomAt(view.zoom*Math.exp(-delta*.0015),local(x,y));
  };});
  useEffect(()=>{
    const node=frame.current!;
    if(!image)return;
    function wheel(e:WheelEvent){
      e.preventDefault();
      const unit=e.deltaMode===1?16:e.deltaMode===2?node.clientHeight:1;
      pendingWheel.current={delta:pendingWheel.current.delta+clamp(e.deltaY*unit,-480,480),x:e.clientX,y:e.clientY};
      if(!wheelFrame.current)wheelFrame.current=requestAnimationFrame(()=>applyWheel.current());
    }
    node.addEventListener('wheel',wheel,{passive:false});
    return ()=>{
      node.removeEventListener('wheel',wheel);
      cancelAnimationFrame(wheelFrame.current);wheelFrame.current=0;pendingWheel.current.delta=0;
    };
  },[image?.url]);
  function key(e:KeyboardEvent<HTMLDivElement>){
    if(!image)return;
    if(e.code==='Space'){e.preventDefault();setSpace(true);return;}
    const middle={x:box.width/2,y:box.height/2};
    if(e.key==='0'){e.preventDefault();update(initialView);}
    else if(e.key==='1' || ['+','=','-'].includes(e.key)){
      e.preventDefault();zoomAt(e.key==='1'?actualZoom:view.zoom*(e.key==='-'?1/1.5:1.5),middle);
    }
  }
  function down(e:PointerEvent<HTMLDivElement>){
    if(!image || ![0,1].includes(e.button) || gesture.current)return;
    e.preventDefault();e.currentTarget.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current={id:e.pointerId,start:local(e.clientX,e.clientY),left:g.left,top:g.top,moved:false,select:e.button===0 && !space};
  }
  function move(e:PointerEvent<HTMLDivElement>){
    const a=gesture.current;if(!a || e.pointerId!==a.id)return;
    const p=local(e.clientX,e.clientY),dx=p.x-a.start.x,dy=p.y-a.start.y;
    if(!a.moved && Math.hypot(dx,dy)<4)return;
    a.moved=true;setDragging(true);
    const x=g.width>box.width?clamp((box.width/2-a.left-dx)/g.width,box.width/(2*g.width),1-box.width/(2*g.width)):.5;
    const y=g.height>box.height?clamp((box.height/2-a.top-dy)/g.height,box.height/(2*g.height),1-box.height/(2*g.height)):.5;
    update({...view,x,y});
  }
  function up(e:PointerEvent<HTMLDivElement>){
    const a=gesture.current;if(!a || e.pointerId!==a.id)return;
    const p=local(e.clientX,e.clientY);
    gesture.current=null;setDragging(false);
    if(!a.moved && a.select && Math.hypot(p.x-a.start.x,p.y-a.start.y)<4){
      const x=(p.x-g.left)/g.width,y=(p.y-g.top)/g.height;
      if(x>=0 && x<=1 && y>=0 && y<=1)onPick?.({x,y});
    }
  }
  const cursor=dragging?'grabbing':space?'grab':onPick?'crosshair':view.zoom>1?'grab':'zoom-in';
  return <figure><figcaption>{label}{image?.width && image.height ? <small>{image.width} × {image.height}{label==='处理结果'?' · PNG':''}</small>:null}</figcaption>
    <div ref={frame} className={'work-preview detail-preview '+backdrop} style={image?{cursor}:undefined}
      aria-label={label+'预览'} tabIndex={image?0:undefined} onKeyDown={key} onKeyUp={e=>{if(e.code==='Space')setSpace(false);}}
      onBlur={()=>setSpace(false)} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onLostPointerCapture={()=>{gesture.current=null;setDragging(false);}}
      onDoubleClick={e=>{if(!onPick && image)zoomAt(view.zoom>1?1:Math.max(2,actualZoom),local(e.clientX,e.clientY));}}>
      {image?<div className="detail-image" style={{width:image.width||1,height:image.height||1,transform:`translate3d(${g.left}px,${g.top}px,0) scale(${g.fit*view.zoom})`}}>
        <img src={image.url} alt={label} draggable={false} onLoad={e=>onSize?.(e.currentTarget.naturalWidth,e.currentTarget.naturalHeight)}/>
        </div>:empty}
      {image && marks?.map(({mode,x,y},i)=><span className={'subject-mark '+mode} key={i} style={{left:0,top:0,transform:`translate3d(${g.left+g.width*x}px,${g.top+g.height*y}px,0) translate(-50%,-50%)`}}>{mode==='keep'?'＋':'−'}{i+1}</span>)}
    </div></figure>;
}

export default function QuickPreview({source,result,backdrop,marks,onPick,onSize,choose,busy,activity}:{
  source?:WorkImage;result?:WorkImage;backdrop?:string;marks:SubjectMark[];onPick?:(p:Point)=>void;
  onSize:(width:number,height:number)=>void;choose:()=>void;busy:boolean;activity:string;
}){
  const [view,setView]=useState(initialView);
  const [sourceFit,setSourceFit]=useState(1),[resultFit,setResultFit]=useState(1);
  const fit=result?resultFit:sourceFit,maxZoom=Math.max(16,4/sourceFit,4/fit);
  const [percent,setPercent]=useState(100);
  const latestPercent=useRef(100);
  const displayTimer=useRef(0);
  const displayPercent=Math.round(view.zoom*fit*100);
  useLayoutEffect(()=>{
    latestPercent.current=displayPercent;
    if(!displayTimer.current)displayTimer.current=window.setTimeout(()=>{
      displayTimer.current=0;setPercent(latestPercent.current);
    },75);
  },[displayPercent]);
  useEffect(()=>()=>window.clearTimeout(displayTimer.current),[]);
  const shared={view,update:setView,maxZoom,actualZoom:1/fit};
  // Match the framing when a small original is enlarged beyond its native dimensions.
  const sourceLimit=source?.width && result?.width ? Math.max(1,result.width/source.width) : 1;
  function scale(zoom:number){setView(v=>({...v,zoom:clamp(zoom,1,maxZoom)}));}
  return <><div className="work-pair">
    <Pane {...shared} label="原图" image={source} marks={marks} onPick={onPick} onSize={onSize} onFitScale={setSourceFit} fitLimit={sourceLimit}
      empty={<button disabled={busy} onClick={choose}>拖入图片，或点击上传</button>}/>
    <Pane {...shared} label="处理结果" image={result} backdrop={backdrop} onFitScale={setResultFit} empty={busy?<div className="quick-processing" role="status">
      {source && <img className="quick-processing-image" src={source.url} alt="" draggable={false}/>}
      <span className="quick-processing-sweep" aria-hidden="true"/>
      <span className="quick-processing-label"><i aria-hidden="true"/>{activity}</span>
    </div>:<span>等待处理</span>}/>
  </div>{source && <div className="work-controls preview-tools" role="group" aria-label="对照预览缩放">
    <button className="quiet-button" aria-label="缩小预览" disabled={view.zoom<=1} onClick={()=>scale(view.zoom/1.5)}>−</button>
    <output title={result?'结果图显示比例':'原图显示比例'}>{percent}%</output>
    <button className="quiet-button" aria-label="放大预览" disabled={view.zoom>=maxZoom} onClick={()=>scale(view.zoom*1.5)}>＋</button>
    <button className="quiet-button" title="按实际像素查看（1）" onClick={()=>scale(1/fit)}>查看 100%</button>
    <button className="quiet-button" onClick={()=>setView(initialView)}>适应窗口</button>
    <small>滚轮缩放 · 拖动平移</small>
  </div>}</>;
}
