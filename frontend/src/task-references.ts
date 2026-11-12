import { createId } from './id';
import { checkImageBatch, MAX_IMAGE_PIXELS } from './image-upload-limits';
import type { ReferenceImage } from './types';

interface SavedReference { index: number; width: number; height: number; url: string }

export async function listTaskReferences(taskId: string, signal: AbortSignal): Promise<SavedReference[]> {
  const response = await fetch('/studio-auth/tasks/references', { method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) });
  if (!response.ok) throw new Error('参考原图读取失败，请重新打开详情后再试。');
  const { references } = await response.json();
  if (!Array.isArray(references) || !references.every((item, i) => item?.index === i + 1 &&
    ['jpg', 'png', 'webp'].some(ext => item.url === `/studio-references/${taskId}/${i + 1}.${ext}`))) {
    throw new Error('参考原图记录格式不正确。');
  }
  return references;
}

export function readReferenceImage(file: File) {
  return new Promise<ReferenceImage>((resolve, reject) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { reject(new Error('参考图支持 PNG、JPEG 和 WebP。')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败。`));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error(`${file.name} 不是可读取的图像。`));
      image.onload = () => {
        if (image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) { reject(new Error(`这张图片为 ${image.naturalWidth} × ${image.naturalHeight}，超过 ${MAX_IMAGE_PIXELS / 10000} 万像素，请缩小后上传。`)); return; }
        resolve({ id: createId(), name: file.name, dataUrl: String(reader.result), width: image.naturalWidth, height: image.naturalHeight });
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export async function loadStudioImage(url: string, name: string) {
  const response = await fetch(url, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('图片读取失败，请重新打开后再试。');
  const blob = await response.blob();
  const file = new File([blob], name, { type: blob.type });
  checkImageBatch([file], []);
  return readReferenceImage(file);
}

export async function restoreTaskReferences(taskId: string, signal: AbortSignal) {
  const entries = await listTaskReferences(taskId, signal);
  const references: ReferenceImage[] = [];
  for (const { index, url } of entries) {
    const response = await fetch(url, { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal });
    if (!response.ok) throw new Error(`参考原图 ${index} 读取失败，请重试。`);
    const blob = await response.blob();
    const file = new File([blob], `参考图 ${index}.${url.split('.').pop()}`, { type: blob.type });
    checkImageBatch([file], references.map(item => item.dataUrl));
    references.push(await readReferenceImage(file));
  }
  return references;
}
