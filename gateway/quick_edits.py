"""Fixed, local product photo recipes. The source is never overwritten."""
import asyncio
import tempfile
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from .image_uploads import MAX_IMAGE_PIXELS

RECIPES = {'cutout': ('transparent',), 'retouch': ('brush', 'paint', 'toy'), 'upscale': ('2', '4')}


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
        rgb = image.convert('RGB')
        brightness = rgb.convert('L')
        adjusted = ImageEnhance.Contrast(brightness).enhance({'brush': 1.035, 'paint': 1.012, 'toy': 1.025}[option])
        sharpen = {'brush': 70, 'paint': 30, 'toy': 45}[option]
        adjusted = adjusted.filter(ImageFilter.UnsharpMask(radius=0.9, percent=sharpen, threshold=3))
        # Apply the luminance difference equally to RGB, avoiding a lossy YCbCr round trip.
        from PIL import ImageChops
        lighter = ImageChops.subtract(adjusted, brightness)
        darker = ImageChops.subtract(brightness, adjusted)
        channels = [ImageChops.subtract(ImageChops.add(channel, lighter), darker) for channel in rgb.split()]
        result = Image.merge('RGBA', (*channels, image.getchannel('A')))
    result.save(output, format='PNG', icc_profile=image.info.get('icc_profile'))


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
            exported.replace(output)
        await asyncio.to_thread(verify)
