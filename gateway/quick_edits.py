"""Fixed, local product photo recipes. The source is never overwritten."""
import asyncio
import tempfile
import shutil
from pathlib import Path
from functools import lru_cache
from threading import Lock
import os
from math import isqrt

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
from .photocraft import PhotoCraft
from .image_uploads import MAX_IMAGE_PIXELS

RECIPES = {'cutout': ('transparent',), 'retouch': ('brush', 'paint', 'toy'), 'upscale': ('2', '4', 'fit')}


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


def upscale_size(width, height, option):
    if option == 'fit':
        size = (min(4*width, isqrt(MAX_IMAGE_PIXELS*width//height)),
                min(4*height, isqrt(MAX_IMAGE_PIXELS*height//width)))
    else:
        size = (width*int(option), height*int(option))
    if size[0]*size[1] > MAX_IMAGE_PIXELS or size == (width,height):
        raise ValueError('当前尺寸无法按所选倍率放大，单次输出上限为 6400 万像素。')
    return size


def retouch_color(rgb, option, ev):
    brightness = rgb.convert('L')
    # Anchor black and white and restrict local contrast around fine labels and nibs.
    contrast, sharpness, limit = {'brush': (.12, 65, 4), 'paint': (.06, 35, 2),
                                 'toy': (.10, 50, 3)}[option]
    tone = brightness.point([round(v + contrast * (v - 127.5) * (1 - abs(v / 127.5 - 1)))
                             for v in range(256)])
    detail = tone.filter(ImageFilter.UnsharpMask(radius=.85, percent=sharpness, threshold=3))
    bounded = [min(i, limit) for i in range(256)]
    plus = ImageChops.subtract(detail, tone).point(bounded)
    minus = ImageChops.subtract(tone, detail).point(bounded)
    adjusted = ImageChops.subtract(ImageChops.add(tone, plus), minus)
    if ev:
        # An exposure adjustment with fixed black/white endpoints protects highlights.
        gain = 2**ev
        adjusted = adjusted.point([round(255 * gain * v / (255 + (gain-1)*v)) for v in range(256)])
    # Apply the luminance difference equally to RGB, avoiding a lossy YCbCr round trip.
    lighter = ImageChops.subtract(adjusted, brightness)
    darker = ImageChops.subtract(brightness, adjusted)
    channels = rgb.split()
    # Limit the shift for the whole pixel so saturated pigments keep their channel differences.
    brightest = ImageChops.lighter(ImageChops.lighter(channels[0],channels[1]),channels[2])
    darkest = ImageChops.darker(ImageChops.darker(channels[0],channels[1]),channels[2])
    lighter = ImageChops.darker(lighter, ImageOps.invert(brightest))
    darker = ImageChops.darker(darker, darkest)
    channels = [ImageChops.subtract(ImageChops.add(channel, lighter), darker) for channel in channels]
    return Image.merge('RGB', channels)


def retouch_or_enlarge(source, output, tool, option):
    image = upright(source)
    if tool == 'upscale':
        size = upscale_size(image.width,image.height,option)
        result = image.resize(size, Image.Resampling.LANCZOS)
    else:
        # Adjust luminance only. Preserve original chroma, markings and alpha.
        option,background,ev = retouch_settings(option)
        result = Image.new('RGB' if background=='white' else 'RGBA',image.size,'white')
        for y in range(0,image.height,768):
            for x in range(0,image.width,768):
                right,bottom=min(x+768,image.width),min(y+768,image.height)
                # Include neighboring pixels for the 0.85px unsharp mask on each tile boundary.
                left,top=max(0,x-8),max(0,y-8)
                tile=image.crop((left,top,min(image.width,right+8),min(image.height,bottom+8)))
                polished=retouch_color(tile.convert('RGB'),option,ev)
                inner=(x-left,y-top,right-left,bottom-top)
                pixels=polished.crop(inner)
                alpha=tile.getchannel('A').crop(inner)
                if background=='white':
                    result.paste(pixels,(x,y),alpha)
                else:
                    pixels.putalpha(alpha)
                    result.paste(pixels,(x,y))
    result.save(output, format='PNG', icc_profile=image.info.get('icc_profile'))


async def heal_product_spots(executable, base, output, strokes):
    """Use the user's marks on the last retouched version, keeping other pixels exact."""
    if not executable or not Path(executable).is_file():
        raise ValueError('本机尚未配置 PhotoCraft，无法使用局部去瑕。')
    with tempfile.TemporaryDirectory(dir=output.parent) as folder:
        workspace = Path(folder)
        local = workspace / 'base.png'
        await asyncio.to_thread(shutil.copyfile, base, local)
        with Image.open(local) as image:
            w, h = image.size
        steps = []
        for stroke in strokes:
            points = [[round(x*(w-1)), round(y*(h-1))] for x,y in stroke['points']]
            steps.append({'id':'paint.spotHealing','params':{'points':points,
                          'size':min(5000,max(1,round(2*stroke['radius']*min(w,h)))),
                          'type':'proximityMatch'}})
        async with PhotoCraft(executable,workspace,timeout=180) as engine:
            await engine.call('doc_open',path=str(local))
            for step in steps:
                await engine.call('command_run',**step)
            await engine.call('doc_save',path=str(workspace/'healed.png'))

        def compose():
            with Image.open(local) as original, Image.open(workspace/'healed.png') as rendered:
                if rendered.size != original.size:
                    raise ValueError('修复尺寸与原图不一致。')
                mask = Image.new('L',(w,h))
                draw = ImageDraw.Draw(mask)
                for step in steps:
                    points = [tuple(p) for p in step['params']['points']]
                    diameter = step['params']['size']
                    if len(points)>1:
                        draw.line(points,fill=255,width=diameter,joint='curve')
                    for x,y in (points[0],points[-1]):
                        radius=diameter/2
                        draw.ellipse((x-radius,y-radius,x+radius,y+radius),fill=255)
                result = original.copy()
                result.paste(rendered.convert(original.mode),mask=mask)
                if 'A' in original.getbands():
                    result.putalpha(original.getchannel('A'))
                result.save(output,format='PNG',icc_profile=original.info.get('icc_profile'))
        await asyncio.to_thread(compose)


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


def refine_edges(original, coarse):
    """Fit the soft mask to full-resolution luminance locally, with overlapping tiles."""
    import numpy as np
    guide = original.convert('L')
    result = coarse.copy()
    radius = max(2, min(12,round(max(original.size)/700)))
    kernel = 2*radius+1

    def mean(values):
        for axis in (0,1):
            pad = [(0,0),(0,0)]
            pad[axis] = (radius+1,radius)
            sums = np.pad(values,pad,mode='edge').cumsum(axis=axis,dtype=np.float64)
            values = ((sums[kernel:]-sums[:-kernel]) if axis==0 else
                      (sums[:,kernel:]-sums[:,:-kernel])) / kernel
        return values

    for y in range(0,guide.height,640):
        for x in range(0,guide.width,640):
            right, bottom = min(x+640,guide.width), min(y+640,guide.height)
            box = (max(0,x-2*radius),max(0,y-2*radius),
                   min(guide.width,right+2*radius),min(guide.height,bottom+2*radius))
            tile = coarse.crop(box)
            if tile.getextrema() in ((0,0),(255,255)):
                continue
            luma = np.asarray(guide.crop(box),dtype=np.float32)/255
            alpha = np.asarray(tile,dtype=np.float32)/255
            light, opacity = mean(luma),mean(alpha)
            variance = np.maximum(0,mean(luma*luma)-light*light)
            slope = (mean(luma*alpha)-light*opacity)/(variance+.0016)
            refined = mean(slope)*luma + mean(opacity-slope*light)
            # A low-contrast surface gives little edge evidence; keep the existing matte there.
            weight = variance/(variance+.0016)
            pixels = np.uint8(np.rint(np.clip(alpha+weight*(refined-alpha),0,1)*255))
            dx,dy = x-box[0],y-box[1]
            result.paste(Image.fromarray(pixels[dy:dy+bottom-y,dx:dx+right-x]),(x,y))
    return result


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
    coarse = mask.resize(original.size, Image.Resampling.LANCZOS)
    alpha = ImageChops.darker(source_alpha, refine_edges(original, coarse))
    if alpha.getextrema()[1] < 128:
        raise ValueError('未识别到可见商品。')
    original.putalpha(alpha)
    original.save(output, format='PNG', icc_profile=original.info.get('icc_profile'))


async def cutout(model_path, source, output):
    await asyncio.to_thread(segment_subject, model_path, source, output)
