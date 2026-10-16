import type { DeploymentConfig, GenerationSettings, Model, ModeConfig, ParamMap, ParamSchema, ReferenceImage } from './types.ts';

export function availableModes(models: Model[], config: DeploymentConfig): (ModeConfig & { model: string })[] {
  const qwen = models.filter(model => /qwen.*image.*2[._-]?1/i.test(`${model.name} ${model.architecture}`));
  if (config.modes?.length) {
    return config.modes.flatMap(mode => {
      const model = qwen.find(item => mode.model ? item.name === mode.model : mode.modelMatch && item.name.toLowerCase().includes(mode.modelMatch.toLowerCase()));
      return model ? [{ ...mode, model: model.name }] : [];
    });
  }
  return qwen.map(model => ({ id: model.name, model: model.name, label: /turbo/i.test(model.name) ? 'Turbo' : '标准' }));
}

export function modelDefaults(model: string, config: DeploymentConfig): ParamMap {
  const mode = config.modes?.find(item => item.model === model || (item.modelMatch && model.toLowerCase().includes(item.modelMatch.toLowerCase())));
  return { ...config.defaults, ...config.modelDefaults?.[model], ...mode?.defaults };
}

function parameterIssue(candidate: ParamMap, params: ParamSchema[]): string {
  const schema = new Map(params.map(param => [param.id, param]));
  for (const [id, value] of Object.entries(candidate)) {
    if (id === 'extra_metadata') continue;
    const definition = schema.get(id);
    if (!definition) return `服务参数列表未提供 ${id}，请刷新连接或检查部署配置。`;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return `${definition.name} 不是有效数字。`;
      if (definition.min != null && value < definition.min) return `${definition.name} 不能小于 ${definition.min}。`;
      if (definition.max != null && value > definition.max) return `${definition.name} 不能超过 ${definition.max}。`;
    }
    if (definition.type === 'dropdown' && typeof value === 'string' && definition.values?.length
      && !definition.values.some(option => option.split('///')[0] === value)) {
      return `服务尚不支持 ${definition.name} 的配置值“${value}”，请刷新连接。`;
    }
  }
  return '';
}

export function configurationIssue(model: string, params: ParamSchema[], config: DeploymentConfig): string {
  return model ? parameterIssue(modelDefaults(model, config), params) : '';
}

export function buildGenerationRequest(settings: GenerationSettings, prompt: string, references: ReferenceImage[], params: ParamSchema[], config: DeploymentConfig): ParamMap {
  const schema = new Map(params.map(param => [param.id, param]));
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('请先描述你想生成的画面。');
  if (!settings.model) throw new Error('没有可用的 Qwen-Image-2.1 模型。');
  if (!Number.isSafeInteger(Number(settings.seed)) || Number(settings.seed) < -1) throw new Error('种子需为 -1 或安全范围内的非负整数。');
  if (![settings.width, settings.height].every(value => Number.isInteger(value) && value >= 64 && value % 32 === 0)) throw new Error('宽高需为至少64像素的32倍数。');
  if (config.maxDimension && Math.max(settings.width, settings.height) > config.maxDimension) throw new Error(`当前配置允许的最长边为 ${config.maxDimension}px。`);
  if (settings.count < 1 || settings.count > 4 || !Number.isInteger(settings.count)) throw new Error('生成数量需为1至4张。');
  if (references.length > (config.maxReferences ?? 3)) throw new Error(`最多添加 ${config.maxReferences ?? 3} 张参考图。`);
  const candidate: ParamMap = {
    ...modelDefaults(settings.model, config), prompt: trimmed, model: settings.model,
    images: settings.count, width: settings.width, height: settings.height,
    aspectratio: 'Custom', steps: settings.steps, cfgscale: settings.cfg, seed: Number(settings.seed),
  };
  if (schema.has('batchsize')) candidate.batchsize = 1;
  if (references.length) candidate.promptimages = references.map(image => image.dataUrl);
  candidate.extra_metadata = {
    studio_resolution_policy: 'square_area_snap32',
    studio_requested_ratio: settings.ratio,
    studio_requested_resolution: settings.resolution,
    studio_reference_dimensions: JSON.stringify(references.map((image, index) => ({ index: index + 1, original_width: image.width, original_height: image.height }))),
  };
  const issue = parameterIssue(candidate, params);
  if (issue) throw new Error(issue);
  return candidate;
}
