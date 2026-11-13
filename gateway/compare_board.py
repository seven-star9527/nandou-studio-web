"""Named, versioned canvas projects scoped to each account. Cards reference original media."""
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


def validate_text_node(node, depth=0):
    blocks = ('paragraph', 'heading', 'blockquote', 'bullet_list', 'ordered_list')
    allowed = {'doc': blocks, 'blockquote': blocks, 'list_item': blocks,
               'bullet_list': ('list_item',), 'ordered_list': ('list_item',),
               'paragraph': ('text', 'hard_break'), 'heading': ('text', 'hard_break'),
               'text': (), 'hard_break': ()}
    if not isinstance(node, dict) or depth > 20 or not isinstance(node.get('type'), str) or node['type'] not in allowed:
        raise ValueError('invalid formatted text node')
    kind = node['type']
    if set(node) - {'type', 'content', 'text', 'marks', 'attrs'}:
        raise ValueError('invalid formatted text fields')
    attrs = node.get('attrs', {})
    if not isinstance(attrs, dict) or set(attrs) - {'align', 'level', 'order'} or attrs.get('align') not in (None, 'left', 'center', 'right') or attrs.get('level', 1) not in (1, 2, 3) or type(attrs.get('order', 1)) is not int:
        raise ValueError('invalid text style')
    if kind == 'text' and (not isinstance(node.get('text'), str) or not 0 < len(node['text']) <= 4000):
        raise ValueError('invalid text span')
    marks = node.get('marks', [])
    if not isinstance(marks, list) or any(not isinstance(m, dict) or set(m) != {'type'} or m['type'] not in ('strong', 'em', 'underline', 'strike') for m in marks):
        raise ValueError('invalid text mark')
    children = node.get('content', [])
    if not isinstance(children, list) or (kind in ('doc', 'blockquote', 'list_item', 'bullet_list', 'ordered_list') and not children):
        raise ValueError('invalid text block')
    if kind == 'list_item' and (not isinstance(children[0], dict) or children[0].get('type') != 'paragraph'):
        raise ValueError('invalid list item')
    for child in children:
        if not isinstance(child, dict) or child.get('type') not in allowed[kind]:
            raise ValueError('invalid text structure')
        validate_text_node(child, depth + 1)


