import { useEffect, useRef, useState, type PointerEvent } from 'react';
import GlassTabs from './GlassTabs';

export interface MaskStroke { mode:'keep'|'erase'; radius:number; points:[number,number][] }
interface Props { original:string; result:string; apply:(strokes:MaskStroke[])=>void; cancel:()=>void }

function load(url:string) {
  return new Promise<HTMLImageElement>((resolve,reject)=>{
    const img = new Image();
    img.onload=()=>resolve(img); img.onerror=()=>reject(new Error('图片读取失败。')); img.src=url;
  });
}

export default function MaskBrush({original,result,apply,cancel}:Props) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const pair=useRef<HTMLImageElement[]>([]);
  const mask=useRef<HTMLCanvasElement | null>(null);
  const strokes=useRef<MaskStroke[]>([]);
  const current=useRef<MaskStroke | null>(null);
  const [mode,setMode]=useState<MaskStroke['mode']>('keep'), [radius,setRadius]=useState(2);
  const [count,setCount]=useState(0),[error,setError]=useState(''),[ready,setReady]=useState(false);
  function render(){
    const frame=canvas.current, buffer=mask.current;
    if(!frame||!buffer||!pair.current.length)return;
    const [source,base]=pair.current;
    const w=frame.width,h=frame.height, ctx=frame.getContext('2d')!, alpha=buffer.getContext('2d')!;
    alpha.clearRect(0,0,w,h);alpha.drawImage(base,0,0,w,h);
    for(const s of strokes.current){
      alpha.globalCompositeOperation=s.mode==='keep'?'source-over':'destination-out';
      const r=Math.max(1,s.radius*Math.min(w,h));
      alpha.strokeStyle=alpha.fillStyle='#fff'; alpha.lineJoin=alpha.lineCap='round';alpha.lineWidth=2*r;
      const [first,...rest]=s.points;
      alpha.beginPath();alpha.arc(first[0]*w,first[1]*h,r,0,Math.PI*2);alpha.fill();
      alpha.beginPath();alpha.moveTo(first[0]*w,first[1]*h);
      for(const [x,y] of rest)alpha.lineTo(x*w,y*h);
      alpha.stroke();
    }
    alpha.globalCompositeOperation='source-over';
    ctx.clearRect(0,0,w,h);ctx.drawImage(source,0,0,w,h);
    ctx.globalCompositeOperation='destination-in';ctx.drawImage(buffer,0,0);ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha=.15;ctx.globalCompositeOperation='destination-over';ctx.drawImage(source,0,0,w,h);
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
  function point(e:PointerEvent<HTMLCanvasElement>):[number,number] {
    const rect=e.currentTarget.getBoundingClientRect();
    const bound=(n:number)=>Math.min(1,Math.max(0,n));
    return [bound((e.clientX-rect.left)/rect.width),bound((e.clientY-rect.top)/rect.height)];
  }
  return <div className="mask-editor"><div className="work-controls"><GlassTabs className="segmented work-tabs" aria-label="修边画笔">
    <button className={mode==='keep'?'selected':''} onClick={()=>setMode('keep')}>恢复主体</button><button className={mode==='erase'?'selected':''} onClick={()=>setMode('erase')}>擦除背景</button></GlassTabs>
    <label>笔刷大小 <input type="range" min=".2" max="10" step=".2" value={radius} onChange={e=>setRadius(Number(e.target.value))}/></label>
    <button className="quiet-button" disabled={!count} onClick={()=>{strokes.current.pop();setCount(strokes.current.length);render();}}>撤销一笔</button></div>
    <div className="mask-stage work-preview checker"><canvas ref={canvas} aria-label="在原图位置涂抹修正蒙版" onPointerDown={e=>{
      if(!ready||e.button!==0)return;
      if(strokes.current.length>=200){setError('本次已达 200 笔，请先应用修边后继续。');return;}
      e.currentTarget.setPointerCapture(e.pointerId);
      current.current={mode,radius:radius/100,points:[point(e)]};strokes.current.push(current.current);setCount(strokes.current.length);render();
    }} onPointerMove={e=>{if(current.current){
      if(current.current.points.length>=120)current.current.points=current.current.points.filter((_,i)=>i%2===0);
      current.current.points.push(point(e));render();
    }}} onPointerUp={()=>{current.current=null;}} onPointerCancel={()=>{current.current=null;}}/></div>
    {error&&<p role="alert">{error}</p>}<div className="work-controls"><small>淡色原图用于定位已去除的部分。</small><span className="work-spacer"/><button className="quiet-button" onClick={cancel}>取消修边</button><button className="primary-button" disabled={!ready||!count} onClick={()=>apply(strokes.current)}>应用修边</button></div></div>;
}
