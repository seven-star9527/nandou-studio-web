"""Small on-disk previews. Callers must authorize the original on every request."""
import asyncio
import hashlib
import os
from pathlib import Path
import tempfile

from PIL import Image, ImageOps

from .image_uploads import MAX_IMAGE_PIXELS

_preview_slots = asyncio.Semaphore(2)


async def preview_path(source, cache, size=144):
    source = Path(source)
    stat = source.stat()
    signature = f'{source}:{stat.st_mtime_ns}:{stat.st_size}:{size}'
    destination = Path(cache) / (hashlib.sha256(signature.encode()).hexdigest() + '.webp')
    if not destination.exists():
        async with _preview_slots:
            if not destination.exists():
                await asyncio.to_thread(_render, source, destination, size)
    return destination


def _render(source, destination, size):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ValueError('preview too large')
        image.thumbnail((size, size))
        preview = ImageOps.exif_transpose(image)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as file:
            temporary = Path(file.name)
        try:
            preview.save(temporary, format='WEBP', quality=85)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)


def svg_headers(path):
    return {"Content-Type": "image/svg+xml", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"} if path.suffix.lower() == '.svg' else {}