class CompareBoard:
    def __init__(self, workbench):
        self.workbench = workbench
        self.store = workbench.store
        with self.store.db:
            self.store.db.execute("""CREATE TABLE IF NOT EXISTS studio_compare_boards(
              owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, board_json TEXT NOT NULL)""")

            self.store.db.execute("""CREATE TABLE IF NOT EXISTS studio_canvas_projects(
              owner_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,
              board_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner_id,id))""")
            self.store.db.execute("""INSERT OR IGNORE INTO studio_canvas_projects
              SELECT owner_id,'legacy','我的对比画布',revision,board_json,0 FROM studio_compare_boards""")

    def read(self, uid, project):
        row = self.store.one('SELECT * FROM studio_canvas_projects WHERE owner_id=? AND id=?',(uid,project))
        if not row and project != 'legacy':
            raise web.HTTPNotFound()
        return (row['revision'], json.loads(row['board_json'])) if row else (0, DEFAULT)

    @staticmethod
    def name(body):
        name = body.get('name')
        if not isinstance(name,str) or not 1 <= len(name.strip()) <= 80:
            raise ValueError('invalid project name')
        return name.strip()

    async def projects(self, request, user):
        uid = user['id']
        if request.method == 'GET':
            return web.json_response(self.store.all("""SELECT id,name,revision,updated_at FROM studio_canvas_projects
                WHERE owner_id=? ORDER BY updated_at DESC,rowid DESC""",(uid,)))
        if request.method != 'POST':
            raise web.HTTPNotFound()
        body = await self.workbench.g.body(request)
        name, project = self.name(body), uuid.UUID(str(body.get('id'))).hex
        with self.store.db:
            self.store.db.execute("""INSERT OR IGNORE INTO studio_canvas_projects VALUES(?,?,?,0,?,unixepoch())""",
                                  (uid,project,name,json.dumps(DEFAULT)))
        return web.json_response({'id':project})

    def check_source(self, user, card):
        kind = card.get('kind', 'image')
        if card.get('placeholder') and card.get('url') == '':
            return
        if kind == 'image' and not card.get('url') and card.get('generationId'):
            return
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

    def project_card(self, user, card):
        card = dict(card)
        if card.get('generationId') and not card.get('url'):
            task = self.store.task(card['generationId'])
            card['generationStatus'] = 'unknown'
            if task and task['owner_id'] == user['id'] and not task['hidden_at']:
                card['generationStatus'] = task['status']
                result = self.store.one('SELECT url FROM artifacts WHERE task_id=? AND owner_id=? ORDER BY created_at LIMIT 1',
                                        (task['id'], user['id']))
                if result:
                    card['url'] = result['url']
        return {**card, 'available': self.visible(user, card)}

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
            if kind == 'image' and item.get('generationId'):
                card['generationId'] = str(uuid.UUID(str(item['generationId'])))
            if item.get('parentId'):
                card['parentId'] = str(uuid.UUID(str(item['parentId'])))
            colors = ('cyan', 'blue', 'violet', 'amber', 'yellow', 'rose')
            if item.get('tag') in colors:
                card['tag'] = item['tag']
            if kind == 'text' and item.get('paper') in colors:
                card['paper'] = item['paper']
            if kind in ('image', 'video') and url == '' and not card.get('generationId'):
                card['placeholder'] = True
            if kind == 'text':
                content = item.get('text')
                if not isinstance(content, str) or len(content) > 4000:
                    raise ValueError('invalid text')
                card['text'] = content
                if 'rich' in item:
                    rich = item['rich']
                    if not isinstance(rich, dict) or rich.get('type') != 'doc' or len(json.dumps(rich, ensure_ascii=False)) > 120000:
                        raise ValueError('invalid formatted text')
                    validate_text_node(rich)
                    card['rich'] = rich
                for key, low, high in [('w', 140, 1600), ('h', 90, 1200)]:
                    if key in item:
                        card[key] = bounded(item[key], low, high)
            else:
                card['url'] = url
                prior = previous.get(cid, {})
                if prior.get('kind', 'image') != kind or prior.get('url') != url or not prior:
                    self.check_source(user, card)
            seen.add(cid)
            cards.append(card)
        for card in cards:
            if card.get('parentId') not in seen or card.get('parentId') == card['id']:
                card.pop('parentId', None)
        preferred, view = body.get('preferred'), body['view']
        if preferred is not None and preferred not in seen:
            raise ValueError('invalid preferred card')
        return {'cards':cards,'preferred':preferred,'view':{'x':bounded(view.get('x')),'y':bounded(view.get('y')),'zoom':bounded(view.get('zoom'),.05,16)}}

    async def route(self, request, user, project="legacy"):
        uid = user['id']
        if request.method=='GET':
            revision, board = self.read(uid, project)
            cards = [self.project_card(user, c) for c in board['cards']]
            name = self.store.one('SELECT name FROM studio_canvas_projects WHERE owner_id=? AND id=?',(uid,project))
            return web.json_response({**board,'cards':cards,'revision':revision,'name':name['name'] if name else '我的对比画布'})
        if request.method!='POST':
            raise web.HTTPNotFound()
        body = await self.workbench.g.body(request)
        revision, old = self.read(uid, project)
        if type(body.get('revision')) is not int or body['revision'] != revision:
            return web.json_response({'error':'画布已在另一个窗口更新，请重新打开后继续。'},status=409)
        board = self.validate(user,body,old)
        with self.store.db:
            if project == 'legacy' and revision == 0:
                self.store.db.execute("INSERT OR IGNORE INTO studio_canvas_projects VALUES(?,'legacy','我的对比画布',0,?,0)",
                                      (uid,json.dumps(DEFAULT)))
            name = self.name(body) if 'name' in body else None
            changed = self.store.db.execute("""UPDATE studio_canvas_projects SET revision=revision+1,board_json=?,
                name=COALESCE(?,name),updated_at=unixepoch() WHERE owner_id=? AND id=? AND revision=?""",
                (json.dumps(board,ensure_ascii=False),name,uid,project,revision))
            if not changed.rowcount:
                return web.json_response({'error':'项目已在另一个窗口更新，请重新打开。'},status=409)
        return web.json_response({'revision':revision+1})
