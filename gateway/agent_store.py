"""Agent journal in the existing account database; all lookups are account scoped."""
import json
import time
import uuid
from pathlib import Path
from PIL import Image


class AgentStore:
    def __init__(self, store):
        self.store = store
        self.db = store.db
        self.dimensions = {}
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS agent_chats(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
          created_at REAL NOT NULL, updated_at REAL NOT NULL, hidden_at REAL);
        CREATE TABLE IF NOT EXISTS agent_turns(
          id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES agent_chats(id),
          text TEXT NOT NULL, settings_json TEXT NOT NULL, refs_json TEXT NOT NULL,
          status TEXT NOT NULL, created_at REAL NOT NULL, ended_at REAL);
        CREATE TABLE IF NOT EXISTS agent_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES agent_chats(id),
          turn_id TEXT NOT NULL REFERENCES agent_turns(id), kind TEXT NOT NULL, data_json TEXT NOT NULL, at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_assets(
          id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES agent_chats(id),
          name TEXT NOT NULL, path TEXT NOT NULL, task_id TEXT, created_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS agent_chat_owner ON agent_chats(owner_id,updated_at);
        CREATE INDEX IF NOT EXISTS agent_events_chat ON agent_events(chat_id,id);
        CREATE TABLE IF NOT EXISTS agent_summaries(chat_id TEXT PRIMARY KEY REFERENCES agent_chats(id), through_event_id INTEGER NOT NULL, summary TEXT NOT NULL, updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS agent_memories(owner_id TEXT PRIMARY KEY REFERENCES users(id), text TEXT NOT NULL, updated_at REAL NOT NULL);
        """)
        self.db.commit()

    def create(self, uid):
        cid = uuid.uuid4().hex
        now = time.time()
        with self.db:
            self.db.execute("INSERT INTO agent_chats VALUES(?,?,?,?,?,NULL)", (cid, uid, "新的创作", now, now))
        return cid

    def chat(self, cid, user, write=False):
        row = self.store.one("SELECT c.*,u.email owner_email FROM agent_chats c JOIN users u ON u.id=c.owner_id WHERE c.id=?", (cid,))
        if not row:
            return None
        if write:
            return row if row["owner_id"] == user["id"] and not row["hidden_at"] else None
        return row if user["role"] == "admin" or row["owner_id"] == user["id"] and not row["hidden_at"] else None

    def listing(self, user, all_users=False):
        clause = "1=1" if all_users and user["role"] == "admin" else "c.owner_id=? AND c.hidden_at IS NULL"
        args = () if all_users and user["role"] == "admin" else (user["id"],)
        chats = self.store.all("SELECT c.*,u.email owner_email,(SELECT status FROM agent_turns WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) status FROM agent_chats c JOIN users u ON c.owner_id=u.id WHERE " + clause + " ORDER BY c.updated_at DESC LIMIT 100", args)

        if not chats:
            return chats
        # Read the actual turn inputs and delivered results in one batch for the visible conversations.
        ids = json.dumps([chat['id'] for chat in chats])
        candidates = self.store.all("""
            WITH visible(id) AS (SELECT value FROM json_each(?)),
            pictures(chat_id, aid, priority, at, position) AS (
              SELECT t.chat_id, j.value, 0, t.created_at, j.key FROM agent_turns t
              JOIN visible ON visible.id=t.chat_id JOIN json_each(t.refs_json) j
              UNION ALL
              SELECT e.chat_id, json_extract(j.value,'$.ref_id'), 1, e.at, j.key FROM agent_events e
              JOIN visible ON visible.id=e.chat_id JOIN json_each(e.data_json,'$.images') j WHERE e.kind='result'
            )
            SELECT p.chat_id,p.aid,p.priority FROM pictures p JOIN agent_assets a
              ON a.id=p.aid AND a.chat_id=p.chat_id JOIN agent_chats c ON c.id=p.chat_id
            LEFT JOIN tasks t ON t.id=a.task_id
            LEFT JOIN task_visibility h ON h.task_id=t.id AND h.viewer_id=t.owner_id
            WHERE a.task_id IS NULL OR (t.id IS NOT NULL AND (? OR (t.owner_id=c.owner_id AND h.hidden_at IS NULL)))
            ORDER BY p.priority,p.at,p.position
        """, (ids, user['role']=='admin'))
        grouped = {}
        for item in candidates:
            key = (item['chat_id'], item['priority'])
            grouped.setdefault(key, {})[item['aid']] = None
        for chat in chats:
            covers = grouped.get((chat['id'], 0)) or grouped.get((chat['id'], 1)) or {}
            chat['cover_id'] = next(iter(covers), None)
            chat['picture_count'] = len(covers)
        return chats

    def event(self, cid, tid, kind, data):
        with self.db:
            cur = self.db.execute("INSERT INTO agent_events(chat_id,turn_id,kind,data_json,at) VALUES(?,?,?,?,?)",
                                  (cid, tid, kind, json.dumps(data, ensure_ascii=False), time.time()))
            self.db.execute("UPDATE agent_chats SET updated_at=? WHERE id=?", (time.time(), cid))
        return cur.lastrowid

    def events(self, cid):
        return [{"id": r["id"], "turn_id": r["turn_id"], "kind": r["kind"], "data": json.loads(r["data_json"]), "at": r["at"]}
                for r in self.store.all("SELECT * FROM agent_events WHERE chat_id=? ORDER BY id", (cid,))]

    def update_event(self, eid, data):
        with self.db:
            self.db.execute("UPDATE agent_events SET data_json=? WHERE id=?", (json.dumps(data, ensure_ascii=False), eid))

    def status(self, tid, value):
        with self.db:
            self.db.execute("UPDATE agent_turns SET status=?,ended_at=? WHERE id=?", (value, None if value == "running" else time.time(), tid))

    def asset(self, cid, name, path, task_id=None):
        aid = uuid.uuid4().hex
        with self.db:
            self.db.execute("INSERT INTO agent_assets VALUES(?,?,?,?,?,?)", (aid, cid, name, str(path), task_id, time.time()))
        return aid

    def public_assets(self, cid, user):
        rows = self.store.all("SELECT * FROM agent_assets WHERE chat_id=? ORDER BY created_at", (cid,))
        return [{"id": r["id"], "name": r["name"], "url": "/studio-agent/assets/" + r["id"], "task_id": r["task_id"], 'kind':'file' if Path(r['path']).suffix.lower() in {'.pcraft','.psd'} else 'image', **self.image_size(r['path'])}
                for r in rows if not r["task_id"] or self.store.task_visible(self.store.task(r["task_id"]), user)]

    def image_size(self, path):
        if path not in self.dimensions:
            try:
                with Image.open(path) as image:
                    rotated = image.getexif().get(274) in {5,6,7,8}
                    self.dimensions[path] = {'width': image.height if rotated else image.width, 'height': image.width if rotated else image.height}
            except OSError:
                return {'width': 1, 'height': 1}
        return self.dimensions[path]

    def memory(self, uid):
        return self.store.one('SELECT text,updated_at FROM agent_memories WHERE owner_id=?', (uid,)) or {'text': '', 'updated_at': None}

    def summary(self, cid):
        return self.store.one('SELECT through_event_id,summary,updated_at FROM agent_summaries WHERE chat_id=?', (cid,))

    def view(self, cid, user):
        chat = self.chat(cid, user)
        if not chat:
            return None
        turns = self.store.all("SELECT id,status,created_at,ended_at,settings_json FROM agent_turns WHERE chat_id=? ORDER BY created_at", (cid,))
        turns = [{**{k:v for k,v in t.items() if k!='settings_json'}, 'agent':json.loads(t['settings_json']).get('agent','generate')} for t in turns]
        events = self.events(cid)
        # A task hidden by its owner must also disappear from the conversation.
        for e in events:
            task_id = e["data"].get("request_id")
            if task_id and not self.store.one('SELECT 1 FROM edit_jobs WHERE id=? AND chat_id=?',(task_id,cid)) and not self.store.task_visible(self.store.task(task_id), user):
                e["data"] = {"hidden": True, "title": "此任务记录已删除"}
        return {"chat": chat, "turns": turns, "events": events, "assets": self.public_assets(cid, user), "context": self.summary(cid)}
