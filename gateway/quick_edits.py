"""Fixed, local product photo recipes. The source is never overwritten."""
import asyncio
import tempfile
from pathlib import Path
from functools import lru_cache
from threading import Lock
import os

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps
from .image_uploads import MAX_IMAGE_PIXELS

RECIPES = {'cutout': ('transparent',), 'retouch': ('brush', 'paint', 'toy'), 'upscale': ('2', '4')}


def retouch_settings(option):
    if not isinstance(option,str):
        raise ValueError('invalid retouch settings')
    parts = option.split('|')
    if len(parts)==1:
        parts += ['original','0']
    if len(parts)!=3 or parts[0] not in RECIPES['retouch'] or parts[1] not in ('original','white') or parts[2] not in ('-0.5','0','0.5'):
        raise ValueError('invalid retouch settings')
    return parts[0],parts[1],float(parts[2])


def upright(path):
    with Image.open(path) as source:
        if source.width * source.height > MAX_IMAGE_PIXELS:
            raise ValueError('原图超过像素上限。')
        return ImageOps.exif_transpose(source).convert('RGBA')


def retouch_or_enlarge(source, output, tool, option):
    image = upright(source)
    if tool == 'upscale':
        factor = int(option)
        size = (image.width * factor, image.height * factor)
        if size[0] * size[1] > MAX_IMAGE_PIXELS:
            raise ValueError('放大后超过 6400 万像素，请降低倍率。')
        result = image.resize(size, Image.Resampling.LANCZOS)
    else:
        # Adjust luminance only. Preserve original chroma, markings and alpha.
        option,background,ev = retouch_settings(option)
        rgb = image.convert('RGB')
        brightness = rgb.convert('L')
        adjusted = ImageEnhance.Contrast(brightness).enhance({'brush': 1.035, 'paint': 1.012, 'toy': 1.025}[option])
        sharpen = {'brush': 70, 'paint': 30, 'toy': 45}[option]
        adjusted = adjusted.filter(ImageFilter.UnsharpMask(radius=0.9, percent=sharpen, threshold=3))
        if ev:
            # An exposure adjustment with fixed black/white endpoints protects highlights.
            gain = 2**ev
            adjusted = adjusted.point([round(255 * gain * v / (255 + (gain-1)*v)) for v in range(256)])
        # Apply the luminance difference equally to RGB, avoiding a lossy YCbCr round trip.
        lighter = ImageChops.subtract(adjusted, brightness)
        darker = ImageChops.subtract(brightness, adjusted)
        channels = [ImageChops.subtract(ImageChops.add(channel, lighter), darker) for channel in rgb.split()]
        result = Image.merge('RGBA', (*channels, image.getchannel('A')))
        if background == 'white':
            result = Image.alpha_composite(Image.new('RGBA',result.size,'white'),result).convert('RGB')
    result.save(output, format='PNG', icc_profile=image.info.get('icc_profile'))


def correct_mask(source, base, output, strokes):
    original = upright(source)
    with Image.open(base) as image:
        alpha = image.getchannel('A')
    if alpha.size != original.size:
        raise ValueError('蒙版尺寸与原图不一致。')
    w, h = alpha.size
    draw = ImageDraw.Draw(alpha)
    for stroke in strokes:
        points = [(round(x*(w-1)),round(y*(h-1))) for x,y in stroke['points']]
        radius = max(1,round(stroke['radius']*min(w,h)))
        fill = 255 if stroke['mode']=='keep' else 0
        if len(points)>1:
            draw.line(points, fill=fill, width=2*radius, joint='curve')
        for x,y in (points[0],points[-1]):
            draw.ellipse((x-radius,y-radius,x+radius,y+radius), fill=fill)
    alpha = ImageChops.darker(alpha, original.getchannel('A'))
    if alpha.getbbox() is None:
        raise ValueError('蒙版移除了整个主体，请撤销后重新调整。')
    original.putalpha(alpha)
    original.save(output, format='PNG', icc_profile=original.info.get('icc_profile'))


async def product_retouch(model_path, source, output, option):
    _, background, _ = retouch_settings(option)
    if background=='white':
        def has_cutout():
            im = upright(source)
            return im.getchannel('A').getextrema()[0] < 16
        if not await asyncio.to_thread(has_cutout):
            with tempfile.TemporaryDirectory(dir=output.parent) as folder:
                transparent = Path(folder)/'subject.png'
                await cutout(model_path,source,transparent)
                await asyncio.to_thread(retouch_or_enlarge,transparent,output,'retouch',option)
            return
    await asyncio.to_thread(retouch_or_enlarge,source,output,'retouch',option)


# The desktop CPU session is shared across users. Only original pixels leave this function.
_inference_lock = Lock()


@lru_cache(maxsize=1)
def subject_session(model_path):
    if not model_path.is_file():
        raise ValueError('缺少本机抠图模型 birefnet-general-lite.onnx，请配置后重试。')
    import onnxruntime as ort
    settings = ort.SessionOptions()
    settings.intra_op_num_threads = min(8, os.cpu_count() or 1)
    return ort.InferenceSession(str(model_path), settings, providers=['CPUExecutionProvider'])


def segment_subject(model_path, source, output):
    import numpy as np
    original = upright(source)
    source_alpha = original.getchannel('A')
    # Use a neutral backdrop at inference time so hidden RGB cannot influence the subject.
    visible = Image.alpha_composite(Image.new('RGBA', original.size, 'white'), original)
    rgb = visible.convert('RGB').resize((1024, 1024), Image.Resampling.LANCZOS)
    tensor = np.asarray(rgb, dtype=np.float32)
    tensor /= max(float(tensor.max()), 1)
    tensor -= np.array([.485, .456, .406], dtype=np.float32)
    tensor /= np.array([.229, .224, .225], dtype=np.float32)
    with _inference_lock:
        session = subject_session(model_path)
        logits = session.run([session.get_outputs()[0].name], {
            session.get_inputs()[0].name: tensor.transpose(2, 0, 1)[None]
        })[0].squeeze()
    probability = 1 / (1 + np.exp(-np.clip(logits, -60, 60)))
    if probability.max() < .85 or probability.min() > .15:
        raise ValueError('未能可靠区分商品和背景，请换一张主体更清楚的图片。')
    mask = Image.fromarray(np.rint(probability * 255).astype('uint8'))
    alpha = ImageChops.darker(source_alpha, mask.resize(original.size, Image.Resampling.LANCZOS))
    if alpha.getextrema()[1] < 128:
        raise ValueError('未识别到可见商品。')
    original.putalpha(alpha)
    original.save(output, format='PNG', icc_profile=original.info.get('icc_profile'))


async def cutout(model_path, source, output):
    await asyncio.to_thread(segment_subject, model_path, source, output)
