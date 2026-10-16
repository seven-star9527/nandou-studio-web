import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { agentRequest, type AgentSettings } from '../agent-api';
import Icon from './Icon';

const MODELS = [['gpt-image-2.5-flare', 'GPT Image 2.5 Flare'], ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'], ['gemini-nano-banana-2.1', 'Nano Banana 2.1']];
const RATIOS = ['auto', '1:1', '3:4', '16:9', '4:3', '9:16', '2:3', '3:2', '21:9'];

export default function AgentPreferences({ value, update, disabled, close }: {value: AgentSettings; update: (value: Partial<AgentSettings>) => void; disabled: boolean; close: () => void}) {
  const [memory, setMemory] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(480);
  useLayoutEffect(() => {
    const resize = () => setAvailableHeight(Math.max(160, (panel.current?.parentElement?.getBoundingClientRect().top ?? 504) - 24));
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => { let alive = true; void agentRequest<{text:string}>('memory').then(v => {if (alive) {setMemory(v.text); setLoaded(true);}}).catch(e => {if (alive) setNotice(e.message);}); return () => {alive = false;}; }, []);
  useEffect(() => { const key = (e: KeyboardEvent) => {if (e.key === 'Escape') close();}; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [close]);
  const save = async (text: string) => {setSaving(true); setNotice(''); try {await agentRequest('memory', {text}); setMemory(text); setNotice(text ? '偏好已保存，后续对话会参考。' : '长期偏好已清空。');} catch(e) {setNotice(e instanceof Error ? e.message : '保存失败');} finally {setSaving(false);} };
  return <div className="agent-preferences" ref={panel} role="dialog" aria-label="生成偏好" style={{maxHeight: availableHeight}}>
    <header><strong>生成偏好</strong><button type="button" className="icon-button" aria-label="关闭生成偏好" onClick={close}><Icon name="close" size={17}/></button></header>
    <div className="agent-preference-type"><Icon name="image" size={17}/><span>图片</span><small>偏好随当前账号草稿保存</small></div>
    <fieldset disabled={disabled}><legend>选择比例</legend><div className="agent-ratio-choices" role="group" aria-label="生成比例">{RATIOS.map(r => { const [w,h] = r.split(':').map(Number); const aspect = w/h; return <button key={r} type="button" aria-pressed={value.ratio === r} className={value.ratio === r ? 'selected' : ''} onClick={() => update({ratio:r})}>{r === 'auto' ? <Icon name="expand" size={17}/> : <i style={{width:aspect>=1?18:18*aspect,height:aspect<=1?18:18/aspect}}/>}<span>{r === 'auto' ? '智能' : r}</span></button>;})}</div><p className="agent-preference-note">智能仅按需求选择比例，画质与分辨率保持下方设置。</p></fieldset>
    <fieldset disabled={disabled}><legend>出图规格</legend><label className="agent-model-select">生图模型<select value={value.model} onChange={e=>update({model:e.target.value})}>{MODELS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><div className="agent-preference-grid">
      <label>图像质量<select value={value.quality} disabled={value.model.startsWith('gemini')} onChange={e=>update({quality:e.target.value})}>{[['low','低'],['medium','中 · 默认'],['high','高'],['xhigh','超高']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>分辨率<select value={value.resolution} onChange={e=>update({resolution:e.target.value})}>{['1K','2K','4K'].map(r=><option key={r}>{r}</option>)}</select></label>
      <label>生成数量<select value={value.count} onChange={e=>update({count:e.target.value})}><option value="auto">跟随需求 · 默认1张</option>{['1','2','3','4'].map(n=><option key={n} value={n}>{n} 张</option>)}</select></label>
    </div></fieldset>
    <fieldset disabled={disabled}><legend>创作方向</legend><div className="agent-preference-grid">
      <label>使用平台<select value={value.platform} onChange={e=>update({platform:e.target.value})}>{[['auto','按需求'],['amazon','Amazon'],['store','独立站']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>图片用途<select value={value.scene} onChange={e=>update({scene:e.target.value})}>{[['auto','按需求'],['main','白底主图'],['detail','材质 / 结构细节'],['lifestyle','使用场景'],['aplus','A+ / 卖点图'],['hero','独立站横幅']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>视觉风格<select value={value.style} onChange={e=>update({style:e.target.value})}>{[['natural','自然商业摄影'],['studio','干净棚拍'],['minimal','简洁视觉'],['creative','创意概念']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    </div></fieldset>
    <details className="agent-memory-editor"><summary>我的长期偏好 <small>手动保存 · 仅当前账号</small></summary><p>可保存品牌风格、常用品类、文案语言和禁用元素。当前需求优先，不会自动记下每次聊天。</p><textarea aria-label="长期偏好" maxLength={4000} disabled={!loaded || saving} rows={4} value={memory} onChange={e=>setMemory(e.target.value)} placeholder="例如：主要制作艺术用品的 Amazon 商品图；商品保持全新干净；默认英文文案，不添加促销角标。"/><div><button type="button" disabled={!loaded || saving} onClick={()=>void save(memory)}>{saving ? '保存中…' : '保存偏好'}</button><button type="button" disabled={!loaded || saving || !memory} onClick={()=>void save('')}>清空</button></div><p role="status">{notice}</p></details>
  </div>;
}
