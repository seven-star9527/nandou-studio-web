"""Fixed, local product photo recipes. The source is never overwritten."""
import asyncio
import tempfile
from pathlib import Path

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


def protect_white_background_details(original, alpha):
    # On nearly uniform white studio backgrounds, disconnected dark bristles and
    # ferrules still provide foreground evidence even if the subject selector missed them.
    sample = original.convert('RGB').resize((96,96),Image.Resampling.BOX)
    edges = [(0,0,96,1),(0,95,96,96),(0,0,1,96),(95,0,96,96)]
    white = sum(sum(min(pixel)>=248 for pixel in sample.crop(box).get_flattened_data()) for box in edges)
    if white < 0.98 * 384:
        return alpha
    r,g,b = original.convert('RGB').split()
    darkest = ImageChops.darker(r,ImageChops.darker(g,b))
    evidence = darkest.point([max(0,min(255,(245-value)*5)) for value in range(256)])
    return ImageChops.darker(original.getchannel('A'),ImageChops.lighter(alpha,evidence))


async def product_retouch(editing, source, output, option):
    _, background, _ = retouch_settings(option)
    if background=='white':
        def has_cutout():
            im = upright(source)
            return im.getchannel('A').getextrema()[0] < 16
        if not await asyncio.to_thread(has_cutout):
            with tempfile.TemporaryDirectory(dir=output.parent) as folder:
                transparent = Path(folder)/'subject.png'
                await cutout(editing,source,transparent)
                await asyncio.to_thread(retouch_or_enlarge,transparent,output,'retouch',option)
            return
    await asyncio.to_thread(retouch_or_enlarge,source,output,'retouch',option)


async def cutout(editing, source, output):
    with tempfile.TemporaryDirectory(dir=output.parent) as scratch:
        folder = Path(scratch)
        prepared, exported = folder / 'source.png', folder / 'result.png'
        def prepare():
            im = upright(source)
            im.save(prepared, format='PNG')
            return im.size
        size = await asyncio.to_thread(prepare)
        async with editing.connection(folder) as mcp:
            await mcp.call('doc_open', path=str(prepared))
            await mcp.call('command_run', id='layer.removeBackground', params={'refine': True})
            await mcp.call('doc_save', path=str(exported))
        def verify():
            with Image.open(exported) as result:
                if result.size != size or 'A' not in result.getbands():
                    raise ValueError('未取得原尺寸透明图，请换一张背景更清楚的原图。')
                low, high = result.getchannel('A').getextrema()
                if low > 20 or high < 220:
                    raise ValueError('未分离出完整主体与透明背景，请使用修图 Agent 调整蒙版。')
                original = upright(source)
                alpha = protect_white_background_details(original,result.getchannel('A'))
                original.putalpha(ImageChops.darker(original.getchannel('A'),alpha))
                original.save(output,format='PNG',icc_profile=original.info.get('icc_profile'))
        await asyncio.to_thread(verify)
