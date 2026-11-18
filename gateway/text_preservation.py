"""Keep photographed printing instead of asking a generator to spell it again.

PP-OCRv4 locates text; no recognized/transcribed string is rendered. Source pixels
are registered once, then composited after all generative and smoothing steps.
"""
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MODEL_SHA256 = 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9'


class TextPreservationError(ValueError):
    pass


@lru_cache(maxsize=2)
def detector(path):
    import hashlib
    import onnxruntime as ort
    path = Path(path)
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != MODEL_SHA256:
        raise TextPreservationError('文字保护模型不可用，已保留模型原稿。')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])


def text_mask(rgb, model, *, compact=False):
    """Overlapping native-detail tiles prevent small printed copy disappearing."""
    height, width = rgb.shape[:2]
    mask = np.zeros((height, width), np.uint8)
    for y in range(0, height, 768):
        for x in range(0, width, 768):
            tile = rgb[y:y + 1024, x:x + 1024]
            h, w = tile.shape[:2]
            padded = np.full(((h + 31) // 32 * 32, (w + 31) // 32 * 32, 3), 255, np.uint8)
            padded[:h, :w] = tile[:, :, ::-1]
            data = (padded.astype(np.float32) / 127.5 - 1).transpose(2, 0, 1)[None]
            prediction = model.run(None, {model.get_inputs()[0].name: data})[0][0, 0]
            contours, _ = cv2.findContours(np.uint8(prediction > .3), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                (cx, cy), (rw, rh), angle = cv2.minAreaRect(contour)
                if min(rw, rh) < 3 or max(rw, rh) < 8 or cx >= w or cy >= h:
                    continue
                bx, by, bw, bh = cv2.boundingRect(contour)
                area = np.zeros((bh, bw), np.uint8)
                cv2.drawContours(area, [contour - (bx, by)], -1, 1, -1)
                if cv2.mean(prediction[by:by + bh, bx:bx + bw], mask=area)[0] < .55:
                    continue
                margin = min(rw, rh) * (.10 if compact else .6) + (2 if compact else 4)
                box = cv2.boxPoints(((cx + x, cy + y), (rw + 2 * margin, rh + 2 * margin), angle))
                cv2.fillConvexPoly(mask, np.int32(box), 255)
    # Keep adjacent lines/table rows together, avoiding seams through glyphs.
    join = 5 if compact else max(3, min(121, round(min(width, height) * .038))) | 1
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((join, join), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask[:] = 0
    count = 0
    for contour in contours:
        if cv2.contourArea(contour) >= 40:
            cv2.fillConvexPoly(mask, cv2.convexHull(contour), 255)
            count += 1
    return cv2.dilate(mask, np.ones((3 if compact else 9,) * 2, np.uint8)), count


def registration(source, target, mask, *, require_local=True):
    # Cleaning changes contrast and removes incidental texture. Retry feature
    # extraction on normalized contrast, keeping every geometry/local gate.
    gray = [cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) for image in (source, target)]
    try:
        return _registration(*gray, mask, require_local=require_local)
    except TextPreservationError:
        # Contrast-recovered global matches must still take the independent
        # bidirectional local validation path in preserve_print.
        if require_local:
            raise
        enhanced = [cv2.createCLAHE(3, (16, 16)).apply(image) for image in gray]
        return _registration(*enhanced, mask, require_local=require_local)


def _registration(source, target, mask, *, require_local=True):
    sift = cv2.SIFT_create(nfeatures=16000, contrastThreshold=.02)
    ka, da = sift.detectAndCompute(source, None)
    kb, db = sift.detectAndCompute(target, None)
    error = '原图文字与精修图未能可靠对齐，已保留模型原稿，请勿将其中的文字作为最终交付。'
    if da is None or db is None or len(db) < 2:
        raise TextPreservationError(error)
    pairs = cv2.BFMatcher().knnMatch(da, db, k=2)
    matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < .7 * pair[1].distance]
    if len(matches) < 20:
        raise TextPreservationError(error)
    p = np.float32([ka[m.queryIdx].pt for m in matches])
    q = np.float32([kb[m.trainIdx].pt for m in matches])
    # Retouch must retain composition. Repeating pans/table cells can match a
    # different cell; reject impossible displacement before fitting the pose.
    nearby = np.linalg.norm(p - q, axis=1) <= max(source.shape[:2]) * .05
    p, q = p[nearby], q[nearby]
    if len(p) < 20:
        raise TextPreservationError(error)
    transform, valid = cv2.findHomography(p, q, cv2.RANSAC, 3)
    if transform is None or not np.isfinite(transform).all() or valid.sum() < 20:
        raise TextPreservationError(error)
    h, w = source.shape[:2]
    corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    mapped = cv2.perspectiveTransform(corners[None], transform)[0]
    if (not cv2.isContourConvex(mapped) or cv2.contourArea(mapped, oriented=True) <= 0
            or np.linalg.norm(mapped - corners, axis=1).max() > max(w, h) * .05):
        raise TextPreservationError(error)
    # Require supporting features near every protected panel, not merely elsewhere.
    points = p[valid.ravel().astype(bool)]
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, rw, rh = cv2.boundingRect(contour)
        radius = max(96, min(rw, rh) * .5)
        near = ((points[:, 0] >= x - radius) & (points[:, 0] <= x + rw + radius)
                & (points[:, 1] >= y - radius) & (points[:, 1] <= y + rh + radius))
        if require_local and near.sum() < 2:
            raise TextPreservationError(error)
    return transform, int(valid.sum())


def local_registration(source, target, contour):
    """Validate a local affine mapping in both directions using lighting-stable edges."""
    x, y, w, h = cv2.boundingRect(contour)
    left, top = max(0, x - 100), max(0, y - 100)
    right, bottom = min(source.shape[1], x + w + 100), min(source.shape[0], y + h + 100)
    edges = []
    for rgb in (source, target):
        gray = cv2.cvtColor(rgb[top:bottom, left:right], cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
        edges.append(cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1)))
    error = '局部文字轮廓未能可靠对齐，已保留模型原稿。'
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 180, 1e-5)
    try:
        score, forward = cv2.findTransformECC(edges[0], edges[1], np.eye(2, 3, dtype=np.float32), cv2.MOTION_AFFINE, criteria, None, 5)
        reverse_score, reverse = cv2.findTransformECC(edges[1], edges[0], np.eye(2, 3, dtype=np.float32), cv2.MOTION_AFFINE, criteria, None, 5)
    except cv2.error as exc:
        raise TextPreservationError(error) from exc
    forward = np.vstack([forward, [0, 0, 1]])
    reverse = np.vstack([reverse, [0, 0, 1]])
    corners = np.float64([[x-left, y-top, 1], [x+w-left, y-top, 1], [x+w-left, y+h-top, 1], [x-left, y+h-top, 1]])
    mapped = corners @ forward.T
    roundtrip = mapped @ reverse.T
    residual = float(np.linalg.norm(roundtrip[:, :2] - corners[:, :2], axis=1).max())
    singular = np.linalg.svd(forward[:2, :2], compute_uv=False)
    if (not np.isfinite(forward).all() or min(score, reverse_score) < .70
            or np.linalg.det(forward[:2, :2]) <= 0 or singular.min() < .94 or singular.max() > 1.06
            or np.linalg.norm(mapped[:, :2] - corners[:, :2], axis=1).max() > 15 or residual > 1.5):
        raise TextPreservationError(error)
    offset = np.array([[1, 0, left], [0, 1, top], [0, 0, 1]], dtype=np.float64)
    return offset @ forward @ np.linalg.inv(offset), {'correlation': float(score), 'reverse_correlation': float(reverse_score), 'roundtrip_px': residual}


