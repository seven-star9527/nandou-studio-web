"""One-GPU FIFO with private per-task snapshots and evidence-based wait estimates."""
import asyncio
import json
import math
import statistics
import time
from datetime import datetime, timezone


def iso(stamp):
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat() if stamp is not None else None


def work_units(data):
    try:
        units = max(1, int(data.get("width", 1024))) * max(1, int(data.get("height", 1024))) * max(1, float(data.get("steps", 8))) * max(1, int(data.get("images", 1)))
        return units if math.isfinite(units) else None
    except (ValueError, TypeError):
        return None


class LocalQueue:
    def __init__(self, gateway, clock=time.time):
        self.gateway = gateway
        self.clock = clock
        self.jobs = {}
        self.order = []
        self.event = asyncio.Event()
        self.worker = None
        self.ticker = None

    def start(self):
        # A known dispatched session is a read-only recovery barrier, never a resubmit.
        # It remains ahead of never-dispatched queued requests until backend completion.
        for task in self.gateway.store.all("SELECT * FROM tasks WHERE kind='local' AND status IN ('queued','outcome_unknown') ORDER BY started_at,rowid"):
            try:
                record = json.loads(task["record_json"])
                owner = self.gateway.store.one("SELECT * FROM users WHERE id=?", (task["owner_id"],))
                if task["status"] == "queued":
                    self.enqueue(owner, task["id"], record["queued_request"], None, record=record, created=task["started_at"])
                elif record.get("backend_session_id"):
                    self.enqueue(owner, task["id"], record["studio_local"], None, record=record, created=task["started_at"], recovering=True)
            except (KeyError, ValueError, TypeError):
                self.gateway.store.update_task(task["id"], status="outcome_unknown")
        self.worker = asyncio.create_task(self.run())
        self.ticker = asyncio.create_task(self.tick())

    async def stop(self):
        for task in (self.worker, self.ticker):
            if task:
                task.cancel()
        await asyncio.gather(*(task for task in (self.worker, self.ticker) if task), return_exceptions=True)
        for job in list(self.jobs.values()):
            if not job["done"].done():
                job["done"].set_result(None)

    def enqueue(self, owner, tid, data, socket, record=None, created=None, recovering=False):
        now = self.clock()
        scalar = {key: data[key] for key in ("width", "height", "steps", "images", "model") if key in data}
        record = record or {"studio_local": scalar, "queued_request": data, "initial_ahead": len(self.order)}
        job = {"id": tid, "owner": owner, "data": data, "socket": socket, "state": "running" if recovering else "queued", "created": created or now,
               "started": record.get("running_at") if recovering else None, "initial_ahead": record.get("initial_ahead", len(self.order)), "record": record,
               "done": asyncio.get_running_loop().create_future(), "cancel_requested": False,
               "backend_session": record.get("backend_session_id") if recovering else None, "recovering": recovering}
        self.jobs[tid] = job
        self.order.append(tid)
        if not recovering:
            self.gateway.store.update_task(tid, status="queued", credits=0, record_json=json.dumps(record, ensure_ascii=False))
        self.event.set()
        return job

    def duration(self, job):
        rates = []
        for task in self.gateway.store.all("SELECT seconds,record_json FROM tasks WHERE kind='local' AND model=? AND status='completed' AND seconds>0 ORDER BY ended_at DESC LIMIT 30", (job["data"].get("model"),)):
            try:
                units = work_units(json.loads(task["record_json"])["studio_local"])
                if units:
                    rates.append(task["seconds"] / units)
            except (ValueError, KeyError, TypeError):
                continue
        units = work_units(job["data"])
        return (statistics.median(rates) * units if len(rates) >= 2 and units else None), len(rates)

    def snapshot(self, tid):
        job = self.jobs.get(tid)
        if not job or tid not in self.order:
            return None
        index = self.order.index(tid)
        now = self.clock()
        estimate = 0.0
        counts = []
        for previous_id in self.order[:index]:
            previous = self.jobs[previous_id]
            duration, samples = self.duration(previous)
            counts.append(samples)
            if duration is None:
                estimate = None
                continue
            if previous["state"] == "running":
                duration -= max(0, now - (previous["started"] or now))
                # Exceeding the historical estimate is uncertainty, not a new countdown.
                if duration <= 0:
                    estimate = None
                    continue
            if estimate is not None:
                estimate += duration
        task = self.gateway.store.task(tid)
        return {"task_id": tid, "ahead": index, "position": index + 1, "total": len(self.order),
                "waited_seconds": max(0, (job["started"] or now) - job["created"]),
                "estimated_wait_seconds": round(estimate, 1) if estimate is not None else None,
                "estimate_samples": min(counts) if counts else 0, "state": job["state"], "initial_ahead": job["initial_ahead"],
                "requested": task["requested"], "completed": task["completed"], "created_utc": iso(job["created"]),
                "started_utc": iso(job["started"]), "model": task["model"]}

    def latest(self, owner_id):
        candidates = [job for job in self.jobs.values() if job["owner"]["id"] == owner_id]
        return self.snapshot(max(candidates, key=lambda job: job["created"])["id"]) if candidates else None

    def latest_task(self, owner_id):
        task = self.gateway.store.one("SELECT t.* FROM tasks t LEFT JOIN task_visibility v ON v.task_id=t.id AND v.viewer_id=t.owner_id WHERE t.owner_id=? AND t.kind='local' AND v.hidden_at IS NULL ORDER BY t.started_at DESC,t.rowid DESC LIMIT 1", (owner_id,))
        if not task:
            return None
        try:
            record = json.loads(task["record_json"])
        except ValueError:
            record = {}
        return {"task_id": task["id"], "status": task["status"], "requested": task["requested"], "completed": task["completed"],
                "created_utc": iso(task["started_at"]), "started_utc": iso(record.get("running_at")), "model": task["model"]}

    async def emit(self, job, value):
        socket = job.get("socket")
        if socket and not socket.closed:
            try:
                await socket.send_json(value)
            except (ConnectionError, RuntimeError):
                job["socket"] = None

    async def cancel(self, owner, sid, tid=None):
        candidates = [job for job in self.jobs.values() if job["owner"]["id"] == owner["id"]
                      and (job["id"] == tid if tid else job["data"].get("session_id") == sid)]
        if not candidates:
            return None
        job = max(candidates, key=lambda value: value["created"])
        job["cancel_requested"] = True
        if job["state"] == "queued":
            self.order.remove(job["id"])
            record = {key: value for key, value in job["record"].items() if key != "queued_request"}
            self.gateway.store.update_task(job["id"], status="cancelled", ended_at=self.clock(), seconds=0, record_json=json.dumps(record))
            await self.emit(job, {"studio_task_id": job["id"], "studio_cancelled": True, "socket_intention": "close"})
            if not job["done"].done():
                job["done"].set_result(None)
            self.jobs.pop(job["id"], None)
            await self.broadcast()
            return {"success": True, "studio_task_id": job["id"], "studio_cancelled": True}
        return {"running_session": job["backend_session"], "job": job}

    async def broadcast(self):
        for tid in list(self.order):
            job = self.jobs.get(tid)
            if job:
                await self.emit(job, {"studio_task_id": tid, "studio_queue": self.snapshot(tid)})

    async def tick(self):
        while True:
            await asyncio.sleep(1)
            await self.broadcast()

    async def run(self):
        while True:
            await self.event.wait()
            if not self.order:
                self.event.clear()
                continue
            tid = self.order[0]
            job = self.jobs[tid]
            if job["recovering"]:
                if not await self.recover(job):
                    await asyncio.sleep(1)
                    continue
                self.order.remove(tid)
                self.jobs.pop(tid, None)
                if not job["done"].done():
                    job["done"].set_result(None)
                await self.broadcast()
                continue
            # A failed session/read connection has not dispatched generation. Retain its
            # committed queue payload and retry only this harmless preflight, in FIFO order.
            try:
                session = await self.gateway.new_session(job["owner"])
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(1)
                continue
            if tid not in self.jobs or job["cancel_requested"]:
                continue
            job["state"] = "running"
            job["started"] = self.clock()
            job["record"] = {key: value for key, value in job["record"].items() if key != "queued_request"}
            job["record"]["running_at"] = job["started"]
            job["record"]["backend_session_id"] = session["session_id"]
            self.gateway.store.update_task(tid, status="processing", record_json=json.dumps(job["record"], ensure_ascii=False))
            await self.broadcast()
            try:
                job["backend_session"] = session["session_id"]
                if job["cancel_requested"]:
                    self.gateway.store.update_task(tid, status="cancelled", ended_at=self.clock(), seconds=0)
                    await self.emit(job, {"studio_task_id": tid, "studio_cancelled": True, "socket_intention": "close"})
                else:
                    data = {**job["data"], "session_id": session["session_id"]}
                    await self.gateway.relay_local(job.get("socket"), job["owner"], tid, data)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.gateway.store.update_task(tid, status="outcome_unknown")
                await self.emit(job, {"studio_task_id": tid, "error": "生成服务响应未确认，请刷新记录核对。", "socket_intention": "close"})
            finally:
                if tid in self.order:
                    self.order.remove(tid)
                self.jobs.pop(tid, None)
                if not job["done"].done():
                    job["done"].set_result(None)
            await self.broadcast()

    async def recover(self, job):
        try:
            value = await self.gateway.upstream_api(job["owner"], "GetCurrentStatus", {"session_id": job["backend_session"]}, False)
            if value.get("error") and value.get("error_id") != "invalid_session_id":
                return False
            state = value.get("status", {})
            if any(state.get(key, 0) for key in ("waiting_gens", "loading_models", "waiting_backends", "live_gens")):
                return False
            await self.gateway.synchronize(job["owner"], include_local=True)
            task = self.gateway.store.task(job["id"])
            record = json.loads(task["record_json"])
            record.pop("backend_session_id", None)
            record["recovery_checked_at"] = self.clock()
            self.gateway.store.update_task(job["id"], record_json=json.dumps(record, ensure_ascii=False))
            # With no backend activity left, unresolved results remain unknown; they
            # are not dispatched again. Saved images reconcile through their marker.
            return True
        except Exception:
            return False
