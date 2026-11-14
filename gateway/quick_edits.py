"""Fixed, local product photo recipes. The source is never overwritten."""
import asyncio
import tempfile
import shutil
from pathlib import Path
from functools import lru_cache
from threading import Lock
import os
import re
import subprocess
from math import isqrt

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
from .photocraft import PhotoCraft
from .image_uploads import MAX_IMAGE_PIXELS
from .product_recognition import mixing_wells, has_mixing_wells, recognize

RECIPES = {'cutout': ('transparent', 'hands', 'include', 'pick', 'subjects'), 'retouch': ('auto','general','palette','brush', 'paint', 'paper', 'miniature', 'toy'), 'upscale': ('2', '4', 'fit', '2-detail', '4-detail', 'fit-detail')}


def backdrop_option(option):
    return isinstance(option, str) and bool(re.fullmatch(r'(solid|studio):#[0-9a-f]{6}', option))


async def replace_backdrop(executable, source, output, option):
    if not backdrop_option(option):
        raise ValueError('背景色无效。')
    mode, color = option.split(':')
    with tempfile.TemporaryDirectory(dir=output.parent) as temp:
        folder = Path(temp)
        def prepare():
            import numpy as np
            im = upright(source)
            alpha = im.getchannel('A')
            bounds = alpha.point(lambda a: 255 if a >= 96 else 0).getbbox()
            if not bounds or alpha.getextrema()[0] >= 250:
                raise ValueError('未找到可用于换底的透明区域和主体。')
            base = Image.new('RGB', im.size, color)
            if mode == 'studio':
                # A seamless sweep and a broad contact shadow follow the visible footprint.
                w, h = im.size
                small = (max(1,round(w*min(1,768/max(w,h)))), max(1,round(h*min(1,768/max(w,h)))))
                y,x = np.ogrid[:small[1],:small[0]]
                x,y = (x+.5)/small[0],(y+.5)/small[1]
                l,t,r,b = bounds
                shadow = 0.
                # A hand or close-up continuing through the frame has no visible floor contact.
                if b < h-1:
                    foot = alpha.crop((l,max(t,b-max(2,round((b-t)*.035))),r,b))
                    contact = foot.point(lambda a: 255 if a >= 96 else 0).getbbox()
                    if contact:
                        center = (2*l+contact[0]+contact[2])/(2*w)
                        footprint = max(.025,(contact[2]-contact[0])/w*.42)
                        depth = max(.008,min(.045,(b-t)/h*.035))
                        shadow = np.exp(-.5*(((x-center)/footprint)**2+((y-b/h)/depth)**2))
                light = .025 + .14*np.exp(-2*((x-.28)**2+(y-.20)**2)) - .08*y
                tint = np.array(base.getpixel((0,0)),dtype=np.float32)
                pixels = tint + light[:,:,None]*np.where(light[:,:,None]>=0,255-tint,tint)
                pixels *= (1-.23*np.asarray(shadow))[...,None]
                base = Image.fromarray(np.clip(pixels,0,255).astype('uint8')).resize(im.size,Image.Resampling.BICUBIC)
            # Large files use the same alpha composite without holding two full editor layers.
            if not executable or not Path(executable).is_file() or im.width*im.height > 16_000_000:
                base.paste(im,mask=alpha)
                base.save(output,format='PNG')
                return None
            base.save(folder/'background.png')
            return im.size
        size = await asyncio.to_thread(prepare)
        if size:
            await asyncio.to_thread(shutil.copyfile,source,folder/'subject.png')
            async with PhotoCraft(executable,folder,timeout=180) as editor:
                await editor.call('doc_open',path=str(folder/'background.png'))
                await editor.call('doc_place',path=str(folder/'subject.png'),scale=100,center=[v/2 for v in size])
                await editor.call('doc_save',path=str(folder/'composite.png'))
            (folder/'composite.png').replace(output)


def retouch_settings(option):
    if not isinstance(option,str):
        raise ValueError('invalid retouch settings')
    parts = option.split('|')
    if len(parts)==1:
        parts += ['original','0']
    if len(parts)==3:
        parts.append('frame')
    if len(parts)!=4 or parts[3] not in ('frame','center') or (parts[3]=='center' and parts[1]!='white') or parts[0] not in RECIPES['retouch'] or parts[1] not in ('original','white') or parts[2] not in ('-0.5','0','0.5'):
        raise ValueError('invalid retouch settings')
    return parts[0],parts[1],float(parts[2]),parts[3]


def upright(path):
    with Image.open(path) as source:
        if source.width * source.height > MAX_IMAGE_PIXELS:
            raise ValueError('原图超过像素上限。')
        return ImageOps.exif_transpose(source).convert('RGBA')


