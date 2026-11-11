"""Bounded Pillow operations, launched by the gateway on an owned working copy."""
import json
import sys
from PIL import Image, ImageOps
from .image_uploads import MAX_IMAGE_PIXELS


def process(payload):
    with Image.open(payload['input']) as source:
        image=ImageOps.exif_transpose(source).copy()
    if image.mode=='P': image=image.convert('RGBA' if 'transparency' in image.info else 'RGB')
    for step in payload['steps']:
        name,p=step['command'],step['params']
        if name=='image.resize':
            if set(p)!={'width','height'} or any(type(v)!=int or not 1<=v<=16384 for v in p.values()) or p['width']*p['height']>MAX_IMAGE_PIXELS: raise ValueError()
            image=image.resize((p['width'],p['height']),Image.Resampling.LANCZOS)
        elif name=='image.crop':
            if set(p)!={'x','y','width','height'} or any(type(v)!=int for v in p.values()) or min(p.values())<0 or min(p['width'],p['height'])<1 or p['x']+p['width']>image.width or p['y']+p['height']>image.height: raise ValueError()
            image=image.crop((p['x'],p['y'],p['x']+p['width'],p['y']+p['height']))
        elif name=='image.rotate':
            if set(p)!={'angle'} or p['angle'] not in (90,180,270): raise ValueError()
            image=image.rotate(p['angle'],expand=True)
        elif name=='image.flip':
            if set(p)!={'axis'} or p['axis'] not in ('horizontal','vertical'): raise ValueError()
            image=ImageOps.mirror(image) if p['axis']=='horizontal' else ImageOps.flip(image)
        else: raise ValueError()
    if payload['output'].endswith('.jpg'):
        if 'A' in image.getbands() and image.getchannel('A').getextrema()[0]<255: raise ValueError('transparent JPEG requires explicit compositing')
        image=image.convert('RGB')
    image.save(payload['output'],**({'quality':94} if payload['output'].endswith('.jpg') else {'lossless':True} if payload['output'].endswith('.webp') else {}),icc_profile=image.info.get('icc_profile'))


if __name__=='__main__':
    with open(sys.argv[1],encoding='utf-8') as file: process(json.load(file))
