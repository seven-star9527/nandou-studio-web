import { AUTH_REQUIRED_EVENT } from './auth';
import { agentRequest } from './agent-api';
import { checkImageBatch } from './image-upload-limits';
import { readReferenceImage } from './task-references';

export interface WorkImage { url: string; name: string; width?: number; height?: number }
export const toolNames = {cutout: '透明底抠图', retouch: '主图精修', upscale: '高清放大'};
export type QuickTool = keyof typeof toolNames;
export interface SubjectMark { x:number; y:number; mode:'keep'|'remove' }
export interface QuickJob {
  id: string; source: string; include?: [number,number][]; marks?:SubjectMark[]; tool: QuickTool; option: string;
  status: 'processing' | 'completed' | 'failed'; error?: string; result?: WorkImage; subject?:string | null;
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

export async function uploadBoardVideo(file: File) {
  if (!['video/mp4', 'video/webm'].includes(file.type)) throw new Error('请选择 MP4 或 WebM 视频。');
  if (file.size > 100 * 1024 * 1024) throw new Error('单个视频不能超过 100 MB。');
  const response = await fetch('/studio-agent/workbench/board-video?name=' + encodeURIComponent(file.name), {
    method: 'POST', credentials: 'same-origin', headers: {'Content-Type': file.type}, body: file,
  });
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '视频上传失败，请检查格式和服务。');
  }
  return await response.json() as WorkImage & {kind:'video'};
}
