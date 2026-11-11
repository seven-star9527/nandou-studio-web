"""Bounded original uploads and separate references for generation providers."""
import base64
import io
import math
import re
import shutil
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_IMAGE_BATCH_BYTES = 200 * 1024 * 1024
MAX_IMAGE_PIXELS = 64_000_000
MAX_DATA_URL_CHARS = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 64
DATA_URL = re.compile(r'data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+')


class ImageUploadError(ValueError):
    """Safe, actionable validation messages for HTTP and WebSocket clients."""
    def __init__(self, message, code='invalid_image'):
        super().__init__(message)
        self.code = code


def upload_size(raw):
    if not isinstance(raw, str) or len(raw) > MAX_DATA_URL_CHARS or not DATA_URL.fullmatch(raw):
        raise ImageUploadError('图片须为 JPG、PNG 或 WebP，单张不能超过 50MB。', 'invalid_image_upload')
    encoded = raw.partition(',')[2].replace('\r', '').replace('\n', '')
    padding = encoded.find('=')
    if len(encoded) % 4 or (padding >= 0 and (len(encoded) - padding > 2 or encoded[padding:] not in {'=', '=='})):
        raise ImageUploadError('图片编码无效，请重新选择原文件。', 'invalid_image_encoding')
    size = len(encoded) * 3 // 4 - (2 if encoded.endswith('==') else 1 if encoded.endswith('=') else 0)
    if size > MAX_IMAGE_BYTES:
        raise ImageUploadError('单张图片不能超过 50MB。', 'image_size_limit')
    return size


def check_upload_batch(values):
    if sum(upload_size(value) for value in values) > MAX_IMAGE_BATCH_BYTES:
        raise ImageUploadError('本次新上传图片合计不能超过 200MB，请分批添加。', 'image_batch_limit')


def original_image_bytes(raw):
    upload_size(raw)
    encoded = raw.partition(',')[2].replace('\r', '').replace('\n', '')
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ImageUploadError('图片编码无效，请重新选择原文件。', 'invalid_image_encoding') from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageUploadError('单张图片不能超过 50MB。', 'image_size_limit')
    try:
        with Image.open(io.BytesIO(data)) as image:
            # MPO frame zero is the primary photograph; auxiliary frames are not animation.
            image.seek(0)
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ImageUploadError(f'图片主图为 {image.width} × {image.height}，超过 {MAX_IMAGE_PIXELS // 10000} 万像素，请缩小后上传。', 'image_pixel_limit')
            if image.format != 'MPO' and getattr(image, 'n_frames', 1) != 1:
                raise ImageUploadError('暂不支持动画或多帧 PNG/WebP，请上传静态图片。', 'animated_image_unsupported')
            extension = {'PNG': '.png', 'JPEG': '.jpg', 'MPO': '.jpg', 'WEBP': '.webp'}.get(image.format)
            if not extension:
                raise ImageUploadError('图片格式不支持，请使用 JPG、PNG 或 WebP。', 'unsupported_image_format')
            if image.format == 'MPO':
                image.load()
            else:
                image.verify()
        return data, extension
    except ImageUploadError:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError, SyntaxError) as exc:
        raise ImageUploadError('图片内容损坏或无法解码，请重新导出原文件。', 'invalid_image_content') from exc


def copy_processing_input(source, target):
    """Keep the stored original immutable; editors receive a lossless primary frame."""
    source, target = Path(source), Path(target)
    if source.suffix.lower() in {'.jpg', '.jpeg', '.mpo'}:
        with Image.open(source) as image:
            if image.format == 'MPO':
                image.seek(0)
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise ImageUploadError(f'图片主图超过 {MAX_IMAGE_PIXELS // 10000} 万像素。', 'image_pixel_limit')
                primary = ImageOps.exif_transpose(image).convert('RGB')
                target = target.with_suffix('.png')
                primary.save(target, format='PNG', icc_profile=image.info.get('icc_profile'))
                return target
    shutil.copyfile(source, target)
    return target


def generation_references(values, *, max_pixels=None):
    """Keep originals untouched; large references fit the existing Swarm 20MiB/32MP contract."""
    result = []
    for raw in values:
        data, _ = original_image_bytes(raw)
        with Image.open(io.BytesIO(data)) as image:
            image.seek(0)
            if (image.format != 'MPO' and len(data) <= 20 * 1024 * 1024
                    and image.width * image.height <= 32_000_000
                    and (max_pixels is None or image.width * image.height <= max_pixels)):
                result.append(raw)
                continue
            if len(data) > 20 * 1024 * 1024 or image.width * image.height > 32_000_000:
                image.thumbnail((2048, 2048))
            preview = ImageOps.exif_transpose(image)
            if max_pixels is not None and preview.width * preview.height > max_pixels:
                scale = math.sqrt(max_pixels / (preview.width * preview.height))
                preview.thumbnail((max(1, int(preview.width * scale)), max(1, int(preview.height * scale))))
            transparent = 'A' in preview.getbands() or 'transparency' in preview.info
            preview = preview.convert('RGBA' if transparent else 'RGB')
            output = io.BytesIO()
            preview.save(output, format='PNG' if transparent else 'JPEG', icc_profile=image.info.get('icc_profile'),
                         **({} if transparent else {'quality': 94}))
            if image.format == 'MPO' and output.tell() > 20 * 1024 * 1024:
                preview.thumbnail((2048, 2048))
                output = io.BytesIO()
                preview.save(output, format='JPEG', quality=94, icc_profile=image.info.get('icc_profile'))
            mime = 'png' if transparent else 'jpeg'
            result.append(f'data:image/{mime};base64,' + base64.b64encode(output.getvalue()).decode())
    return result
