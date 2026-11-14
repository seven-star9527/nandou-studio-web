"""Local product-photo classification. Reference features are built once at model installation."""
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


SUBJECTS = {
    'palette': ('an empty folding watercolor mixing palette with mixing wells',
                'an empty plastic artist paint mixing tray with a thumb hole'),
    'brush': ('a set of artist paint brushes with bristles and long handles',
              'a close up product photo of a single artists paintbrush',
              'a wide flat paintbrush with dense brown bristles, a shiny metal ferrule and a short wooden handle',
              'a hake wash brush for watercolor painting, with a broad rectangular bristle head',
              'a flat varnish brush or a decorators paint brush for painting'),
    'paint': ('a watercolor paint set filled with colorful paint pans',
              'a set of bottles or tubes of acrylic paint for artists'),
    'paper': ('an artists watercolor sketchbook with blank paper pages',
              'a pad of watercolor paper, notebook or sketchbook for drawing'),
    'miniature': ('a painted miniature figurine on a small base',
                  'a scale model or unpainted tabletop miniature figure'),
    'toy': ('a plastic playset or pretend kitchen toy for children',
            'a childrens toy, doll, stuffed toy or building blocks'),
    'general': ('a different everyday household item or accessory',
                'clothing, shoes or a handbag', 'food, a bottle or cosmetics',
                'an electronic device, smartphone or appliance', 'a tool or stationery item'),
}


@lru_cache(maxsize=2)
def _session(path):
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 3
    opts.enable_cpu_mem_arena = False
    return ort.InferenceSession(str(path), opts, providers=['CPUExecutionProvider'])


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-8)


def prepare(directory):
    from tokenizers import Tokenizer
    tokenizer = Tokenizer.from_file(str(directory/'tokenizer.json'))
    encoder = _session(directory/'text_model_quantized.onnx')
    vectors = {}
    for name, prompts in SUBJECTS.items():
        features = []
        for prompt in prompts:
            ids = np.asarray([tokenizer.encode(prompt).ids], dtype=np.int64)
            features.append(_unit(encoder.run(['text_embeds'], {'input_ids':ids})[0])[0])
        vectors[name] = np.stack(features)
    np.savez(directory/'subjects.npz', **vectors)


def mixing_wells(view):
    """Look for a regular group of unfilled, pale wells with matching moulded edges."""
    import cv2
    photo = view.copy()
    photo.thumbnail((640,640),Image.Resampling.LANCZOS)
    rgb = np.asarray(photo)
    gray = cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    shade = cv2.subtract(cv2.GaussianBlur(gray,(0,0),max(2,max(gray.shape)/120)),gray)
    contours,_ = cv2.findContours((shade>5).astype('uint8'),cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    scale = max(gray.shape)
    for contour in contours:
        x,y,w,h = cv2.boundingRect(contour)
        if not scale*.012<min(w,h)<=max(w,h)<scale*.12 or not .45<w/h<1.8 or cv2.contourArea(contour)<w*h*.24:
            continue
        patch = rgb[y:y+h,x:x+w]
        if np.median(patch.min(2))>140 and np.percentile(np.ptp(patch,axis=2),80)<25:
            candidates.append((x+w/2,y+h/2,w,h))
    wells = set()
    points = np.array(candidates)
    for x,y,w,h in candidates:
        group = points[(abs(points[:,2]-w)<w*.24)&(abs(points[:,3]-h)<h*.24)]
        if len(group)<6:
            continue
        # At least two rows of three similarly sized, adjacent wells.
        row = group[(abs(group[:,1]-y)<h*.35)&(abs(group[:,0]-x)<w*3.4)]
        adjacent = group[(abs(group[:,1]-y)>h*.7)&(abs(group[:,1]-y)<h*2)&(abs(group[:,0]-x)<w*3.4)]
        if len(row)>=3 and any(np.count_nonzero(abs(adjacent[:,1]-cy)<h*.35)>=3 for cy in adjacent[:,1]):
            wells.update(tuple(p) for p in row)
    return wells,photo.size


def has_mixing_wells(view):
    return bool(mixing_wells(view)[0])


def recognize(source, directory):
    weights = directory/'vision_model_quantized.onnx'
    vocabulary = directory/'subjects.npz'
    with Image.open(source) as camera:
        camera.draft('RGB',(640,640))
        camera.thumbnail((640,640),Image.Resampling.LANCZOS)
        rgba = ImageOps.exif_transpose(camera).convert('RGBA')
    view = Image.new('RGB',rgba.size,'white')
    view.paste(rgba,mask=rgba.getchannel('A'))
    if not weights.is_file() or not vocabulary.is_file():
        return 'palette' if has_mixing_wells(view) else 'general'
    with np.load(vocabulary,allow_pickle=False) as references:
        vectors = {name:references[name] for name in SUBJECTS}
    def scores_for(photo):
        patch = ImageOps.pad(photo,(224,224),Image.Resampling.BICUBIC,color=photo.getpixel((0,0)))
        pixels = np.asarray(patch,dtype=np.float32)/255
        pixels = (pixels-np.array([.48145466,.4578275,.40821073],np.float32))/np.array([.26862954,.26130258,.27577711],np.float32)
        feature = _unit(_session(weights).run(['image_embeds'],{'pixel_values':pixels.transpose(2,0,1)[None]})[0])[0]
        return {name:float(np.max(matrix@feature)) for name,matrix in vectors.items()}
    values = scores_for(view)
    # Distinguish a filled pan set from an empty mixing tray when the model matches both.
    import cv2
    hsv=cv2.cvtColor(np.asarray(view),cv2.COLOR_RGB2HSV)
    colours=hsv[:,:,0][(hsv[:,:,1]>85)&(hsv[:,:,2]>75)]
    hues=np.bincount(colours//15,minlength=12)
    if np.count_nonzero(hues>hsv.shape[0]*hsv.shape[1]*.001)>=4 and values['paint']>=max(values.values())-.023 and values['paper']<values['paint']+.008:
        return 'paint'
    if values['palette'] >= max(values.values())-.045 and has_mixing_wells(view):
        return 'palette'
    scores = sorted(((v,k) for k,v in values.items()),reverse=True)
    (score,name),(runner_up,_) = scores[:2]
    if name=='general' or score-runner_up<.006:
        w,h=view.size
        interior=view.crop((int(w*.15),int(h*.15),max(1,round(w*.85)),max(1,round(h*.85))))
        rotated=scores_for(view.transpose(Image.Transpose.ROTATE_90))
        detail=scores_for(interior)
        candidate=max(rotated,key=rotated.get)
        if candidate!='general' and candidate==max(detail,key=detail.get) and values[candidate]>=score-.024:
            gaps=[v[candidate]-max(n for k,n in v.items() if k!=candidate) for v in (rotated,detail)]
            if min(rotated[candidate],detail[candidate])>=.245 and sum(gaps)>.015:
                return candidate
    return name if score>=.23 and score-runner_up>=.006 else 'general'


if __name__ == '__main__':
    import sys
    prepare(Path(sys.argv[1]))
