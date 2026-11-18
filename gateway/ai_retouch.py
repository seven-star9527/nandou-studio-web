"""Product-specific directions for reference-image retouching."""
import re
from .text_preservation import TextPreservationError

REBUILD_MODEL = 'gemini-nano-banana-2.1'


class RetouchStageError(ValueError):
    """A safe, user-facing failure from the reconstruction stage."""


def validate_rebuild(models, user, size='1:1'):
    from .model_management import ModelPolicyError
    try:
        models.validate(user, {**rebuild_options(size), 'operation': 'edit', 'reference_images': ['input']}, retouch_rebuild=True)
    except ModelPolicyError as exc:
        raise ModelPolicyError('AI 去纹所需的 Gemini 模型或参数未开放，请联系管理员。精修暂不可用。', exc.code, exc.status) from exc


def rebuild_options(size='1:1'):
    return dict(model=REBUILD_MODEL, size=size, resolution='4K', n=1)


def rebuild_instruction(category, request, white_background):
    background = ('远离商品的白背景保持均匀中性白，保留贴近商品的自然接触阴影。'
                  if white_background else '保留输入图及用户要求的背景颜色、场景与光照，不擅自改成白底。')
    return ('重建输入商品图的干净表面，最高优先级是去掉平坦区域内浅白纹、云雾状色斑和重复纹样。'
            '把这些平面重新表现为干净连续的颜色与宽缓的真实光照渐变，不把跨材质的伪纹理当作材质保留。'
            '不是磨皮或模糊：产品边缘、细窄反光和文字仍须清楚。'
            '包装、标签、色卡、色号和标志是不可重写的印刷区域，不重绘字形、不换字体、不改排版，不猜测或补写小字。'
            '输入图是唯一结构依据。严格保持构图、透视、位置、大小、零件数量、轮廓、色块顺序、全部字形和标志。'
            '保持各色号身份，不额外提亮或增加饱和度，避免荧光感与过曝；颜色克制自然，保留自然光泽。'
            '只在平坦区域去除非物理的重复浅纹，不添加颗粒、画布纹或规则细纹。保留实际存在的毛束、纸纤维、织物、木纹及细颗粒材质。'
            + background + MATERIALS.get(category, MATERIALS['general'])
            + '\n不得新增文字、拼版或改画幅。用户明确要求优先：\n' + request)


def reconstruction_schema(store):
    existing = {r['name'] for r in store.all('PRAGMA table_info(ai_retouch_jobs)')}
    # Existing tasks keep their original delivery contract; only new tasks opt in.
    for name, definition in {'rebuild': 'INTEGER NOT NULL DEFAULT 0', 'rebuild_id': 'TEXT',
                             'rebuild_record': 'TEXT', 'rebuild_url': 'TEXT'}.items():
        if name not in existing:
            store.db.execute(f'ALTER TABLE ai_retouch_jobs ADD COLUMN {name} {definition}')
    store.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS ai_retouch_rebuild_id ON ai_retouch_jobs(rebuild_id)')
    store.db.commit()


def combined_record(record, job):
    """Display both provider charges on the parent without double-counting child tasks."""
    import json
    result = dict(record)
    if not job.get('rebuild'):
        return result
    child = json.loads(job['rebuild_record']) if job.get('rebuild_record') else {}
    result['retouch_stage'] = '原尺寸交付' if job.get('rebuild_url') else 'AI 去纹' if job.get('engine_url') else '精修生成'
    result['workflow_models'] = [record.get('model'), REBUILD_MODEL]
    for key in ('credits_cost', 'cost', 'actual_time', 'estimated_credits'):
        first, second = record.get(key), child.get(key)
        if isinstance(first, (int, float)) and isinstance(second, (int, float)):
            result[key] = round(first + second, 8)
        elif key in ('credits_cost', 'cost') and not job.get('failure'):
            result[key] = None  # second step is not settled yet
    result['reference_billing'] = bool(record.get('reference_billing') and child.get('reference_billing'))
    result['billing_components'] = [
        {k: r.get(k) for k in ('request_id', 'model', 'status', 'credits_cost', 'reference_billing')}
        for r in (record, child) if r]
    return result


