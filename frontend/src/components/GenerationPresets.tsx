import { useRef, useState } from 'react';
import type { useStudio } from '../useStudio';
import type { GenerationSettings } from '../types';
import { useModalDialog } from '../useModalDialog';
import ModalPortal from './ModalPortal';
import Icon from './Icon';

export type PresetControls = ReturnType<typeof useStudio>['presetControls'];
type Controls = PresetControls;
export default function GenerationPresets({controls, settings, modelLabel}: {controls: Controls; settings: GenerationSettings; modelLabel: string}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const close = () => setOpen(false);
  useModalDialog(open, dialog, close);
  return <>
    <button type="button" className="toolbar-button" onClick={() => setOpen(true)} aria-haspopup="dialog" title="保存或使用生图配置"><Icon name="layers" size={16}/><span>我的配置</span></button>
    {open && <ModalPortal><div className="modal-backdrop" onClick={close}>
      <section ref={dialog} className="scene-dialog modal generation-presets" tabIndex={-1} role="dialog" aria-modal="true" aria-label="我的生图配置" onClick={e => e.stopPropagation()}>
        <div className="modal-heading"><h2>我的生图配置</h2><button type="button" className="icon-button" aria-label="关闭配置" onClick={close}><Icon name="close"/></button></div>
        <PresetManager controls={controls} settings={settings} modelLabel={modelLabel} afterApply={close}/>
      </section>
    </div></ModalPortal>}
  </>;
}

export function PresetManager({controls, settings, modelLabel, agent, afterApply}: {controls: Controls; settings: GenerationSettings; modelLabel: string; agent?: boolean; afterApply?: () => void}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const perform = async (action: () => void | Promise<void>) => {
    setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作未完成，请重试。'); }
  };
  const save = () => perform(async () => {
    await controls.change({action: 'save', name: name.trim(), cloudModel: controls.cloudModelId, settings});
    setName('');
  });
  return <>
        <p className="panel-note">当前：{modelLabel} · {settings.outputFormat === 'gif' ? `GIF · ${settings.gifWidth ?? 512}×${settings.gifHeight ?? 512}` : `${settings.outputFormat === 'svg' ? 'SVG · ' : ''}${settings.ratio === 'custom' ? settings.width+'×'+settings.height : settings.ratio} · ${settings.resolution}`} · {settings.count} 张</p>
        <div className="preset-save">
          <label className="form-field">配置名称<input maxLength={32} value={name} placeholder="例如：商品主图" onChange={e => setName(e.target.value)} onKeyDown={e => {if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.closest('.preset-save')?.querySelector('button')?.click(); }}} /></label>
          <button type="button" className="toolbar-button" onClick={() => void save()} disabled={!name.trim() || !controls.initialized || controls.busy || !!controls.error || controls.presets.length >= 5}>保存当前参数</button>
        </div>
        <div className="scene-manager">
          <p>已保存 {controls.presets.length} / 5{!controls.presets.length && ' · 第一套将作为默认配置'}</p>
          {controls.presets.map((entry, i) => <div key={entry.id} className="scene-manager-row">
            <button type="button" disabled={controls.busy || (agent && !entry.cloudModel)} title={`使用 ${entry.name}`} onClick={() => void perform(() => { controls.apply(entry); afterApply?.(); })}>{entry.name}{agent && !entry.cloudModel && ' · 仅图片创作可用'}</button>
            {i === 0 ? <span className="preset-default">默认</span> : <button type="button" className="quiet-button" disabled={controls.busy || (agent && !entry.cloudModel)} aria-label={`将 ${entry.name} 设为默认`} onClick={() => void perform(() => controls.change({action:'default', id:entry.id}))}>设为默认</button>}
            <button type="button" className="icon-button" disabled={controls.busy} aria-label={`删除配置 ${entry.name}`} onClick={() => void perform(() => controls.change({action:'delete', id:entry.id}))}><Icon name="trash" size={15}/></button>
          </div>)}
        </div>
        {(error || controls.error) && <p role="alert">{error || controls.error} <button type="button" className="quiet-button" onClick={() => void perform(controls.read)}>刷新配置</button></p>}
  </>;
}
