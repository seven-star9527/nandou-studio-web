"""Account-aware LAN entry point. Swarm itself must listen on loopback only."""
import argparse
import asyncio
import contextlib
import hashlib
import ipaddress
import json
import math
import os
import re
import sqlite3
import sys
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType, web

from .store import Store, TERMINAL, password_hash, password_valid, token_hash
from .local_queue import LocalQueue
from .generation_presets import generation_presets
from .official_usage import official_usage
from .image_preview import svg_headers, preview_path
from .agent import CreativeAgent
from .workbench import Workbench, private_history
from .image_uploads import ImageUploadError, check_upload_batch, generation_references
from .task_references import reference_directory, save_task_references, task_references
from . import ai_retouch
from .prompt_polish import PromptPolisher
from .model_management import LOCAL_MODELS, ModelManagement, ModelPolicyError, units


COOKIE = "nandou_session"
AI_RETOUCH_MODELS = ('gemini-nano-banana-2.1', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst')
READ_APIS = {"ListT2IParams", "GetCurrentStatus", "GetStudioCloudCapabilities", "GetStudioCloudAccount",
             "GetStudioCloudQuote", "GetStudioPolishCapabilities", "PolishStudioPrompt"}
TASK_APIS = {"GetNewSession", "ListImages", "InterruptAll", "SubmitStudioCloudImage", "GetStudioCloudTask", "ListStudioCloudTasks"}
SENSITIVE_KEYS = {"impersonateuser", "user_id", "userid", "owner_id", "role", "swarm_id"}
IDENTITY_HEADERS = {"x-swarm-user_id", "x-session-id"}
PUBLIC_HOST = "nandouai.cn"
PUBLIC_ACCOUNT_DISABLED = {"/studio-auth/register", "/studio-auth/reset"}
RESET_INITIAL_PASSWORD = "abc123456"
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
    if not isinstance(values, list) or len(values) > limit:
        return False
    check_upload_batch(values)
    return True


def socket_peer(request):
    try:
        peer = ipaddress.ip_address(request.transport.get_extra_info("peername")[0])
        return peer.ipv4_mapped if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped else peer
    except (ValueError, TypeError, IndexError, AttributeError):
        return None


def local_entry(request):
    try:
        peer = socket_peer(request)
        host = urlsplit("//" + request.host).hostname
        return bool(peer and peer.is_loopback and host in {"localhost", "127.0.0.1", "::1"})
    except ValueError:
        return False


def account_name(value):
    if isinstance(value, str):
        name = value.strip()
        if 1 <= len(name) <= 64 and name.isprintable() and any(c.isalpha() for c in name):
            return name
    return None


def public_user(user):
    if not user:
        return None
    hosted = user["password_hash"] == "hosted"
    return {"id": user["id"], "email": "" if hosted else user["email"], "name": user["name"],
            "role": user["role"], "is_admin": user["role"] == "admin", "hosted": hosted}


class Gateway:
    def __init__(self, root, database, upstream="http://127.0.0.1:7802", reconcile_interval=15, trusted_proxy=None):
        self.root = Path(root).resolve()
        self.trusted_proxy = trusted_proxy
        self.public_login_attempts = deque()
        self.store = Store(database)
        catalog = self.root / 'server/SwarmUI/Data/StudioCloudModels.json'
        if not catalog.is_file():
            catalog = Path(__file__).resolve().parents[1] / 'integrations/swarm/overlay/Data/StudioCloudModels.json'
        self.models = ModelManagement(self.store, json.loads(catalog.read_text(encoding='utf-8-sig'))['models'])
        self.upstream = upstream.rstrip("/")
        self.output = self.root / "server/SwarmUI/Output"
        self.results = self.root / "server/SwarmUI/src/wwwroot/studio-results"
        self.static = self.root / "server/SwarmUI/src/wwwroot/studio"
        self.client = None
        self.sessions = {}
        self.session_locks = defaultdict(asyncio.Lock)
        self.sockets = defaultdict(dict)
        self.rate = defaultdict(list)
        self.local_queue = LocalQueue(self)
        self.agent = CreativeAgent(self)
        self.polisher = PromptPolisher(self)
        self.workbench = Workbench(self)
        self.retouch_workers={}
        self.retouch_limit=asyncio.Semaphore(1)
        self.store.db.execute("""CREATE TABLE IF NOT EXISTS ai_retouch_jobs(
            task_id TEXT PRIMARY KEY REFERENCES tasks(id), category TEXT NOT NULL, white_bg INTEGER NOT NULL,
            align_geometry INTEGER NOT NULL, engine_url TEXT, output_json TEXT, failure TEXT)""")
        ai_retouch.reconstruction_schema(self.store)
        self.reconcile_interval = reconcile_interval
        self.import_cloud_ledger()
        self.app = web.Application(client_max_size=384 * 1024 ** 2, middlewares=[self.boundary])
        self.app["gateway"] = self
        self.app.router.add_route("*", "/{path:.*}", self.route)
        self.app.on_startup.append(self.startup)
        self.app.on_cleanup.append(self.cleanup)

    @web.middleware
    async def boundary(self, request, handler):
        names = {name.lower() for name in request.headers}
        if names & IDENTITY_HEADERS:
            return error("不接受客户端身份或转发请求头。", 400)
        public = self.trusted_proxy is not None and socket_peer(request) == self.trusted_proxy
        if public:
            # Only the TCP peer can establish proxy trust. Traefik appends its
            # immediate client to XFF when forwarding, so do not use earlier entries.
            forwarded_for = request.headers.getall("X-Forwarded-For", [])
            if (request.headers.getall("Host", []) != [PUBLIC_HOST]
                    or request.headers.getall("X-Forwarded-Host", []) != [PUBLIC_HOST]
                    or request.headers.getall("X-Forwarded-Proto", []) != ["https"]
                    or len(forwarded_for) != 1):
                return error("公网入口转发信息无效。", 400)
            try:
                remote = str(ipaddress.ip_address(forwarded_for[0].rsplit(",", 1)[-1].strip()))
            except ValueError:
                return error("公网入口转发信息无效。", 400)
            request = request.clone(scheme="https", remote=remote)
            if request.path in PUBLIC_ACCOUNT_DISABLED:
                return error("公网入口仅支持已有账号登录。", 403)
        elif (names & {"forwarded", "x-real-ip"} or any(name.startswith("x-forwarded-") for name in names)
              or request.host.lower().split(":", 1)[0].rstrip(".") == PUBLIC_HOST):
            return error("不接受客户端身份或转发请求头。", 400)
        request["public_entry"] = public
        request["admin_entry"] = public or local_entry(request)
        origin = request.headers.get("Origin")
        if origin:
            try:
                parsed = urlsplit(origin)
            except ValueError:
                return error("请求来源不匹配。", 403)
            if parsed.netloc.lower() != request.host.lower() or parsed.scheme != request.scheme:
                return error("请求来源不匹配。", 403)
        user = self.store.session(request.cookies.get(COOKIE))
        if user and user["role"] == "admin" and not request["admin_entry"]:
            user = None
        request["user"] = user
        if user:
            self.store.touch(user, request.remote or "unknown")
        try:
            response = await handler(request)
        except ModelPolicyError as exc:
            response = error(str(exc), exc.status, exc.code)
        except ImageUploadError as exc:
            response = error(str(exc), 400, exc.code)
        except (ValueError, json.JSONDecodeError):
            response = error("请求参数无效。")
        except (asyncio.TimeoutError, ConnectionError, ClientError):
            response = error("后端响应未确认，请刷新记录核对；不会自动重提任务。", 502, "outcome_unknown")
        if not isinstance(response, web.WebSocketResponse):
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "same-origin"
            if not request.path.startswith("/studio/"):
                response.headers.setdefault("Cache-Control", "private, no-store")
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
        if self.retouch_workers:
            await asyncio.gather(*list(self.retouch_workers.values()),return_exceptions=True)
        if self.workbench.running:
            await asyncio.gather(*self.workbench.running, return_exceptions=True)
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
        if user and user["role"] != "admin" and not user["name"] and path not in {
            "/studio-auth/me", "/studio-auth/nandou-sso", "/studio-auth/bind-name", "/studio-auth/logout", "/studio-auth/login",
            "/studio-auth/register", "/studio-auth/recover", "/studio-auth/reset", "/studio-auth/change-password",
        }:
            return error("请刷新页面并绑定姓名后继续。", 403, "name_required")
        if path.startswith("/studio-auth/"):
            return await self.auth(request)
        if not user:
            return error("请先登录。", 401, "authentication_required")
        if path.startswith("/studio-agent/workbench/"):
            return await self.workbench.route(request, user, path.removeprefix("/studio-agent/workbench/"))
        if path.startswith("/studio-agent/"):
            return await self.agent.route(request, user)
        if path.startswith('/studio-references/') and request.method in {'GET', 'HEAD'}:
            parts = http_parts(request)
            if len(parts) != 3 or not self.store.task_visible(self.store.task(parts[1]), user):
                raise web.HTTPNotFound()
            entries = task_references(self.root, parts[1])
            if not any(entry['url'] == '/' + '/'.join(parts) for entry in entries):
                raise web.HTTPNotFound()
            target = reference_directory(self.root, parts[1]) / parts[2]
            if not target.is_file():
                raise web.HTTPNotFound()
            response = web.FileResponse(target)
            response.headers['Cache-Control'] = 'private, no-store'
            return response
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
            return web.json_response({"user": public_user(user), "admin_entry": request["admin_entry"]})
        if action == "admin/password-reset" and request.method == "POST":
            if not user or user["role"] != "admin" or not request["admin_entry"]:
                return error("无法访问。", 403)
            data = await self.body(request)
            uid = data.get("account")
            if set(data) != {"account"} or not isinstance(uid, str):
                raise ValueError("invalid target account")
            result = self.store.issue_password_reset(uid, user["id"], request.remote or "unknown")
            if not result:
                return error("普通账号不存在。", 404, "account_not_found")
            await self.close_sessions(uid)
            return web.json_response({**result, "initial_password": RESET_INITIAL_PASSWORD})
        if action == 'admin/model-management':
            if not user or user['role'] != 'admin' or not request["admin_entry"]:
                return error('无法访问。', 403)
            return await self.model_management(request)
        if action == "history" and request.method == "GET":
            if not user:
                return error("请先登录。", 401)
            payload = {"files": self.local_history(user), "tasks": self.cloud_history(user)}
            return private_history(request, user, payload)
        if action == "generation-presets" and request.method in {"GET", "POST"}:
            if not user:
                return error("请先登录。", 401)
            change = None
            if request.method == "POST":
                change = await self.body(request)
                if change.get("account") != user["id"]:
                    return error("当前账号已切换，请刷新页面。", 409)
            try:
                entries = generation_presets(self.store, user["id"], change)
            except ValueError as exc:
                return error(str(exc))
            except KeyError:
                return error("配置不存在。", 404)
            return web.json_response({"account": user["id"], "presets": entries})
        if action == "admin/official-usage" and request.method == "GET":
            if not user or user["role"] != "admin" or not request["admin_entry"]:
                return error("无法访问。", 403)
            prior = self.store.all("""SELECT id,model,strftime('%Y-%m-%dT%H:%M:%SZ',started_at,'unixepoch') at
                FROM tasks WHERE json_extract(record_json,'$.reference_billing') = 1""")
            report = await asyncio.to_thread(official_usage, self.root, prior)
            return web.json_response(report, headers={"Cache-Control": "private, no-store"})
        if action == "admin/overview" and request.method == "GET":
            if not user or user["role"] != "admin" or not request["admin_entry"]:
                return error("无法访问。", 403)
            await self.synchronize(user, include_local=True)
            return web.json_response(self.store.overview())
        if request.method != "POST":
            raise web.HTTPNotFound()
        data = await self.body(request)
        if action == "nandou-sso":
            return await self.hosted_sign_in(request, data)
        if action == "bind-name":
            if not user:
                return error("请先登录。", 401)
            if user["role"] == "admin":
                return error("管理员无需绑定姓名。", 403)
            if data.get("account") != user["id"]:
                return error("当前账号已切换，请刷新页面。", 409)
            name = account_name(data.get("name"))
            if not name:
                return error("请输入有效姓名，最多 64 个字符。")
            account = self.store.bind_name(user["id"], name)
            if account["name"] != name:
                return error("此账号已绑定姓名，请刷新页面。", 409)
            return web.json_response({"user": public_user(account)})
        if action == 'tasks/references':
            if not user:
                return error('请先登录。', 401)
            task_id = str(data.get('task_id', ''))
            if not self.store.task_visible(self.store.task(task_id), user):
                return error('记录不可见。', 404)
            return web.json_response({'references': task_references(self.root, task_id)})
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
        if action == "reset":
            return error("请联系管理员领取一次性重置码。", 403, "reset_code_required")
        if action not in {"register", "login", "recover", "change-password"}:
            raise web.HTTPNotFound()
        if action == "change-password" and not user:
            return error("请先登录。", 401, "authentication_required")
        now = time.monotonic()
        remote = request.remote or "unknown"
        if request["public_entry"]:
            attempts = self.public_login_attempts
            while attempts and now - attempts[0][0] >= 60:
                attempts.popleft()
            if len(attempts) >= 120 or sum(ip == remote for _, ip in attempts) >= 12:
                return error("请求过于频繁，请稍后再试。", 429)
            attempts.append((now, remote))
        else:
            bucket = self.rate[remote]
            bucket[:] = [stamp for stamp in bucket if now - stamp < 60]
            if len(bucket) >= 30:
                return error("请求过于频繁，请稍后再试。", 429)
            bucket.append(now)
        if action == "change-password":
            return await self.change_password(request, user, data, remote)
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
            name = account_name(data.get("name"))
            if not name:
                return error("请输入有效姓名，最多 64 个字符。")
            encoded = await asyncio.to_thread(password_hash, password)
            try:
                account = self.store.create_user(email, encoded, name=name)
            except sqlite3.IntegrityError:
                return error("此邮箱已注册。", 409)
        elif action == "recover":
            if password == RESET_INITIAL_PASSWORD:
                return error("新密码不能与初始密码相同。")
            code = data.get("code")
            if (not account or account["role"] == "admin" or data.get("initial_password") != RESET_INITIAL_PASSWORD
                    or not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", code)
                    or not self.store.password_reset_valid(account["id"], code)):
                return error("初始密码或重置码无效，或重置码已过期。", 400, "invalid_reset_code")
            encoded = await asyncio.to_thread(password_hash, password)
            if not self.store.complete_password_reset(account["id"], code, encoded, remote):
                return error("重置码已失效，请联系管理员。", 400, "invalid_reset_code")
            return web.json_response({"ok": True})
        else:
            # Dummy hash for unknown accounts keeps the expensive work comparable.
            if not account or account["password_hash"].startswith("reset$"):
                await asyncio.to_thread(password_hash, password)
                return error("账号或密码不正确。", 401)
            if account["role"] == "admin" and not request["admin_entry"]:
                return error("请从 Studio 正式 HTTPS 地址或本机入口登录管理员账号。", 403)
            if not await asyncio.to_thread(password_valid, password, account["password_hash"]):
                return error("账号或密码不正确。", 401)
            # Password hashing runs off-loop: a reset can finish while it is running.
            # Compare the verified snapshot again with no await before issuing a token.
            fresh = self.store.user(email)
            if not fresh or fresh["password_hash"] != account["password_hash"]:
                return error("密码已变更，请使用新密码重新登录。", 401)
            account = fresh
        return self.sign_in_response(request, account, action)

    def sign_in_response(self, request, account, action):
        token = self.store.login(account["id"])
        self.store.touch(account, request.remote or "unknown", action)
        response = web.json_response({"user": public_user(account)})
        response.set_cookie(COOKIE, token, httponly=True, samesite="Strict", secure=request.secure, max_age=86400 * 7, path="/")
        return response

    async def hosted_sign_in(self, request, data):
        org = os.getenv("NANDOU_ORG_ID")
        secret = os.getenv("NANDOU_HOSTED_APP_SECRET")
        if not org or not secret:
            return error("Studio 尚未配置南斗免登录。", 503, "sso_unavailable")
        invalid = "南斗登录凭证无效或已过期，请从南斗重新打开 Studio。"
        ticket = data.get("ticket")
        if (set(data) != {"organization_id", "ticket"} or data["organization_id"] != org
                or not isinstance(ticket, str) or not 10 <= len(ticket) <= 256):
            return error(invalid, 401, "invalid_ticket")
        try:
            async with self.client.post(
                "https://api.nandouai.cn/api/context/hosted-apps/verify-ticket",
                headers={"X-Hosted-App-Id": "nandou-studio", "X-Hosted-App-Secret": secret},
                json={"organization_id": org, "ticket": ticket},
                timeout=ClientTimeout(total=8), allow_redirects=False,
            ) as response:
                if response.status >= 500:
                    return error("南斗登录服务暂时不可用，请从南斗重新打开 Studio。", 503, "sso_unavailable")
                if response.status != 200:
                    return error(invalid, 401, "invalid_ticket")
                body = await response.json()
        except (asyncio.TimeoutError, ClientError, ValueError):
            return error("南斗登录服务暂时不可用，请从南斗重新打开 Studio。", 503, "sso_unavailable")
        identity = body.get("data") if isinstance(body, dict) and body.get("success") is True else None
        if (not isinstance(identity, dict) or identity.get("valid") is not True
                or identity.get("app_id") != "nandou-studio" or identity.get("organization_id") != org
                or not isinstance(identity.get("organization"), dict) or identity["organization"].get("id") != org
                or not isinstance(identity.get("user"), dict)):
            return error(invalid, 401, "invalid_ticket")
        member = identity["user"]
        try:
            subject = str(uuid.UUID(str(member.get("id"))))
        except ValueError:
            return error(invalid, 401, "invalid_ticket")
        name = account_name(member.get("display_name")) or account_name(member.get("username")) or "南斗成员"
        account = self.store.hosted_user(org, subject, name)
        return self.sign_in_response(request, account, "nandou-sso")

    async def change_password(self, request, user, data, remote):
        if set(data) != {"account", "current_password", "password"}:
            raise ValueError("invalid password change parameters")
        if data["account"] != user["id"]:
            return error("当前账号已切换，请刷新页面。", 409)
        current, password = data["current_password"], data["password"]
        if not isinstance(current, str) or not 1 <= len(current) <= 256:
            return error("请输入有效的当前密码。", 400, "incorrect_current_password")
        if not isinstance(password, str) or not 6 <= len(password) <= 256:
            return error("新密码需为 6 至 256 个字符。")
        if not await asyncio.to_thread(password_valid, current, user["password_hash"]):
            return error("当前密码不正确。", 403, "incorrect_current_password")
        if password == current or password == RESET_INITIAL_PASSWORD:
            return error("请设置与当前密码和初始密码不同的新密码。", 400, "invalid_new_password")
        encoded = await asyncio.to_thread(password_hash, password)
        token = request.cookies[COOKIE]
        if not self.store.change_password(user["id"], user["password_hash"], encoded, token, remote):
            if not self.store.session(token):
                return error("登录已失效，请重新登录。", 401, "authentication_required")
            return error("密码已变更，请核对当前密码后重试。", 409)
        await self.close_sessions(user["id"], keep=token_hash(token))
        return web.json_response({"ok": True})

    async def close_sessions(self, uid, *, keep=None):
        if keep is None:
            self.sessions.pop(uid, None)
        for socket, login in list(self.sockets.get(uid, {}).items()):
            if login != keep:
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
        internal_dispatch = endpoint == 'SubmitStudioCloudImage' and data is not None and 'studio_official_only' not in data
        if internal_dispatch:
            tid = str(uuid.UUID(data['request_id']))
            # Only a durable, server-created reconstruction belonging to this owner
            # may use the model hidden from ordinary generation. Never trust a payload flag.
            child = self.store.one('''SELECT j.task_id FROM ai_retouch_jobs j JOIN tasks t ON t.id=j.task_id
                WHERE j.rebuild_id=? AND j.rebuild=1 AND j.engine_url IS NOT NULL AND t.owner_id=?''', (tid,user['id']))
            try:
                data = await self.managed_dispatch(user,tid,child['task_id'] if child else tid,data,retouch_rebuild=bool(child))
            except ModelPolicyError as exc:
                return {'error': str(exc), 'error_id': exc.code}
        session = self.sessions.get(user["id"]) or await self.new_session(user)
        value = {"session_id": session["session_id"], **(data or {})}
        async with self.client.post(self.upstream + "/API/" + endpoint, json=value, headers={"X-SWARM-USER_ID": user["swarm_id"]}) as response:
            result = await response.json()
        if endpoint in {'SubmitStudioCloudImage','GetStudioCloudTask'} and data and result.get('request_id') == data.get('request_id'):
            self.models.settle(result)
        elif internal_dispatch and result.get('error'):
            self.models.settle({'request_id':data['request_id'],'status':'failed','credits_cost':0})
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
            return web.json_response({"files": self.local_history(user), "folders": []})
        if endpoint == "SubmitStudioCloudImage":
            return await self.submit_cloud(user, data)
        if endpoint == 'GetStudioCloudAccount' and user['role'] != 'admin':
            return web.json_response({'studio_quota': self.models.snapshot(user['id'])})
        if endpoint == 'GetStudioCloudQuote':
            data = {'operation':'generate', **data}
            self.models.validate(user, data)
            return web.json_response(await self.cloud_quote(user, data))
        if endpoint == "GetStudioCloudTask":
            task = self.store.task(str(data.get("request_id", "")))
            if not self.store.task_visible(task, user) or task["kind"] != "cloud":
                return error("记录不可见。", 404)
            owner = self.store.one("SELECT * FROM users WHERE id=?", (task["owner_id"],))
            result = await self.upstream_api(owner, endpoint, {"request_id": task["id"]})
            if result.get("request_id"):
                self.save_cloud(owner, result)
            latest = self.store.task(task["id"])
            return web.json_response(self.store.public_task(json.loads(latest["record_json"]), latest))
        if endpoint == "ListStudioCloudTasks":
            await self.synchronize(user)
            return web.json_response({"tasks": self.cloud_history(user)})
        if endpoint == 'GetStudioPolishCapabilities':
            return web.json_response(self.polisher.capabilities())
        if endpoint == 'PolishStudioPrompt':
            try:
                return web.json_response(await self.polisher.polish(user, data))
            except ValueError as exc:
                return error(str(exc), 400, 'polish_invalid_input')
        result = await self.upstream_api(user, endpoint, data, endpoint != "PolishStudioPrompt")
        if endpoint == 'GetStudioCloudCapabilities':
            result = self.models.public_models(result,user)
        if endpoint == 'ListT2IParams' and user['role'] != 'admin' and isinstance(result.get('models'),dict):
            entries = result['models'].get('Stable-Diffusion',[])
            result['models'] = {'Stable-Diffusion': [entry for entry in entries if entry[0] in LOCAL_MODELS and self.models.model(entry[0])['enabled']]}
        if endpoint == "GetCurrentStatus":
            result["studio_queue"] = self.local_queue.latest(user["id"])
            result["studio_task"] = self.local_queue.latest_task(user["id"])
        return web.json_response(result)

    async def model_management(self, request):
        if request.method == 'POST':
            body = await self.body(request)
            action = body.get('action')
            if action == 'save-model' and set(body) == {'action','model','policy'}:
                self.models.set_model(body['model'],body['policy'])
            elif action == 'save-limits' and set(body) == {'action','account','limits'}:
                self.models.set_limits(body['account'],body['limits'])
            elif action == 'reset-user' and set(body) == {'action','account'} and isinstance(body['account'],str):
                return web.json_response({'reset': self.models.reset(body['account'])})
            elif action == 'reset-all' and set(body) == {'action','confirm'} and body['confirm'] is True:
                return web.json_response({'reset': self.models.reset()})
            else:
                raise ValueError('invalid model action')
        elif request.method != 'GET':
            raise web.HTTPMethodNotAllowed(request.method,['GET','POST'])
        return web.json_response({'models': [{'supported': m, 'policy': self.models.model(m['id'])} for m in self.models.catalog.values()],
            'users': [{**row, 'quota': self.models.snapshot(row['id'])} for row in self.store.all("SELECT id,email,name FROM users WHERE role!='admin' ORDER BY name,email")]})

    async def managed_dispatch(self, user, tid, parent, data, *, retouch_rebuild=False):
        self.models.validate(user,data,retouch_rebuild=retouch_rebuild)
        estimate = None
        if user['role'] != 'admin' and self.models.has_limit(user['id'], data['model']):
            params = {k:v for k,v in data.items() if k in {'model','size','resolution','quality','n','output_format','frame_count','frame_duration_ms','operation'}}
            try:
                quote = await self.upstream_api(user,'GetStudioCloudQuote',params)
                if not quote.get('stale') and not quote.get('error'):
                    estimate = units(quote.get('credits_total_reference'))
                    if estimate is None and type(params.get('n')) is int:
                        high = units(quote.get('max_credits_per_image'))
                        estimate = None if high is None else high * params['n']
            except (ClientError, asyncio.TimeoutError, ConnectionError):
                pass
        official_only = self.models.reserve(user,tid,parent,data,estimate,retouch_rebuild=retouch_rebuild)
        if official_only:
            try:
                capabilities = await self.upstream_api(user,'GetStudioCloudCapabilities')
                if capabilities.get('studioCreditGuard') != 1:
                    raise ConnectionError('cloud credit guard is not available')
            except (ClientError, asyncio.TimeoutError, ConnectionError):
                self.models.settle({'request_id':tid,'status':'failed','credits_cost':0})
                raise ModelPolicyError('备用通道的积分保护尚未就绪。本次未提交。','credit_guard_unavailable',503)
        return {**data, 'studio_official_only': official_only}

    async def cloud_quote(self, user, data):
        params = {k: v for k, v in data.items() if k in {'model', 'size', 'resolution', 'quality', 'n', 'output_format', 'frame_count', 'frame_duration_ms', 'operation'}}
        first = await self.upstream_api(user, 'GetStudioCloudQuote', params)
        workflow = (data.get('retouch_category') is not None or data.get('model') in AI_RETOUCH_MODELS and
                    ai_retouch.wants_retouch(data.get('prompt', ''))) and data.get('operation') == 'edit'
        transparent = data.get('background') == 'transparent' or bool(re.search(r'透明(?:底|背景|PNG)|transparent', data.get('prompt', ''), re.I))
        if not workflow or transparent or data.get('n') != 1 or data.get('output_format', 'png') != 'png':
            return first
        try:
            ai_retouch.validate_rebuild(self.models, user, data.get('size', '1:1') if data.get('size') != 'auto' else '1:1')
        except ModelPolicyError as exc:
            return {'error': str(exc), 'error_id': exc.code}
        second = await self.upstream_api(user, 'GetStudioCloudQuote', ai_retouch.rebuild_options(data.get('size', '1:1')))
        if first.get('error') or second.get('error'):
            return {'error': '精修与去纹报价暂不可用，请稍后重试。'}
        result = dict(first)
        for key in ('credits_total_reference', 'credits_per_image', 'min_credits_per_image', 'max_credits_per_image'):
            a, b = first.get(key), second.get(key)
            result[key] = round(a + b, 8) if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None
        result.update(label='包含精修与 AI 去纹，输入费用另计；按实际用量结算', stale=bool(first.get('stale') or second.get('stale')),
                      additional_input_cost_unknown=True)
        return result

    async def submit_cloud(self, user, data):
        if 'studio_official_only' in data:
            return error('预留策略由服务端配置。', 400)
        if not inline_references(data.get("reference_images", []), 16):
            return error("参考图必须为上传的内联图像，不能使用文件路径或图片链接。")
        tid = str(uuid.UUID(str(data.get("request_id", ""))))
        if tid != data.get("request_id"):
            raise ValueError("canonical UUID required")
        if not self.store.task(tid):
            try:
                self.models.validate(user,data)
            except ModelPolicyError as exc:
                return error(str(exc),exc.status,exc.code)
        fingerprint = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        references = await asyncio.to_thread(generation_references, data.get('reference_images', []))
        upstream_data = {**data, 'reference_images': references}
        explicit=upstream_data.pop('retouch_category',None)
        prompt=data.get('prompt','')
        original_prompt=upstream_data.pop('original_prompt', prompt)
        if not isinstance(original_prompt, str) or len(original_prompt)>12000:
            return error('原始提示词无效。')
        workflow=(explicit is not None or data.get('model') in AI_RETOUCH_MODELS and ai_retouch.wants_retouch(original_prompt)) and data.get('operation')=='edit'
        if workflow and (len(references)!=1 or data.get('n')!=1 or data.get('output_format','png')!='png'
                         or data.get('model') not in AI_RETOUCH_MODELS):
            return error('AI 商品精修需要一张原片、单张 PNG，以及 Gemini 或 GPT Image 2.6。')
        if explicit is not None and (not workflow or explicit not in ('auto',*ai_retouch.MATERIALS)):
            return error('AI 精修参数无效。')
        transparent = data.get('background') == 'transparent' or bool(re.search(r'透明(?:底|背景|PNG)|transparent', original_prompt, re.I))
        if workflow and not transparent and not self.store.task(tid):
            from PIL import Image, ImageOps
            import base64, io
            with Image.open(io.BytesIO(base64.b64decode(references[0].split(',', 1)[-1]))) as im:
                rebuild_size = ai_retouch.source_ratio(ImageOps.exif_transpose(im).size)
            try:
                ai_retouch.validate_rebuild(self.models, user, rebuild_size)
            except ModelPolicyError as exc:
                return error(str(exc), exc.status, exc.code)
        if not self.store.claim(tid, user["id"], "cloud", data.get("model"), data.get("n"), fingerprint):
            old = self.store.task(tid)
            if old["owner_id"] != user["id"] or old["fingerprint"] != fingerprint or old.get("hidden_at"):
                return error("请求编号不可用，请创建新任务。", 409)
            # An idempotent browser retry reads the ledger; it NEVER repeats a paid write.
            record = json.loads(old["record_json"])
            if not record.get("request_id"):
                record = {"request_id": tid, "status": "outcome_unknown", "model": old["model"], "prompt": data.get("prompt", ""), "images": [], "error": "提交结果待核对，不会重复提交。"}
            return web.json_response(self.store.public_task(record, old))
        self.store.update_task(tid, record_json=json.dumps({
            "request_id": tid, "status": "initializing", "model": data.get("model"),
            "prompt": data.get("prompt", ""), "original_prompt": original_prompt, "images": []
        }, ensure_ascii=False))
        try:
            await asyncio.to_thread(save_task_references, self.root, tid, data.get('reference_images', []))
            if workflow:
                src=reference_directory(self.root,tid)/Path(task_references(self.root,tid)[0]['url']).name
                from PIL import Image,ImageOps
                with Image.open(src) as source_image:
                    upstream_data['size']=ai_retouch.source_ratio(ImageOps.exif_transpose(source_image).size)
                category=await asyncio.to_thread(ai_retouch.category_for,src,explicit if explicit and explicit!='auto' else ai_retouch.category_hint(prompt),self.workbench.cutout_model.parent/'product-recognition')
                transparent = data.get('background') == 'transparent' or bool(re.search(r'透明(?:底|背景|PNG)|transparent', original_prompt, re.I))
                if transparent and data['model'].startswith('gpt-image-2.6-'):
                    upstream_data['background'] = 'transparent'
                with self.store.db:
                    self.store.db.execute('INSERT INTO ai_retouch_jobs(task_id,category,white_bg,align_geometry,rebuild) VALUES(?,?,?,?,?)',
                        (tid,category,2 if transparent else int(ai_retouch.needs_white(original_prompt)),0,int(not transparent)))
                upstream_data['prompt']=ai_retouch.instruction(category,prompt)
        except Exception as exc:
            print('reference preparation failed:',tid,type(exc).__name__,file=sys.stderr)
            msg='原片保存或识别失败，未提交生成，未扣费。'
            self.store.update_task(tid, status='failed', ended_at=time.time(), credits=0,record_json=json.dumps(dict(request_id=tid,status='failed',images=[],error=msg,credits_cost=0)))
            return error(msg, 503, 'reference_save_failed')
        try:
            upstream_data = await self.managed_dispatch(user,tid,tid,upstream_data)
        except ModelPolicyError as exc:
            self.store.update_task(tid,status='failed',ended_at=time.time(),credits=0,
                record_json=json.dumps(dict(request_id=tid,model=data.get('model'),status='failed',images=[],error=str(exc),error_id=exc.code,credits_cost=0)))
            return error(str(exc),exc.status,exc.code)
        self.store.update_task(tid, status="submitting", record_json=json.dumps({"request_id": tid, "model": data.get("model"), "prompt": data.get("prompt", ""), "status": "submitting", "images": []}, ensure_ascii=False))
        try:
            result = await self.upstream_api(user, "SubmitStudioCloudImage", upstream_data, False)
            if result.get("request_id"):
                self.save_cloud(user, result)
                latest=self.store.task(tid)
                return web.json_response(self.store.public_task(json.loads(latest['record_json']),latest))
            self.models.settle({'request_id':tid,'status':'failed','credits_cost':0})
            self.store.update_task(tid, status="failed", ended_at=time.time(), record_json=json.dumps({"request_id": tid, "status": "failed", "model": data.get("model"), "prompt": data.get("prompt", ""), "images": [], "error": result.get("error", "提交被拒绝")}, ensure_ascii=False))
            return web.json_response(result)
        except Exception:
            self.store.update_task(tid, status="outcome_unknown")
            return error("提交响应未确认，请刷新任务核对；禁止重复提交。", 502, "outcome_unknown")

    def save_cloud(self, owner, record):
        record = dict(record)
        record.pop("original_prompt", None)  # Only the authenticated submission can supply this field.
        tid = str(uuid.UUID(record["request_id"]))
        child = self.store.one('SELECT j.task_id,t.owner_id FROM ai_retouch_jobs j JOIN tasks t ON t.id=j.task_id WHERE j.rebuild_id=?', (tid,))
        if child:
            if child['owner_id'] != owner['id']:
                raise ValueError('reconstruction owner mismatch')
            ai_retouch.save_rebuild_record(self.store, child['task_id'], record)
            self.models.settle(record)
            return
        old = self.store.task(tid)
        if old and old["owner_id"] != owner["id"]:
            raise ValueError("global task collision")
        if old and old["status"] in TERMINAL and record.get("status") not in TERMINAL:
            # A concurrent list read can finish after the terminal status was recorded.
            return
        self.models.settle(record)
        if not old:
            self.store.claim(tid, owner["id"], "cloud", record.get("model"), record.get("parameters", {}).get("n"))
            try:
                when = datetime.fromisoformat(record["created_utc"].replace("Z", "+00:00")).timestamp()
                self.store.update_task(tid, started_at=when)
            except (KeyError, ValueError, TypeError):
                pass
        job=self.store.one('SELECT * FROM ai_retouch_jobs WHERE task_id=?',(tid,))
        if job:
            record=dict(record)
            if old:
                record['prompt']=json.loads(old['record_json']).get('prompt',record.get('prompt',''))
            if job['output_json']:
                record.update(status='completed',images=[json.loads(job['output_json'])],delivery_status='complete')
            elif job['failure']:
                record.update(status='failed',images=[{'url':job['engine_url'],'index':0}],error=job['failure'])
            elif record.get('status')=='completed':
                items=record.get('images',[])
                url=items[0].get('url','') if items else ''
                if re.fullmatch(r'/studio-results/'+re.escape(tid)+r'-[\w-]+\.(?:png|jpg|jpeg|webp)',url) and (self.results/Path(url).name).is_file():
                    with self.store.db:
                        self.store.db.execute('UPDATE ai_retouch_jobs SET engine_url=? WHERE task_id=?',(url,tid))
                    try:
                        loop=asyncio.get_running_loop()
                    except RuntimeError:
                        loop=None
                    if loop and tid not in self.retouch_workers:
                        self.retouch_workers[tid]=loop.create_task(self.finish_retouch(owner,record.copy(),tid))
                record.update(status='processing',images=[],delivery_status='cache_pending')
            record = ai_retouch.combined_record(record, job)
        delivered = 0
        for image in record.get("images", []):
            url = image.get("url", "")
            if not re.fullmatch(r"/studio-results/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif|svg)", url):
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

    async def finish_retouch(self,owner,record,tid):
        try:
            async with self.retouch_limit:
                job=self.store.one('SELECT * FROM ai_retouch_jobs WHERE task_id=?',(tid,))
                request = json.loads(self.store.task(tid)['record_json']).get('prompt', '')
                if not await ai_retouch.reconstruct(self, owner, job, request):
                    return
                job=self.store.one('SELECT * FROM ai_retouch_jobs WHERE task_id=?',(tid,))
                result=await asyncio.to_thread(ai_retouch.render_delivery,self.root,self.results,job)
            with self.store.db:
                self.store.db.execute('UPDATE ai_retouch_jobs SET output_json=? WHERE task_id=?',(json.dumps(result),tid))
        except Exception as exc:
            print('retouch delivery failed:',tid,type(exc).__name__,file=sys.stderr)
            failure = str(exc) if isinstance(exc, (ai_retouch.TextPreservationError, ai_retouch.RetouchStageError)) else '精修已生成，去纹或原尺寸处理未完成。已保留初次精修原稿，可从创作记录下载。'
            with self.store.db:
                self.store.db.execute('UPDATE ai_retouch_jobs SET failure=? WHERE task_id=?',(failure,tid))
        finally:
            self.retouch_workers.pop(tid,None)
        self.save_cloud(owner,record)

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

    def local_history(self, user):
        rows = self.store.all("""SELECT a.*,u.email owner_email,u.name owner_name,v.hidden_at,t.started_at,t.ended_at,t.seconds
            FROM artifacts a JOIN users u ON u.id=a.owner_id JOIN tasks t ON t.id=a.task_id
            LEFT JOIN task_visibility v ON v.task_id=t.id AND v.viewer_id=t.owner_id
            WHERE t.kind='local' AND (? OR (a.owner_id=? AND v.hidden_at IS NULL)) ORDER BY a.created_at DESC""",
            (user["role"] == "admin", user["id"]))
        files = [{"src": row["url"].lstrip("/"), "metadata": row["metadata"], "studio_task_id": row["task_id"], "studio_owner_id": row["owner_id"], "studio_owner_email": row["owner_email"], "studio_owner_name": row["owner_name"], "studio_hidden_at": row["hidden_at"],
                  # Legacy imports only know the image file's modification time, not submission time.
                  "studio_created_utc": None if row["task_id"].startswith("legacy_") else datetime.fromtimestamp(row["started_at"], timezone.utc).isoformat(),
                  "studio_completed_utc": datetime.fromtimestamp(row["ended_at"], timezone.utc).isoformat() if row["ended_at"] else None,
                  "studio_duration_seconds": row["seconds"]}
                 for row in rows]
        return files

    def cloud_history(self, user):
        tasks = self.store.all("""SELECT t.*,u.email owner_email,u.name owner_name,v.hidden_at FROM tasks t
            JOIN users u ON u.id=t.owner_id LEFT JOIN task_visibility v ON v.task_id=t.id AND v.viewer_id=t.owner_id
            WHERE t.kind='cloud' AND (? OR (t.owner_id=? AND v.hidden_at IS NULL)) ORDER BY t.started_at DESC""",
            (user["role"] == "admin", user["id"]))
        result = []
        for task in tasks:
            record = json.loads(task["record_json"])
            if not record.get("request_id"):
                record = {"request_id": task["id"], "status": task["status"], "model": task["model"], "prompt": "", "images": []}
            result.append(self.store.public_task(record, task))
        return result

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
            if not (local or disk.is_relative_to(self.results.resolve())) or disk.suffix.lower() not in (IMAGE_EXTENSIONS if local else IMAGE_EXTENSIONS | {'.gif','.svg'}):
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
        if request.query.get("preview") == "1":
            headers = {"Cache-Control": "private, no-cache", "Vary": "Cookie", **svg_headers(disk)}
            if disk.suffix.lower() in IMAGE_EXTENSIONS:
                disk = await preview_path(disk, self.root / "runtime/image-previews", 240)
                headers["Content-Type"] = "image/webp"
            return web.FileResponse(disk, headers=headers)
        response = web.FileResponse(disk, headers=svg_headers(disk))
        response.headers["Cache-Control"] = "private, no-store"
        return response

    async def generate(self, request, user):
        socket = web.WebSocketResponse(max_msg_size=384 * 1024 ** 2, heartbeat=30, timeout=1)
        await socket.prepare(request)
        login = request.cookies[COOKIE]
        self.sockets[user["id"]][socket] = token_hash(login)
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
            current = self.store.session(login)
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
            # Qwen 2.1's upstream reference-latent branch skips its usual input-size
            # normalization. Bound only this inference copy; archive the full original.
            data['promptimages'] = await asyncio.to_thread(generation_references, references, max_pixels=1024 ** 2)
            count = int(data.get("images", 1))
            if not 1 <= count <= 4:
                raise ValueError("生成数量超出范围")
            self.models.validate(user,data,local=True)
            metadata = data.get("extra_metadata", {})
            if not isinstance(metadata, dict):
                raise ValueError("invalid metadata")
            if not self.store.claim(tid, user["id"], "local", data.get("model"), count):
                raise ValueError("任务编号已使用，不会重复生成")
            try:
                await asyncio.to_thread(save_task_references, self.root, tid, references)
            except (OSError, ValueError):
                self.store.update_task(tid, status='failed', ended_at=time.time(), credits=0)
                raise ValueError('参考图保存失败，未提交生成')
            data["session_id"] = sid
            # Server-owned marker lets saved local output recover the correct task after restart.
            data["extra_metadata"] = {**metadata, "studio_task_id": tid}
            job = self.local_queue.enqueue(user, tid, data, socket)
            await self.local_queue.emit(job, {"studio_task_id": tid, "studio_queue": self.local_queue.snapshot(tid)})
            await asyncio.shield(job["done"])
        except ImageUploadError as exc:
            if not socket.closed:
                await socket.send_json({"error": str(exc), "error_id": exc.code, "socket_intention": "close"})
        except ModelPolicyError as exc:
            if not socket.closed:
                await socket.send_json({'error':str(exc),'error_id':exc.code,'socket_intention':'close'})
        except (ValueError, KeyError) as exc:
            messages = {
                '会话不属于当前账号': ('图像会话无效，请重新连接图像服务。', 'invalid_session_id'),
                '登录已失效': ('登录已失效，请重新登录。', 'authentication_required'),
                'unsupported local model': ('当前本地模型不受支持，请重新选择模型。', 'unsupported_model'),
                'unsupported generation parameter': ('生成请求包含不支持的参数，请刷新页面后重试。', 'unsupported_parameter'),
                'invalid dimensions': ('图像宽高须为 64 至 4096 像素，且为 32 的倍数。', 'invalid_dimensions'),
                'invalid steps': ('生成步数须为 1 至 100。', 'invalid_steps'),
                'references must be inline images': ('请上传图片文件，最多 10 张参考图。', 'invalid_references'),
                '生成数量超出范围': ('生成数量须为 1 至 4 张。', 'invalid_image_count'),
                '任务编号已使用，不会重复生成': ('此任务编号已提交，请刷新创作记录核对，不会重复生成。', 'duplicate_task'),
                '参考图保存失败，未提交生成': ('参考图保存失败，未提交生成，请检查本机存储。', 'reference_save_failed'),
            }
            message, code = messages.get(str(exc), ('生成请求参数无效，请检查模型、尺寸和参考图。', 'invalid_generation_request'))
            if not socket.closed:
                await socket.send_json({"error": message, "error_id": code, "socket_intention": "close"})
                if code == 'authentication_required':
                    await socket.close(code=1008)
        except asyncio.TimeoutError:
            if not socket.closed:
                await socket.send_json({"error": "接收生成请求超时，尚未提交生成，请重新连接后重试。", "error_id": "request_timeout", "socket_intention": "close"})
        finally:
            self.sockets[user["id"]].pop(socket, None)
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
                    value["studio_owner_name"] = user["name"]
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
    parser.add_argument("--trusted-proxy", type=ipaddress.IPv4Address, default=None,
                        help="Exact non-loopback IPv4 address of the public HTTPS proxy")
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
    if args.trusted_proxy and (args.trusted_proxy.is_loopback or args.trusted_proxy.is_unspecified):
        parser.error("--trusted-proxy must be a specific non-loopback peer")
    gateway = Gateway(args.root, database, args.upstream, trusted_proxy=args.trusted_proxy)
    if not gateway.store.user("admin"):
        raise SystemExit("Administrator is not initialized. Run --bootstrap-admin with password on stdin first.")
    web.run_app(gateway.app, host=args.host, port=args.port, access_log=None, print=None)


if __name__ == "__main__":
    main()
