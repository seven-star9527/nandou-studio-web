import { useEffect, useRef, useState, type PointerEvent } from 'react';
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
  const [zoomTarget,setZoomTarget]=useState(false), [zoomed,setZoomed]=useState(false);
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
  function point(e:PointerEvent<HTMLCanvasElement>):[number,number] {
    const rect=e.currentTarget.getBoundingClientRect();
    const bound=(n:number)=>Math.min(1,Math.max(0,n));
    const area=crop.current;
    return [area.x+area.size*bound((e.clientX-rect.left)/rect.width),area.y+area.size*bound((e.clientY-rect.top)/rect.height)];
  }
  return <div className="mask-editor"><div className="work-controls">{!heal && <GlassTabs className="segmented work-tabs" aria-label="修边画笔">
    <button className={mode==='keep'?'selected':''} onClick={()=>setMode('keep')}>恢复主体</button><button className={mode==='erase'?'selected':''} onClick={()=>setMode('erase')}>擦除背景</button></GlassTabs>}
    <button className="quiet-button" aria-pressed={zoomTarget||zoomed} onClick={()=>{
      if(zoomed){crop.current={x:0,y:0,size:1};setZoomed(false);render();}
      else setZoomTarget(!zoomTarget);
    }}>{zoomed?'查看全图':zoomTarget?'点击要放大的位置':'放大局部'}</button>
    <label>笔刷大小 <input type="range" min=".2" max="10" step=".2" value={radius} onChange={e=>setRadius(Number(e.target.value))}/></label>
    <button className="quiet-button" disabled={!count} onClick={()=>{strokes.current.pop();setCount(strokes.current.length);render();}}>撤销一笔</button></div>
    <div className="mask-stage work-preview checker"><canvas ref={canvas} aria-label={heal?"标记需要去除的污点":"在原图位置涂抹修正蒙版"} onPointerDown={e=>{
      if(!ready||e.button!==0)return;
      if(zoomTarget){
        const [x,y]=point(e),size=.25;
        crop.current={x:Math.max(0,Math.min(1-size,x-size/2)),y:Math.max(0,Math.min(1-size,y-size/2)),size};
        setZoomTarget(false);setZoomed(true);render();return;
      }
      if(strokes.current.length>=200){setError('本次已达 200 笔，请先应用修边后继续。');return;}
      e.currentTarget.setPointerCapture(e.pointerId);
      current.current={mode:heal?'heal':mode,radius:radius/100,points:[point(e)]};strokes.current.push(current.current);setCount(strokes.current.length);render();
    }} onPointerMove={e=>{if(current.current){
      if(current.current.points.length>=120)current.current.points=current.current.points.filter((_,i)=>i%2===0);
      current.current.points.push(point(e));render();
    }}} onPointerUp={()=>{current.current=null;}} onPointerCancel={()=>{current.current=null;}}/></div>
    {error&&<p role="alert">{error}</p>}<div className="work-controls"><small>{heal?'点选或涂过灰尘、污点，笔刷略大于瑕疵即可。':'淡色原图用于定位已去除的部分。'}</small><span className="work-spacer"/><button className="quiet-button" onClick={cancel}>{heal?'取消':'取消修边'}</button><button className="primary-button" disabled={!ready||!count} onClick={()=>apply(strokes.current)}>{heal?'修复标记区域':'应用修边'}</button></div></div>;
}
