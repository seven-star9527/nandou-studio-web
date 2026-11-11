export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 200 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64_000_000;
export const IMAGE_UPLOAD_HINT = `每张 50MB、${MAX_IMAGE_PIXELS / 10000} 万像素以内；新上传合计不超过 200MB`;

export function inlineImageBytes(value: string): number {
  if (!value.startsWith('data:image/')) return 0;
  const length = value.length - value.indexOf(',') - 1;
  return Math.floor(length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

export function checkImageUpload(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请使用 JPG、PNG 或 WebP 图片。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 50MB。');
}

export function checkImageBatch(files: File[], existing: string[]) {
  files.forEach(checkImageUpload);
  if (files.reduce((sum, file) => sum + file.size, 0) + existing.reduce((sum, value) => sum + inlineImageBytes(value), 0) > MAX_IMAGE_BATCH_BYTES) throw new Error('本次新上传图片合计不能超过 200MB，请分批添加。');
}