def save_rebuild_record(store, tid, record):
    import json
    old = store.one('SELECT rebuild_record FROM ai_retouch_jobs WHERE task_id=?', (tid,))
    prior = json.loads(old['rebuild_record']) if old and old['rebuild_record'] else {}
    terminal = ('completed', 'failed', 'cancelled')
    if prior.get('status') in terminal and record.get('status') not in terminal:
        return
    with store.db:
        store.db.execute('UPDATE ai_retouch_jobs SET rebuild_record=? WHERE task_id=?', (json.dumps(record), tid))


async def reconstruct(gateway, owner, job, request):
    """One durable child ID; uncertain writes are only polled, including after restart."""
    import asyncio
    import json
    import os
    import shutil
    import uuid
    from pathlib import Path
    from PIL import Image

    if not job.get('rebuild') or job.get('rebuild_url'):
        return True
    tid = job['task_id']
    raw = gateway.results / Path(job['engine_url']).name
    if not job.get('rebuild_id'):
        with Image.open(raw) as im:
            size = source_ratio(im.size)
        reference = await asyncio.to_thread(gateway.agent.inline, {'path': raw})
        cid = str(uuid.uuid4())
        # Commit before the only paid await. A crash between these lines may leave
        # outcome unknown; it must never cause a second paid submission.
        with gateway.store.db:
            claimed = gateway.store.db.execute(
                'UPDATE ai_retouch_jobs SET rebuild_id=? WHERE task_id=? AND rebuild_id IS NULL', (cid, tid)).rowcount
        if claimed:
            try:
                value = await gateway.upstream_api(owner, 'SubmitStudioCloudImage', {
                    **rebuild_options(size), 'request_id': cid, 'operation': 'edit',
                    'prompt': rebuild_instruction(job['category'], request, job['white_bg'] == 1),
                    'reference_images': [reference]}, False)
                if value.get('request_id') == cid:
                    save_rebuild_record(gateway.store, tid, value)
                elif value.get('error'):
                    message = ('AI 去纹所需的 Gemini 模型或参数未开放，请联系管理员。已保留初次精修原稿。'
                               if value.get('error_id') in ('model_disabled', 'model_parameters_restricted')
                               else 'AI 去纹提交被拒绝，已保留初次精修原稿。')
                    raise RetouchStageError(message)
            except ValueError:
                raise
            except Exception:
                pass  # Read back this exact ID; never repeat the write.
        job = gateway.store.one('SELECT * FROM ai_retouch_jobs WHERE task_id=?', (tid,))
    cid = job['rebuild_id']
    for _ in range(150):
        try:
            value = await gateway.upstream_api(owner, 'GetStudioCloudTask', {'request_id': cid})
        except Exception:
            value = {}
        if value.get('request_id') == cid:
            save_rebuild_record(gateway.store, tid, value)
            if value.get('status') in ('failed', 'cancelled'):
                raise ValueError('AI 去纹未完成，已保留初次精修原稿。')
            if value.get('status') == 'completed':
                items = value.get('images', [])
                url = items[0].get('url', '') if items else ''
                if re.fullmatch(r'/studio-results/' + re.escape(cid) + r'-[\w-]+\.(?:png|jpg|jpeg|webp)', url):
                    source = gateway.results / Path(url).name
                    if source.is_file():
                        dest = gateway.results / (tid + '-reconstructed' + source.suffix)
                        temp = dest.with_suffix('.tmp')
                        await asyncio.to_thread(shutil.copyfile, source, temp)
                        os.replace(temp, dest)
                        with gateway.store.db:
                            gateway.store.db.execute('UPDATE ai_retouch_jobs SET rebuild_url=? WHERE task_id=?', ('/studio-results/' + dest.name, tid))
                        return True
        await asyncio.sleep(4)
    return False  # reconcile resumes read-only polling

