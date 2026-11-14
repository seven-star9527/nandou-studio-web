import hashlib
import json
import os
from collections import Counter
from decimal import Decimal

from dotenv import dotenv_values


def official_usage(root, prior_tasks):
    settings = dotenv_values(root / ".env", interpolate=False)
    def configured(name):
        return os.environ.get(name) or settings.get(name) or ""

    keys = dict.fromkeys(k.strip() for k in
                         [*configured("OPENAI_API_KEYS").split(","), configured("OPENAI_API_KEY")] if k.strip())
    labels = {hashlib.sha256(k.encode()).hexdigest()[:12].upper(): f"Key {i}"
              for i, k in enumerate(keys, 1)}
    totals = {label: Decimal(0) for label in labels.values()}
    counts, pending = Counter(), Counter()
    tasks = []
    for path in (root / "server/SwarmUI/Data/StudioOfficialUsage").glob("*.json"):
        receipt = json.loads(path.read_text(encoding="utf-8-sig"), parse_float=Decimal)
        key_id = receipt["key_id"]
        label = labels.get(key_id, f"已移除 · {key_id[:6]}")
        usd = receipt["estimated_usd"]
        counts[label] += 1
        totals.setdefault(label, Decimal(0))
        if usd is None:
            pending[label] += 1
        else:
            totals[label] += usd
        tasks.append({"id": receipt["id"], "key": label, "model": receipt["model"], "at": receipt["at"],
                      "tokens": (receipt.get("usage") or {}).get("total_tokens"),
                      "usd": float(usd) if usd is not None else None})
    recorded = {task["id"] for task in tasks}
    for task in prior_tasks:
        if task["id"] not in recorded:
            tasks.append({"id": task["id"], "key": "未记录", "model": task["model"], "at": task["at"],
                          "tokens": None, "usd": None})
    return {"keys": [{"key": label, "tasks": counts[label], "pending": pending[label], "usd": float(total)}
                     for label, total in totals.items()],
            "tasks": sorted(tasks, key=lambda task: task["at"], reverse=True)}
