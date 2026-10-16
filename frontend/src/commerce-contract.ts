export interface CommerceOption { id: string; label: string; rules: string; }
export interface CommerceCatalog { platforms: CommerceOption[]; categories: CommerceOption[]; scenes: CommerceOption[]; sources: { title: string; url: string }[]; }
export interface PolishCapabilities { configured: boolean; model: string; commerce: CommerceCatalog; provider: 'deepseek'; image_upload: false; }
export interface PolishInput { prompt: string; facts: string; platform: string; category: string; scene: string; reference_count: number; width: number; height: number; }
export interface PolishResult { prompt: string; changes: string[]; missing_facts: string[]; warnings: string[]; model: string; provider_model?: string; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; }

export function polishIdentity(input: PolishInput, model: string, referenceIds: string): string {
  return JSON.stringify([input, model, referenceIds]);
}

export function validPolishResult(value: PolishResult): boolean {
  return Boolean(typeof value.prompt === 'string' && value.prompt.trim() && value.prompt.length <= 12000
    && [value.changes, value.missing_facts, value.warnings].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))
    && value.model === 'deepseek-flash');
}