MATERIALS = {
    'palette': '逐一保留调色槽、侧翼、真实指孔、卡扣和盖面印字。让浅色槽底到内壁有清楚连续的明暗，槽沿有细窄受光线；深色盖面用连贯棚灯反射表现涂层，保留均匀细颗粒。',
    'brush': '保留准确笔锋轮廓与真实细毛，沿毛束方向分出层次。木柄保留木纹，金属笔箍清理杂乱反射，同时保留铆钉和刻字。',
    'paper': '保留真实纸白、纤维、每层纸边、装订孔、封皮和随套装出现的配件，纸边和白背景之间有清楚但自然的层次。',
    'paint': '保持颜料的色相身份、色块顺序和各色号之间的区别，不擅自提亮或增加饱和度。以自然克制的商业摄影调色为基准，粉色和紫色不偏荧光，蓝绿不额外增艳，白色槽框中性不过曝，避免整体泛紫。用户指定色彩风格时以用户要求为准，不统一改成同一套颜色。颜料平面以均匀连续的固有色为主，逐格去除细白丝、浅条带、云雾色斑及重复颗粒，包含浅粉、浅蓝和奶黄色块；只保留柔和宽缓的体积明暗和自然光泽。细窄反光仅沿真实槽壁和弯折受光处出现，不沿平面横向复制高光，不用抹平真实槽壁高光来实现均匀。白色塑料槽框保持清楚的厚度与转折。按实际存在的材质处理瓶身、管身、盖面或膏体，保留包装标签、末尾字母和容量文字，不重排、补造或删减。',
    'miniature': '按实际塑料、树脂或涂装材质塑造体积。保留刻线、薄件、底座、涂装分界和比例。',
    'toy': '保留零件数量、连接结构、关节、涂装配色与包装印刷。分别处理光滑塑胶、软胶和布料。',
    'general': '先识别实物，逐个区分金属、塑料、纸张、织物、木材或透明件，只对照片中实际存在的材质调整光影和纹理。',
}
def instruction(category, request):
    return ('以参考原片为唯一商品事实，输出这张实物的商业摄影精修成片。严格保持同一机位、透视、画幅、位置、大小、数量、轮廓、'
            '结构和原有文字标志，除非用户明确要求改变。包装、标签和色卡的原有字形、色号及排版原样保留，不补写无法辨认的小字。去掉背景脏点、杂光和压缩噪声。保留商品真实微纹理，避免塑料化、描边、过锐。'
            '默认纯白无缝影棚背景，主体严丝合缝，真实孔洞透出背景。覆盖全幅，禁止拼版、边框、新增文字、道具或水印。'
            '使用面积充足的柔光，棚灯反射沿真实受光面自然过渡。背景和大面积色面应干净均匀，避免跨越不同材质的浅色线纹、网格、雾状斑驳。色彩遵循用户明确的校正要求，未要求改色时以原片为准，保持自然光泽。'
            + MATERIALS[category] + '\n本次用户要求（背景、构图、材质与其他明确要求优先）\n' + request)

def wants_retouch(text):
    if not isinstance(text,str):return False
    text=re.sub(r'【参考图\d+】','',text).strip()
    if re.search(r'不要精修|不用精修|无需精修|先别|暂不|不(?:要|用)(?:付费|生图|生成)|怎么|如何|怎样|什么是|是什么|教程|多少钱|多少积分|能否|是否|只.{0,3}(?:分析|解释|写提示词)',text):
        return False
    if re.search(r"\b(?:do not|don't|without)\s+retouch|\b(?:how|explain|whether)\b",text,re.I):return False
    if re.match(r'^(?:please\s+)?retouch\b',text,re.I):return True
    return bool(re.search(r'^(?:请|麻烦|帮我|用AI|AI|对|把|将|给|为|这|那|一|支|套|张|个|幅|图片|图|照片|主图|产品|商品|原片|进行|做|一下|的|画笔|调色盘|颜料|水彩本|水彩纸|微缩模型|玩具|白底|商业|电商|专业|\s)*精修',text,re.I))

def category_hint(text):
    names={'调色盘':'palette','画笔':'brush','水彩本':'paper','水彩纸':'paper','颜料':'paint','微缩模型':'miniature','玩具':'toy'}
    found={v for k,v in names.items() if k in text}
    return found.pop() if len(found)==1 else 'auto'

