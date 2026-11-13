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

RECIPES = {'cutout': ('transparent', 'hands', 'include', 'pick', 'subjects'), 'retouch': ('brush', 'paint', 'paper', 'toy'), 'upscale': ('2', '4', 'fit')}


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
    if option == 'fit':
        size = (min(4*width, isqrt(MAX_IMAGE_PIXELS*width//height)),
                min(4*height, isqrt(MAX_IMAGE_PIXELS*height//width)))
    else:
        size = (width*int(option), height*int(option))
    if size[0]*size[1] > MAX_IMAGE_PIXELS or size == (width,height):
        raise ValueError('当前尺寸无法按所选倍率放大，单次输出上限为 6400 万像素。')
    return size


def studio_white_balance(source):
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
    if len(neutrals)<3 or np.max(np.ptp(neutrals,axis=0))>24:
        return (1.,1.,1.),0.
    neutral = np.median(neutrals,axis=0)
    return np.clip(neutral.mean()/neutral,.96,1.04),min(.28,max(0.,(245-neutral.mean())/155))


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
    contrast, sharpness, limit = {'brush': (.12, 65, 4), 'paint': (.06, 35, 2),
                                 'paper': (.045, 40, 2), 'toy': (.10, 50, 3)}[option]
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


def retouch_or_enlarge(source, output, tool, option, balance=None):
    image = upright(source)
    if tool == 'upscale':
        size = upscale_size(image.width,image.height,option)
        result = image.resize(size, Image.Resampling.LANCZOS)
    else:
        # Adjust luminance only. Preserve original chroma, markings and alpha.
        option,background,ev,framing = retouch_settings(option)
        if balance is None:
            balance = studio_white_balance(source)
        if framing=='center':
            # Crop to visible pixels including the antialiased fringe. Keep near-full-frame closeups.
            bounds=image.getchannel('A').getbbox()
            if bounds and (bounds[2]-bounds[0]<image.width*.95 and bounds[3]-bounds[1]<image.height*.95):
                subject=image.crop(bounds)
                subject=ImageOps.contain(subject,(max(1,round(image.width*.88)),max(1,round(image.height*.88))),Image.Resampling.LANCZOS)
                framed=Image.new('RGBA',image.size)
                framed.paste(subject,((image.width-subject.width)//2,(image.height-subject.height)//2))
                framed.info.update(image.info)
                image=framed
        result = Image.new('RGB' if background=='white' else 'RGBA',image.size,'white')
        for y in range(0,image.height,768):
            for x in range(0,image.width,768):
                right,bottom=min(x+768,image.width),min(y+768,image.height)
                # Include neighboring pixels for the 0.85px unsharp mask on each tile boundary.
                left,top=max(0,x-8),max(0,y-8)
                tile=image.crop((left,top,min(image.width,right+8),min(image.height,bottom+8)))
                polished=retouch_color(tile.convert('RGB'),option,ev,balance)
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
    _, background, _, _ = retouch_settings(option)
    if background=='white':
        def has_cutout():
            im = upright(source)
            return im.getchannel('A').getextrema()[0] < 16
        if not await asyncio.to_thread(has_cutout):
            with tempfile.TemporaryDirectory(dir=output.parent) as folder:
                transparent = Path(folder)/'subject.png'
                await cutout(model_path,source,transparent)
                balance = await asyncio.to_thread(studio_white_balance,source)
                await asyncio.to_thread(retouch_or_enlarge,transparent,output,'retouch',option,balance)
            return
    await asyncio.to_thread(retouch_or_enlarge,source,output,'retouch',option)


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


def segment_subject(model_path, source, output, points=None, only_picked=False, hands=False, marks=None):
    import numpy as np
    original = upright(source)
    source_alpha = original.getchannel('A')
    # Use a neutral backdrop at inference time so hidden RGB cannot influence the subject.
    visible = Image.alpha_composite(Image.new('RGBA', original.size, 'white'), original)
    if hands:
        points=palm_centers(model_path.parent,visible)
    if points:
        marks=[{'x':x,'y':y,'mode':'keep'} for x,y in checked_points(points)]
    if only_picked:
        checked_subject_marks(marks)
        mask=Image.new('L',(1024,1024))
    else:
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
        if (probability.max() < .85 or probability.min() > .15) and not marks:
            raise ValueError('未能可靠区分商品和背景，请换一张主体更清楚的图片。')
        mask = Image.fromarray(np.rint(probability * 255).astype('uint8'))
    if marks:
        if not only_picked and probability.min()>.15:
            mask=Image.new('L',mask.size)
        mask=include_objects(model_path.parent,visible,checked_subject_marks(marks),mask)
    coarse = mask.resize(original.size, Image.Resampling.LANCZOS)
    refine = refine_selected_edges if marks else refine_edges
    alpha = ImageChops.darker(source_alpha, refine(original, coarse))
    if alpha.getextrema()[1] < 128:
        raise ValueError('没有剩余的可见主体，请撤销移除点或补选要保留的物体。' if marks else '未识别到可见商品。')
    original.putalpha(alpha)
    original.save(output, format='PNG', icc_profile=original.info.get('icc_profile'))


async def cutout(model_path, source, output, points=None, only_picked=False, hands=False, marks=None):
    await asyncio.to_thread(segment_subject, model_path, source, output, points, only_picked, hands, marks)
