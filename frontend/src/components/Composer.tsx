import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { availableModes } from '../generation-contract';
import { referenceLimit } from '../cloud-contract';
import type { CloudModelCapability, CloudQuote, DeploymentConfig, GenerationSettings, Model, ParamSchema, RatioId, ReferenceImage, ResolutionId } from '../types';
import Icon from './Icon';
import ParameterPanel from './ParameterPanel';
import GenerationQuote from './GenerationQuote';
import ReferenceDock from './ReferenceDock';
import type { ReactNode } from 'react';

const modelDescriptions: Record<string, string> = {
  original: '本地生成与参考图编辑，适合细节对照和精修',
  official_turbo: '本地快速生成与参考图编辑，适合试构图、改提示词',
  'gemini-nano-banana-2.1': '多样风格与高分辨率输出，适合商品场景创意',
  'gpt-image-2.5-flare': '图像生成与编辑，适合商品场景和广告创意',
  'gpt-image-2.5-sunburst': '参考图编辑优先，适合保留商品后调整场景',
};

export default function Composer({ settings, config, params, models, prompt, references, editing, setEditing, setPrompt, update,
  setGeometry, addReferences, removeReference, selectModel, selectLocal, selectCloud, cloudModel, cloudModels, cloudConfigured, cloudCapabilityError, creditQuote, polisher, generate, busy, ready }: {
  settings: GenerationSettings; config: DeploymentConfig; params: ParamSchema[]; models: Model[];
  prompt: string; references: ReferenceImage[]; editing: boolean;
  setEditing: (value: boolean) => void; setPrompt: (value: string) => void;
  update: (changes: Partial<GenerationSettings>) => void;
  setGeometry: (ratio: RatioId, resolution: ResolutionId) => void;
  addReferences: (files: FileList | File[]) => Promise<void>; removeReference: (id: string) => void;
  selectModel: (model: string) => void; generate: () => void; busy: boolean; ready: boolean;
  selectLocal: () => void; selectCloud: (id: string) => void; cloudModel?: CloudModelCapability; cloudModels: CloudModelCapability[]; cloudConfigured: boolean; cloudCapabilityError: string;
  creditQuote: { quote: CloudQuote | null; loading: boolean; error: string };
  polisher: ReactNode;
}) {
  const [panel, setPanel] = useState<'size' | 'mode' | 'model' | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const quoteDescriptionId = useId();
  const closePanel = useCallback(() => setPanel(null), []);
  const modes = availableModes(models, config);
  const mode = modes.find(item => item.model === settings.model);
  const ratioLabel = ['smart', 'auto'].includes(settings.ratio) ? '智能' : settings.ratio === 'custom' ? '自定义' : settings.ratio;
  const maxReferences = cloudModel ? referenceLimit(cloudModel) : config.maxReferences ?? 3;
  const steps = params.find(param => param.id === 'steps');
  const cfg = params.find(param => param.id === 'cfgscale');

  useLayoutEffect(() => {
    const resize = () => {
      const input = promptInput.current;
      if (!input) return;
      const style = getComputedStyle(input);
      input.style.height = '0px';
      input.style.height = `${Math.max(parseFloat(style.minHeight) || 84, Math.min(parseFloat(style.maxHeight) || 220, input.scrollHeight))}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [prompt]);

  useEffect(() => {
    if (!panel) return;
    const pointer = (event: PointerEvent) => { if (!composer.current?.contains(event.target as Node)) setPanel(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); };
  }, [panel]);

  const chooseFiles = async (files: FileList | File[]) => { if (files.length) setEditing(true); await addReferences(files); };
  const submit = () => { setPanel(null); generate(); };

  return <>
    <div className="creation-tabs segmented" role="tablist" aria-label="创作方式">
      <button role="tab" aria-selected={!editing} disabled={Boolean(cloudModel && !cloudModel.operations.includes('generate'))} className={!editing ? 'selected' : ''} onClick={() => setEditing(false)}>图片生成</button>
      <button role="tab" aria-selected={editing} disabled={Boolean(cloudModel && !cloudModel.operations.includes('edit'))} className={editing ? 'selected' : ''} onClick={() => setEditing(true)}>参考图编辑</button>
    </div>
    <div className={`composer ${dragging ? 'is-dragging' : ''}`} ref={composer}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void chooseFiles(event.dataTransfer.files); }}>
      <div className="prompt-row">
        <ReferenceDock references={editing ? references : []} add={() => fileInput.current?.click()} remove={removeReference} maxReferences={maxReferences} />
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { if (event.target.files) void chooseFiles(event.target.files); event.target.value = ''; }} />
        <div className="prompt-content">
          <textarea ref={promptInput} aria-label="图像提示词" value={prompt} onChange={event => setPrompt(event.target.value)}
            placeholder={editing ? '上传参考图，描述你希望进行的修改…' : '描述你想生成的画面，或上传参考图进行编辑…'}
            onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy && ready) submit(); }} />
        </div>
      </div>
      <div className="composer-toolbar">
        <div className="toolbar-controls">
          <div className="control-anchor">
            <button className={`toolbar-button ${panel === 'model' ? 'active' : ''}`} aria-expanded={panel === 'model'} onClick={() => setPanel(panel === 'model' ? null : 'model')} title={modelDescriptions[cloudModel?.id ?? mode?.id ?? ''] ?? '选择图像模型'}>
              <Icon name="cube" size={18} /><span className="model-name">{cloudModel?.label ?? `Qwen-Image-2.1 · ${mode?.label ?? '本地'}`}</span><Icon name="chevron" size={13} />
            </button>
            {panel === 'model' ? <div className="model-panel popover" role="dialog" aria-label="选择模型">
              <p className="popover-heading">选择模型</p>
              {!modes.length ? <button className={`model-option ${!cloudModel ? 'selected' : ''}`} onClick={() => { selectLocal(); setPanel(null); }}><span><strong>Qwen-Image-2.1 · 本地</strong><small>模型准备中</small></span>{!cloudModel ? <Icon name="check" size={17} /> : null}</button> : null}
              {modes.length ? modes.map(item => <button key={item.id} className={`model-option ${!cloudModel && item.model === settings.model ? 'selected' : ''}`} onClick={() => { selectModel(item.model); setPanel(null); }}>
                <span><strong>Qwen-Image-2.1 · {item.label}</strong><small>{modelDescriptions[item.id] ?? modelDescriptions.original}</small></span>{!cloudModel && item.model === settings.model ? <Icon name="check" size={17} /> : null}
              </button>) : <p className="panel-note">服务尚未发现 Qwen-Image-2.1 模型。</p>}
              {cloudModels.map(item => <button key={item.id} className={`model-option ${item.id === cloudModel?.id ? 'selected' : ''}`} onClick={() => { selectCloud(item.id); setPanel(null); }}><span><strong>{item.label}</strong><small>{modelDescriptions[item.id] ?? '图像生成与参考图编辑'}{cloudConfigured ? '' : ' · 待配置'}</small></span>{item.id === cloudModel?.id ? <Icon name="check" size={17} /> : null}</button>)}
              {cloudCapabilityError ? <p className="panel-note">云模型能力读取失败，请刷新连接。</p> : null}
            </div> : null}
          </div>
          <div className="control-anchor">
            <button className={`toolbar-button ${panel === 'mode' ? 'active' : ''}`} aria-expanded={panel === 'mode'} onClick={() => setPanel(panel === 'mode' ? null : 'mode')}>
              <Icon name="settings" size={18} /><span>{cloudModel ? '图像质量' : mode?.label ?? '标准'}</span><Icon name="chevron" size={13} />
            </button>
            {panel === 'mode' ? <div className="mode-panel popover" role="dialog" aria-label="生成模式">
              {cloudModel ? <><p className="popover-heading">图像质量</p>{cloudModel.qualities.length ? <div className="segmented mode-options">{cloudModel.qualities.map(quality => <button key={quality} className={settings.quality === quality ? 'selected' : ''} onClick={() => update({ quality })}>{({ auto: '自动', low: '低', medium: '中', high: '高' } as Record<string, string>)[quality] ?? quality}</button>)}</div> : <p className="panel-note">当前模型未提供可选质量参数。</p>}{cloudModel.id.startsWith('gpt-image-2.5-') ? <p className="panel-note">默认中档（medium）；高与 xhigh 需手动选择，分辨率变化不会提高档位。</p> : null}<p className="panel-note">参考图：{cloudModel.maxReferences == null ? `服务未声明固定上限，界面上限 ${maxReferences} 张` : `最多 ${maxReferences} 张`}。</p></> : <>
              <p className="popover-heading">生成模式</p>
              <div className="segmented mode-options">{modes.map(item => <button key={item.id} className={item.model === settings.model ? 'selected' : ''} onClick={() => selectModel(item.model)}>{item.label}</button>)}</div>
              {mode?.detail ? <p className="panel-note">{mode.detail}</p> : null}
              <div className="advanced-fields">
                <label>采样步数<input type="number" min={steps?.min ?? 1} max={steps?.max ?? 200} value={settings.steps} onChange={event => update({ steps: Number(event.target.value) })} /></label>
                <label>提示词引导<input type="number" min={cfg?.min ?? 0} max={cfg?.max ?? 100} step="0.1" value={settings.cfg} onChange={event => update({ cfg: Number(event.target.value) })} /></label>
                <label className="seed-field">种子<span><input inputMode="numeric" value={settings.seed} onChange={event => update({ seed: event.target.value })} /><button className="icon-button" title="随机种子" aria-label="设为随机种子" onClick={() => update({ seed: '-1' })}><Icon name="refresh" size={16} /></button></span></label>
              </div>
              <p className="panel-note">种子 -1 为随机；固定种子便于比较。</p>
              </>}
            </div> : null}
          </div>
          <div className="control-anchor size-anchor">
            <button className={`toolbar-button size-button ${panel === 'size' ? 'active' : ''}`} aria-expanded={panel === 'size'} onClick={() => setPanel(panel === 'size' ? null : 'size')}>
              <Icon name="expand" size={17} /><span>{ratioLabel}<span className="control-dot">·</span>{settings.resolution}<span className="control-dot">·</span>{settings.count} 张</span><Icon name="chevron" size={13} />
            </button>
            {panel === 'size' ? <ParameterPanel settings={settings} config={config} cloudModel={cloudModel} update={update} setGeometry={setGeometry} close={closePanel} /> : null}
          </div>
        </div>
        <div className="generation-actions"><GenerationQuote local={!cloudModel} quote={creditQuote.quote} loading={creditQuote.loading} error={creditQuote.error} descriptionId={quoteDescriptionId} />
        {polisher}
        <button className="generate-button" onClick={submit} disabled={!ready || busy || !prompt.trim() || (editing && !references.length)} title={busy ? '正在生成' : '生成图像 · Ctrl / ⌘ + Enter'} aria-label={busy ? '生成中' : '生成图像'} aria-describedby={quoteDescriptionId}>
          <Icon name={busy ? 'spark' : 'arrow'} size={22} className={busy ? 'spinning' : 'send-arrow'} />
        </button>
        </div>
      </div>
    </div>
  </>;
}
