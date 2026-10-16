import type { RatioId, ResolutionId } from './types.ts';

export const RATIOS: { id: RatioId; label: string; ratio: number }[] = [
  { id: 'smart', label: '智能', ratio: 1 },
  { id: '1:1', label: '1:1', ratio: 1 }, { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 }, { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 }, { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 }, { id: '21:9', label: '21:9', ratio: 21 / 9 },
];
export const RESOLUTIONS: { id: ResolutionId; side: number }[] = [
  { id: '1K', side: 1024 }, { id: '1.5K', side: 1536 }, { id: '2K', side: 2048 },
];
export const snap32 = (value: number) => Math.max(64, Math.round(value / 32) * 32);

// K labels are area-equivalent squares. Every request includes actual pixels.
export function dimensions(ratio: RatioId, resolution: ResolutionId, reference?: { width: number; height: number }) {
  const r = ratio === 'smart' && reference
    ? reference.width / reference.height
    : RATIOS.find(item => item.id === ratio)?.ratio ?? 1;
  const side = RESOLUTIONS.find(item => item.id === resolution)?.side ?? 1024;
  return { width: snap32(side * Math.sqrt(r)), height: snap32(side / Math.sqrt(r)) };
}
export function megapixels(width: number, height: number) { return (width * height / 1_000_000).toFixed(2); }
