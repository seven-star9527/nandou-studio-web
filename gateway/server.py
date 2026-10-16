"""Account-aware LAN entry point. Swarm itself must listen on loopback only."""
import argparse
import asyncio
import contextlib
import hashlib
import ipaddress
import json
import math
import re
import sqlite3
import sys
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType, web

from .store import Store, TERMINAL, password_hash, password_valid
from .local_queue import LocalQueue
from .agent import CreativeAgent


COOKIE = "nandou_session"
READ_APIS = {"ListT2IParams", "GetCurrentStatus", "GetStudioCloudCapabilities", "GetStudioCloudAccount",
             "GetStudioCloudQuote", "GetStudioPolishCapabilities", "PolishStudioPrompt"}
TASK_APIS = {"GetNewSession", "ListImages", "InterruptAll", "SubmitStudioCloudImage", "GetStudioCloudTask", "ListStudioCloudTasks"}
SENSITIVE_KEYS = {"impersonateuser", "user_id", "userid", "owner_id", "role", "swarm_id"}
IDENTITY_HEADERS = {"x-swarm-user_id", "x-session-id", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
LOCAL_PARAMS = {"prompt", "model", "images", "width", "height", "aspectratio", "steps", "cfgscale", "seed",
                "batchsize", "promptimages", "extra_metadata", "qwenmodel", "vae", "automaticvae", "sampler", "scheduler", "textencodedimage"}


def error(message, status=400, code="invalid_request"):
    return web.json_response({"error": message, "error_id": code}, status=status)


def safe_parts(raw):
    """Validate literal filesystem names; percent signs are ordinary filename data."""
    value = raw
    if "\\" in value or any(ord(c) < 32 for c in value):
        raise ValueError("invalid path")
    parts = value.strip("/").split("/")
    if not parts or any(p in {"", ".", ".."} or ":" in p or p.endswith((".", " ")) for p in parts):
        raise ValueError("invalid path")
    return parts


def http_parts(request):
    # request.path is already decoded by aiohttp. Start from the wire path instead
    # so a literal filename such as "100% cotton" is decoded exactly once.
    path = request.raw_path.split("?", 1)[0]
    return safe_parts(unquote(path, encoding="utf-8", errors="strict"))


def inline_references(values, limit):
    return isinstance(values, list) and len(values) <= limit and all(
        isinstance(value, str) and re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+", value)
        for value in values)


def local_entry(request):
    try:
        peer = request.transport.get_extra_info("peername")[0]
        host = urlsplit("//" + request.host).hostname
        return ipaddress.ip_address(peer).is_loopback and host in {"localhost", "127.0.0.1", "::1"}
    except (ValueError, TypeError, IndexError, AttributeError):
        return False


def public_user(user):
    return {"id": user["id"], "email": user["email"], "role": user["role"], "is_admin": user["role"] == "admin"} if user else None


class Gateway:
    def __init__(self, root, database, upstream="http://127.0.0.1:7802", reconcile_interval=15):
        self.root = Path(root).resolve()
        self.store = Store(database)
        self.upstream = upstream.rstrip("/")
        self.output = self.root / "server/SwarmUI/Output"
        self.results = self.root / "server/SwarmUI/src/wwwroot/studio-results"
        self.static = self.root / "server/SwarmUI/src/wwwroot/studio"
        self.client = None
        self.sessions = {}
        self.session_locks = defaultdict(asyncio.Lock)
        self.sockets = defaultdict(set)
        self.rate = defaultdict(list)
        self.local_queue = LocalQueue(self)
        self.agent = CreativeAgent(self)
        self.reconcile_interval = reconcile_interval
        self.import_cloud_ledger()
        self.app = web.Application(client_max_size=384 * 1024 ** 2, middlewares=[self.boundary])
        self.app["gateway"] = self
        self.app.router.add_route("*", "/{path:.*}", self.route)
        self.app.on_startup.append(self.startup)
        self.app.on_cleanup.append(self.cleanup)

    @web.middleware
    async def boundary(self, request, handler):
        if any(name.lower() in IDENTITY_HEADERS for name in request.headers):
            return error("不接受客户端身份或转发请求头。", 400)
        origin = request.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.netloc.lower() != request.host.lower() or parsed.scheme != request.scheme:
                return error("请求来源不匹配。", 403)
        user = self.store.session(request.cookies.get(COOKIE))
        if user and user["role"] == "admin" and not local_entry(request):
            user = None
        request["user"] = user
        if user:
            self.store.touch(user, request.remote or "unknown")
        try:
            response = await handler(request)
        except (ValueError, json.JSONDecodeError):
            response = error("请求参数无效。")
        except (asyncio.TimeoutError, ConnectionError, ClientError):
            response = error("后端响应未确认，请刷新记录核对；不会自动重提任务。", 502, "outcome_unknown")
        if not isinstance(response, web.WebSocketResponse):
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "same-origin"
            if not request.path.startswith("/studio/"):
                response.headers["Cache-Control"] = "private, no-store"
        return response

    async def startup(self, app):
        self.client = ClientSession(timeout=ClientTimeout(total=180, connect=10))
        await self.agent.startup()
        # An interrupted local stream is uncertain until its saved files are reconciled.
        with self.store.db:
            self.store.db.execute("UPDATE tasks SET status='outcome_unknown' WHERE kind='local' AND status NOT IN ('completed','failed','cancelled','interrupted','queued')")
        self.local_queue.start()
        self.poller = asyncio.create_task(self.reconcile_loop())

    async def cleanup(self, app):
        await self.agent.close()
        await self.local_queue.stop()
        self.poller.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.poller
        for sockets in list(self.sockets.values()):
            for socket in list(sockets):
                await socket.close(code=1001)
        await self.client.close()
        self.store.close()

    async def body(self, request):
        if request.content_type != "application/json":
            raise ValueError("JSON required")
        data = await request.json()
        if not isinstance(data, dict) or any(str(k).lower() in SENSITIVE_KEYS for k in data):
            raise ValueError("identity parameters forbidden")
        return data

    async def route(self, request):
        path = request.path
        if path == "/health":
            return web.json_response({"ok": True, "service": "nandou-account-gateway"})
        if path.startswith("/studio-auth/"):
            return await self.auth(request)
        if path in {"/", "/studio"}:
            raise web.HTTPFound("/studio/")
        if path.startswith("/studio/") and request.method in {"GET", "HEAD"}:
            try:
                parts = http_parts(request)
                target = self.static.joinpath(*(parts[1:] or ["index.html"])).resolve()
                if not target.is_relative_to(self.static.resolve()) or not target.is_file():
                    raise ValueError()
            except ValueError:
                raise web.HTTPNotFound()
            return web.FileResponse(target)
        user = request["user"]
        if not user:
            return error("请先登录。", 401, "authentication_required")
        if path.startswith("/studio-agent/"):
            return await self.agent.route(request, user)
        if path == "/API/GenerateText2ImageWS" and request.method == "GET":
            return await self.generate(request, user)
        if path.startswith("/API/") and request.method == "POST":
            endpoint = path[5:]
            if endpoint not in READ_APIS | TASK_APIS:
                raise web.HTTPNotFound()
            data = await self.body(request)
            return await self.api(user, endpoint, data)
        if path.startswith(("/View/", "/Output/", "/studio-results/")) and request.method in {"GET", "HEAD"}:
            return await self.file(request, user)
        raise web.HTTPNotFound()

    async def auth(self, request):
        action = request.path[len("/studio-auth/"):]
        user = request["user"]
        if action == "me" and request.method == "GET":
            return web.json_response({"user": public_user(user), "admin_entry": local_entry(request)})
        if action == "admin/overview" and request.method == "GET":
            if not user or user["role"] != "admin" or not local_entry(request):
                return error("无法访问。", 403)
            await self.synchronize(user, include_local=True)
            return web.json_response(self.store.overview())
        if request.method != "POST":
            raise web.HTTPNotFound()
        data = await self.body(request)
        if action == "tasks/hide":
            if not user:
                return error("请先登录。", 401)
            reason = self.store.hide(str(data.get("task_id", "")), user)
            if reason == "not_found":
                return error("记录不可见。", 404)
            if reason == "active":
                return error("任务仍在运行，结束后才能删除记录。", 409)
            return web.json_response({"ok": True})
        if action == "logout":
            if user:
                self.store.revoke(user["id"])
                await self.close_sessions(user["id"])
                self.store.touch(user, request.remote or "unknown", "logout")
            response = web.json_response({"ok": True})
            response.del_cookie(COOKIE, path="/")
            return response
        if action not in {"register", "login", "reset"}:
            raise web.HTTPNotFound()
        now = time.monotonic()
        bucket = self.rate[request.remote or "unknown"]
        bucket[:] = [stamp for stamp in bucket if now - stamp < 60]
        if len(bucket) >= 30:
            return error("请求过于频繁，请稍后再试。", 429)
        bucket.append(now)
        email = str(data.get("email", "")).strip().lower()
        password = data.get("password")
        if not isinstance(password, str) or not 6 <= len(password) <= 256:
            return error("密码需为6至256个字符。")
        if email != "admin" and (len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)):
            return error("请输入有效邮箱。")
        account = self.store.user(email)
        if action == "register":
            if email == "admin":
                return error("此账号不可注册。")
            encoded = await asyncio.to_thread(password_hash, password)
            try:
                account = self.store.create_user(email, encoded)
            except sqlite3.IntegrityError:
                return error("此邮箱已注册。", 409)
        elif action == "reset":
            if email == "admin" or account and account["role"] == "admin":
                return error("管理员不支持此重置入口。", 403)
            if account:
                self.store.revoke(account["id"], await asyncio.to_thread(password_hash, password))
                await self.close_sessions(account["id"])
                self.store.touch(account, request.remote or "unknown", "password_reset")
            return web.json_response({"ok": True})
        else:
            # Dummy hash for unknown accounts keeps the expensive work comparable.
            if not account:
                await asyncio.to_thread(password_hash, password)
                return error("账号或密码不正确。", 401)
            if account["role"] == "admin" and not local_entry(request):
                return error("管理员仅支持本机入口登录。", 403)
            if not await asyncio.to_thread(password_valid, password, account["password_hash"]):
                return error("账号或密码不正确。", 401)
            # Password hashing runs off-loop: a reset can finish while it is running.
            # Compare the verified snapshot again with no await before issuing a token.
            fresh = self.store.user(email)
            if not fresh or fresh["password_hash"] != account["password_hash"]:
                return error("密码已变更，请使用新密码重新登录。", 401)
            account = fresh
        token = self.store.login(account["id"])
        self.store.touch(account, request.remote or "unknown", action)
        response = web.json_response({"user": public_user(account)})
        response.set_cookie(COOKIE, token, httponly=True, samesite="Strict", secure=request.secure, max_age=86400 * 7, path="/")
        return response

    async def close_sessions(self, uid):
        self.sessions.pop(uid, None)
        for socket in list(self.sockets.get(uid, [])):
            await socket.close(code=1008, message="登录已失效，请重新登录。".encode())

    async def new_session(self, user):
        async with self.session_locks[user["id"]]:
            async with self.client.post(self.upstream + "/API/GetNewSession", json={}, headers={"X-SWARM-USER_ID": user["swarm_id"]}) as response:
                result = await response.json()
            if not result.get("session_id") or result.get("user_id") != user["swarm_id"] or result.get("output_append_user") is not True:
                raise ConnectionError("backend identity/output mode mismatch")
            self.sessions[user["id"]] = result
            self.store.bind_session(result["session_id"], user["id"])
            return result

    async def upstream_api(self, user, endpoint, data=None, retry_read=True):
        session = self.sessions.get(user["id"]) or await self.new_session(user)
        value = {"session_id": session["session_id"], **(data or {})}
        async with self.client.post(self.upstream + "/API/" + endpoint, json=value, headers={"X-SWARM-USER_ID": user["swarm_id"]}) as response:
            result = await response.json()
        if result.get("error_id") == "invalid_session_id" and retry_read and endpoint not in {"SubmitStudioCloudImage", "PolishStudioPrompt", "InterruptAll"}:
            await self.new_session(user)
            return await self.upstream_api(user, endpoint, data, False)
        return result

    async def api(self, user, endpoint, data):
        if endpoint == "GetNewSession":
            if set(data) - {"session_id"}:
                return error("不接受会话身份参数。")
            return web.json_response(await self.new_session(user))
        sid = data.pop("session_id", None)
        if not isinstance(sid, str) or not self.store.session_owned(sid, user["id"]):
            return error("会话不属于当前账号，请重新连接。", 403, "invalid_session_id")
        if endpoint == "InterruptAll":
            if data.get("other_sessions") is not False:
                return error("仅允许停止当前账号任务。", 403)
            decision = await self.local_queue.cancel(user, sid, data.get("studio_task_id"))
            if decision and "running_session" not in decision:
                return web.json_response(decision)
            if decision:
                if not decision["running_session"]:
                    return web.json_response({"success": True})
                sid = decision["running_session"]
            elif data.get("studio_task_id"):
                return error("记录不可见或任务已结束。", 404)
            # Interrupt exactly the account-bound session the browser is generating with.
            return web.json_response(await self.upstream_api(user, endpoint, {"other_sessions": False, "session_id": sid}, False))
        if endpoint == "ListImages":
            if data.get("path", "") != "" or int(data.get("depth", 10)) not in range(0, 21):
                return error("只允许读取当前作品目录。")
            await self.synchronize(user, include_local=True)
            rows = self.store.all("SELECT a.*,u.email owner_email,v.hidden_at,t.started_at FROM artifacts a JOIN users u ON u.id=a.owner_id JOIN tasks t ON t.id=a.task_id LEFT JOIN task_visibility v ON v.task_id=t.id AND v.viewer_id=t.owner_id WHERE t.kind='local' ORDER BY a.created_at DESC")
            files = [{"src": row["url"].lstrip("/"), "metadata": row["metadata"], "studio_task_id": row["task_id"], "studio_owner_id": row["owner_id"], "studio_owner_email": row["owner_email"], "studio_hidden_at": row["hidden_at"],
                      "studio_created_utc": datetime.fromtimestamp(row["started_at"], timezone.utc).isoformat()}
                     for row in rows if user["role"] == "admin" or row["owner_id"] == user["id"] and not row["hidden_at"]]
            return web.json_response({"files": files, "folders": []})
        if endpoint == "SubmitStudioCloudImage":
            return await self.submit_cloud(user, data)
        if endpoint == "GetStudioCloudTask":
            task = self.store.task(str(data.get("request_id", "")))
            if not self.store.task_visible(task, user) or task["kind"] != "cloud":
                return error("记录不可见。", 404)
            owner = self.store.one("SELECT * FROM users WHERE id=?", (task["owner_id"],))
            result = await self.upstream_api(owner, endpoint, {"request_id": task["id"]})
            if result.get("request_id"):
                self.save_cloud(owner, result)
            else:
                result = json.loads(task["record_json"])
            return web.json_response(self.store.public_task(result, self.store.task(task["id"])))
        if endpoint == "ListStudioCloudTasks":
            await self.synchronize(user)
            tasks = self.store.all("SELECT id FROM tasks WHERE kind='cloud' ORDER BY started_at DESC")
            result = []
            for row in tasks:
                task = self.store.task(row["id"])
                if self.store.task_visible(task, user):
                    record = json.loads(task["record_json"])
                    if not record.get("request_id"):
                        record = {"request_id": task["id"], "status": task["status"], "model": task["model"], "prompt": "", "images": []}
                    result.append(self.store.public_task(record, task))
            return web.json_response({"tasks": result})
        result = await self.upstream_api(user, endpoint, data, endpoint != "PolishStudioPrompt")
        if endpoint == "GetCurrentStatus":
            result["studio_queue"] = self.local_queue.latest(user["id"])
            result["studio_task"] = self.local_queue.latest_task(user["id"])
        return web.json_response(result)

    async def submit_cloud(self, user, data):
        if not inline_references(data.get("reference_images", []), 16):
            return error("参考图必须为上传的内联图像，不能使用文件路径或图片链接。")
        tid = str(uuid.UUID(str(data.get("request_id", ""))))
        if tid != data.get("request_id"):
            raise ValueError("canonical UUID required")
        fingerprint = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if not self.store.claim(tid, user["id"], "cloud", data.get("model"), data.get("n"), fingerprint):
            old = self.store.task(tid)
            if old["owner_id"] != user["id"] or old["fingerprint"] != fingerprint or old.get("hidden_at"):
                return error("请求编号不可用，请创建新任务。", 409)
            # An idempotent browser retry reads the ledger; it NEVER repeats a paid write.
            record = json.loads(old["record_json"])
            if not record.get("request_id"):
                record = {"request_id": tid, "status": "outcome_unknown", "model": old["model"], "prompt": data.get("prompt", ""), "images": [], "error": "提交结果待核对，不会重复提交。"}
            return web.json_response(self.store.public_task(record, old))
        self.store.update_task(tid, status="submitting", record_json=json.dumps({"request_id": tid, "model": data.get("model"), "prompt": data.get("prompt", ""), "status": "submitting", "images": []}, ensure_ascii=False))
        try:
            result = await self.upstream_api(user, "SubmitStudioCloudImage", data, False)
            if result.get("request_id"):
                self.save_cloud(user, result)
                return web.json_response(self.store.public_task(result, self.store.task(tid)))
            self.store.update_task(tid, status="failed", ended_at=time.time(), record_json=json.dumps({"request_id": tid, "status": "failed", "model": data.get("model"), "prompt": data.get("prompt", ""), "images": [], "error": result.get("error", "提交被拒绝")}, ensure_ascii=False))
            return web.json_response(result)
        except Exception:
            self.store.update_task(tid, status="outcome_unknown")
            return error("提交响应未确认，请刷新任务核对；禁止重复提交。", 502, "outcome_unknown")

    def save_cloud(self, owner, record):
        tid = str(uuid.UUID(record["request_id"]))
        old = self.store.task(tid)
        if old and old["owner_id"] != owner["id"]:
            raise ValueError("global task collision")
        if not old:
            self.store.claim(tid, owner["id"], "cloud", record.get("model"), record.get("parameters", {}).get("n"))
            try:
                when = datetime.fromisoformat(record["created_utc"].replace("Z", "+00:00")).timestamp()
                self.store.update_task(tid, started_at=when)
            except (KeyError, ValueError, TypeError):
                pass
        delivered = 0
        for image in record.get("images", []):
            url = image.get("url", "")
            if not re.fullmatch(r"/studio-results/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp)", url):
                continue
            if not Path(url).name.startswith(tid + "-"):
                raise ValueError("cloud artifact request mismatch")
            disk = (self.results / Path(url).name).resolve()
            if disk.is_relative_to(self.results.resolve()) and disk.is_file():
                self.store.artifact(url, tid, owner["id"], disk)
                delivered += 1
        status = record.get("status", "outcome_unknown")
        seconds = record.get("actual_time") if isinstance(record.get("actual_time"), (float, int)) else None
        credits = record.get("credits_cost") if isinstance(record.get("credits_cost"), (float, int)) and record["credits_cost"] >= 0 else None
        self.store.update_task(tid, model=record.get("model"), status=status, requested=record.get("parameters", {}).get("n"), completed=delivered,
                               credits=credits, seconds=seconds, ended_at=time.time() if status in TERMINAL else None, record_json=json.dumps(record, ensure_ascii=False))

    def import_cloud_ledger(self):
        """Reserve historical IDs before accepting any new paid request."""
        base = self.root / "server/SwarmUI/Data/StudioCloudTasks"
        for owner in self.store.all("SELECT * FROM users"):
            folder = base / hashlib.sha256(owner["swarm_id"].encode()).hexdigest().upper()[:24]
            if not folder.is_dir():
                continue
            for path in folder.glob("*.json"):
                try:
                    self.save_cloud(owner, json.loads(path.read_text(encoding="utf-8-sig")))
                except (ValueError, KeyError, TypeError, OSError):
                    continue

    def local_artifact(self, owner, source, metadata=None, task_id=None):
        parts = safe_parts(source)
        if parts[0] == "View":
            if len(parts) < 3 or parts[1] != owner["swarm_id"]:
                raise ValueError("wrong output owner")
            parts = parts[2:]
        elif parts[0] == "Output":
            parts = parts[1:]
        disk = self.output.joinpath(owner["swarm_id"], *parts).resolve()
        if not disk.is_relative_to((self.output / owner["swarm_id"]).resolve()) or disk.suffix.lower() not in IMAGE_EXTENSIONS:
            raise ValueError("invalid image path")
        url = "/View/" + owner["swarm_id"] + "/" + "/".join(parts)
        existing = self.store.one("SELECT task_id FROM artifacts WHERE url=?", (url,))
        if existing:
            task_id = existing["task_id"]
        elif not task_id:
            try:
                recovered = json.loads(metadata or "{}").get("sui_extra_data", {}).get("studio_task_id")
                bound = self.store.task(recovered) if recovered else None
                if bound and bound["owner_id"] == owner["id"] and bound["kind"] == "local":
                    task_id = recovered
            except (ValueError, TypeError):
                pass
            if not task_id:
                task_id = "legacy_" + hashlib.sha256(url.encode()).hexdigest()[:32]
                self.store.claim(task_id, owner["id"], "local", None, 1)
                self.store.update_task(task_id, status="completed", completed=1, credits=0, started_at=disk.stat().st_mtime if disk.is_file() else time.time())
        self.store.artifact(url, task_id, owner["id"], disk, metadata)
        bound = self.store.task(task_id)
        if bound["status"] == "outcome_unknown":
            count = self.store.one("SELECT COUNT(*) total FROM artifacts WHERE task_id=?", (task_id,))["total"]
            self.store.update_task(task_id, completed=count, status="completed" if count >= (bound["requested"] or 1) else "outcome_unknown")
        return url, task_id

    async def synchronize(self, user, include_local=False):
        owners = self.store.all("SELECT * FROM users") if user["role"] == "admin" else [user]
        for owner in owners:
            # Importing reads only this owner's backend namespace, never client-controlled paths.
            try:
                result = await self.upstream_api(owner, "ListStudioCloudTasks")
                for record in result.get("tasks", []):
                    self.save_cloud(owner, record)
                if include_local:
                    result = await self.upstream_api(owner, "ListImages", {"path": "", "depth": 20, "sortBy": "Date", "sortReverse": False})
                    for image in result.get("files", []):
                        try:
                            self.local_artifact(owner, image["src"], image.get("metadata"))
                        except (ValueError, KeyError):
                            continue
            except Exception:
                # Known ledger history remains available during a backend outage.
                continue

    async def file(self, request, user):
        try:
            parts = http_parts(request)
            if parts[0] == "Output":
                parts = ["View", user["swarm_id"], *parts[1:]]
            url = "/" + "/".join(parts)
            row = self.store.visible_artifact(url, user)
            if not row:
                raise ValueError()
            disk = Path(row["disk_path"]).resolve()
            local = disk.is_relative_to(self.output.resolve())
            if not (local or disk.is_relative_to(self.results.resolve())) or disk.suffix.lower() not in IMAGE_EXTENSIONS:
                raise ValueError()
        except ValueError:
            raise web.HTTPNotFound()
        task = self.store.task(row["task_id"])
        recent = task["ended_at"] is not None and time.time() - task["ended_at"] < 15
        if local and (task["status"] not in TERMINAL or recent or not disk.is_file() or disk.stat().st_size == 0):
            # Swarm emits the image URL before its background file write finishes.
            # Its native View handler waits for StillSavingFiles' complete byte task;
            # serving the partially written disk file here creates a permanent img error.
            # The cache read happens only AFTER the exact artifact ownership check.
            owner = self.store.one("SELECT swarm_id FROM users WHERE id=?", (row["owner_id"],))
            # Native ViewOutput performs another URI decode after ASP.NET path decoding.
            # Protect literal '%' once more so filenames such as '100% cotton %2e'
            # retain their exact filesystem spelling at that backend boundary.
            native_path = quote(url.replace("%", "%25"), safe="/")
            async with self.client.get(self.upstream + native_path, headers={"X-SWARM-USER_ID": owner["swarm_id"]}) as upstream:
                upstream.raise_for_status()
                content_type = upstream.headers.get("Content-Type", "").split(";", 1)[0]
                if content_type not in {"image/png", "image/jpeg", "image/webp"}:
                    return error("图像仍在保存，请稍后刷新记录。", 502)
                body = bytearray()
                async for chunk in upstream.content.iter_chunked(65536):
                    body.extend(chunk)
                    if len(body) > 128 * 1024 ** 2:
                        return error("图像大小超出当前读取范围。", 502)
                return web.Response(body=bytes(body), content_type=content_type, headers={"Cache-Control": "private, no-store"})
        if not disk.is_file():
            raise web.HTTPNotFound()
        response = web.FileResponse(disk)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    async def generate(self, request, user):
        socket = web.WebSocketResponse(max_msg_size=384 * 1024 ** 2, heartbeat=30, timeout=1)
        await socket.prepare(request)
        self.sockets[user["id"]].add(socket)
        try:
            message = await asyncio.wait_for(socket.receive(), timeout=30)
            if message.type != WSMsgType.TEXT:
                raise ValueError("expected JSON")
            data = json.loads(message.data)
            if not isinstance(data, dict) or any(str(k).lower() in SENSITIVE_KEYS for k in data):
                raise ValueError("identity parameters forbidden")
            sid = data.pop("session_id", None)
            if not self.store.session_owned(sid, user["id"]):
                raise ValueError("会话不属于当前账号")
            # Revalidate cookie immediately before generation, including password-reset revocation.
            current = self.store.session(request.cookies.get(COOKIE))
            if not current or current["id"] != user["id"]:
                raise ValueError("登录已失效")
            tid = str(uuid.UUID(str(data.pop("studio_task_id", uuid.uuid4()))))
            if set(data) - LOCAL_PARAMS:
                raise ValueError("unsupported generation parameter")
            if data.get("model") not in {"qwen_image_2.1_int8_convrot.safetensors", "qwen_image_2.1_turbo_int8_convrot.safetensors"}:
                raise ValueError("unsupported local model")
            for field in ("width", "height"):
                value = data.get(field, 1024)
                if not isinstance(value, int) or not 64 <= value <= 4096 or value % 32:
                    raise ValueError("invalid dimensions")
            steps = data.get("steps", 8)
            if not isinstance(steps, (int, float)) or not math.isfinite(steps) or not 1 <= steps <= 100:
                raise ValueError("invalid steps")
            references = data.get("promptimages", [])
            if not inline_references(references, 10):
                raise ValueError("references must be inline images")
            count = int(data.get("images", 1))
            if not 1 <= count <= 4:
                raise ValueError("生成数量超出范围")
            metadata = data.get("extra_metadata", {})
            if not isinstance(metadata, dict):
                raise ValueError("invalid metadata")
            if not self.store.claim(tid, user["id"], "local", data.get("model"), count):
                raise ValueError("任务编号已使用，不会重复生成")
            data["session_id"] = sid
            # Server-owned marker lets saved local output recover the correct task after restart.
            data["extra_metadata"] = {**metadata, "studio_task_id": tid}
            job = self.local_queue.enqueue(user, tid, data, socket)
            await self.local_queue.emit(job, {"studio_task_id": tid, "studio_queue": self.local_queue.snapshot(tid)})
            await asyncio.shield(job["done"])
        except (ValueError, KeyError, asyncio.TimeoutError):
            if not socket.closed:
                await socket.send_json({"error": "生成请求无效或登录已失效，请刷新连接。", "socket_intention": "close"})
        finally:
            self.sockets[user["id"]].discard(socket)
            await socket.close()
        return socket

    async def relay_local(self, socket, user, tid, data):
        completed = set()
        started = time.time()
        status = "outcome_unknown"
        cancel_sent = False
        try:
            async with self.client.ws_connect(self.upstream + "/API/GenerateText2ImageWS", max_msg_size=384 * 1024 ** 2,
                                              headers={"X-SWARM-USER_ID": user["swarm_id"]}, heartbeat=30) as upstream:
                job = self.local_queue.jobs.get(tid)
                if job and job["cancel_requested"]:
                    status = "cancelled"
                    if socket and not socket.closed:
                        await socket.send_json({"studio_task_id": tid, "studio_cancelled": True, "socket_intention": "close"})
                    return
                await upstream.send_json(data)
                async for message in upstream:
                    if message.type != WSMsgType.TEXT:
                        continue
                    value = json.loads(message.data)
                    value["studio_task_id"] = tid
                    value["studio_owner_id"] = user["id"]
                    value["studio_owner_email"] = user["email"]
                    value["studio_queue"] = self.local_queue.snapshot(tid)
                    if job and job["cancel_requested"] and not cancel_sent:
                        await self.upstream_api(user, "InterruptAll", {"other_sessions": False, "session_id": data["session_id"]}, False)
                        cancel_sent = True
                    if value.get("image"):
                        url, _ = self.local_artifact(user, value["image"], value.get("metadata"), tid)
                        value["image"] = url
                        completed.add(url)
                        self.store.update_task(tid, completed=len(completed), status="processing")
                    if value.get("error"):
                        status = "failed"
                    elif value.get("socket_intention") == "close":
                        status = "completed" if len(completed) >= int(data.get("images", 1)) else "interrupted"
                    if socket and not socket.closed:
                        with contextlib.suppress(ConnectionError, RuntimeError):
                            await socket.send_json(value)
        except Exception:
            if socket and not socket.closed:
                with contextlib.suppress(ConnectionError, RuntimeError):
                    await socket.send_json({"error": "生成连接结果未确认，请刷新记录核对。", "studio_task_id": tid, "socket_intention": "close"})
        finally:
            self.store.update_task(tid, status=status, completed=len(completed), ended_at=time.time() if status in TERMINAL else None,
                                   seconds=time.time() - started if status in TERMINAL else None)

    async def reconcile_loop(self):
        while True:
            await asyncio.sleep(self.reconcile_interval)
            await self.reconcile_once()

    async def reconcile_once(self):
        for task in self.store.all("SELECT t.* FROM tasks t WHERE t.kind='cloud' AND (t.status NOT IN ('completed','failed','cancelled') OR t.completed < t.requested)"):
            owner = self.store.one("SELECT * FROM users WHERE id=?", (task["owner_id"],))
            try:
                result = await self.upstream_api(owner, "GetStudioCloudTask", {"request_id": task["id"]})
                if result.get("request_id"):
                    self.save_cloud(owner, result)
            except Exception:
                continue


def main():
    parser = argparse.ArgumentParser(description="Nandou Studio account gateway")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--database", default=None)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7801)
    parser.add_argument("--upstream", default="http://127.0.0.1:7802")
    parser.add_argument("--bootstrap-admin", action="store_true", help="Read initial password from stdin; never overwrite an existing admin")
    args = parser.parse_args()
    database = args.database or str(Path(args.root) / "runtime/studio-accounts.sqlite3")
    if args.bootstrap_admin:
        store = Store(database)
        if store.user("admin"):
            print("Administrator already initialized; unchanged.")
        else:
            password = sys.stdin.readline().rstrip("\r\n")
            if not 6 <= len(password) <= 256:
                raise SystemExit("Initial password must contain 6 to 256 characters.")
            store.create_user("admin", password_hash(password), "admin")
            print("Administrator initialized; only a salted password hash was stored.")
        store.close()
        return
    gateway = Gateway(args.root, database, args.upstream)
    if not gateway.store.user("admin"):
        raise SystemExit("Administrator is not initialized. Run --bootstrap-admin with password on stdin first.")
    web.run_app(gateway.app, host=args.host, port=args.port, access_log=None, print=None)


if __name__ == "__main__":
    main()
