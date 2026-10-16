import { createId } from '../id';
import { useEffect, useRef, useState } from 'react';
import type { ScenePreset } from '../types';
import { useModalDialog } from '../useModalDialog';
import Icon from './Icon';
import ModalPortal from './ModalPortal';
import { accountStorageKey } from '../account-storage';

const STORAGE_KEY = 'qwen-studio.scenes.v1';
const DEFAULT_SCENES: ScenePreset[] = [
  { id: 'product', name: '产品摄影', icon: 'flower', prompt: '一张高品质产品摄影，主体为【填写产品】，以干净完好的新售商品状态展示，放置在整洁的浅色背景上，柔和的侧面自然光，真实材质、接触阴影与自然景深，干净构图。保留商品实际外观，不添加使用痕迹、污渍、磨损或做旧。' },
  { id: 'poster', name: '海报设计', icon: 'poster', prompt: '设计一张【填写主题】海报，主标题为「【填写标题】」，配色为【填写配色】，视觉层次清晰，中文文字准确可读，留白得当。' },
  { id: 'background', name: '背景替换', icon: 'image', prompt: '保持参考图中主体的形状、颜色和材质不变，将背景替换为【填写背景场景】，使光线与透视自然一致。' },
  { id: 'illustration', name: '插画创作', icon: 'brush', prompt: '创作一幅【填写主题】插画，采用【填写画风】，色彩协调，构图清晰，画面包含【填写主体与环境】。' },
];
function readScenes(): ScenePreset[] {
  try {
    const saved = localStorage.getItem(accountStorageKey(STORAGE_KEY));
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.prompt === 'string' && ['flower', 'poster', 'image', 'brush'].includes(item.icon))
        .map(item => item.id === 'product' && item.prompt === '一张高品质产品摄影，主体为【填写产品】，放置在简洁的浅色背景上，柔和的侧面自然光，真实材质与细节，干净构图。' ? DEFAULT_SCENES[0] : item);
    }
  } catch { /* Local storage may be unavailable. Presets still work in memory. */ }
  return DEFAULT_SCENES;
}

export default function ScenePresets({ currentPrompt, apply }: { currentPrompt: string; apply: (prompt: string) => void }) {
  const [scenes, setScenes] = useState(readScenes);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [storageError, setStorageError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(open, dialog, () => setOpen(false));
  useEffect(() => {
    try { localStorage.setItem(accountStorageKey(STORAGE_KEY), JSON.stringify(scenes)); setStorageError(''); }
    catch { setStorageError('浏览器无法保存场景；当前页面内仍可使用。'); }
  }, [scenes]);
  const create = () => { setEditing(null); setName(''); setPrompt(currentPrompt); setOpen(true); };
  const edit = (scene: ScenePreset) => { setEditing(scene.id); setName(scene.name); setPrompt(scene.prompt); };
  const save = () => {
    if (!name.trim() || !prompt.trim()) return;
    const next: ScenePreset = { id: editing ?? createId(), name: name.trim(), prompt: prompt.trim(), icon: 'brush' };
    setScenes(previous => editing ? previous.map(scene => scene.id === editing ? { ...scene, name: next.name, prompt: next.prompt } : scene) : [...previous, next]);
    setOpen(false);
  };
  return <>
    <div className="scene-presets" aria-label="场景提示词">
      {scenes.map(scene => <button className="scene-chip" key={scene.id} onClick={() => apply(scene.prompt)} title={scene.prompt}><Icon name={scene.icon} size={18} /><span>{scene.name}</span></button>)}
      <button className="scene-add" onClick={create}><Icon name="plus" size={15} /><span>新建场景</span></button>
    </div>
    {storageError ? <p className="scene-storage-note">{storageError}</p> : null}
    {open ? <ModalPortal><div className="modal-backdrop" onClick={() => setOpen(false)}>
      <section ref={dialog} tabIndex={-1} className="scene-dialog modal" role="dialog" aria-modal="true" aria-label="场景提示词管理" onClick={event => event.stopPropagation()}>
        <div className="modal-heading"><h2>{editing ? '编辑场景' : '新建场景'}</h2><button className="icon-button" onClick={() => setOpen(false)} aria-label="关闭场景管理"><Icon name="close" /></button></div>
        <label className="form-field">场景名称<input data-autofocus maxLength={20} placeholder="例如：极简产品主图" value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="form-field">提示词<textarea rows={4} placeholder="填写可重复使用的场景要求…" value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
        <button className="primary-button" onClick={save} disabled={!name.trim() || !prompt.trim()}>保存场景</button>
        <div className="scene-manager"><p>已保存场景</p>{scenes.map(scene => <div className="scene-manager-row" key={scene.id}><button onClick={() => edit(scene)}>{scene.name}</button><button className="icon-button" title="删除场景" aria-label={`删除场景 ${scene.name}`} onClick={() => setScenes(previous => previous.filter(item => item.id !== scene.id))}><Icon name="trash" size={15} /></button></div>)}</div>
      </section>
    </div></ModalPortal> : null}
  </>;
}
