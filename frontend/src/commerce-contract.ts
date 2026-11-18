export interface CommerceOption { id: string; label: string; rules: string; }
export interface CommerceCatalog { platforms: CommerceOption[]; categories: CommerceOption[]; scenes: CommerceOption[]; sources: { title: string; url: string }[]; }
export interface PolishCapabilities { configured: boolean; model: string; commerce: CommerceCatalog; provider: 'deepseek'; image_upload: boolean; scopes?: ('general' | 'commerce')[]; }
export interface PolishInput { scope?: 'general' | 'commerce'; prompt: string; facts: string; platform: string; category: string; scene: string; reference_count: number; width: number; height: number; aspect_ratio?: string; request_id?: string; reference_images?: string[]; }
export interface PolishResult { prompt: string; changes: string[]; missing_facts: string[]; warnings: string[]; blocking_questions?: string[]; model: string; provider_model?: string; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; }

/** Ignore reference tokens; count CJK characters and Latin words, not bytes. */
export function needsAutoPolish(prompt: string): boolean {
  const text = prompt.replace(/【参考图\d+】|⟦ref:[^⟧]+⟧/g, '').trim();
  if (!text || /(?:不要|无需|不用|禁止)(?:自动)?润色|(?:do not|don't) (?:rewrite|polish)/i.test(text)) return false;
  const units = text.match(/[\u3400-\u9fff]|[\p{L}\p{N}]+/gu) ?? [];
  return units.length < 80;
}

export function polishIdentity(input: PolishInput, model: string, referenceIds: string): string {
  return JSON.stringify([input, model, referenceIds]);
}

export function validPolishResult(value: PolishResult): boolean {
  return Boolean(typeof value.prompt === 'string' && value.prompt.trim() && value.prompt.length <= 12000
    && [value.changes, value.missing_facts, value.warnings].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))
    && (value.blocking_questions === undefined || Array.isArray(value.blocking_questions) && value.blocking_questions.every(item => typeof item === 'string'))
    && value.model === 'deepseek-flash');
}
