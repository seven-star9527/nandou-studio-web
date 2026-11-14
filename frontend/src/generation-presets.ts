import type { GenerationSettings } from './types';

export type GenerationPreset = { id: string; name: string; cloudModel: string | null; settings: GenerationSettings };
export type PresetChange = {action: 'save'; name: string; cloudModel: string | null; settings: GenerationSettings}
  | {action: 'default' | 'delete'; id: string};

export async function requestPresets(account: string, change?: PresetChange): Promise<GenerationPreset[]> {
  const response = await fetch('/studio-auth/generation-presets', change ? {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account, ...change}),
  } : {cache: 'no-store'});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '配置请求失败，请重试。');
  if (data.account !== account || !Array.isArray(data.presets)) throw new Error('账号或配置已变更，请刷新页面。');
  return data.presets;
}
