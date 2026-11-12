"""One versioned comparison draft per account. Cards reference original media."""
import json
import math
import uuid

from aiohttp import web
from .board_video import video_source

DEFAULT = {'cards': [], 'preferred': None, 'view': {'x': 24, 'y': 44, 'zoom': 1}}
MAX_CARDS = 60


def bounded(value, low=-1000000, high=1000000):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('invalid board geometry')
    return value


class CompareBoard:
    def __init__(self, workbench):
        self.workbench = workbench
        self.store = workbench.store
        with self.store.db:
            self.store.db.execute("""CREATE TABLE IF NOT EXISTS studio_compare_boards(
              owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, board_json TEXT NOT NULL)""")

    def read(self, uid):
        row = self.store.one('SELECT * FROM studio_compare_boards WHERE owner_id=?',(uid,))
        return (row['revision'], json.loads(row['board_json'])) if row else (0, DEFAULT)

    def check_source(self, user, card):
        kind = card.get('kind', 'image')
        if kind == 'image':
            self.workbench.source(user, card['url'])
        elif kind == 'video':
            video_source(self.workbench, user, card['url'])

    def visible(self, user, card):
        try:
            self.check_source(user, card)
            return True
        except (ValueError, OSError, web.HTTPNotFound):
            return False

    def validate(self, user, body, old):
        items = body.get('cards')
        if not isinstance(items,list) or len(items)>MAX_CARDS or not isinstance(body.get('view'),dict):
            raise ValueError('invalid board')
        previous = {c['id']: c for c in old['cards']}
        cards, seen = [], set()
        for item in items:
            if not isinstance(item,dict):
                raise ValueError('invalid card')
            cid = str(uuid.UUID(str(item.get('id'))))
            url, name = item.get('url'), item.get('name')
            if cid in seen or not isinstance(name,str) or not 1<=len(name)<=160:
                raise ValueError('invalid card')
            kind = item.get('kind', 'image')
            hidden = item.get('hidden', False)
            if kind not in ('image', 'video', 'text') or type(hidden) is not bool:
                raise ValueError('invalid layer')
            card = {'id':cid, 'kind':kind, 'name':name, 'hidden':hidden,
                    'x':bounded(item.get('x')), 'y':bounded(item.get('y'))}
            if kind == 'text':
                content = item.get('text')
                if not isinstance(content, str) or len(content) > 4000:
                    raise ValueError('invalid text')
                card['text'] = content
            else:
                card['url'] = url
                prior = previous.get(cid, {})
                if prior.get('kind', 'image') != kind or prior.get('url') != url or not prior:
                    self.check_source(user, card)
            seen.add(cid)
            cards.append(card)
        preferred, view = body.get('preferred'), body['view']
        if preferred is not None and preferred not in seen:
            raise ValueError('invalid preferred card')
        return {'cards':cards,'preferred':preferred,'view':{'x':bounded(view.get('x')),'y':bounded(view.get('y')),'zoom':bounded(view.get('zoom'),.05,16)}}

    async def route(self, request, user):
        uid = user['id']
        if request.method=='GET':
            revision, board = self.read(uid)
            cards = [{**c,'available':self.visible(user,c)} for c in board['cards']]
            return web.json_response({**board,'cards':cards,'revision':revision})
        if request.method!='POST':
            raise web.HTTPNotFound()
        body = await self.workbench.g.body(request)
        revision, old = self.read(uid)
        if type(body.get('revision')) is not int or body['revision'] != revision:
            return web.json_response({'error':'画布已在另一个窗口更新，请重新打开后继续。'},status=409)
        board = self.validate(user,body,old)
        with self.store.db:
            self.store.db.execute('INSERT INTO studio_compare_boards VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,board_json=excluded.board_json',
                                  (uid,revision+1,json.dumps(board,ensure_ascii=False)))
        return web.json_response({'revision':revision+1})
