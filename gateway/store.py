"""Small, transactional account/task ledger; image bytes remain in Swarm output."""
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import uuid
from pathlib import Path


TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


def password_hash(password):
    salt = secrets.token_bytes(16)
    value = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return "scrypt$" + salt.hex() + "$" + value.hex()


def password_valid(password, encoded):
    try:
        algorithm, salt, expected = encoded.split("$")
        value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32)
        return algorithm == "scrypt" and hmac.compare_digest(value.hex(), expected)
    except (ValueError, TypeError):
        return False


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL, role TEXT NOT NULL, swarm_id TEXT NOT NULL UNIQUE,
          created_at REAL NOT NULL, last_seen REAL, last_ip TEXT);
        CREATE TABLE IF NOT EXISTS login_sessions(
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS backend_sessions(
          session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
          model TEXT, status TEXT NOT NULL, requested INTEGER, completed INTEGER NOT NULL DEFAULT 0,
          started_at REAL NOT NULL, ended_at REAL, seconds REAL, credits REAL,
          fingerprint TEXT, record_json TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS artifacts(
          url TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          owner_id TEXT NOT NULL REFERENCES users(id), disk_path TEXT NOT NULL,
          metadata TEXT, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS task_visibility(
          viewer_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL REFERENCES tasks(id),
          hidden_at REAL NOT NULL, PRIMARY KEY(viewer_id,task_id));
        CREATE TABLE IF NOT EXISTS access_events(
          id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id), at REAL NOT NULL,
          ip TEXT NOT NULL, event TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS task_owner ON tasks(owner_id,started_at);
        CREATE INDEX IF NOT EXISTS artifact_task ON artifacts(task_id);
        """)
        self.db.commit()

    def close(self):
        self.db.close()

    def one(self, sql, args=()):
        row = self.db.execute(sql, args).fetchone()
        return dict(row) if row else None

    def all(self, sql, args=()):
        return [dict(row) for row in self.db.execute(sql, args)]

    def user(self, email):
        return self.one("SELECT * FROM users WHERE email=?", (email,))

    def create_user(self, email, encoded, role="user"):
        uid = uuid.uuid4().hex
        swarm_id = "local" if role == "admin" else "nd_" + uid
        with self.db:
            self.db.execute("INSERT INTO users(id,email,password_hash,role,swarm_id,created_at) VALUES(?,?,?,?,?,?)",
                            (uid, email, encoded, role, swarm_id, time.time()))
        return self.user(email)

    def session(self, token):
        return self.one("SELECT u.* FROM login_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
                        (token_hash(token), time.time())) if token else None

    def login(self, uid):
        token = secrets.token_urlsafe(48)
        with self.db:
            self.db.execute("DELETE FROM login_sessions WHERE expires_at<?", (time.time(),))
            self.db.execute("INSERT INTO login_sessions VALUES(?,?,?)", (token_hash(token), uid, time.time() + 86400 * 7))
        return token

    def revoke(self, uid, password=None):
        with self.db:
            self.db.execute("DELETE FROM login_sessions WHERE user_id=?", (uid,))
            self.db.execute("DELETE FROM backend_sessions WHERE user_id=?", (uid,))
            if password:
                self.db.execute("UPDATE users SET password_hash=? WHERE id=?", (password, uid))

    def touch(self, user, ip, event="visit"):
        now = time.time()
        with self.db:
            self.db.execute("UPDATE users SET last_seen=?,last_ip=? WHERE id=?", (now, ip, user["id"]))
            if event != "visit" or not user["last_seen"] or now - user["last_seen"] > 60:
                self.db.execute("INSERT INTO access_events(user_id,at,ip,event) VALUES(?,?,?,?)", (user["id"], now, ip, event))

    def bind_session(self, sid, uid):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO backend_sessions VALUES(?,?)", (sid, uid))

    def session_owned(self, sid, uid):
        return bool(self.one("SELECT 1 FROM backend_sessions WHERE session_id=? AND user_id=?", (sid, uid)))

    def claim(self, tid, owner, kind, model, requested, fingerprint=None):
        """Global primary key is committed before a potentially paid upstream write."""
        try:
            with self.db:
                self.db.execute("INSERT INTO tasks(id,owner_id,kind,model,status,requested,started_at,fingerprint) VALUES(?,?,?,?,?,?,?,?)",
                                (tid, owner, kind, model, "initializing", requested, time.time(), fingerprint))
            return True
        except sqlite3.IntegrityError:
            return False

    def task(self, tid):
        return self.one("SELECT t.*,u.email owner_email,v.hidden_at FROM tasks t JOIN users u ON u.id=t.owner_id LEFT JOIN task_visibility v ON v.task_id=t.id AND v.viewer_id=t.owner_id WHERE t.id=?", (tid,))

    def task_visible(self, task, user):
        return bool(task and (user["role"] == "admin" or task["owner_id"] == user["id"] and not task.get("hidden_at")))

    def update_task(self, tid, **fields):
        allowed = {"model", "status", "requested", "completed", "started_at", "ended_at", "seconds", "credits", "record_json"}
        assert fields and set(fields) <= allowed
        with self.db:
            self.db.execute("UPDATE tasks SET " + ",".join(key + "=?" for key in fields) + " WHERE id=?", (*fields.values(), tid))

    def artifact(self, url, tid, owner, disk_path, metadata=None):
        # Never allow an upstream response to reassign an existing globally named file.
        existing = self.one("SELECT task_id,owner_id FROM artifacts WHERE url=?", (url,))
        if existing and (existing["task_id"] != tid or existing["owner_id"] != owner):
            raise ValueError("artifact ownership conflict")
        with self.db:
            self.db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET metadata=excluded.metadata",
                            (url, tid, owner, str(disk_path), metadata, time.time()))

    def visible_artifact(self, url, user):
        row = self.one("SELECT a.*,v.hidden_at FROM artifacts a LEFT JOIN task_visibility v ON v.task_id=a.task_id AND v.viewer_id=a.owner_id WHERE a.url=?", (url,))
        return row if row and (user["role"] == "admin" or row["owner_id"] == user["id"] and not row["hidden_at"]) else None

    def hide(self, tid, user):
        task = self.task(tid)
        if not task or task["owner_id"] != user["id"]:
            return "not_found"
        if task["status"] not in TERMINAL:
            return "active"
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO task_visibility VALUES(?,?,?)", (user["id"], tid, time.time()))
        return None

    def public_task(self, record, task):
        value = dict(record)
        value.pop("fingerprint", None)
        value.update(studio_task_id=task["id"], studio_owner_id=task["owner_id"], studio_owner_email=task["owner_email"], studio_hidden_at=task["hidden_at"])
        # Private results must not escape the authenticated file boundary via CDN fallbacks.
        value["images"] = [{key: val for key, val in image.items() if key != "remote_url"}
                           for image in value.get("images", []) if str(image.get("url", "")).startswith("/studio-results/")]
        return value

    def overview(self):
        users = self.all("""SELECT u.id,u.email,u.created_at,u.last_seen,u.last_ip,
          COUNT(t.id) tasks,COALESCE(SUM(t.completed),0) images,
          CASE WHEN COUNT(t.id)=0 THEN 0 WHEN COUNT(t.credits)<COUNT(t.id) THEN NULL ELSE SUM(t.credits) END credits
          FROM users u LEFT JOIN tasks t ON t.owner_id=u.id GROUP BY u.id ORDER BY u.created_at""")
        tasks = self.all("""SELECT t.id,u.email owner_email,t.model,t.status,t.requested,t.completed,t.started_at,t.seconds,t.credits,v.hidden_at
          FROM tasks t JOIN users u ON u.id=t.owner_id LEFT JOIN task_visibility v ON v.task_id=t.id AND v.viewer_id=t.owner_id ORDER BY t.started_at DESC""")
        summary = {"users": len(users), "tasks": len(tasks), "images": sum(t["completed"] for t in tasks),
                   "credits": None if any(t["credits"] is None for t in tasks) else sum(t["credits"] for t in tasks)}
        return {"summary": summary, "users": users, "tasks": tasks,
                "access_events": self.all("SELECT e.at,e.ip,e.event,u.email FROM access_events e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.at DESC LIMIT 300")}
