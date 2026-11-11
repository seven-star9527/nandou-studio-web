"""Private, immutable originals attached to an existing account-owned task."""
import hashlib
import io
import json
import re
from pathlib import Path

from PIL import Image

from .image_uploads import original_image_bytes


def reference_directory(root, task_id):
    if not re.fullmatch(r'(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|legacy_[0-9a-f]{32})', task_id):
        raise ValueError('invalid task id')
    return Path(root) / 'runtime' / 'task-references' / task_id


def save_task_references(root, task_id, values):
    folder = reference_directory(root, task_id)
    if not values:
        return
    # Task IDs are claimed before this call; never overwrite an existing snapshot.
    folder.mkdir(parents=True, exist_ok=False)
    entries = []
    for index, raw in enumerate(values, 1):
        data, extension = original_image_bytes(raw)
        name = f'{index}{extension}'
        (folder / name).write_bytes(data)
        with Image.open(io.BytesIO(data)) as image:
            entries.append({'index': index, 'width': image.width, 'height': image.height,
                            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                            'url': f'/studio-references/{task_id}/{name}'})
    (folder / 'manifest.json').write_text(json.dumps(entries, ensure_ascii=False), encoding='utf-8')


def task_references(root, task_id):
    path = reference_directory(root, task_id) / 'manifest.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else []
