"""Private, bounded MP4 and WebM uploads for the comparison board."""
import asyncio
import json
import uuid

from aiohttp import web

MAX_VIDEO_BYTES = 100 * 1024 * 1024
VIDEO_ROUTE = '/studio-agent/workbench/board-video/'
FORMATS = {'video/mp4': ('.mp4', 'mov'), 'video/webm': ('.webm', 'matroska')}


async def video_dimensions(path, demuxer):
    try:
        process = await asyncio.create_subprocess_exec(
            'ffprobe', '-v', 'error', '-protocol_whitelist', 'file', '-f', demuxer,
            '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height',
            '-of', 'json', str(path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except FileNotFoundError:
        raise web.HTTPServiceUnavailable(text='本机缺少视频读取工具 ffprobe。')
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), 15)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    streams = json.loads(stdout or b'{}').get('streams', [])
    if process.returncode or not streams or streams[0].get('codec_name') not in ('h264', 'vp8', 'vp9', 'av1'):
        raise ValueError('请选择可播放的 MP4 或 WebM 视频。')
    width, height = streams[0].get('width', 0), streams[0].get('height', 0)
    if min(width, height) < 1 or width * height > 64_000_000:
        raise ValueError('视频尺寸无效。')
    return width, height


async def upload_video(workbench, request, user):
    if request.content_type not in FORMATS:
        return web.json_response({'error': '请选择 MP4 或 WebM 视频。'}, status=415)
    ext, demuxer = FORMATS[request.content_type]
    uid, mid = user['id'], uuid.uuid4().hex
    folder = workbench.root / uid
    folder.mkdir(exist_ok=True)
    path = folder / (mid + ext)
    try:
        size = 0
        with path.open('xb') as output:
            async for part in request.content.iter_chunked(256 * 1024):
                size += len(part)
                if size > MAX_VIDEO_BYTES:
                    raise ValueError('单个视频不能超过 100 MB。')
                output.write(part)
        width, height = await video_dimensions(path, demuxer)
        name = (request.query.get('name') or '视频')[:160]
        with workbench.store.db:
            workbench.store.db.execute('INSERT INTO studio_media VALUES(?,?,?,?,?,?)',
                                       (mid, uid, name, ext, width, height))
    except (ValueError, TimeoutError) as exc:
        path.unlink(missing_ok=True)
        return web.json_response({'error': str(exc) or '视频读取超时。'}, status=400)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return web.json_response({'kind':'video', 'url':VIDEO_ROUTE + mid, 'name':name, 'width':width, 'height':height})


def video_source(workbench, user, url):
    if not isinstance(url, str) or not url.startswith(VIDEO_ROUTE):
        raise web.HTTPNotFound()
    mid = uuid.UUID(url[len(VIDEO_ROUTE):]).hex
    row = workbench.media(user['id'], mid)
    if row['extension'] not in ('.mp4', '.webm'):
        raise web.HTTPNotFound()
    path = workbench.root / user['id'] / (mid + row['extension'])
    if not path.is_file():
        raise web.HTTPNotFound()
    return path
