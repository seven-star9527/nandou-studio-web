import GlassTabs from './GlassTabs';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { megapixels, RATIOS, RESOLUTIONS, snap32 } from '../resolution-policy';
import type { CloudModelCapability, DeploymentConfig, GenerationSettings, RatioId, ResolutionId } from '../types';
import Icon from './Icon';

function navigateChoices(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'));
  const current = choices.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !choices.length) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
    : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
  choices[index].click(); choices[index].focus();
}

export default function ParameterPanel({ settings, config, cloudModel, setGeometry, update, close }: {
  settings: GenerationSettings; config: DeploymentConfig;
  cloudModel?: CloudModelCapability;
  setGeometry: (ratio: RatioId, resolution: ResolutionId) => void;
  update: (changes: Partial<GenerationSettings>) => void; close: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const position = () => {
      const element = panel.current;
      if (!element || window.innerWidth <= 680) return;
      const anchor = element.parentElement!.getBoundingClientRect();
      const left = Math.max(20, Math.min(anchor.right - 90, window.innerWidth - element.offsetWidth - 25));
      element.style.left = `${left - anchor.left}px`;
      element.style.right = 'auto';
      element.style.setProperty('--pointer-left', `${Math.max(18, Math.min(element.offsetWidth - 35, anchor.right - left - 45))}px`);
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, []);
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [close]);
  const custom = (key: 'width' | 'height', value: string) => {
    const number = Number(value);
    const multiple = cloudModel?.exactSize?.multiple ?? 32;
    if (Number.isFinite(number) && number > 0) update({ [key]: cloudModel ? Math.max(multiple, Math.round(number / multiple) * multiple) : snap32(number), ratio: 'custom' });
  };
  const ratioOptions = cloudModel ? cloudModel.ratios.map(id => {
    const [w, h] = id.split(':').map(Number);
    return { id, label: id === 'auto' ? '智能' : id, ratio: w > 0 && h > 0 ? w / h : 1 };
  }) : RATIOS;
  const resolutionOptions = cloudModel ? cloudModel.resolutions.map(id => ({ id })) : RESOLUTIONS;
  const allowsCustom = !cloudModel || cloudModel.exactSize?.supported;
  const knownSize = settings.width > 0 && settings.height > 0;
  const capability = (id: ResolutionId) => config.resolutions?.[id] ?? (id === '1K'
    ? { status: 'available' as const }
    : { status: 'experimental' as const, detail: '此分辨率尚未完成本机速度与稳定性测试。' });
  return <motion.div data-motion-layer initial={{opacity:0,y:12,scale:.94}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:8,scale:.97}} transition={{duration:reduced?0:.32,ease:[.22,1,.36,1]}} className="parameter-panel popover" ref={panel} role="dialog" aria-label="图像尺寸与数量">
    <button className="icon-button panel-close" onClick={close} aria-label="关闭尺寸设置"><Icon name="close" size={16} /></button>
    <fieldset>
      <legend>选择比例</legend>
      <GlassTabs className={`ratios ${ratioOptions.length > 9 ? 'ratios-many' : ''}`} role="radiogroup" aria-label="选择比例" onKeyDown={navigateChoices}>
        {ratioOptions.map(item => <button key={item.id} role="radio" tabIndex={settings.ratio === item.id ? 0 : -1} aria-checked={settings.ratio === item.id} className={settings.ratio === item.id ? 'selected' : ''}
          title={item.id === 'smart' ? '跟随首张参考图的比例，无参考图时为1:1' : item.id === 'auto' ? '由服务选择比例，生成后读取实际像素' : undefined}
          onClick={() => setGeometry(item.id, settings.resolution)}>
          {['smart', 'auto'].includes(item.id) ? <Icon name="expand" size={17} /> : <span className="ratio-shape" style={{ width: item.ratio >= 1 ? 18 : 18 * item.ratio, height: item.ratio <= 1 ? 18 : 18 / item.ratio }} />}
          <span>{item.label}</span>
        </button>)}
      </GlassTabs>
    </fieldset>
    <fieldset>
      <legend>选择分辨率</legend>
      <GlassTabs className="segmented resolution-options" role="radiogroup" aria-label="选择分辨率" onKeyDown={navigateChoices}>
        {resolutionOptions.map(item => <button key={item.id} role="radio" tabIndex={settings.resolution === item.id ? 0 : -1} aria-checked={settings.resolution === item.id} className={settings.resolution === item.id ? 'selected' : ''}
          disabled={!cloudModel && capability(item.id).status === 'disabled'} onClick={() => setGeometry(settings.ratio === 'custom' ? ratioOptions.find(ratio => ratio.id === '1:1')?.id ?? ratioOptions[0].id : settings.ratio, item.id)}>
          {item.id}{!cloudModel && capability(item.id).status === 'experimental' ? <small>待实测</small> : null}
        </button>)}
      </GlassTabs>
    </fieldset>
    <fieldset>
      <legend>生成数量</legend>
      <GlassTabs className="segmented" role="radiogroup" aria-label="生成数量" onKeyDown={navigateChoices}>
        {Array.from({ length: cloudModel?.maxImages ?? 4 }, (_, index) => index + 1).map(count => <button key={count} role="radio" tabIndex={settings.count === count ? 0 : -1} aria-checked={settings.count === count} className={settings.count === count ? 'selected' : ''} onClick={() => update({ count })}>{count}</button>)}
      </GlassTabs>
    </fieldset>
    <fieldset>
      <legend>尺寸</legend>
      <div className="dimensions">
        <label><span>W</span><input aria-label="图像宽度" type="number" min="1" step={cloudModel?.exactSize?.multiple ?? 32} readOnly={!allowsCustom} key={`w-${settings.width}-${cloudModel?.id}`} defaultValue={knownSize ? settings.width : ''} placeholder="服务决定" onBlur={event => { if (allowsCustom) custom('width', event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        <Icon name="link" size={18} />
        <label><span>H</span><input aria-label="图像高度" type="number" min="1" step={cloudModel?.exactSize?.multiple ?? 32} readOnly={!allowsCustom} key={`h-${settings.height}-${cloudModel?.id}`} defaultValue={knownSize ? settings.height : ''} placeholder="服务决定" onBlur={event => { if (allowsCustom) custom('height', event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><span>PX</span>
      </div>
    </fieldset>
    <p className="panel-note">{knownSize ? `${megapixels(settings.width, settings.height)} MP · ${cloudModel ? settings.ratio === 'custom' ? `尺寸按 ${cloudModel.exactSize?.multiple} 像素对齐` : '服务预设尺寸' : '尺寸按 32 像素对齐'}` : '尺寸由服务决定，生成后显示真实像素。'}</p>
    {!cloudModel && capability(settings.resolution).detail ? <p className="panel-note resolution-detail">{capability(settings.resolution).detail}</p> : null}
  </motion.div>;
}
