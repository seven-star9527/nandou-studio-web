import { agentRequest } from './agent-api';
import { checkImageBatch } from './image-upload-limits';
import { readReferenceImage } from './task-references';

export interface WorkImage { url: string; name: string; width?: number; height?: number }
export const toolNames = {cutout: '透明底抠图', retouch: '主图精修', upscale: '高清放大'};
export type QuickTool = keyof typeof toolNames;
export interface QuickJob {
  id: string; source: string; tool: QuickTool; option: string;
  status: 'processing' | 'completed' | 'failed'; error?: string; result?: WorkImage;
}

export function workRequest<T>(path: string, data?: object, signal?: AbortSignal) {
  return agentRequest<T>('workbench/' + path, data, signal);
}

export async function uploadImage(file: File) {
  checkImageBatch([file], []);
  const image = await readReferenceImage(file);
  return workRequest<WorkImage>('upload', {name: file.name, data_url: image.dataUrl});
}

export function ownImageUrl(url: string) {
  return /^\/(View|Output|studio-results|studio-agent\/assets|studio-agent\/workbench\/media)\//.test(url);
}
