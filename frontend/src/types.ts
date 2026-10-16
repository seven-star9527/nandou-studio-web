export type ParamValue = string | number | boolean | string[] | Record<string, string>;
export type ParamMap = Record<string, ParamValue>;
export interface ParamSchema {
  id: string; name: string; type: string; default: string;
  min?: number; max?: number; step?: number; values?: string[];
}
export interface Model { name: string; architecture?: string; title?: string; }
export interface ReferenceImage { id: string; name: string; dataUrl: string; width: number; height: number; }
export type RatioId = string;
export type ResolutionId = string;
export interface GenerationSettings {
  ratio: RatioId; resolution: ResolutionId; width: number; height: number;
  count: number; model: string; steps: number; cfg: number; seed: string; quality?: string;
}
export interface ModeConfig {
  id: string; label: string; model?: string; modelMatch?: string;
  defaults?: ParamMap; detail?: string;
}
export interface DeploymentConfig {
  modelDefaults?: Record<string, ParamMap>;
  defaults?: ParamMap;
  modes?: ModeConfig[];
  maxReferences?: number;
  maxDimension?: number;
  resolutions?: Partial<Record<ResolutionId, { status: 'available' | 'experimental' | 'disabled'; detail?: string }>>;
}
export interface BackendStatus {
  status?: { waiting_gens: number; loading_models: number; waiting_backends: number; live_gens: number };
  backend_status?: { status: string; class: string; message: string; any_loading: boolean };
  supported_features?: string[];
  studio_queue?: StudioQueue | null;
  studio_task?: StudioTaskSnapshot | null;
}
export interface StudioTaskSnapshot {
  task_id: string; status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  requested: number; completed: number; created_utc: string; started_utc?: string | null; model?: string;
}
export interface StudioQueue {
  task_id: string; ahead: number; position: number; total: number; waited_seconds: number;
  estimated_wait_seconds: number | null; estimate_samples: number; state: 'queued' | 'running'; initial_ahead: number;
  requested?: number; completed?: number; created_utc?: string; started_utc?: string | null; model?: string;
}
export interface GenerationMessage extends BackendStatus {
  error?: string; error_id?: string;
  gen_progress?: { batch_index: string; overall_percent: number; current_percent: number; preview?: string };
  image?: string; batch_index?: string; request_id?: string; metadata?: string;
  discard_indices?: number[]; socket_intention?: string;
  studio_task_id?: string; studio_owner_id?: string; studio_owner_email?: string;
  studio_cancelled?: boolean;
}
export interface Artwork {
  id: string; url: string; prompt: string; width?: number; height?: number;
  seed?: string; model?: string; steps?: number; metadata?: string;
  generatedAt?: string; duration?: number; current?: boolean; batchIndex?: number;
  source?: 'local' | 'cloud';
  locallySaved?: boolean; downloadError?: string; mimeType?: string;
  taskCreditsCost?: number; taskCostSettled?: boolean;
  taskId?: string; ownerId?: string; ownerEmail?: string; hiddenAt?: string;
}
export interface Job {
  id: string; started: number; requested: number; completed: number;
  phase: 'connecting' | 'queued' | 'loading' | 'generating' | 'stopping' | 'complete' | 'error' | 'interrupted' | 'background' | 'unknown' | 'delivery_pending';
  percent?: number; preview?: string; error?: string;
  progressBatch?: number; progressStage?: 'sampling' | 'finalizing';
  source?: 'local' | 'cloud';
  taskCreditsCost?: number; taskCostSettled?: boolean;
  queue?: StudioQueue; restored?: boolean; model?: string;
}
export interface ScenePreset { id: string; name: string; prompt: string; icon: 'flower' | 'poster' | 'image' | 'brush'; }
export type CloudOperation = 'generate' | 'edit';
export interface CloudModelCapability {
  id: string; label: string; operations: CloudOperation[]; preferredOperation: CloudOperation;
  ratios: string[]; resolutions: string[]; sizeMap: Record<string, Record<string, [number, number] | null>>;
  maxReferences: number | null; appMaxReferences: number; maxImages: number; qualities: string[];
  exactSize: { supported: boolean; multiple: number; maxSide: number; minPixels: number; maxPixels: number; maxAspect: number } | null;
}
export interface CloudCapabilities { provider: 'apimart'; configured: boolean; models: CloudModelCapability[]; localReadiness?: Record<string, boolean>; }
export interface CloudAccount {
  configured: boolean; state: 'ready' | 'partial' | 'unavailable' | 'not_configured';
  remaining_credits: number | null; account_credits: number | null; token_credits: number | null;
  token_unlimited: boolean; checked_utc: string; error?: string;
}
export interface CloudQuoteRequest { model: string; size: string; resolution: string; quality?: string; n: number; }
export interface CloudQuote {
  model: string; kind: 'output_reference' | 'precharge_reference' | 'unknown';
  credits_per_image: number | null; min_credits_per_image: number | null; max_credits_per_image: number | null;
  credits_total_reference: number | null; source: string; captured_at: string | null; stale: boolean;
  label: string; additional_input_cost_unknown: boolean;
}
export interface CloudRequest {
  request_id: string; model: string; operation: CloudOperation; prompt: string; size: string;
  resolution: string; n: number; quality?: string; reference_images: string[];
}
export interface CloudTask {
  request_id: string; status: 'uploading' | 'submitting' | 'submitted' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  progress?: number; images: { url: string; remote_url?: string; width?: number; height?: number; index: number; mime_type?: string; download_error?: string }[];
  delivery_status?: 'complete' | 'partial' | 'cache_pending'; delivered_images?: number; provider_status?: string | null;
  operation?: CloudOperation; reference_count?: number;
  poll_error?: string; result_warning?: string;
  error?: string; model: string; prompt: string; parameters: Record<string, unknown>; cost?: unknown; credits_cost?: number | null; created_utc: string;
  studio_task_id?: string; studio_owner_id?: string; studio_owner_email?: string; studio_hidden_at?: string;
}
export interface PromptTemplate {
  id: string; title: string; category: string; description: string; prompt: string; tags: string[];
  operations: CloudOperation[]; minReferences: number; recommended: { ratio: string; resolution: string; model?: string };
  sources: { title: string; url: string }[]; steps?: string[];
}