def cover_word_ends(mask):
    """Include faint end strokes without expanding a logo into adjacent surfaces."""
    output = mask.copy()
    for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        center, (w, h), angle = cv2.minAreaRect(contour)
        short, long = min(w, h), max(w, h)
        if short < 3 or long / short < 2 or cv2.contourArea(contour) > mask.size * .01:
            continue
        # One character of context along the line, not a broad isotropic patch.
        extension = min(40, short)
        if w >= h:
            w, h = w + 2 * extension, h + 8
        else:
            w, h = w + 8, h + 2 * extension
        box = cv2.boxPoints((center, (w, h), angle))
        cv2.fillConvexPoly(output, np.int32(box), 255)
    return output


def blend_registered_print(source, target, mask):
    """Transfer source gradients, solving illumination from the target boundary.

    Copy masks: OpenCV mutates them during seamlessClone. Keep all pixels outside
    the original protection region exact, including transparency boundaries.
    """
    output = target.copy()
    for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(contour)
        left, top = max(0, x - 8), max(0, y - 8)
        right, bottom = min(target.shape[1], x + w + 8), min(target.shape[0], y + h + 8)
        region = np.zeros((bottom - top, right - left), np.uint8)
        cv2.drawContours(region, [contour - (left, top)], -1, 255, -1)
        region &= mask[top:bottom, left:right]
        # The solver requires a destination boundary. Never paste at the frame edge.
        region[[0, -1], :] = 0
        region[:, [0, -1]] = 0
        bx, by, bw, bh = cv2.boundingRect(region)
        if bw < 4 or bh < 4:
            continue
        roi = output[top:bottom, left:right].copy()
        center = (bx + bw // 2, by + bh // 2)
        cloned = cv2.seamlessClone(source[top:bottom, left:right].copy(), roi,
                                   region.copy(), center, cv2.NORMAL_CLONE)
        roi[region > 0] = cloned[region > 0]
        output[top:bottom, left:right] = roi
    return output


def preserve_print(source, generated, model_path):
    """Preserve original glyphs; adjust only broad illumination of the pasted paper."""
    if source.size != generated.size:
        raise TextPreservationError('文字保护需要原图与交付画幅一致。')
    source_rgb = np.asarray(source.convert('RGB'))
    output = np.array(generated.convert('RGB'))
    width, height = source.size
    factor = min(1, 3168 / max(width, height))
    size = (max(1, round(width * factor)), max(1, round(height * factor)))
    preview = cv2.resize(source_rgb, size, interpolation=cv2.INTER_AREA)
    model = detector(str(model_path))
    mask, count = text_mask(preview, model)
    # Low-contrast embossed lettering can disappear from ordinary RGB detection.
    enhanced = cv2.createCLAHE(3, (16, 16)).apply(cv2.cvtColor(preview, cv2.COLOR_RGB2GRAY))
    extra, _ = text_mask(cv2.cvtColor(enhanced, cv2.COLOR_GRAY2RGB), model)
    nearby = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (97, 97)))
    contours, _ = cv2.findContours(extra, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        component = np.zeros(mask.shape, np.uint8)
        cv2.drawContours(component, [contour], -1, 255, -1)
        if not np.any(mask[component > 0]) and cv2.contourArea(contour) < mask.size * .03:
            mask |= component
        elif np.any(mask[component > 0]):
            # Include faint terminal strokes without accepting a large enhanced
            # detection as an entire lid-sized replacement region.
            mask |= cv2.bitwise_and(component, nearby)
    mask = cover_word_ends(mask)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    count = len(contours)
    if not count:
        return generated, {'status': 'no_text_detected', 'regions': 0}
    # Registration needs context, but copying that context can splice a product
    # rim into a slightly different generated outline. Blend only the compact
    # word support, including faint terminal strokes, inside that search area.
    compact, _ = text_mask(preview, model, compact=True)
    enhanced_support, _ = text_mask(cv2.cvtColor(enhanced, cv2.COLOR_GRAY2RGB), model, compact=True)
    compact = cover_word_ends(compact | enhanced_support) & mask
    support = mask.copy()
    for contour in contours:
        rw, rh = cv2.minAreaRect(contour)[1]
        # Graphic emblems and whole printed panels need their complete original
        # shapes. Only isolated text lines use the narrower word boundary.
        if min(rw, rh) < 3 or max(rw, rh) / min(rw, rh) < 2 or cv2.contourArea(contour) > mask.size * .01:
            continue
        region = np.zeros(mask.shape, np.uint8)
        cv2.drawContours(region, [contour], -1, 255, -1)
        # Dark printed/calligraphic lettering can extend beyond an OCR line.
        # Retain its broad protection; this boundary refinement is for faint,
        # isolated embossed words whose search margin can include the box rim.
        tones = cv2.cvtColor(preview, cv2.COLOR_RGB2GRAY)[region > 0]
        if np.percentile(tones, 99) - np.percentile(tones, 1) >= 80:
            continue
        if not np.any(compact[region > 0]):
            raise TextPreservationError('无法确定完整文字保护范围，已保留模型原稿。')
        support[region > 0] = compact[region > 0]
    target = cv2.resize(output, size, interpolation=cv2.INTER_AREA)
    local_proof = []
    try:
        transform, inliers = registration(preview, target, mask)
        global_transform = transform
        regions = [(mask, transform)]
    except TextPreservationError:
        # A valid global product pose is still mandatory. Local ECC is not a way
        # to accept an unrelated, mirrored or substantially deformed product.
        global_transform, inliers = registration(preview, target, mask, require_local=False)
        regions = []
        for contour in contours:
            transform, proof = local_registration(preview, target, contour)
            component = np.zeros(mask.shape, np.uint8)
            cv2.drawContours(component, [contour], -1, 255, -1)
            regions.append((component, transform))
            local_proof.append(proof)
    scale = np.diag([width / size[0], height / size[1], 1])
    warped = cv2.warpPerspective(source_rgb, scale @ global_transform @ np.linalg.inv(scale),
                                 (width, height), flags=cv2.INTER_LANCZOS4)
    mask = np.zeros((height, width), np.uint8)
    for component, transform in regions:
        full = scale @ transform @ np.linalg.inv(scale)
        region_mask = cv2.resize(component & support, (width, height), interpolation=cv2.INTER_NEAREST)
        region_mask = cv2.warpPerspective(region_mask, full, (width, height))
        region_mask = np.uint8(region_mask >= 128) * 255
        if source.mode == 'RGBA':
            opaque = np.uint8(np.asarray(source.getchannel('A')) == 255)
            opaque = cv2.warpPerspective(opaque, full, (width, height), flags=cv2.INTER_NEAREST)
            region_mask *= cv2.erode(opaque, np.ones((9, 9), np.uint8))
        selected = region_mask > mask
        # Fill the whole registered image for the global case, preserving the
        # previous broad illumination estimate; for local cases only the region.
        registered = cv2.warpPerspective(source_rgb, full, (width, height), flags=cv2.INTER_LANCZOS4)
        if len(regions) == 1:
            warped[:] = registered
        else:
            warped[selected] = registered[selected]
        mask = np.maximum(mask, region_mask)
    # Transparent pixels and their boundary are never made opaque by a print patch.
    if generated.mode == 'RGBA':
        opaque = np.uint8(np.asarray(generated.getchannel('A')) == 255)
        mask *= cv2.erode(opaque, np.ones((9, 9), np.uint8))
    output = blend_registered_print(warped, output, mask)
    result = Image.fromarray(output)
    if generated.mode == 'RGBA':
        result.putalpha(generated.getchannel('A'))
    return result, {'status': 'source_pixels_preserved', 'regions': count, 'alignment_inliers': inliers,
                    'local_alignment': local_proof, 'blend': 'source_gradients_target_boundary'}
