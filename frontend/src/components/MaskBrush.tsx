import { useEffect, useRef, useState } from 'react';
import GlassTabs from './GlassTabs';

export interface MaskStroke { mode:'keep'|'erase'|'heal'; radius:number; points:[number,number][] }
interface Props { original:string; result:string; heal?:boolean; apply:(strokes:MaskStroke[])=>void; cancel:()=>void }

function load(url:string) {
  return new Promise<HTMLImageElement>((resolve,reject)=>{
    const img = new Image();
    img.onload=()=>resolve(img); img.onerror=()=>reject(new Error('图片读取失败。')); img.src=url;
  });
}

export default function MaskBrush({original,result,apply,cancel,heal=false}:Props) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const pair=useRef<HTMLImageElement[]>([]);
  const mask=useRef<HTMLCanvasElement | null>(null);
  const strokes=useRef<MaskStroke[]>([]);
  const current=useRef<MaskStroke | null>(null);
  const [mode,setMode]=useState<MaskStroke['mode']>('keep'), [radius,setRadius]=useState(heal ? .6 : 2);
  const [count,setCount]=useState(0),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const [zoom,setZoom]=useState(1),[hand,setHand]=useState(false),[space,setSpace]=useState(false);
  const anchor=useRef<[number,number]>([.5,.5]);
  const drag=useRef<{id:number,x:number,y:number,originX:number,originY:number}|null>(null);
  const painting=useRef<number|null>(null);
  const crop=useRef({x:0,y:0,size:1});
  function render(){
    const frame=canvas.current, buffer=mask.current;
    if(!frame||!buffer||!pair.current.length)return;
    const [source,base]=pair.current;
    const w=frame.width,h=frame.height, ctx=frame.getContext('2d')!, alpha=buffer.getContext('2d')!;
    const area=crop.current;
    const blit=(context:CanvasRenderingContext2D,img:HTMLImageElement)=>{
      context.drawImage(img,area.x*img.width,area.y*img.height,area.size*img.width,area.size*img.height,0,0,w,h);
    };
    alpha.clearRect(0,0,w,h);blit(alpha,base);
    for(const s of strokes.current){
      alpha.globalCompositeOperation=s.mode!=='erase'?'source-over':'destination-out';
      const r=Math.max(1,s.radius*Math.min(w,h)/area.size);
      alpha.strokeStyle=alpha.fillStyle=heal?'#c49aff99':'#fff'; alpha.lineJoin=alpha.lineCap='round';alpha.lineWidth=2*r;
      const [first,...rest]=s.points.map(([x,y])=>[(x-area.x)/area.size,(y-area.y)/area.size]);
      alpha.beginPath();alpha.arc(first[0]*w,first[1]*h,r,0,Math.PI*2);alpha.fill();
      alpha.beginPath();alpha.moveTo(first[0]*w,first[1]*h);
      for(const [x,y] of rest)alpha.lineTo(x*w,y*h);
      alpha.stroke();
    }
    alpha.globalCompositeOperation='source-over';
    ctx.clearRect(0,0,w,h);
    if(heal){ctx.drawImage(buffer,0,0);return;}
    blit(ctx,source);
    ctx.globalCompositeOperation='destination-in';ctx.drawImage(buffer,0,0);ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha=.15;ctx.globalCompositeOperation='destination-over';blit(ctx,source);
    ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  }
  useEffect(()=>{
    let alive=true;
    void Promise.all([load(original),load(result)]).then(images=>{
      if(!alive||!canvas.current)return;
      pair.current=images;
      const ratio=Math.min(1,1280/Math.max(images[0].width,images[0].height));
      const buffer=document.createElement('canvas');mask.current=buffer;
      buffer.width=canvas.current.width=Math.max(1,Math.round(images[0].width*ratio));
      buffer.height=canvas.current.height=Math.max(1,Math.round(images[0].height*ratio));
      render();setReady(true);
    }).catch(cause=>{if(alive)setError(String(cause));});
    return ()=>{alive=false;};
  },[original,result]);
  const clamp=(v:number,max=1)=>Math.max(0,Math.min(max,v));
  function position(x:number,y:number):[number,number]{
    const r=canvas.current!.getBoundingClientRect();
    return [clamp((x-r.left)/r.width),clamp((y-r.top)/r.height)];
  }
  function point(x:number,y:number):[number,number]{
    const [u,v]=position(x,y),area=crop.current;
    return [area.x+area.size*u,area.y+area.size*v];
  }
  function magnify(factor:number,at=anchor.current){
    if(current.current||drag.current)return;
    const area=crop.current, size=Math.max(1/16,Math.min(1,area.size/factor));
    crop.current={x:clamp(area.x+(area.size-size)*at[0],1-size),y:clamp(area.y+(area.size-size)*at[1],1-size),size};
    setZoom(1/size);render();
  }
  function undo(){
    if(current.current||drag.current)return;
    strokes.current.pop();setCount(strokes.current.length);render();
  }
  useEffect(()=>{
    const frame=canvas.current;
    if(!frame||!ready)return;
    frame.focus({preventScroll:true});
    function wheel(e:WheelEvent){
      e.preventDefault();anchor.current=position(e.clientX,e.clientY);
      magnify(Math.exp(-Math.sign(e.deltaY)*.20));
    }
    const release=()=>{setSpace(false);drag.current=null;painting.current=null;current.current=null;};
    window.addEventListener('blur',release);
    frame.addEventListener('wheel',wheel,{passive:false});
    return ()=>{frame.removeEventListener('wheel',wheel);window.removeEventListener('blur',release);};
  },[ready]);
  return <div className="mask-editor" onKeyDown={e=>{
    if(e.target instanceof HTMLInputElement)return;
    if(['+','=','-','0'].includes(e.key)){
      e.preventDefault();magnify(e.key==='-'?1/1.5:e.key==='0'?1/16:1.5);
    }else if(e.code==='Space' && e.target===canvas.current){e.preventDefault();setSpace(true);}
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}
  }} onKeyUp={e=>{if(e.code==='Space')setSpace(false);}}><div className="work-controls">{!heal && <GlassTabs className="segmented work-tabs" aria-label="修边画笔">
    <button className={mode==='keep'&&!hand?'selected':''} onClick={()=>{setMode('keep');setHand(false);}}>恢复主体</button><button className={mode==='erase'&&!hand?'selected':''} onClick={()=>{setMode('erase');setHand(false);}}>擦除背景</button></GlassTabs>}
    <button className="quiet-button" aria-label="缩小" disabled={zoom<=1} onClick={()=>magnify(1/1.5)}>−</button>
    <button className="quiet-button" title="适应全图（0）" onClick={()=>magnify(1/16)}>{Math.round(zoom*100)}%</button>
    <button className="quiet-button" aria-label="放大" disabled={zoom>=16} onClick={()=>magnify(1.5)}>＋</button>
    <button className="quiet-button" aria-pressed={hand} onClick={()=>{setHand(!hand);canvas.current?.focus();}}>平移</button>
    <label>笔刷大小 <input type="range" min=".2" max="10" step=".2" value={radius} onChange={e=>setRadius(Number(e.target.value))}/></label>
    <button className="quiet-button" disabled={!count} onClick={undo}>撤销一笔</button></div>
    <div className="mask-stage work-preview checker"><canvas tabIndex={0} ref={canvas} style={{cursor:space||hand?'grab':'crosshair'}} onBlur={()=>setSpace(false)} aria-label={heal?"标记需要去除的污点":"在原图位置涂抹修正蒙版"} onPointerDown={e=>{
      if(!ready||drag.current||current.current)return;
      e.currentTarget.focus({preventScroll:true});
      if(e.button===1 || (e.button===0 && (space||hand))){
        e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
        drag.current={id:e.pointerId,x:e.clientX,y:e.clientY,originX:crop.current.x,originY:crop.current.y};return;
      }
      if(e.button!==0)return;
      painting.current=e.pointerId;
      if(strokes.current.length>=200){setError('本次已达 200 笔，请先应用修边后继续。');return;}
      e.currentTarget.setPointerCapture(e.pointerId);
      current.current={mode:heal?'heal':mode,radius:radius/100,points:[point(e.clientX,e.clientY)]};strokes.current.push(current.current);setCount(strokes.current.length);render();
    }} onPointerMove={e=>{
      anchor.current=position(e.clientX,e.clientY);
      const pan=drag.current;
      if(pan?.id===e.pointerId){
        const r=e.currentTarget.getBoundingClientRect(),size=crop.current.size;
        crop.current={x:clamp(pan.originX-(e.clientX-pan.x)*size/r.width,1-size),y:clamp(pan.originY-(e.clientY-pan.y)*size/r.height,1-size),size};
        render();return;
      }
      if(painting.current===e.pointerId && current.current){
      if(current.current.points.length>=120)current.current.points=current.current.points.filter((_,i)=>i%2===0);
      current.current.points.push(point(e.clientX,e.clientY));render();
    }}} onLostPointerCapture={e=>{
      if(drag.current?.id===e.pointerId)drag.current=null;
      if(painting.current===e.pointerId){painting.current=null;current.current=null;}
    }}/></div>
    {error&&<p role="alert">{error}</p>}<div className="work-controls"><small>{heal?'点选或涂过灰尘、污点，笔刷略大于瑕疵即可。':'淡色原图用于定位已去除的部分。'} 滚轮或 ＋ / − 缩放，空格拖动或按住中键平移，0 查看全图。</small><span className="work-spacer"/><button className="quiet-button" onClick={cancel}>{heal?'取消':'取消修边'}</button><button className="primary-button" disabled={!ready||!count} onClick={()=>apply(strokes.current)}>{heal?'修复标记区域':'应用修边'}</button></div></div>;
}