def upscale_size(width, height, option):
    option = option.removesuffix('-detail')
    if option == 'fit':
        size = (min(4*width, isqrt(MAX_IMAGE_PIXELS*width//height)),
                min(4*height, isqrt(MAX_IMAGE_PIXELS*height//width)))
    else:
        factor = int(option)
        size = (width*factor, height*factor)
    if size[0]*size[1] > MAX_IMAGE_PIXELS or size == (width,height):
        raise ValueError('当前尺寸无法按所选倍率放大，单次输出上限为 6400 万像素。')
    return size


def studio_white_balance(source, category=None):
    """Estimate a mild cast only when several sides share a pale neutral backdrop."""
    import numpy as np
    with Image.open(source) as image:
        image.draft('RGB',(256,256))
        image.thumbnail((256,256))
        sample = np.asarray(image.convert('RGBA'),dtype=np.float32)
    sides = (sample[0],sample[-1],sample[:,0],sample[:,-1])
    neutrals = []
    for side in sides:
        rgb = side[:,:3]
        usable = (side[:,3]>250) & (rgb.min(axis=1)>135) & (np.ptp(rgb,axis=1)<27)
        if usable.mean()>.6:
            neutrals.append(np.median(rgb[usable],axis=0))
    # A brush or a cast shadow can occupy one side of the photograph. Estimate the
    # illuminant from the agreeing sides, without using the brightness of that outlier.
    if len(neutrals)>=3:
        middle = np.median(neutrals, axis=0)
        consensus = [side for side in neutrals if np.max(np.abs(side-middle)) <= 18]
        if len(consensus)>=3:
            neutral = np.median(consensus,axis=0)
            return np.clip(neutral.mean()/neutral,.96,1.04),min(.28,max(0.,(245-neutral.mean())/155))
    # Coloured sets are intentional. Pale cards, a lid or paper across several
    # quadrants can support a small luminance lift without neutralising the set.
    if category in ('paint','paper') and min(sample.shape[:2])>=8:
        levels = []
        for half in np.array_split(sample,2,axis=0):
            for quadrant in np.array_split(half,2,axis=1):
                rgb = quadrant[:,:,:3]
                usable = (quadrant[:,:,3]>250) & (rgb.min(2)>150) & (rgb.max(2)<249) & (np.ptp(rgb,axis=2)<26)
                if usable.mean()>=.10:
                    levels.append(np.percentile(rgb[usable].mean(1),90))
        if len(levels)>=3 and np.ptp(levels)<20:
            return (1.,1.,1.), float(np.clip((238-np.median(levels))/95,0,.22))
    return (1.,1.,1.),0.


def retouch_color(rgb, option, ev, balance):
    balance,lift = balance
    if any(abs(gain-1)>.001 for gain in balance):
        channels = rgb.split()
        corrected = Image.merge('RGB', [band.point([min(255,round(v*gain)) for v in range(256)])
                                       for band,gain in zip(channels,balance)])
        spread = ImageChops.subtract(ImageChops.lighter(ImageChops.lighter(*channels[:2]),channels[2]),
                                     ImageChops.darker(ImageChops.darker(*channels[:2]),channels[2]))
        rgb = Image.composite(corrected,rgb,spread.point([max(0,255-4*v) for v in range(256)]))
    brightness = rgb.convert('L')
    # Anchor black and white and restrict local contrast around fine labels and nibs.
    contrast, sharpness, limit = {'general':(.055,38,2),'palette':(.075,46,3),'brush': (.12, 65, 4), 'paint': (.06, 35, 2),
                                 'paper': (.045, 40, 2), 'miniature': (.065, 48, 2), 'toy': (.10, 50, 3)}[option]
    tone = brightness.point([min(255,round(v + lift*v*(255-v)/255 + contrast * (v - 127.5) * (1 - abs(v / 127.5 - 1))))
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


def panel_lighting(image):
    """Flatten small exposure variations on a large painted lid while retaining its lighting gradient."""
    import cv2
    import numpy as np
    small=image.resize(tuple(max(1,round(v*min(1,640/max(image.size)))) for v in image.size),Image.Resampling.BILINEAR)
    rgba=np.asarray(small)
    lum=np.asarray(small.convert('L'),dtype=np.float32)
    eligible=(rgba[:,:,3]>249)&(lum>12)&(lum<100)&(np.ptp(rgba[:,:,:3],axis=2)>18)
    count,labels,stats,_=cv2.connectedComponentsWithStats(eligible.astype('uint8'))
    correction=np.zeros_like(lum)
    # The walls and rim are opposite sides of a measured brightness transition.
    # Limit relief to repeated neutral wells; never introduce a bevel at the silhouette.
    wells,_=mixing_wells(small.convert('RGB'))
    cavities=np.zeros_like(lum)
    # A neighbouring lid can obscure the top rim. Extend one measured row only
    # when the translated patch also matches the real shape in the photograph.
    confirmed=set(wells)
    for cx,cy,w,h in wells:
        column=sorted({yy for xx,yy,ww,hh in wells if abs(xx-cx)<w*.28 and abs(yy-cy)>h*.6})
        for yy in column:
            if not h*.83<abs(yy-cy)<h*1.6:
                continue
            target=2*cy-yy
            if any(abs(xx-cx)<w*.3 and abs(y-target)<h*.4 for xx,y,_,_ in confirmed):
                continue
            hw,hh=int(w*.55),int(h*.55)
            ix,iy,ty=round(cx),round(cy),round(target)
            if min(ix-hw,iy-hh,ty-hh-3)<0 or ix+hw>=small.width or max(iy,ty+3)+hh>=small.height:
                continue
            exemplar=lum[iy-hh:iy+hh+1,ix-hw:ix+hw+1]
            scan=lum[ty-hh-3:ty+hh+4,ix-hw:ix+hw+1]
            score=cv2.matchTemplate(scan,exemplar,cv2.TM_CCOEFF_NORMED).ravel()
            if score.max()>.78:
                confirmed.add((cx,ty+int(score.argmax())-3,w,h))
    for cx,cy,w,h in confirmed:
        x1,y1=max(0,int(cx-w*.7)),max(0,int(cy-h*.7))
        x2,y2=min(small.width,int(cx+w*.7+1)),min(small.height,int(cy+h*.7+1))
        cavities[y1:y2,x1:x2]=1
    if wells:
        radius=max(2,float(np.median([w for _,_,w,_ in wells]))*.36)
        local=cv2.GaussianBlur(lum,(0,0),radius)
        # Keep the floor of each well near its original tone; most of the depth
        # comes from the narrow dark wall, not a brighter flat interior.
        detail=lum-cv2.GaussianBlur(lum,(0,0),1.3)
        relief=np.clip(.28*np.minimum(lum-local,0)+.62*detail,-10,2.5)
        correction+=relief*cv2.GaussianBlur(cavities,(0,0),1.6)*(rgba[:,:,3]>250)
    if count>1:
        idx=1+np.argmax(stats[1:,cv2.CC_STAT_AREA])
        core=cv2.erode((labels==idx).astype('uint8'),np.ones((5,5),np.uint8)).astype(bool)
        y,x=np.nonzero(core)
        if len(x)>=max(12,lum.size*.04):
            u,v=x/max(1,lum.shape[1]),y/max(1,lum.shape[0])
            design=np.stack((np.ones_like(u),u,v),axis=1)
            light=lum[y,x]
            fit=design@np.linalg.lstsq(design,light,rcond=None)[0]
            close=abs(light-fit)<8
            if close.mean()>.85:
                coeff=np.linalg.lstsq(design[close],light[close],rcond=None)[0]
                # Retain the principal studio light; soften cross-axis glare on the coating.
                variation=coeff[1:]*np.array([np.ptp(u),np.ptp(v)])
                minor=1+np.argmin(abs(variation))
                fit=design@coeff
                flatten=.64*coeff[minor]*(design[:,minor]-np.median(design[:,minor]))
                broad=cv2.GaussianBlur(cv2.morphologyEx(lum,cv2.MORPH_OPEN,np.ones((3,3),np.uint8)),(0,0),2.)
                delta=np.clip(fit-broad[y,x]-flatten-np.clip(np.median(light)*.14,0,8),-19,7)
                field=np.zeros_like(lum); weights=np.zeros_like(lum)
                field[y,x]=delta; weights[y,x]=1
                smooth=lambda t:cv2.GaussianBlur(t,(0,0),2.)
                correction+=smooth(field)/np.maximum(.01,smooth(weights))*np.clip(smooth(weights)*1.25,0,1)
    if not np.any(correction):
        return None
    return Image.fromarray(np.uint8(np.clip(np.rint(128+correction*6),0,255)))


def photo_noise(image):
    """Estimate grain at native scale from flat, opaque midtones across the frame."""
    import cv2
    import numpy as np
    values = []
    for cy in (.16,.5,.84):
        for cx in (.16,.5,.84):
            x,y = int(image.width*cx),int(image.height*cy)
            tile = image.crop((max(0,x-48),max(0,y-48),min(image.width,x+48),min(image.height,y+48)))
            if min(tile.size)<7:
                continue
            lum = np.asarray(tile.convert('L'))
            smooth = cv2.GaussianBlur(lum,(5,5),1.4)
            dx = cv2.Sobel(smooth,cv2.CV_32F,1,0)
            dy = cv2.Sobel(smooth,cv2.CV_32F,0,1)
            flat = (dx*dx+dy*dy<26**2) & (lum>20) & (lum<235) & (np.asarray(tile.getchannel('A'))==255)
            if flat.sum() >= 160:
                residual = cv2.absdiff(lum,cv2.medianBlur(lum,3))
                values.append(float(np.median(residual[flat])))
    return float(np.median(values)) if values else 0.


_upscale_lock = Lock()


def camera_super_resolution(image, result, model_dir, folder):
    """Use the photographic model in padded strips and anchor its edges to the observed pixels."""
    import cv2
    import numpy as np
    root = model_dir/'realesrgan'
    executable = root/'realesrgan-ncnn-vulkan.exe'
    if not executable.is_file() or not all((root/'models'/('realesrgan-x4plus.'+ext)).is_file() for ext in ('bin','param')):
        return False
    sx,sy = result.width/image.width,result.height/image.height
    # Cap native 4x intermediates even for very wide originals or fractional output sizes.
    with _upscale_lock, tempfile.TemporaryDirectory(dir=folder) as temporary:
        workspace=Path(temporary)
        inp,out=workspace/'input.png',workspace/'output.png'
        for y in range(0,image.height,1024):
            for x in range(0,image.width,1024):
                end_x,end_y=min(x+1024,image.width),min(y+1024,image.height)
                left,top=max(0,x-32),max(0,y-32)
                tile=image.crop((left,top,min(image.width,end_x+32),min(image.height,end_y+32)))
                rgb=Image.new('RGB',tile.size,'white')
                rgb.paste(tile,mask=tile.getchannel('A'))
                rgb.save(inp)
                args=[str(executable.resolve()),'-i',str(inp.resolve()),'-o',str(out.resolve()),'-m',str((root/'models').resolve()),
                      '-n','realesrgan-x4plus','-s','4','-t','192','-j','1:1:1']
                try:
                    proc=subprocess.run(args,cwd=workspace,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=240)
                except (OSError,subprocess.TimeoutExpired) as exc:
                    raise ValueError('本机显卡未完成细节增强，请选择保真放大或稍后重试。') from exc
                if proc.returncode or not out.is_file():
                    raise ValueError('本机显卡未完成细节增强，请选择保真放大或稍后重试。')
                box=(round(x*sx),round(y*sy),round(end_x*sx),round(end_y*sy))
                region=result.crop(box)
                with Image.open(out) as prediction:
                    if prediction.size != (tile.width*4,tile.height*4):
                        raise ValueError('细节增强输出尺寸异常。')
                    mapped=tuple(max(0,min(limit,(v/scale-start)*4)) for v,scale,start,limit in
                                 zip(box,(sx,sy)*2,(left,top)*2,prediction.size*2))
                    target=np.asarray(prediction.convert('L').resize(region.size,Image.Resampling.LANCZOS,box=mapped),dtype=np.float32)
                original=np.asarray(region.convert('L'),dtype=np.float32)
                # Keep fine printing tied to the original edge position, and remove low-frequency relighting.
                residual=target-original
                delta=residual-.75*cv2.GaussianBlur(residual,(0,0),max(1.5,1.5*sx))
                pixels=np.array(region)
                bands=pixels[:,:,:3]
                # Smooth painted grain less than high-contrast printed strokes.
                edge=cv2.magnitude(cv2.Sobel(original,cv2.CV_32F,1,0),cv2.Sobel(original,cv2.CV_32F,0,1))
                # Strong, coherent printed edges accept neural detail; fine surface grain stays on the camera path.
                density=cv2.GaussianBlur(edge,(0,0),max(1.,sx))
                gate=np.clip((density-22)/80,0,1)
                gate=gate*gate*(3-2*gate)
                strength=.025+.955*gate
                # Recover some source edge contrast without inventing strokes in a blank field.
                delta+=np.clip(original-cv2.GaussianBlur(original,(0,0),max(1.,sx*.72)),-24,24)*.22*gate
                delta=np.rint(np.clip(delta*strength,-38,38)).astype(np.int16)
                delta[pixels[:,:,3]!=255]=0
                delta=np.clip(delta,-bands.min(2).astype(np.int16),255-bands.max(2))
                pixels[:,:,:3]=bands+delta[:,:,None]
                result.paste(Image.fromarray(pixels),box)
                out.unlink()
    return True


def enlarge_details(image, result, model_dir):
    """Recover luminance detail in overlapping source tiles, retaining colour and alpha."""
    import cv2
    import numpy as np
    scale_x, scale_y = result.width/image.width, result.height/image.height
    factor = 2 if max(scale_x,scale_y)<=2 else 4
    weights = model_dir / f'FSRCNN_x{factor}.pb'
    if not weights.is_file():
        raise ValueError('本机缺少细节增强模型，请选择保真放大。')
    engine = cv2.dnn_superres.DnnSuperResImpl_create()
    engine.readModel(str(weights))
    engine.setModel('fsrcnn', factor)
    noise = photo_noise(image)
    for y in range(0, image.height, 256):
        for x in range(0, image.width, 256):
            right, bottom = min(x+256, image.width), min(y+256, image.height)
            # Context exceeds the network receptive field. Only write the inner result.
            left, top = max(0,x-12), max(0,y-12)
            tile = image.crop((left,top,min(image.width,right+12),min(image.height,bottom+12)))
            opaque = Image.new('RGB', tile.size, 'white')
            opaque.paste(tile, mask=tile.getchannel('A'))
            luma = np.asarray(opaque.convert('L'))
            if noise>=4:
                # Smooth luminance within similar tones only. The range follows measured grain.
                luma = cv2.bilateralFilter(luma,5,min(24,noise*2.5),2)
            prediction = Image.fromarray(engine.upsample(luma))
            box = (round(x*scale_x),round(y*scale_y),round(right*scale_x),round(bottom*scale_y))
            region = result.crop(box)
            pixels = np.array(region)
            # Fractional fit uses the same global pixel centres on both sides of every seam.
            source_box = tuple((p/scale-origin)*factor for p,scale,origin in
                               zip(box,(scale_x,scale_y)*2,(left,top)*2))
            source_box = (max(0,source_box[0]),max(0,source_box[1]),
                          min(prediction.width,source_box[2]),min(prediction.height,source_box[3]))
            prediction = prediction.resize(region.size, Image.Resampling.LANCZOS, box=source_box)
            detail = np.asarray(prediction,dtype=np.int16) - np.asarray(region.convert('L'))
            # Limit overshoot on ink and metallic edges, leave translucent coverage alone.
            delta = np.clip(detail,-18,18)
            delta[pixels[:,:,3] != 255] = 0
            rgb = pixels[:,:,:3]
            delta = np.clip(delta, -rgb.min(2).astype(np.int16), 255-rgb.max(2))
            pixels[:,:,:3] = rgb + delta[:,:,None]
            result.paste(Image.fromarray(pixels), box)


def finish_material(tile, polished, category, long_edge, well_area=None):
    """Local contrast at two physical scales; keep alpha and channel detail independent."""
    import cv2
    import numpy as np
    rgb = np.asarray(polished, dtype=np.float32)
    lum = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    smooth = lambda plane, sigma: cv2.GaussianBlur(plane, (0,0), sigma)
    radius = np.clip(long_edge / 1250, .7, 4.)
    fine = lum - smooth(lum, radius)
    broad = lum - smooth(lum, radius * 3)
    spread = np.ptp(rgb,axis=2)
    alpha = np.array(tile.getchannel('A'))
    solid = cv2.erode((alpha>248).astype('float32'),np.ones((5,5),'uint8'))
    if category=='palette':
        wells = np.asarray(well_area,dtype=np.float32)/255 if well_area is not None else 0.
        wells = wells * np.clip((33-spread)/12,0,1) * solid
        sculpt = np.clip(1.15*broad + .9*fine - 3.2,-15,10)
        # Reduce uneven coating at medium scales; retain native fine grain and protect lettering.
        dark = np.clip((108-lum)/32,0,1)*np.clip((spread-15)/15,0,1)*solid
        clean = np.clip((9-np.abs(broad))/5,0,1)
        change = wells*sculpt - dark*clean*(.52*(broad-fine)+.12*fine)
    elif category=='brush':
        # A bundle of hairs has coherent directional detail; a smooth wooden handle does not.
        gx=cv2.Sobel(lum,cv2.CV_32F,1,0)/8
        gy=cv2.Sobel(lum,cv2.CV_32F,0,1)/8
        xx,yy,xy=(smooth(p,radius*3) for p in (gx*gx,gy*gy,gx*gy))
        energy=xx+yy
        coherence=np.sqrt((xx-yy)**2+4*xy**2)/(energy+.1)
        warm=np.clip((rgb[:,:,0]-rgb[:,:,2]-12)/18,0,1)*np.clip((88-spread)/30,0,1)
        hair=warm*np.clip((coherence-.42)/.4,0,1)*np.clip((energy-5)/32,0,1)*solid
        change=hair*(np.clip((lum-35)/55,0,1)*np.clip((231-lum)/60,0,1)*11+np.clip(.43*fine,-5,5))
    elif category=='paper':
        paper=np.clip((lum-160)/40,0,1)*np.clip((30-spread)/16,0,1)*solid
        change=paper*np.clip(broad*.75+fine*.45,-9,5)
    else:
        return polished
    change=np.clip(change,-rgb.min(axis=2),255-rgb.max(axis=2))
    return Image.fromarray(np.uint8(np.rint(rgb+change[:,:,None])))


def retouch_or_enlarge(source, output, tool, option, balance=None, model_dir=None):
    image = upright(source)
    if tool == 'upscale':
        size = upscale_size(image.width,image.height,option)
        result = image.resize(size, Image.Resampling.LANCZOS)
        if option.endswith('-detail') and not camera_super_resolution(image,result,model_dir,Path(output).parent):
            enlarge_details(image, result, model_dir)
    else:
        # Adjust luminance only. Preserve original chroma, markings and alpha.
        option,background,ev,framing = retouch_settings(option)
        if balance is None:
            balance = studio_white_balance(source,option)
        if framing=='center':
            # Crop to visible pixels including the antialiased fringe. Keep near-full-frame closeups.
            bounds=image.getchannel('A').getbbox()
            # A composition touching a frame edge may be an intentional macro crop.
            # Fit complete products even when a long brush almost spans one dimension.
            if bounds and bounds[0]>0 and bounds[1]>0 and bounds[2]<image.width and bounds[3]<image.height:
                subject=image.crop(bounds)
                subject=ImageOps.contain(subject,(max(1,round(image.width*.88)),max(1,round(image.height*.88))),Image.Resampling.LANCZOS)
                framed=Image.new('RGBA',image.size)
                framed.paste(subject,((image.width-subject.width)//2,(image.height-subject.height)//2))
                framed.info.update(image.info)
                image=framed
        result = Image.new('RGB' if background=='white' else 'RGBA',image.size,'white')
        lighting=panel_lighting(image) if option=='palette' else None
        well_map=None
        if option=='palette':
            thumb=image.copy()
            thumb.thumbnail((640,640),Image.Resampling.LANCZOS)
            wells,small_size=mixing_wells(thumb.convert('RGB'))
            if wells:
                well_map=Image.new('L',small_size)
                draw=ImageDraw.Draw(well_map)
                for cx,cy,w,h in wells:
                    draw.rounded_rectangle((cx-w*.65,cy-h*.66,cx+w*.65,cy+h*.66),radius=min(w,h)*.14,fill=255)
                well_map=well_map.filter(ImageFilter.GaussianBlur(1.6))
            del thumb
        for y in range(0,image.height,768):
            for x in range(0,image.width,768):
                right,bottom=min(x+768,image.width),min(y+768,image.height)
                # Include neighboring pixels for the 0.85px unsharp mask on each tile boundary.
                margin=56 if option in ('brush','palette','paper') else 8
                left,top=max(0,x-margin),max(0,y-margin)
                tile_box=(left,top,min(image.width,right+margin),min(image.height,bottom+margin))
                tile=image.crop(tile_box)
                polished=retouch_color(tile.convert('RGB'),option,ev,balance)
                if option in ('brush','palette','paper'):
                    area=None
                    if well_map is not None:
                        box=tuple(v*s/n for v,s,n in zip(tile_box,well_map.size*2,image.size*2))
                        area=well_map.resize(tile.size,Image.Resampling.BILINEAR,box=box)
                    polished=finish_material(tile,polished,option,max(image.size),area)
                inner=(x-left,y-top,right-left,bottom-top)
                pixels=polished.crop(inner)
                if lighting is not None:
                    import numpy as np
                    region=tuple(pos*small/full for pos,small,full in zip((x,y,right,bottom),lighting.size*2,image.size*2))
                    adjust=(np.asarray(lighting.resize(pixels.size,Image.Resampling.BILINEAR,box=region),dtype=np.int16)-128)/6
                    values=np.asarray(pixels,dtype=np.int16)
                    pixels=Image.fromarray(np.uint8(np.clip(values+np.rint(adjust[:,:,None]),0,255)))
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
        corrected = image.convert('RGBA')
        alpha = corrected.getchannel('A')
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
    # Retain decontaminated colours from the last result. Newly exposed coverage
    # comes from the original photograph, including on a second round of corrections.
    restored = ImageChops.subtract(alpha, corrected.getchannel('A')).point(lambda v: 255 if v else 0)
    corrected.paste(original, mask=restored)
    corrected.putalpha(alpha)
    corrected.save(output, format='PNG', icc_profile=original.info.get('icc_profile'))


async def product_retouch(model_path, source, output, option):
    category, background, _, _ = retouch_settings(option)
    if category=='auto':
        category = await asyncio.to_thread(recognize,source,model_path.parent/'product-recognition')
        option = option.replace('auto',category,1)
    if background=='white':
        def has_cutout():
            im = upright(source)
            return im.getchannel('A').getextrema()[0] < 16
        if not await asyncio.to_thread(has_cutout):
            with tempfile.TemporaryDirectory(dir=output.parent) as folder:
                transparent = Path(folder)/'subject.png'
                await cutout(model_path,source,transparent,category=category)
                balance = await asyncio.to_thread(studio_white_balance,source,category)
                await asyncio.to_thread(retouch_or_enlarge,transparent,output,'retouch',option,balance)
            return category
    await asyncio.to_thread(retouch_or_enlarge,source,output,'retouch',option)
    return category


# The desktop CPU session is shared across users. Only original pixels leave this function.
_inference_lock = Lock()


@lru_cache(maxsize=4)
def subject_session(model_path):
    if not model_path.is_file():
        raise ValueError(f'本机缺少抠图模型 {model_path.name}。')
    import onnxruntime as ort
    settings = ort.SessionOptions()
    # Multiple local editing services share the host. Release intermediate tensors after each run.
    settings.enable_cpu_mem_arena = False
    settings.enable_mem_pattern = False
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


def refine_selected_edges(original, coarse):
    """Fit the upsampled silhouette to the original colours along the matte boundary."""
    import numpy as np
    result = coarse.copy()
    radius = max(4, min(48, round(max(original.size) / 160)))
    kernel = 2 * radius + 1

    def box_sum(values):
        for axis in (0, 1):
            pad = [(0, 0)] * values.ndim
            pad[axis] = (radius + 1, radius)
            sums = np.pad(values, pad, mode='edge').cumsum(axis=axis, dtype=np.float64)
            values = sums[kernel:] - sums[:-kernel] if axis == 0 else sums[:, kernel:] - sums[:, :-kernel]
        return values

    for y in range(0, original.height, 512):
        for x in range(0, original.width, 512):
            right, bottom = min(x + 512, original.width), min(y + 512, original.height)
            box = (max(0, x-radius), max(0, y-radius), min(original.width, right+radius), min(original.height, bottom+radius))
            tile = coarse.crop(box)
            if tile.getextrema() in ((0, 0), (255, 255)):
                continue
            alpha = np.asarray(tile, dtype=np.float32) / 255
            rgb = np.asarray(original.crop(box).convert('RGB'), dtype=np.float32)
            def sample(mask):
                count = box_sum(mask.astype(np.float32))
                colour = box_sum(rgb * mask[:, :, None]) / np.maximum(1, count[:, :, None])
                return colour, count

            # A hard SAM boundary may sit several original pixels inside or outside the object.
            # Keep those uncertain pixels out of both colour samples.
            soft = np.asarray(tile.filter(ImageFilter.GaussianBlur(max(1, radius/4))), dtype=np.float32)/255
            fg, nf = sample(soft >= .97)
            bg, nb = sample(soft <= .03)
            delta = fg - bg
            contrast = (delta * delta).sum(axis=2)
            raw_projection = ((rgb-bg)*delta).sum(axis=2)/np.maximum(1,contrast)
            projected = raw_projection.clip(0,1)
            # Suppress sensor noise in the estimate; opaque skin texture stays in the source RGB.
            smooth = Image.fromarray(np.uint8(np.rint(projected*255))).filter(ImageFilter.GaussianBlur(1.2))
            edge_alpha = np.clip((np.asarray(smooth, dtype=np.float32)/255 - .10)/.66, 0, 1)
            # Darker shading inside an opaque object can extend beyond the sampled foreground colour.
            # Measure colour-line fit before clamping, so that shading does not punch holes in the edge.
            residual = np.linalg.norm(rgb-bg-raw_projection[:, :, None]*delta, axis=2)
            evidence = np.maximum(np.clip(1-residual/32,0,1),
                                  np.clip((raw_projection-.55)/.25,0,1)*np.clip(1-residual/100,0,1))
            # Trust colour matting only where both sides are sampled and the two-colour model fits.
            confidence = np.clip((np.sqrt(contrast)-12)/22, 0, 1) * evidence
            confidence *= np.clip(np.minimum(nf, nb) / (.1 * kernel**2), 0, 1)
            # Limit updates to the transition. Protect solid product details (e.g. lettering).
            band = np.clip(np.minimum(soft, 1-soft)/.03, 0, 1)
            values = alpha + band * confidence * (edge_alpha-alpha)
            dx, dy = x-box[0], y-box[1]
            result.paste(Image.fromarray(np.uint8(np.rint(values[dy:dy+bottom-y,dx:dx+right-x]*255))), (x,y))
    return result


def suppress_shaft_shadows(camera, coarse, alpha, background):
    """Trace a hard dark edge from exterior background through a cast shadow along both image axes."""
    import numpy as np
    radius = max(6, min(100, round(max(camera.size)/76)))
    low = np.asarray(camera.convert('L').filter(ImageFilter.GaussianBlur(.9)))
    chroma = np.asarray(camera)
    prior = np.asarray(coarse)
    original_alpha = np.asarray(alpha)
    out = original_alpha.copy()
    for vertical in (False, True):
        grey = low.T if vertical else low
        mask = prior.T if vertical else prior
        opacity = original_alpha.T if vertical else original_alpha
        result = out.T if vertical else out
        rgb = chroma.swapaxes(0,1) if vertical else chroma
        for direction in (1,-1):
            g, c, a, pixels = grey[:,::direction], mask[:,::direction], result[:,::direction], rgb[:,::direction]
            uncut = opacity[:, ::direction]
            width = g.shape[1]
            for row in range(0,len(g),192):
                slab = c[row:row+192]
                ys,xs = np.where((slab[:,1:]>=128)&(slab[:,:-1]<128))
                for start in range(0,len(xs),2048):
                    y = row+ys[start:start+2048]
                    x = xs[start:start+2048]+1
                    positions = x[:,None]+np.arange(-radius,radius+1)
                    def at(offset):
                        return g[y[:,None],(positions+offset).clip(0,width-1)].astype(np.float32)
                    # On a dark physical edge the luminance falls sharply, then stays dark inside.
                    exterior = at(-4)
                    inside = at(4)
                    step = exterior-inside
                    score = np.minimum(step,exterior-at(8))
                    # Prefer the outer edge of the shaft, retaining specular stripes inside.
                    ok=(score>36)&(inside<105)&(exterior>80)&(positions>=8)&(positions<width-9)
                    ok &= (g[y,(x-radius-2).clip(0,width-1)][:,None].astype(float)>exterior-14)
                    # Constrain to a shadow with the neutral hue of the studio backdrop.
                    sample=pixels[y[:,None],(positions-4).clip(0,width-1)].astype(float)
                    ok &= (sample.max(axis=2)-sample.min(axis=2)<22)
                    # A cast shadow is darker than the studio background. A bright reflection
                    # or a thin, coloured tip is not evidence to cut into the product.
                    # Discard internal reflections before ranking candidates. A reflection can
                    # have more contrast than the contour, but reaching it crosses dark material.
                    floor = np.minimum.accumulate(at(0),axis=1)
                    floor = np.concatenate([np.full((len(y),4),255),floor[:,:-4]],axis=1)
                    ok &= floor>=inside+4
                    ok &= abs(positions-x[:,None])<=max(8,radius//2)
                    edge=np.argmax(np.where(ok,score-np.abs(positions-x[:,None])*.9,-1000),axis=1)
                    chosen=positions[np.arange(len(y)),edge]
                    inner_rgb=pixels[y,(chosen+4).clip(0,width-1)].astype(float)
                    valid=ok.any(axis=1) & (np.ptp(inner_rgb,axis=1)<24)
                    valid &= g[y,(chosen-4).clip(0,width-1)] < np.mean(background)-18
                    valid &= c[y,(chosen+12).clip(0,width-1)]>=170
                    if not valid.any():
                        continue
                    y,x,edge=y[valid],x[valid],positions[np.arange(len(y)),edge][valid]
                    # Trace from transparent exterior; a neighbouring brush must break the trace.
                    start_x=(x-radius).clip(0,width-1)
                    outside=c[y,start_x]<16
                    yy,ee,ss=y[outside],edge[outside],start_x[outside]
                    for line,bound,begin in zip(yy,ee,ss):
                        if bound<=begin+6: continue
                        # A highlight inside the shaft can look like a second exterior edge.
                        # Reject the trace if it would cross the already opaque subject.
                        # Leave the antialiased transition itself available for refinement.
                        trusted = slice(begin, bound-4)
                        if np.any((uncut[line,trusted]>=240) & (c[line,trusted]>=235)):
                            continue
                        outer=float(g[line,bound-4]);inner=float(g[line,bound+4])

                        a[line,begin:bound-3]=0
                        strip=slice(bound-3,bound+4)
                        fraction=np.clip((outer-g[line,strip].astype(float))/max(1,outer-inner),0,1)
                        a[line,strip]=np.minimum(a[line,strip],np.rint(255*fraction).astype(np.uint8))
    return Image.fromarray(out)


def refit_dark_contour(camera, original, matte, allow_extension):
    """Recover the optical transition of an opaque dark surface on a neutral backdrop."""
    import numpy as np
    result = matte.copy()
    for top in range(0, matte.height, 256):
        for left in range(0, matte.width, 256):
            box = (left, top, min(left+256, matte.width), min(top+256, matte.height))
            tile = (max(0, left-14), max(0, top-14), min(matte.width, box[2]+14), min(matte.height, box[3]+14))
            mask = matte.crop(tile)
            if mask.getextrema() != (0, 255):
                continue
            # Use the mask only for orientation. Sample the photographed edge at camera resolution.
            guide = np.asarray(mask.filter(ImageFilter.GaussianBlur(2)), dtype=np.float32)
            sy, sx = top-tile[1], left-tile[0]
            patch = guide[sy:sy+box[3]-top, sx:sx+box[2]-left]
            j, i = np.nonzero((patch > 1) & (patch < 254))
            if not len(i):
                continue
            y, x = j+sy, i+sx
            gy, gx = np.gradient(guide)
            norm = np.maximum(np.hypot(gx[y,x], gy[y,x]), 1)
            dx, dy = gx[y,x]/norm, gy[y,x]/norm
            def offset(n):
                return (np.rint(y+n*dy).astype(int).clip(0, guide.shape[0]-1),
                        np.rint(x+n*dx).astype(int).clip(0, guide.shape[1]-1))
            a = np.asarray(mask)
            photo = camera.crop(tile)
            rgb = np.asarray(photo)
            smooth = np.asarray(photo.filter(ImageFilter.GaussianBlur(.6)))
            outside, inside = offset(-5), offset(5)
            bg, fg = smooth[outside].astype(np.float32), smooth[inside].astype(np.float32)
            span = bg.mean(1)-fg.mean(1)
            valid = (norm > 4) & (a[outside] < 8) & (a[offset(9)] > 246)
            valid &= (fg.max(1) < 100) & (np.ptp(fg, axis=1) < 22)
            valid &= (np.ptp(bg, axis=1) < 25) & (span > 45)
            if not valid.any():
                continue
            # Locate the photographed transition along the mask normal. A derivative of the
            # lightly denoised photo ignores both the broad shadow and surface grain.
            yy, xx = y[valid], x[valid]
            nx, ny = dx[valid], dy[valid]
            light = np.asarray(photo.convert('L').filter(ImageFilter.GaussianBlur(1)), dtype=np.float32)
            offsets = np.arange(-7, 8, dtype=np.float32)
            px = (xx[:,None]+nx[:,None]*offsets).clip(0, light.shape[1]-1)
            py = (yy[:,None]+ny[:,None]*offsets).clip(0, light.shape[0]-1)
            x0, y0 = px.astype(int), py.astype(int)
            x1, y1 = (x0+1).clip(max=light.shape[1]-1), (y0+1).clip(max=light.shape[0]-1)
            fx, fy = px-x0, py-y0
            line = ((1-fy)*((1-fx)*light[y0,x0]+fx*light[y0,x1])
                    + fy*((1-fx)*light[y1,x0]+fx*light[y1,x1]))
            slopes = line[:,:-1]-line[:,1:]
            peak = slopes.argmax(axis=1)
            strongest = slopes.max(axis=1)
            # Reject weak, ambiguous and out-of-window edges.
            trusted = (peak >= 2) & (peak <= 11) & (strongest > .18*span[valid])
            if not trusted.any():
                continue
            j, i, yy, xx = j[valid][trusted], i[valid][trusted], yy[trusted], xx[trusted]
            peak = peak[trusted]
            k = peak[:,None]+np.arange(-2,3)
            weights = np.maximum(0, np.take_along_axis(slopes[trusted], k, axis=1))
            boundary = ((offsets[k]+.5)*weights).sum(1)/weights.sum(1)
            # Preserve subpixel coverage across roughly two camera pixels at a hard edge.
            coverage = np.clip(.5-boundary/2.6, 0, 1)
            prior = a[yy,xx]/255.
            if not allow_extension:
                coverage = np.minimum(coverage, prior)
            new_alpha = np.asarray(result.crop(box)).copy()
            new_alpha[j,i] = np.rint(coverage*255).astype(np.uint8)
            result.paste(Image.fromarray(new_alpha), box)
            colour = np.asarray(original.crop(box)).copy()
            observed = rgb[yy,xx].astype(np.float32)
            # The first clean pixel inside the edge supplies the colour under partial coverage.
            blend = (1-coverage[:,None])
            colour[j,i,:3] = np.rint(observed*(1-blend)+fg[valid][trusted]*blend).astype(np.uint8)
            original.paste(Image.fromarray(colour), box)
    return result


def studio_edge_detail(original, coarse, matte, allow_extension=True):
    """Refit boundary pixels against a locally uniform backdrop, including sub-mask-width bristles."""
    import numpy as np
    radius = max(3, min(35, round(max(original.size) / 190)))
    # Compute support at model scale; use the camera pixels for all colour and opacity estimates.
    ratio = min(1, 1024 / max(coarse.size))
    small = coarse.resize(tuple(max(1, round(n*ratio)) for n in coarse.size), Image.Resampling.BILINEAR)
    extent = small.point(lambda v: 255 if v>10 else 0).filter(ImageFilter.MaxFilter(7))
    core = small.point(lambda v: 255 if v>245 else 0).filter(ImageFilter.MinFilter(7))
    band = ImageChops.subtract(extent, core).resize(coarse.size, Image.Resampling.NEAREST)
    angle = np.arange(12)*np.pi/6
    directions = np.column_stack((np.sin(angle),np.cos(angle)))
    def offsets(radii):
        return np.unique(np.rint(np.concatenate([directions*r for r in radii])).astype(int), axis=0)
    far = offsets([radius, 2*radius, 3*radius])
    detail = offsets([1, max(2,radius/9), max(3,radius/4)])
    thumbnail = np.asarray(original.resize(small.size, Image.Resampling.BILINEAR).convert("RGB"))
    backdrop = thumbnail[np.asarray(small)<5][::8]
    if not len(backdrop):
        return matte
    neutral = np.median(backdrop,axis=0)
    uniform = np.mean(np.max(abs(backdrop-neutral),axis=1)<20)>.85
    if not uniform or neutral.max()-neutral.min()>32 or original.getextrema()[3][0] != 255:
        return matte
    camera = original.convert('RGB')
    alpha = matte.copy()
    for top in range(0, coarse.height, 512):
        for left in range(0, coarse.width, 512):
            box = (left,top,min(left+512,coarse.width),min(top+512,coarse.height))
            yy,xx = np.nonzero(np.asarray(band.crop(box)))
            if not len(xx):
                continue
            pad = 3*radius
            tile = (max(0,left-pad),max(0,top-pad),min(coarse.width,box[2]+pad),min(coarse.height,box[3]+pad))
            patch = camera.crop(tile)
            # Smooth only the colour estimate; keep original pixel detail in the exported object.
            rgb = np.asarray(patch.filter(ImageFilter.GaussianBlur(.85)), dtype=np.float32)
            light = patch.convert('L')
            ridge = np.asarray(light.filter(ImageFilter.GaussianBlur(max(1,radius/8))),dtype=np.float32) - np.asarray(light,dtype=np.float32)
            prior = np.asarray(coarse.crop(tile))
            result = np.asarray(alpha.crop(box)).copy()
            colours = np.asarray(original.crop(box)).copy()
            h,w = prior.shape
            for start in range(0,len(xx),2048):
                j,i = yy[start:start+2048],xx[start:start+2048]
                y,x = j+top-tile[1],i+left-tile[0]
                def neighbours(offset):
                    return ((y[:,None]+offset[:,0]).clip(0,h-1),(x[:,None]+offset[:,1]).clip(0,w-1))
                by,bx = neighbours(far)
                samples = rgb[by,bx]
                valid = prior[by,bx]<8
                count = valid.sum(axis=1)
                # A compact background cluster is required; skip gradients, textures and ambiguous selections.
                bg = (samples*valid[:,:,None]).sum(axis=1)/np.maximum(1,count[:,None])
                spread = np.max(abs(samples-bg[:,None]),axis=2)
                stable = (count>=7) & (((spread<10)&valid).sum(axis=1)>=.85*count)
                near = (np.max(abs(samples-neutral),axis=2)<25)&valid
                n = near.sum(axis=1)
                local = (samples*near[:,:,None]).sum(axis=1)/np.maximum(n[:,None],1)
                fallback = ~stable & (n>=3)
                bg[fallback] = local[fallback]
                stable |= fallback
                if not stable.any():
                    continue
                ny,nx = neighbours(detail)
                # Use the actual contrast of the nearby fibre or surface. An opaque, thin
                # bristle can have no fully opaque seed in the model's low-resolution matte.
                distances = np.max(abs(rgb[ny,nx]-bg[:,None]),axis=2)
                peak = np.percentile(distances,90,axis=1)
                signal = np.max(abs(rgb[y,x]-bg),axis=1)
                # A grey cast shadow beside a coloured fibre differs mainly in brightness.
                # Where nearby fibre pixels show colour separation, measure chroma as well.
                shifts = bg[:,None]-rgb[ny,nx]
                chroma = shifts.max(axis=2)-shifts.min(axis=2)
                fibre = np.max(chroma,axis=1)
                shift = bg-rgb[y,x]
                tint = shift.max(axis=1)-shift.min(axis=1)
                colour_edge = (fibre>24)&(np.max(abs(bg-neutral),axis=1)<26)

                a = np.clip((signal-5)/np.maximum(16,.91*peak-5),0,1)
                a = np.where(np.min(distances,axis=1)>18,1,a)
                tint_alpha = np.clip((tint-4)/np.maximum(18,.85*fibre-4),0,1)
                a = np.where(colour_edge & (signal<65), np.minimum(a,tint_alpha), a)
                # Chroma survives a soft shadow on a neutral backdrop. Nearby colour or
                # very dark shaft pixels support extension beyond the original matte.
                saturated = np.clip((tint-7)/20,0,1)
                dark = np.clip((signal-56)/60,0,1)
                seed = np.maximum(prior[y,x],result[j,i]).astype(float)/255
                a = np.minimum(a, np.maximum.reduce([saturated,dark,seed]))
                neutral_shadow = (tint<12)&(signal<50)&(peak<56)
                a = np.where(neutral_shadow,0,a)
                # A well-separated, coloured surface is opaque right up to the boundary.
                a = np.maximum(a,np.clip((tint-14)/22,0,1)*np.clip((np.min(distances,axis=1)-9)/10,0,1))
                # Fine tips can taper below a model pixel. A narrow dark ridge in the original
                # supports the terminal filament even when neighbouring background is in shadow.
                filament = np.clip((ridge[y,x]-5)/24,0,1)*np.clip((signal-8)/24,0,1)
                a = np.maximum(a, filament)
                # Bright paper and pale fibres are lighter than their local backdrop.
                # A shadow veto intended for dark shafts must not eat that side of the edge.
                bright_rise=(rgb[y,x]-bg).mean(axis=1)
                light_seed=(prior[y,x]>32)|(result[j,i]>32)
                light_edge=(bright_rise>3)&light_seed&(np.ptp(rgb[y,x],axis=1)<38)
                if light_edge.any():
                    bright_peak=np.percentile((rgb[ny,nx]-bg[:,None]).mean(axis=2),90,axis=1)
                    light_alpha=np.clip((bright_rise-2)/np.maximum(12,bright_peak-2),0,1)
                    a=np.where(light_edge,np.maximum(a,light_alpha),a)
                a = a*a*(3-2*a)
                # Only extend across a small miss. Never restore a distant excluded subject.
                a = np.where((prior[y,x]<3)&(result[j,i]<3)&(peak<24),0,a)
                if not allow_extension:
                    a = np.minimum(a,np.maximum(prior[y,x],result[j,i])/255.)
                result[j[stable],i[stable]] = np.uint8(np.rint(255*a[stable]))
                partial = stable & (a>0) & (a<1)
                if partial.any():
                    # Remove the photographed background's contribution to a partially covered pixel.
                    recovered = bg + (colours[j,i,:3]-bg)/np.maximum(.12,a[:,None])
                    colours[j[partial],i[partial],:3] = np.uint8(np.rint(recovered[partial].clip(0,255)))
            alpha.paste(Image.fromarray(result),box)
            original.paste(Image.fromarray(colours),box)
    alpha = suppress_shaft_shadows(camera,coarse,alpha,neutral)
    return refit_dark_contour(camera, original, alpha, allow_extension)


def checked_points(points):
    import math
    if not isinstance(points,list) or not 1<=len(points)<=8 or any(
        not isinstance(p,list) or len(p)!=2 or any(type(v) not in (float,int) or
        not math.isfinite(v) or not 0<=v<=1 for v in p) for p in points):
        raise ValueError('请在要补留的主体内部点选 1 至 8 个位置。')
    return points


def palm_centers(model_dir, visible):
    """Decode MediaPipe palm detections on a 192px letterbox into image-relative SAM prompts."""
    import numpy as np
    side=192
    scale=side/max(visible.size)
    width,height=(max(1,round(v*scale)) for v in visible.size)
    left,top=(side-width)//2,(side-height)//2
    patch=np.zeros((1,side,side,3),np.float32)
    patch[0,top:top+height,left:left+width]=np.asarray(visible.resize((width,height),Image.Resampling.BILINEAR).convert('RGB'))/255.
    with _inference_lock:
        detector=subject_session(model_dir/'palm_detection_mediapipe_2023feb.onnx')
        boxes,scores=detector.run(None,{detector.get_inputs()[0].name:patch})
    # Two anchors on each 24x24 cell and six on each 12x12 cell in this export.
    centers=[]
    for grid,repeats in [(24,2),(12,6)]:
        y,x=np.indices((grid,grid))
        centers.append(np.repeat(np.stack((x.ravel()+.5,y.ravel()+.5),axis=1)*side/grid,repeats,axis=0))
    anchors=np.concatenate(centers)
    points=[]
    seen=[]
    for index in np.argsort(scores[0,:,0])[::-1]:
        if scores[0,index,0]<0.4 or len(points)>=8:  # sigmoid(0.4) ≈ 60%
            break
        cx,cy=anchors[index]+boxes[0,index,:2]
        w,h=np.maximum(1,boxes[0,index,2:4])
        if any(abs(cx-x)<min(w,bw)*.55 and abs(cy-y)<min(h,bh)*.55 for x,y,bw,bh in seen):
            continue
        x,y=(cx-left)/width,(cy-top)/height
        if 0<=x<=1 and 0<=y<=1:
            seen.append((cx,cy,w,h))
            points.append([float(x),float(y)])
    if not points:
        raise ValueError('未能定位手部，请选择「补留主体」并点在手背或手掌内部。')
    return points


def checked_subject_marks(marks):
    if not isinstance(marks,list) or not 1<=len(marks)<=8:
        raise ValueError('请在主体内部点选 1 至 8 个位置。')
    for mark in marks:
        if not isinstance(mark,dict) or set(mark)!={'mode','x','y'} or mark['mode'] not in ('keep','remove'):
            raise ValueError('无效的主体选点。')
        checked_points([[mark['x'],mark['y']]])
    return marks


def join_subject_mattes(base, added, pixels):
    """Bridge narrow gaps between two foreground mattes only where the source differs from background."""
    import numpy as np
    union=ImageChops.lighter(base,added)
    # Work at encoder resolution. Close cracks, while protecting genuine background visible between objects.
    hard=union.point(lambda v: 255 if v>=128 else 0)
    a=base.point(lambda v: 255 if v>=128 else 0)
    b=added.point(lambda v: 255 if v>=128 else 0)
    selected=np.asarray(b)>0
    if np.count_nonzero(selected & (np.asarray(a)==0)) < .05*np.count_nonzero(selected):
        return union  # An already retained object has no second silhouette to reconnect.
    reach=ImageFilter.MaxFilter(51)
    close=hard.filter(reach).filter(ImageFilter.MinFilter(51))
    near_both=ImageChops.darker(ImageChops.subtract(a,b).filter(reach),ImageChops.subtract(b,a).filter(reach))
    result=np.asarray(union).copy()
    ys,xs=np.where((np.asarray(near_both)>0)&(result<255))
    if not len(xs):
        return union

    # Sample real exterior background, excluding the crack itself. Require several agreeing samples
    # to classify a pixel as background; a single stray foreground sample is insufficient.
    exterior=np.asarray(ImageChops.lighter(near_both,close).filter(ImageFilter.MaxFilter(11)))==0
    enclosed=np.asarray(close)>0
    h,w=exterior.shape
    angles=np.arange(16)*np.pi/8
    offsets=np.unique(np.rint(np.concatenate([np.column_stack((np.sin(angles),np.cos(angles)))*r
                       for r in (8,16,32,64,120)])).astype(int),axis=0)
    for begin in range(0,len(xs),2048):
        y,x=ys[begin:begin+2048],xs[begin:begin+2048]
        sy=y[:,None]+offsets[:,0]
        sx=x[:,None]+offsets[:,1]
        valid=(sy>=0)&(sx>=0)&(sy<h)&(sx<w)
        sy,sx=sy.clip(0,h-1),sx.clip(0,w-1)
        valid &= exterior[sy,sx]
        dist=np.max(np.abs(pixels[y,x,None]-pixels[sy,sx]),axis=2)
        gap=np.partition(np.where(valid,dist,255.),2,axis=1)[:,2]
        # On a consistent studio background, occasional mask misses in the exterior
        # samples must not veto a real foreground pixel at the contact.
        agreement=((dist<15)&valid).sum(axis=1)/np.maximum(1,valid.sum(axis=1))
        samples=pixels[sy,sx]
        count=np.maximum(1,valid.sum(axis=1,keepdims=True))
        center=(samples*valid[:,:,None]).sum(axis=1)/count
        spread=np.max(np.abs(samples-center[:,None]),axis=2)
        stable=((spread<19)&valid).sum(axis=1)>=.75*count[:,0]
        distance_to_center=np.max(np.abs(pixels[y,x]-center),axis=1)
        gap=np.where(stable & (agreement<.18),np.maximum(gap,distance_to_center-5),gap)
        solid=np.where(valid.sum(axis=1)>=3,np.clip((gap-10)/18,0,1),enclosed[y,x])
        result[y,x]=np.maximum(result[y,x],np.uint8(np.rint(solid*255)))
    return Image.fromarray(result)


def subtract_subject(base, subject, point):
    """When the picked mask describes most of one isolated foreground island, remove its edges too."""
    import numpy as np
    region=base.point(lambda v: 255 if v>=128 else 0)
    if region.getpixel(point):
        ImageDraw.floodfill(region,point,128)
        island=np.asarray(region)==128
        picked=np.asarray(subject)>=128
        overlap=np.count_nonzero(picked & island)
        if overlap>=.62*np.count_nonzero(island) and overlap>=.9*np.count_nonzero(picked):
            contour=Image.fromarray(np.uint8(island)*255).filter(ImageFilter.MaxFilter(7))
            subject=ImageChops.lighter(subject,contour)
    return ImageChops.darker(base,ImageOps.invert(subject))


def include_objects(model_dir, visible, marks, mask):
    """Encode once, then apply the requested object selections in click order."""
    import numpy as np
    scale=1024/max(visible.size)
    size=tuple(max(1,round(v*scale)) for v in visible.size)
    pixels=np.asarray(visible.convert('RGB').resize(size,Image.Resampling.BILINEAR),dtype=np.float32)
    with _inference_lock:
        encoder=subject_session(model_dir/'mobile_sam_image_encoder.onnx')
        decoder=subject_session(model_dir/'sam_mask_decoder_multi.onnx')
        embedding=encoder.run(None,{'input_image':pixels})[0]
        base=mask.resize(size,Image.Resampling.BILINEAR)
        for mark in marks:
            px,py=mark['x']*(size[0]-1),mark['y']*(size[1]-1)
            logits,scores=decoder.run(['masks','iou_predictions'],{
                'image_embeddings':embedding,'point_coords':np.float32([[[px,py],[0,0]]]),
                'point_labels':np.float32([[1,-1]]),'mask_input':np.zeros((1,1,256,256),np.float32),
                'has_mask_input':np.zeros(1,np.float32),'orig_im_size':np.float32(size[::-1])})
            for index in np.argsort(scores[0])[::-1]:
                region=logits[0,index]
                if region[round(py),round(px)]>0 and (region>0).mean()<.94:
                    alpha=255/(1+np.exp(-np.clip(region*1.8,-50,50)))
                    subject=Image.fromarray(np.uint8(np.rint(alpha)))
                    if mark['mode']=='remove':
                        base=subtract_subject(base,subject,(round(px),round(py)))
                    elif base.getbbox() is None:
                        base=subject
                    else:
                        base=join_subject_mattes(base,subject,pixels)
                    break
            else:
                raise ValueError('这个点没有识别到独立主体，请点在主体内部再试。')
    return base


def subject_probability(model_path, rgb, category=None):
    from onnxruntime.capi.onnxruntime_pybind11_state import RuntimeException
    import numpy as np
    tensor = np.asarray(rgb, dtype=np.float32)
    tensor /= max(float(tensor.max()), 1)
    tensor -= np.array([.485, .456, .406], dtype=np.float32)
    tensor /= np.array([.229, .224, .225], dtype=np.float32)
    with _inference_lock:
        session = subject_session(model_path)
        try:
            logits = session.run([session.get_outputs()[0].name], {
                session.get_inputs()[0].name: tensor.transpose(2, 0, 1)[None]
            })[0].squeeze()
        except (MemoryError, RuntimeException) as exc:
            if isinstance(exc, MemoryError) or 'bad allocation' in str(exc).lower() or 'out of memory' in str(exc).lower():
                fallback=model_path.with_name('u2netp.onnx')
                if category!='brush' or not fallback.is_file():
                    raise ValueError('本机可用内存不足，请稍后重试抠图。') from exc
                compact=subject_session(fallback)
                small=np.asarray(rgb.resize((320,320),Image.Resampling.LANCZOS),dtype=np.float32)
                small/=max(1.,float(small.max()))
                small=(small-np.float32([.485,.456,.406]))/np.float32([.229,.224,.225])
                mask=compact.run([compact.get_outputs()[0].name],{compact.get_inputs()[0].name:small.transpose(2,0,1)[None]})[0].squeeze()
                spread=float(np.ptp(mask))
                if spread<.4 or not np.isfinite(mask).all():
                    raise ValueError('轻量模型没有找到清晰的主体，请点选商品。') from exc
                resized=Image.fromarray((mask-mask.min())/spread).resize(rgb.size,Image.Resampling.BILINEAR)
                return np.asarray(resized)
            raise
    return 1 / (1 + np.exp(-np.clip(logits, -60, 60)))


def recover_pale_attachments(model_path, rgb, mask, category=None):
    """Use an alternate model view for pale attached panels on a uniform studio set."""
    import cv2
    import numpy as np
    alpha = np.array(mask)
    pixels = np.asarray(rgb)
    outside = pixels[::8,::8][alpha[::8,::8]<8].astype(np.int16)
    if len(outside)<128:
        return mask
    neutral = np.median(outside,axis=0)
    if neutral.min()<145 or np.ptp(neutral)>30 or np.mean(np.max(abs(outside-neutral),axis=1)<25)<.75:
        return mask
    rotated = subject_probability(model_path,rgb.transpose(Image.Transpose.ROTATE_90),category)
    alternate = np.rot90(np.rint(rotated*255).astype(np.uint8),-1)
    n,labels,stats,_ = cv2.connectedComponentsWithStats(((alternate>220)&(alpha<128)).astype(np.uint8))
    for k in range(1,n):
        x,y,w,h,area = stats[k]
        if area<alpha.size*.006:
            continue
        box = np.s_[max(0,y-15):y+h+15,max(0,x-15):x+w+15]
        component = (labels[box]==k).astype(np.uint8)
        support = cv2.dilate(component,np.ones((9,9),np.uint8)).astype(bool)
        if np.count_nonzero(support & (alpha[box]>220))<12:
            continue
        sample = pixels[box][component!=0][::4]
        if np.mean((sample.min(1)>145) & (np.ptp(sample,axis=1)<35))<.8:
            continue
        nearby = cv2.dilate(component,np.ones((29,29),np.uint8)).astype(bool)
        bg = pixels[box][nearby & (alpha[box]<16) & (alternate[box]<16)][::4]
        if len(bg)<32:
            continue
        # A neutral cast shadow darkens all channels together. Require a tint
        # difference from the adjacent background before admitting new coverage.
        tint_difference = np.median(sample,axis=0)-np.median(bg,axis=0)
        if np.ptp(tint_difference)>5:
            np.maximum(alpha[box],alternate[box],out=alpha[box],where=support)
    return Image.fromarray(alpha)


def recover_pale_inserts(rgb, mask):
    """Recover a pale sheet enclosed by a darker cover when it differs from nearby backdrop."""
    import cv2
    import numpy as np
    alpha = np.array(mask)
    n, labels, regions, _ = cv2.connectedComponentsWithStats((alpha < 248).astype(np.uint8))
    border = np.unique(np.concatenate((labels[0], labels[-1], labels[:,0], labels[:,-1])))
    exterior = np.isin(labels, border[border != 0]) & (alpha < 16)
    pixels = np.asarray(rgb)
    for label in range(1,n):
        x,y,w,h,area = regions[label]
        if label in border or area < alpha.size * .012 or area < .64*w*h:
            continue
        region = np.s_[y:y+h,x:x+w]
        inside = labels[region] == label
        paper = pixels[region][inside][::8].astype(np.int16)
        if np.percentile(paper.min(1),20) < 200 or np.percentile(np.ptp(paper,axis=1),80) > 12:
            continue
        pad = max(w,h)//2
        near = np.s_[max(0,y-pad):y+h+pad,max(0,x-pad):x+w+pad]
        background = pixels[near][exterior[near]][::8].astype(np.int16)
        if len(background)<128:
            continue
        # Compare both brightness and tint. Preserve real openings onto the same
        # backdrop even on a gradient, and defer coloured or ambiguous holes.
        light, cast = paper.mean(1), np.ptp(paper, axis=1)
        if (np.percentile(light,25) > np.percentile(background.mean(1),75)+4
                and np.percentile(cast,75)+3 < np.percentile(np.ptp(background,axis=1),25)):
            alpha[region][inside] = 255
    return Image.fromarray(alpha)


def refine_tapered_tips(source, output, matte):
    """Remove captured backdrop colour where a long dark tip narrows below optical resolution."""
    import cv2
    import numpy as np
    scale=min(1.,2048/max(matte.size))
    size=tuple(max(1,round(n*scale)) for n in matte.size)
    if min(size)<32:
        return matte
    a=np.asarray(matte.resize(size,Image.Resampling.BILINEAR))
    solid=(a>110).astype('uint8')
    # Find thin protrusions, excluding broad edges of a larger body. Demand a
    # nearby darker, opaque core on the same narrow component.
    inside=cv2.distanceTransform(solid,cv2.DIST_L2,5)
    broad=cv2.dilate((inside>4).astype('uint8'),np.ones((9,9),np.uint8))
    narrow=(a>8)&(broad==0)
    if not narrow.any():
        return matte
    with Image.open(source) as file:
        camera=ImageOps.exif_transpose(file).convert('RGB')
    rgb=np.asarray(camera.resize(size,Image.Resampling.BILINEAR))
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    surround=cv2.GaussianBlur((a<6).astype('float32'),(0,0),6)
    bg=cv2.GaussianBlur(rgb*(a<6)[:,:,None].astype('float32'),(0,0),6)/np.maximum(surround[:,:,None],.001)
    core=np.where((a>205)&(gray<130),gray,255).astype('uint8')
    window=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(27,27))
    dark=cv2.erode(core,window)
    valid=narrow&(dark<125)&(surround>.23)&(bg.min(2)>150)&(np.ptp(bg,axis=2)<28)
    if not valid.any():
        return matte
    # Blend the change continuously as the tip approaches its thicker base.
    confidence=Image.fromarray(cv2.GaussianBlur(np.uint8(valid)*255,(0,0),1.2))
    bg_image=Image.fromarray(np.uint8(np.clip(bg,0,255)))
    dark_image=Image.fromarray(dark)
    result=matte.copy()
    for top in range(0,matte.height,512):
        for left in range(0,matte.width,512):
            box=(left,top,min(left+512,matte.width),min(top+512,matte.height))
            region=tuple(v*n/o for v,n,o in zip(box,size*2,matte.size*2))
            if not confidence.crop(tuple(map(round,region))).getbbox():
                continue
            alpha=np.array(matte.crop(box));h,w=alpha.shape
            def tile(field):
                return np.asarray(field.resize((w,h),Image.Resampling.BILINEAR,box=region),dtype=np.float32)
            weight=tile(confidence)/255
            indices=(alpha>0)&(weight>.05)
            background=tile(bg_image)[indices]
            observed=np.asarray(camera.crop(box),dtype=np.float32)[indices]
            difference=background.mean(1)-observed.mean(1)
            coverage=np.clip(difference/np.maximum(35,background.mean(1)-tile(dark_image)[indices]),0,1)
            strength=weight[indices]*np.clip((difference-4)/12,0,1)
            old=alpha[indices].astype(float)
            alpha[indices]=np.uint8(np.rint(old+strength*(np.minimum(old,coverage*255)-old)))
            colour=np.array(output.crop(box));current=colour[indices,:3].astype(float)
            recovered=background+(observed-background)/np.maximum(.08,coverage[:,None])
            colour[indices,:3]=np.uint8(np.clip(np.rint(current+(recovered-current)*strength[:,None]),0,255))
            result.paste(Image.fromarray(alpha),box);output.paste(Image.fromarray(colour),box)
    return result


def refine_paper_and_bristles(source, output, matte):
    """Use local foreground and background colour to reconstruct a pale, opaque edge."""
    import cv2
    import numpy as np
    scale=min(1.,2048/max(matte.size))
    size=tuple(max(1,round(n*scale)) for n in matte.size)
    if min(size)<32:
        return matte
    with Image.open(source) as camera:
        camera.draft('RGB',size)
        rgb=np.asarray(ImageOps.exif_transpose(camera).resize(size,Image.Resampling.BILINEAR).convert('RGB'),dtype=np.float32)
    a=np.asarray(matte.resize(size,Image.Resampling.BILINEAR))
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15))
    inside=cv2.erode((a>248).astype('uint8'),kernel)
    outside=cv2.erode((a<5).astype('uint8'),kernel)
    band=cv2.dilate((a>100).astype('uint8'),kernel)!=0
    def colour_field(seeds):
        mass=cv2.GaussianBlur(seeds.astype('float32'),(0,0),10)
        average=cv2.GaussianBlur(rgb*seeds[:,:,None],(0,0),10)/np.maximum(mass[:,:,None],.0001)
        return mass,average
    fm,fg=colour_field(inside);bm,bg=colour_field(outside)
    vector=fg-bg
    valid=(fm>.042)&(bm>.042)&band&(inside==0)&(fg.min(2)>165)&(np.ptp(fg,axis=2)<25)
    light_anchor=(vector.mean(2)>12)&(fg.min(2)>180)&(fm>.04)&(bm>.04)
    nearby=cv2.dilate(light_anchor.astype('uint8'),kernel,iterations=3)!=0
    valid&=nearby&(vector.mean(2)<85)&(np.ptp(bg,axis=2)<45)
    valid&=(vector.mean(2)>10)|((vector.mean(2)>-7)&(np.ptp(vector,axis=2)>8))
    # Combine brightness with tint. Horizontal page-layer shadows can have the
    # background's brightness yet still retain the colour of paper.
    def metric(c):
        return c+2*(c-c.mean(2,keepdims=True))
    direction=metric(vector)
    fraction=(metric(rgb-bg)*direction).sum(2)/np.maximum(1,(direction*direction).sum(2))
    binary=(fraction>.45).astype('uint8')
    support=cv2.morphologyEx(binary,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
    smooth=cv2.GaussianBlur(support.astype('float32'),(0,0),.65)
    evidence=np.clip((smooth-.16)/.68,0,1)
    revised=np.where(valid,np.maximum(a,np.rint(evidence*255)),a).astype('uint8')
    # Upsample just the recovered coverage. Keep the native contour elsewhere.
    increase=np.maximum(revised.astype('int16')-a,0).astype('uint8')
    result=matte
    if np.any(increase>12):
        addition=Image.fromarray(increase).resize(matte.size,Image.Resampling.BILINEAR)
        with Image.open(source) as camera:
            output.paste(ImageOps.exif_transpose(camera).convert('RGB'),mask=addition.point(lambda v:min(255,3*v)))
        result=ImageChops.add(matte,addition)
    # Neutral studio light can mix into the outer hairs of a warm brush. Solve
    # coverage from the observed RGB against nearby clean bristles and backdrop.
    warm=(fg[:,:,0]-fg[:,:,2]>18)&(np.ptp(bg,axis=2)<30)&(bg.min(2)>140)
    warm&=(fm>.01)&(bm>.01)&(np.linalg.norm(vector,axis=2)>27)&band
    if not warm.any():
        return result
    warm_map=Image.fromarray(cv2.GaussianBlur(np.uint8(warm)*255,(0,0),2.5))
    bg_map=Image.fromarray(np.uint8(np.clip(bg,0,255)))
    fg_map=Image.fromarray(np.uint8(np.clip(fg,0,255)))
    with Image.open(source) as photo:
        camera=ImageOps.exif_transpose(photo).convert('RGB')
    if result is matte:
        result=matte.copy()
    for top in range(0,output.height,512):
        for left in range(0,output.width,512):
            box=(left,top,min(left+512,output.width),min(top+512,output.height))
            region=tuple(v*s/n for v,s,n in zip(box,size*2,output.size*2))
            if not warm_map.crop(tuple(map(round,region))).getbbox():
                continue
            alpha=np.array(result.crop(box));h,w=alpha.shape
            confidence=np.asarray(warm_map.resize((w,h),Image.Resampling.BILINEAR,box=region))/255.
            active=(confidence>.05)&(alpha>0)
            if not active.any():
                continue
            def field(image):
                return np.asarray(image.resize((w,h),Image.Resampling.BILINEAR,box=region),dtype=np.float32)[active]
            background=field(bg_map);delta=field(fg_map)-background
            observed=np.asarray(camera.crop(box),dtype=np.float32)[active]
            contrast=metric(delta.reshape(-1,1,3))[:,0]
            measured=metric((observed-background).reshape(-1,1,3))[:,0]
            coverage=np.clip((contrast*measured).sum(1)/np.maximum(1,(contrast*contrast).sum(1)),0,1)
            error=np.linalg.norm(observed-background-coverage[:,None]*delta,axis=1)
            # Reject cast shadows and any colour inconsistent with this local hair.
            good=(error<20)&(coverage<.98)
            if not good.any():
                continue
            yy,xx=np.nonzero(active);yy,xx=yy[good],xx[good]
            c=coverage[good]
            weight=.64*confidence[yy,xx]*np.clip((20-error[good])/11,0,1)
            target=np.minimum(alpha[yy,xx],255*c)
            bounded=np.rint(alpha[yy,xx]+weight*(target-alpha[yy,xx])).astype('uint8')
            rgb_out=np.array(output.crop(box))
            recovered=background[good]+(observed[good]-background[good])/np.maximum(.08,c[:,None])
            current=rgb_out[yy,xx,:3].astype('float32')
            rgb_out[yy,xx,:3]=np.clip(np.rint(current+(recovered-current)*weight[:,None]),0,255).astype('uint8')
            alpha[yy,xx]=bounded
            output.paste(Image.fromarray(rgb_out),box);result.paste(Image.fromarray(alpha),box)
    return result


def restore_page_notches(original, matte):
    """Fill short bites in a pale page stack only where the photo supports paper colour."""
    import cv2
    import numpy as np
    scale=min(1,2048/max(matte.size))
    size=tuple(max(1,round(v*scale)) for v in matte.size)
    a=np.asarray(matte.resize(size,Image.Resampling.BILINEAR))
    rgb=np.asarray(original.resize(size,Image.Resampling.BILINEAR).convert('RGB'),dtype=np.float32)
    radius=max(3,round(max(size)*.009))
    disk=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*radius+1,2*radius+1))
    closed=cv2.morphologyEx(a,cv2.MORPH_CLOSE,disk)
    diff=cv2.subtract(closed,a)
    if diff.max()<24:
        return matte
    # Compare tint separately from brightness. Individual page seams are dark
    # even when the surrounding sheet is paler than the photographic backdrop.
    def local(seed):
        blur=lambda v:cv2.GaussianBlur(v,(0,0),radius*.8)
        mass=blur(seed)
        return mass,blur(rgb*seed[:,:,None])/np.maximum(mass[:,:,None],.001)
    foreground,fg=local(((a>243)&(rgb.min(2)>160)&(np.ptp(rgb,axis=2)<32)).astype('float32'))
    outer=cv2.erode((a<8).astype('uint8'),disk).astype('float32')
    background,bg=local(outer)
    tint=lambda col:col-col.mean(2,keepdims=True)
    delta=tint(fg-bg)
    leverage=(delta**2).sum(2)
    fraction=(tint(rgb-bg)*delta).sum(2)/np.maximum(leverage,1)
    supported=(foreground>.13)&(background>.018)&(rgb.min(2)>155)&(np.ptp(rgb,axis=2)<34)&(leverage>12)
    blend=np.clip((fraction-.26)/.54,0,1)*supported
    gain=Image.fromarray(np.uint8(np.rint(diff*blend)))
    if gain.getbbox() is None:
        return matte
    return ImageChops.add(matte,gain.resize(matte.size,Image.Resampling.BILINEAR))


def align_pale_straight_edges(original, matte):
    """Refit only long pale silhouette spans supported by a real edge in the camera image."""
    import cv2
    import numpy as np
    scale=min(1.,2048/max(original.size))
    size=tuple(max(1,round(n*scale)) for n in original.size)
    if min(size)<32:
        return matte
    rgb=np.asarray(original.resize(size,Image.Resampling.LANCZOS).convert('RGB'))
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    alpha=np.asarray(matte.resize(size,Image.Resampling.BILINEAR))
    # Examine only a narrow band at the existing silhouette. Ignore dark objects,
    # colourful props and marks; never trace an interior mould line as an outer edge.
    pale=(rgb.min(2)>128)&(np.ptp(rgb,axis=2)<38)
    if np.count_nonzero(pale & (alpha>192))<150:
        return matte
    near=cv2.morphologyEx((alpha>127).astype('uint8'),cv2.MORPH_GRADIENT,np.ones((11,11),np.uint8))
    lines=cv2.createLineSegmentDetector().detect(gray)[0]
    if lines is None:
        return matte
    ratio=np.array(original.size)/size
    def sample(a,p):
        ij=np.rint(p).astype(int)
        return a[np.clip(ij[...,1],0,size[1]-1),np.clip(ij[...,0],0,size[0]-1)]
    fixed=None
    spans=[]
    for raw in lines[:,0]:
        a,b=raw[:2],raw[2:]
        length=np.linalg.norm(b-a)
        if length<max(30,max(size)*.018):
            continue
        direction=(b-a)/length
        normal=np.array([-direction[1],direction[0]])
        t=np.linspace(3,length-3,min(128,max(12,int(length/3))))
        points=a+t[:,None]*direction
        if sample(near,points).mean()<.88:
            continue
        outer=sample(alpha,points+normal*5).astype(float); inner=sample(alpha,points-normal*5).astype(float)
        if np.median(outer)>np.median(inner):
            normal=-normal;inner,outer=outer,inner
        if np.mean((inner>230)&(outer<25))<.90:
            continue
        inside=points-normal*3;outside=points+normal*4
        if min(sample(pale,inside).mean(),sample(pale,outside).mean())<.84:
            continue
        # The physical lip commonly darkens towards a cast shadow; the second,
        # reverse-polarity line is the far side of that shadow. Reject it.
        trace=np.stack([sample(gray,points+normal*k) for k in (-2,-1,0,1,2)]).astype(float)
        if np.mean((trace[0]-trace[-1])>3)<.76 or np.median(trace[1]-trace[3])<3:
            continue
        spans.append((a.copy(),b.copy(),normal.copy()))
    # At a re-entrant corner the end of a vertical mould line may continue up
    # across solid plastic. Join measured spans before painting either half-plane.
    joins=[]
    for i,(a,b,n) in enumerate(spans):
        for c,e,m in spans[:i]:
            if abs(n@m)>.32:
                continue
            if min(np.linalg.norm(u-v) for u in (a,b) for v in (c,e))>15:
                continue
            pt=np.linalg.solve([n,m],[n@a,m@c])
            if max(min(np.linalg.norm(pt-u) for u in (a,b)),min(np.linalg.norm(pt-u) for u in (c,e)))>13:
                continue
            # Require the two mixed quadrants to be solid: a concave junction,
            # never an ordinary rounded outer corner or an internal highlight.
            if min(sample(alpha,pt+(n-m)*9),sample(alpha,pt+(m-n)*9))>235 and sample(alpha,pt+(n+m)*9)<20:
                joins.append((pt,n,m))
    for a,b,normal in spans:
        length=np.linalg.norm(b-a);direction=(b-a)/length
        # Work in a tight output tile. Distances use analysis pixels while the
        # antialiasing ramp is a single output pixel even on a 40 MP photograph.
        # A diagonal across a high-resolution photograph has a huge rectangular
        # bounding box; bound scratch storage while keeping the original line.
        step=max(1,int(640/max(ratio)))
        for offset in range(0,int(np.ceil(length)),step):
            start=a+direction*offset;end=a+direction*min(length,offset+step)
            lo=np.maximum(0,np.floor((np.minimum(start,end)-8)*ratio).astype(int))
            hi=np.minimum(original.size,np.ceil((np.maximum(start,end)+8)*ratio).astype(int))
            x,y=np.meshgrid((np.arange(lo[0],hi[0])+.5)/ratio[0]-.5-a[0],
                            (np.arange(lo[1],hi[1])+.5)/ratio[1]-.5-a[1],sparse=True)
            along=x*direction[0]+y*direction[1];cross=x*normal[0]+y*normal[1]
            # Fade into the old matte at real corners and beyond the measured line.
            weight=np.clip(np.minimum(along+1,length+1-along)/3,0,1)*np.clip((6-abs(cross))/2,0,1)
            weight*=((along>=offset) if offset else True)
            if offset+step<length:
                weight*=along<offset+step
            if fixed is None:
                fixed=matte.copy()
            box=(*lo,*hi);old=np.asarray(fixed.crop(box))
            fresh=np.clip(.5-cross*scale**-1,0,1)*255
            fixed.paste(Image.fromarray(np.uint8(np.rint(old+(fresh-old)*weight))),box)
    for pt,n,m in joins:
        lo=np.maximum(0,np.floor((pt-16)*ratio).astype(int))
        hi=np.minimum(original.size,np.ceil((pt+16)*ratio).astype(int))
        x,y=np.meshgrid((np.arange(lo[0],hi[0])+.5)/ratio[0]-.5-pt[0],
                        (np.arange(lo[1],hi[1])+.5)/ratio[1]-.5-pt[1],sparse=True)
        cross=np.minimum(x*n[0]+y*n[1],x*m[0]+y*m[1])
        w=np.clip((15-np.hypot(x,y))/3,0,1)
        box=(*lo,*hi); old=np.asarray(fixed.crop(box))
        val=np.clip(.5-cross/scale,0,1)*255
        fixed.paste(Image.fromarray(np.uint8(np.rint(old+(val-old)*w))),box)
    return fixed if fixed is not None else matte


def rigid_tray_matte(original, mask):
    """Trace a moulded tray on a neutral set using the colour of its plastic and the actual cutouts."""
    import cv2
    import numpy as np
    scale = min(1,1280/max(original.size))
    thumb = original.resize(tuple(max(1,round(n*scale)) for n in original.size),Image.Resampling.LANCZOS).convert('RGB')
    if not has_mixing_wells(thumb):
        return None
    rgb = cv2.GaussianBlur(np.asarray(thumb).astype(np.float32),(0,0),1.)
    coarse = np.asarray(mask.resize(thumb.size,Image.Resampling.BILINEAR))
    tint = rgb-rgb.mean(2,keepdims=True)
    outside = tint[::3,::3][coarse[::3,::3]<4]
    inside = (coarse>246)&(rgb.min(2)>150)&(np.ptp(rgb,axis=2)<32)
    if len(outside)<200 or inside.mean()<.035:
        return None
    background = np.median(outside,axis=0)
    direction = np.median(tint[inside],axis=0)-background
    separation = np.linalg.norm(direction)
    if separation<3:
        return None
    projection = (tint-background)@(direction/separation)
    bg_range = np.percentile((outside-background)@(direction/separation),98)
    if bg_range>separation*.65:
        return None
    # Cast shadows lower brightness but generally retain the backdrop's chromaticity.
    pale = projection>max(bg_range+.6,separation*.38)
    support = cv2.dilate((coarse>100).astype('uint8'),cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(85,85)))
    candidate = (pale | ((coarse>140)&(rgb.min(2)<135))) & (support!=0)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(7,7))
    clean = cv2.morphologyEx(candidate.astype('uint8'),cv2.MORPH_CLOSE,kernel)
    clean = cv2.medianBlur(clean,5)
    contours,tree = cv2.findContours(clean,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    if tree is None:
        return None
    outer = max(range(len(contours)),key=lambda i:cv2.contourArea(contours[i]))
    shape = np.zeros_like(coarse)
    cv2.drawContours(shape,contours,outer,255,-1)
    trusted = coarse>240
    if (trusted&(shape!=0)).sum()<trusted.sum()*.98 or (shape!=0).sum()>trusted.sum()*1.32:
        return None
    # Preserve holes and other independently selected items from the semantic mask.
    holes,hierarchy = cv2.findContours((coarse>127).astype('uint8'),cv2.RETR_CCOMP,cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return None
    for i,contour in enumerate(holes):
        if hierarchy[0,i,3]<0 and cv2.contourArea(contour)>max(8,coarse.size*.00010):
            points=contour[:,0,:]
            if np.mean(shape[points[:,1],points[:,0]]!=0)<.15:
                return None  # A separate accessory needs the normal multiple-object matte.
    ratio = np.array(original.size)/np.array(thumb.size)
    result = np.zeros((original.height,original.width),np.uint8)
    def render(contour,fill,tolerance):
        polygon = cv2.approxPolyDP(contour,tolerance,True)[:,0,:].astype(float)
        if len(polygon)<3:
            return
        # Keep long straight spans; round only the last few pixels at each measured vertex.
        last,following = np.roll(polygon,1,axis=0),np.roll(polygon,-1,axis=0)
        def tangent(neighbours):
            delta=neighbours-polygon
            return polygon+delta*np.minimum(.24,2./np.maximum(1,np.linalg.norm(delta,axis=1)))[:,None]
        before,after=tangent(last),tangent(following)
        curve=np.stack((before,.25*before+.5*polygon+.25*after,after),axis=1).reshape(-1,2)
        coords=np.rint(((curve+.5)*ratio-.5)*256).astype(np.int32)
        cv2.fillPoly(result,[coords],fill,lineType=cv2.LINE_AA,shift=8)
    render(contours[outer],255,1.35)
    for i,contour in enumerate(holes):
        if hierarchy[0,i,3]>=0 and cv2.contourArea(contour)>8:
            x,y,w,h=cv2.boundingRect(contour)
            local=np.zeros((h,w),np.uint8)
            cv2.drawContours(local,[contour-(x,y)],0,1,-1)
            # The tabletop seen through a deep finger hole can itself be tinted by the lid.
            # A sizeable enclosed opening in the model mask takes precedence over panel colour.
            if cv2.contourArea(contour)>coarse.size*.00065 or np.mean(pale[y:y+h,x:x+w][local!=0])<.70:
                perimeter=cv2.arcLength(contour,True)
                circle=4*np.pi*cv2.contourArea(contour)/(perimeter**2) if perimeter else 0
                if circle>.81 and len(contour)>=12 and .78<w/h<1.28:
                    ellipse=cv2.fitEllipse(contour)
                    (cx,cy),(ew,eh),angle=ellipse
                    if abs(ratio[0]-ratio[1])<.015*ratio[0]:
                        center=tuple(np.rint(((np.array([cx,cy])+.5)*ratio-.5)*256).astype(int))
                        axes=tuple(np.rint(np.array([ew,eh])*ratio*128).astype(int))
                        cv2.ellipse(result,center,axes,angle,0,360,0,-1,cv2.LINE_AA,8)
                        continue
                render(contour,0,.60)
    return Image.fromarray(result)


def segment_subject(model_path, source, output, points=None, only_picked=False, hands=False, marks=None, category=None):
    import numpy as np
    original = upright(source)
    source_alpha = original.getchannel('A')
    # Use a neutral backdrop at inference time so hidden RGB cannot influence the subject.
    opaque = source_alpha.getextrema() == (255,255)
    visible = original if opaque else Image.alpha_composite(Image.new('RGBA', original.size, 'white'), original)
    if hands:
        points=palm_centers(model_path.parent,visible)
    if points:
        marks=[{'x':x,'y':y,'mode':'keep'} for x,y in checked_points(points)]
    if only_picked:
        checked_subject_marks(marks)
        mask=Image.new('L',(1024,1024))
    else:
        rgb = (visible.resize((1024,1024),Image.Resampling.LANCZOS).convert('RGB') if opaque
               else visible.convert('RGB').resize((1024,1024),Image.Resampling.LANCZOS))
        if category is None and opaque and not marks and not hands:
            category=recognize(source,model_path.parent/'product-recognition')
        probability = subject_probability(model_path,rgb,category)
        if (probability.max() < .85 or probability.min() > .15) and not marks:
            raise ValueError('未能可靠区分商品和背景，请换一张主体更清楚的图片。')
        mask = Image.fromarray(np.rint(probability * 255).astype('uint8'))
        if opaque:
            mask = recover_pale_attachments(model_path, rgb, mask,category)
            mask = recover_pale_inserts(rgb, mask)
    if marks:
        if not only_picked and probability.min()>.15:
            mask=Image.new('L',mask.size)
        mask=include_objects(model_path.parent,visible,checked_subject_marks(marks),mask)
    if not marks and not hands and not only_picked and opaque:
        rigid = rigid_tray_matte(original,mask)
        if rigid is not None:
            original.putalpha(align_pale_straight_edges(original,rigid))
            original.save(output,format='PNG',icc_profile=original.info.get('icc_profile'))
            return
    coarse = mask.resize(original.size, Image.Resampling.LANCZOS)
    refine = refine_selected_edges if marks else refine_edges
    matte = refine(original, coarse)
    extend = not any(mark['mode']=='remove' for mark in (marks or []))
    alpha = ImageChops.darker(source_alpha, studio_edge_detail(original, coarse, matte, extend))
    if opaque and not marks and not only_picked and not hands:
        alpha=align_pale_straight_edges(original,alpha)
        alpha=refine_paper_and_bristles(source,original,alpha)
        alpha=refine_tapered_tips(source,original,alpha)
        if (category or recognize(source,model_path.parent/'product-recognition'))=='paper':
            alpha=restore_page_notches(visible,alpha)
    if alpha.getextrema()[1] < 128:
        raise ValueError('没有剩余的可见主体，请撤销移除点或补选要保留的物体。' if marks else '未识别到可见商品。')
    original.putalpha(alpha)
    original.save(output, format='PNG', icc_profile=original.info.get('icc_profile'))


async def cutout(model_path, source, output, points=None, only_picked=False, hands=False, marks=None, category=None):
    await asyncio.to_thread(segment_subject, model_path, source, output, points, only_picked, hands, marks, category)