def source_ratio(size):
    import math
    ratios=('1:1','3:4','4:3','2:3','3:2','9:16','16:9','21:9','4:5','5:4')
    return min(ratios,key=lambda r:abs(math.log(size[0]/size[1]*int(r.split(':')[1])/int(r.split(':')[0]))))

def needs_white(text):
    # Custom styling and requests to retain the photographed set take precedence.
    # Colour and gradient words describing the product are not background requests.
    return not re.search(r'保留.{0,6}(?:背景|原底)|原背景|透明|transparent|(?:keep|preserve|retain)\b[^.\n]{0,45}\bbackground|(?:black|gray|grey|blue|green|red|pink|gradient|studio|wooden)\s+background|(?:背景色?|底色)[^，。；\n]{0,6}(?:黑|灰|蓝|绿|红|黄|粉|暖|渐变|场景|木纹|台面|#)|(?:黑|灰|蓝|绿|红|黄|粉|暖|纯色|渐变|自定义|场景|木纹|影棚|台面)(?:色)?(?:底|背景)',text,re.I)

def category_for(source,selected,directory):
    from .product_recognition import recognize
    if selected=='auto':
        return recognize(source,directory)
    if selected not in MATERIALS:
        raise ValueError('商品类别无效。')
    return selected

def smooth_paint_pan_interiors(rgb):
    """Level bounded pigment interiors; white frames and reflections stay intact."""
    import cv2
    import numpy as np
    height, width = rgb.shape[:2]
    scale = min(1, 2048 / max(height, width))
    small = cv2.resize(rgb, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    mask = np.uint8((np.ptp(small, axis=2) > 32) & (small.mean(2) > 65)) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    output = rgb.copy()
    for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        area = cv2.contourArea(contour)
        rw, rh = cv2.minAreaRect(contour)[1]
        if (min(rw, rh) < 8 or not mask.size * .00015 < area < mask.size * .015
                or not 1.3 < max(rw, rh) / min(rw, rh) < 7 or area / (rw * rh) < .78):
            continue
        x, y, w, h = cv2.boundingRect(contour)
        l, t = max(0, x - 15), max(0, y - 15)
        r, b = min(small.shape[1], x + w + 15), min(small.shape[0], y + h + 15)
        component = np.zeros((b - t, r - l), np.uint8)
        cv2.drawContours(component, [contour - (l, t)], -1, 255, -1)
        ring = ((cv2.dilate(component, np.ones((21, 21), np.uint8)) > 0)
                & (cv2.dilate(component, np.ones((9, 9), np.uint8)) == 0))
        surround = small[t:b, l:r]
        white = (np.ptp(surround, axis=2) < 28) & (surround.mean(2) > 185)
        if not ring.any() or white[ring].mean() < .5:
            continue
        # Work at the delivery resolution; never downsample the output or lettering.
        full_contour = np.int32(np.rint(contour / scale))
        x, y, w, h = cv2.boundingRect(full_contour)
        l, t = max(0, x - 24), max(0, y - 24)
        r, b = min(width, x + w + 24), min(height, y + h + 24)
        region = rgb[t:b, l:r]
        component = np.zeros(region.shape[:2], np.uint8)
        cv2.drawContours(component, [full_contour - (l, t)], -1, 255, -1)
        distance = cv2.distanceTransform(component, cv2.DIST_L2, 5)
        short = min(rw, rh) / scale
        kernel = np.ones((max(9, round(9 / scale)) | 1,) * 2, np.uint8)
        contrast = (cv2.dilate(region, kernel) - cv2.erode(region, kernel)).max(2)
        safe = (distance > max(4, short * .12)) & (contrast < 22)
        if safe.sum() < 80:
            continue
        yy, xx = np.mgrid[:b - t, :r - l]
        xx, yy = (xx - w / 2) / max(w, h), (yy - h / 2) / max(w, h)
        basis = np.stack([xx * 0 + 1, xx, yy, xx * xx, xx * yy, yy * yy], -1)
        stride = max(1, int(safe.sum()) // 5000)
        coefficient = np.linalg.lstsq(basis[safe][::stride], region[safe][::stride], rcond=None)[0]
        surface = basis @ coefficient
        weight = (np.clip((distance - short * .09) / (short * .12), 0, 1)
                  * np.clip((24. - contrast) / 10, 0, 1))
        correction = np.clip(surface - region, -8, 8) * weight[:, :, None]
        output[t:b, l:r] = np.uint8(np.clip(np.rint(output[t:b, l:r] + correction), 0, 255))
    return output


def smooth_generated(image, category, white_background):
    """Smooth weak fluctuations on flat paint and on exterior near-white background."""
    import cv2
    import numpy as np
    from PIL import Image

    alpha = image.getchannel('A') if image.mode == 'RGBA' else None
    original = np.asarray(image.convert('RGB'))
    result = original.copy()
    background = None
    if white_background:
        # Border-connected bright area, inset so the outline and shadows are protected.
        height, width = original.shape[:2]
        small = cv2.resize(original, (max(1, width // 4), max(1, height // 4)), interpolation=cv2.INTER_AREA)
        candidates = np.uint8(small.min(axis=2) >= 249)
        _, labels = cv2.connectedComponents(candidates)
        border = np.unique(np.r_[labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        exterior = np.uint8(np.isin(labels, border[border != 0])) * 255
        exterior = cv2.erode(exterior, np.ones((9, 9), np.uint8))
        background = cv2.resize(exterior, (width, height), interpolation=cv2.INTER_LINEAR)

    kernel = np.ones((15, 15), np.uint8)
    for top in range(0, image.height, 384):
        bottom = min(image.height, top + 384)
        start, stop = max(0, top - 64), min(image.height, bottom + 64)
        rgb = original[start:stop]
        # Per-channel contrast protects isoluminant colour boundaries as well as text.
        contrast = (cv2.dilate(rgb, kernel) - cv2.erode(rgb, kernel)).max(axis=2)
        quiet = np.clip((9.0 - contrast.astype(np.float32)) / 5.0, 0, 1)
        lum = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
        weight = np.zeros_like(lum)
        if category in ('paint', 'palette'):
            chroma = np.ptp(rgb, axis=2)
            weight = np.clip((chroma.astype(np.float32) - 34) / 22, 0, 1)
        if background is not None:
            weight = np.maximum(weight, background[start:stop].astype(np.float32) / 255)
        if alpha is not None:
            opaque = np.asarray(alpha.crop((0, start, image.width, stop))) == 255
            weight *= cv2.erode(np.uint8(opaque), kernel)
        delta = np.clip(cv2.GaussianBlur(lum, (0, 0), 5) - lum, -2, 2)
        delta = np.repeat(delta[:, :, None], 3, axis=2)
        if background is not None:
            # Near-white exterior also has channel-to-channel noise. Preserve
            # pigment chroma, but smooth all three channels inside this mask.
            exterior_weight = background[start:stop, :, None].astype(np.float32) / 255
            rgb_delta = np.clip(cv2.GaussianBlur(rgb.astype(np.float32), (0, 0), 5) - rgb, -2, 2)
            delta = delta * (1 - exterior_weight) + rgb_delta * exterior_weight
        if category in ('paint', 'palette'):
            # Estimate surface variation after suppressing grain, but retain a raw
            # contrast veto for lettering, borders and narrow specular highlights.
            surface = cv2.GaussianBlur(rgb, (0, 0), 1.2)
            surface_contrast = (cv2.dilate(surface, kernel) - cv2.erode(surface, kernel)).max(axis=2)
            pigment_quiet = np.minimum(np.clip((16.0-surface_contrast)/8,0,1),
                                       np.clip((32.0-contrast)/12,0,1))
            pigment = cv2.erode(np.clip((chroma.astype(np.float32)-14)/18,0,1),kernel)
            if alpha is not None:
                pigment *= cv2.erode(np.uint8(opaque),kernel)
            pigment_weight = pigment * pigment_quiet
            # Include faint bands wider than single-pixel grain. The raw contrast
            # veto still excludes narrow wall reflections, type and pan borders.
            # A bounded residual leaves broad lighting and pigment identity intact.
            pigment_delta = np.clip(cv2.GaussianBlur(rgb.astype(np.float32),(0,0),9)-rgb,-8,8)
            delta = delta * (weight*quiet)[:,:,None]
            delta = delta*(1-pigment_weight[:,:,None])+pigment_delta*pigment_weight[:,:,None]
            weight = quiet = np.ones_like(lum)
        rows = slice(top - start, bottom - start)
        adjusted = rgb[rows] + ((weight * quiet)[:, :, None] * delta)[rows]
        result[top:bottom] = np.uint8(np.clip(np.rint(adjusted), 0, 255))
    if category in ('paint', 'palette'):
        leveled = smooth_paint_pan_interiors(result)
        if alpha is not None:
            opaque = cv2.erode(np.uint8(np.asarray(alpha) == 255), kernel)
            result[opaque > 0] = leveled[opaque > 0]
        else:
            result = leveled
    output = Image.fromarray(result)
    if alpha is not None:
        output.putalpha(alpha)
    return output


def fit_native(image, size):
    """Fit the entire generated frame. Extend its outermost pixels if ratios differ."""
    from PIL import Image, ImageOps

    if image.size == size:
        return image
    fitted = ImageOps.contain(image, size, Image.Resampling.LANCZOS)
    if fitted.size == size:
        return fitted
    width, height = size
    left, top = (width - fitted.width) // 2, (height - fitted.height) // 2
    canvas = Image.new(fitted.mode, size)
    canvas.paste(fitted, (left, top))
    if left or width > fitted.width:
        for offset, end, column in ((0, left, 0), (left + fitted.width, width, fitted.width - 1)):
            if end > offset:
                strip = fitted.crop((column, 0, column + 1, fitted.height))
                canvas.paste(strip.resize((end - offset, fitted.height), Image.Resampling.NEAREST), (offset, top))
    if top or height > fitted.height:
        for offset, end, row in ((0, top, top), (top + fitted.height, height, top + fitted.height - 1)):
            if end > offset:
                strip = canvas.crop((0, row, width, row + 1))
                canvas.paste(strip.resize((width, end - offset), Image.Resampling.NEAREST), (0, offset))
    return canvas


def render_delivery(root, results, job):
    from pathlib import Path
    import os
    import uuid
    from PIL import Image, ImageOps
    from .task_references import task_references, reference_directory
    from .text_preservation import preserve_print

    task = job['task_id']
    ref = task_references(root, task)[0]
    source = reference_directory(root, task) / Path(ref['url']).name
    with Image.open(source) as header:
        width, height = header.size
        if header.getexif().get(274) in (5, 6, 7, 8):
            width, height = height, width

    raw = results / Path(job.get('rebuild_url') or job['engine_url']).name
    final = results / (task + '-original-size.png')
    partial = final.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    try:
        with Image.open(raw) as model:
            profile = model.info.get('icc_profile')
            frame = ImageOps.exif_transpose(model)
            mode = 'RGBA' if 'A' in frame.getbands() or 'transparency' in frame.info else 'RGB'
            frame = frame.convert(mode)
            if job['white_bg'] == 2 and (mode != 'RGBA' or frame.getchannel('A').getextrema()[0] == 255):
                raise ValueError('模型返回的图片没有透明区域')
            frame = fit_native(frame, (width, height))
            filtered = smooth_generated(frame, job['category'], job['white_bg'] == 1)
            with Image.open(source) as original:
                original = ImageOps.exif_transpose(original)
                filtered, text_protection = preserve_print(
                    original, filtered, Path(root) / 'models/text-preservation/ch_PP-OCRv4_det_infer.onnx')
            filtered.save(partial, format='PNG', icc_profile=profile)
        os.replace(partial, final)
        return {'url': '/studio-results/' + final.name, 'width': width, 'height': height,
                'index': 0, 'mime_type': 'image/png', 'text_preservation': text_protection,
                'model_original': '/studio-agent/workbench/ai-retouch/' + task + '/original' + raw.suffix.lower()}
    finally:
        partial.unlink(missing_ok=True)
