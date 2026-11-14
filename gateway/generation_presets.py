"""Personal picture-generation settings. The first saved entry is the sole default."""
import json
import re
import uuid


def checked_settings(data):
    required = {"model", "ratio", "resolution", "width", "height", "count", "steps", "cfg", "seed"}
    integers = {"width": (0, 32768), "height": (0, 32768), "count": (1, 16), "steps": (1, 1000),
                "gifWidth": (16, 4096), "gifHeight": (16, 4096), "frameCount": (2, 16), "frameDurationMs": (20, 655350)}
    if not isinstance(data, dict) or not required <= data.keys() or data.keys() - required - integers.keys() - {"svgTransparent", "outputFormat", "quality"}:
        raise ValueError("配置只可包含生图参数。")
    if any(type(data[k]) is not int or not lo <= data[k] <= hi for k, (lo, hi) in integers.items() if k in data):
        raise ValueError("尺寸、数量或采样参数超出范围。")
    patterns = {"model": r"[^\x00-\x1f]{0,240}", "ratio": r"auto|smart|custom|\d{1,3}:\d{1,3}",
                "resolution": r"[\w.\-]{1,16}", "seed": r"-1|[0-9]{1,20}", "quality": r"[a-z0-9_-]{0,24}"}
    if any(not isinstance(data[k], str) or not re.fullmatch(p, data[k]) for k, p in patterns.items() if k in data):
        raise ValueError("模型、画幅或种子格式无效。")
    if (type(data["cfg"]) not in (int, float) or not 0 <= data["cfg"] <= 100
            or data.get("outputFormat", "png") not in ("png", "svg", "gif") or type(data.get("svgTransparent", False)) is not bool):
        raise ValueError("画质或输出格式无效。")
    return data


def generation_presets(store, owner, change=None):
    def read():
        row = store.one("SELECT entries FROM generation_presets WHERE owner_id=?", (owner,))
        return json.loads(row["entries"]) if row else []

    if change is None:
        return read()
    with store.db:
        store.db.execute("BEGIN IMMEDIATE")
        entries = read()
        action = change.get("action")
        if action == "save":
            if len(entries) >= 5:
                raise ValueError("最多保存 5 套配置，请先删除一套。")
            name, cloud = change.get("name"), change.get("cloudModel")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 32:
                raise ValueError("配置名需为 1 至 32 个字符。")
            if cloud is not None and (not isinstance(cloud, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,96}", cloud)):
                raise ValueError("模型名称无效。")
            settings = checked_settings(change.get("settings"))
            if cloud is None and not settings["model"]:
                raise ValueError("请选择模型。")
            entries.append(dict(id=uuid.uuid4().hex, name=name.strip(), cloudModel=cloud, settings=settings))
        elif action in ("default", "delete"):
            entry = next((item for item in entries if item["id"] == change.get("id")), None)
            if not entry:
                raise KeyError("配置不存在。")
            entries.remove(entry)
            if action == "default":
                entries.insert(0, entry)
        else:
            raise ValueError("未知的配置操作。")
        store.db.execute("INSERT INTO generation_presets VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET entries=excluded.entries",
                         (owner, json.dumps(entries, ensure_ascii=False)))
        return entries
