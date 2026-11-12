"""Private media, quick jobs and source resolution for the comparison board."""
import asyncio
import json
import logging
import uuid
from pathlib import Path
from urllib.parse import unquote

from aiohttp import web
from PIL import Image
from .image_uploads import original_image_bytes, ImageUploadError
from .image_preview import preview_path
from .compare_board import CompareBoard
from .quick_edits import RECIPES, cutout, retouch_or_enlarge
from .photocraft import PhotoCraftError
from .agent_limits import AgentError

MEDIA = '/studio-agent/workbench/media/'


def identifier(value):
    return uuid.UUID(str(value)).hex


def fail(message, status):
    return web.json_response({'error': message}, status=status)


def dimensions(path):
    with Image.open(path) as image:
        rotated = image.getexif().get(274) in (5, 6, 7, 8)
        return (image.height, image.width) if rotated else image.size


class Workbench:
    def __init__(self, gateway):
        self.g = gateway
        self.store = gateway.store
        self.root = gateway.root / 'runtime/workbench'
        self.root.mkdir(parents=True, exist_ok=True)
        self.slots = asyncio.Semaphore(2)
        self.running = set()
        self.board = CompareBoard(self)
        self.store.db.executescript("""
          CREATE TABLE IF NOT EXISTS studio_media(
            id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,extension TEXT NOT NULL,
            width INTEGER NOT NULL,height INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS studio_quick_jobs(
            id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source TEXT NOT NULL,tool TEXT NOT NULL,
            option TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL);
          UPDATE studio_quick_jobs SET status='failed',error='服务已重启，请核对原图后重新处理。'
            WHERE status='processing';
        """)

    def media(self, uid, mid):
        row = self.store.one('SELECT * FROM studio_media WHERE id=? AND owner_id=?', (mid, uid))
        if not row:
            raise web.HTTPNotFound()
        return row

    def info(self, uid, mid):
        row = self.media(uid, mid)
        return {'url': MEDIA + mid, 'name': row['name'], 'width': row['width'], 'height': row['height']}

    def source(self, user, url):
        if not isinstance(url, str) or len(url) > 2048 or '?' in url or '#' in url:
            raise web.HTTPNotFound()
        if url.startswith(MEDIA):
            row = self.media(user['id'], identifier(url[len(MEDIA):]))
            path = self.root / user['id'] / (row['id'] + row['extension'])
        elif url.startswith('/studio-agent/assets/'):
            aid = identifier(url.split('/')[-1])
            asset = self.store.one('SELECT a.chat_id FROM agent_assets a JOIN agent_chats c ON c.id=a.chat_id WHERE a.id=? AND c.owner_id=? AND c.hidden_at IS NULL', (aid, user['id']))
            if not asset:
                raise web.HTTPNotFound()
            try:
                row = self.g.agent.resolve_asset(asset['chat_id'], {**user, 'role':'user'}, aid)
            except ValueError:
                raise web.HTTPNotFound()
            path = Path(row['path'])
        else:
            raw = unquote(url)
            if raw.startswith('/Output/'):
                raw = '/View/' + user['swarm_id'] + '/' + raw[len('/Output/'):]
            if not raw.startswith(('/View/', '/studio-results/')):
                raise web.HTTPNotFound()
            row = self.store.visible_artifact(raw, {**user, 'role':'user'})
            if not row:
                raise web.HTTPNotFound()
            path = Path(row['disk_path']).resolve()
            if not any(path.is_relative_to(root.resolve()) for root in (self.g.output, self.g.results)):
                raise web.HTTPNotFound()
        if not path.is_file() or path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):
            raise web.HTTPNotFound()
        return path

    async def upload(self, user, data):
        uid, mid = user['id'], uuid.uuid4().hex
        name = str(data.get('name') or '上传图片')[:160]
        binary, ext = await asyncio.to_thread(original_image_bytes, data.get('data_url'))
        folder = self.root / uid
        folder.mkdir(exist_ok=True)
        path = folder / (mid + ext)
        await asyncio.to_thread(path.write_bytes, binary)
        try:
            width, height = await asyncio.to_thread(dimensions, path)
            with self.store.db:
                self.store.db.execute('INSERT INTO studio_media VALUES(?,?,?,?,?,?)', (mid, uid, name, ext, width, height))
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return web.json_response(self.info(uid, mid))

    def job(self, user, jid):
        row = self.store.one('SELECT * FROM studio_quick_jobs WHERE id=? AND owner_id=?', (jid,user['id']))
        if not row:
            raise web.HTTPNotFound()
        result = self.info(user['id'], jid) if row['status']=='completed' else None
        return {'id':jid, 'status':row['status'], 'error':row['error'], 'result':result,
                'source':row['source'], 'tool':row['tool'], 'option':row['option']}

    async def submit(self, user, data):
        jid = identifier(data.get('id'))
        tool, option, source = data.get('tool'), data.get('option'), data.get('source')
        if not isinstance(tool, str) or tool not in RECIPES or option not in RECIPES[tool]:
            raise ValueError('unknown recipe')
        existing = self.store.one('SELECT owner_id FROM studio_quick_jobs WHERE id=?', (jid,))
        if existing:
            previous = self.job(user, jid)
            if (source,tool,option) != (previous['source'],previous['tool'],previous['option']):
                return fail('该请求编号已经用于另一张图片。',409)
            return web.json_response(previous)
        path = self.source(user, source)
        if tool == 'upscale':
            width, height = dimensions(path)
            if width * height * int(option)**2 > 64_000_000:
                return fail('放大后超过 6400 万像素，请降低倍率。',400)
        if self.store.one("SELECT 1 FROM studio_quick_jobs WHERE owner_id=? AND status='processing'",(user['id'],)):
            return fail('上一张图片仍在处理中。',409)
        with self.store.db:
            self.store.db.execute("INSERT INTO studio_quick_jobs VALUES(?,?,?,?,?,'processing',NULL,unixepoch())",
                                  (jid,user['id'],source,tool,option))
        task = asyncio.create_task(self.process(user['id'],jid,path,tool,option))
        self.running.add(task)
        task.add_done_callback(self.running.discard)
        return web.json_response(self.job(user,jid),status=202)

    async def process(self, uid, jid, source, tool, option):
        folder = self.root / uid
        folder.mkdir(exist_ok=True)
        temp, final = folder / (jid + '.part'), folder / (jid + '.png')
        try:
            async with self.slots:
                if tool == 'cutout':
                    await cutout(self.g.agent.editing,source,temp)
                else:
                    await asyncio.to_thread(retouch_or_enlarge,source,temp,tool,option)
                w,h = dimensions(temp)
                temp.replace(final)
            name = {'cutout':'透明底','retouch':'主图精修','upscale':'高清放大'}[tool] + '.png'
            with self.store.db:
                self.store.db.execute('INSERT INTO studio_media VALUES(?,?,?,?,?,?)',(jid,uid,name,'.png',w,h))
                self.store.db.execute("UPDATE studio_quick_jobs SET status='completed' WHERE id=?",(jid,))
        except Exception as exc:
            if isinstance(exc,(ValueError,PhotoCraftError,AgentError)):
                message = str(exc)
            else:
                logging.getLogger(__name__).warning('quick edit failed: %s',type(exc).__name__)
                message = '本机处理未完成，请核对原图和修图服务。'
            with self.store.db:
                self.store.db.execute("UPDATE studio_quick_jobs SET status='failed',error=? WHERE id=?",(message,jid))
        finally:
            temp.unlink(missing_ok=True)

    async def route(self, request, user, route):
        if route == 'board':
            return await self.board.route(request,user)
        if route == 'board-image' and request.method == 'GET':
            path = self.source(user, request.query.get('source'))
            if request.query.get('preview') == '1':
                path = await preview_path(path,self.root/'previews',560)
            return web.FileResponse(path)
        if route == 'upload' and request.method=='POST':
            return await self.upload(user, await self.g.body(request))
        if route == 'jobs' and request.method=='POST':
            return await self.submit(user, await self.g.body(request))
        if route.startswith('jobs/') and request.method=='GET':
            return web.json_response(self.job(user,identifier(route[5:])))
        if route.startswith('media/') and request.method=='GET':
            path = self.source(user,MEDIA + route[6:])
            if request.query.get('preview') == '1':
                path = await preview_path(path,self.root/'previews',480)
            return web.FileResponse(path)
        raise web.HTTPNotFound()
