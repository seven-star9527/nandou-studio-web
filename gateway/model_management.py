"""Studio model policy and APIMart credit admission. Provider estimates never become charges."""
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING


LOCAL_MODELS = {
    'qwen_image_2.1_int8_convrot.safetensors': 'Qwen Image 2.1 标准',
    'qwen_image_2.1_turbo_int8_convrot.safetensors': 'Qwen Image 2.1 快速',
}
MODEL_LISTS = {'resolutions': 'resolution', 'ratios': 'size', 'qualities': 'quality',
               'operations': 'operation', 'formats': 'output_format'}
UNIT = 100_000_000
STUDIO_TZ = timezone(timedelta(hours=8))
TERMINAL = {'completed', 'failed', 'cancelled', 'interrupted'}


class ModelPolicyError(ValueError):
    def __init__(self, message, code='model_policy', status=403):
        super().__init__(message)
        self.code, self.status = code, status


def units(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or not 0 <= amount <= 100_000_000:
            return None
        return int((amount * UNIT).to_integral_value(rounding=ROUND_CEILING))
    except (InvalidOperation, ValueError):
        return None


def credits(value):
    return None if value is None else value / UNIT


def day_start(now):
    return datetime.fromtimestamp(now, STUDIO_TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def official_possible(data):
    return data.get('model') in {'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'} and not (
        data.get('output_format') == 'svg' and data.get('reference_images'))


class ModelManagement:
    def __init__(self, store, cloud_catalog):
        self.store = store
        self.cloud_specs = {m['id']: m for m in cloud_catalog}
        self.catalog = {m['id']: {
            'id': m['id'], 'name': m.get('label') or m.get('name') or m['id'], 'kind': 'cloud',
            **{key: list(m.get(key) or []) for key in ('resolutions', 'ratios', 'qualities', 'operations')},
            'formats': m.get('formats', ['png', 'gif', 'svg'] if m['id'].startswith('gpt-image-2.6-') else ['png']),
            'exactSize': bool((m.get('exactSize') or {}).get('supported', False)),
            'maxImages': m['maxImages'], 'maxReferences': min(m.get('maxReferences') or m['appMaxReferences'], m['appMaxReferences']),
        } for m in cloud_catalog}
        self.catalog.update({mid: {'id': mid, 'name': name, 'kind': 'local', 'maxImages': 4,
                                   'maxReferences': 10, 'maxSide': 4096, 'maxSteps': 100}
                             for mid, name in LOCAL_MODELS.items()})
        store.db.executescript('''
            CREATE TABLE IF NOT EXISTS studio_model_policy (model TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS studio_user_credit_policy (
                owner_id TEXT PRIMARY KEY REFERENCES users(id), limits TEXT NOT NULL DEFAULT '{}', reset_at REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS studio_credit_dispatch (
                id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
                model TEXT NOT NULL, reserved INTEGER, actual INTEGER, settled_at REAL);
            CREATE INDEX IF NOT EXISTS studio_credit_dispatch_owner ON studio_credit_dispatch(owner_id, model);
        ''')

    def model(self, mid):
        base = self.catalog.get(mid) if isinstance(mid, str) else None
        if not base:
            return None
        row = self.store.one('SELECT value FROM studio_model_policy WHERE model=?', (mid,))
        return {**base, 'enabled': True, **(json.loads(row['value']) if row else {})}

    def public_models(self, caps, user):
        if user['role'] == 'admin' or 'models' not in caps:
            return caps
        models = []
        for upstream in caps['models']:
            mid = upstream.get('id')
            policy = self.model(mid)
            if not policy or not policy['enabled']:
                continue
            item = {**upstream, **{key: [v for v in (upstream.get(key) or []) if v in policy[key]] for key in MODEL_LISTS if key in upstream},
                    'formats': policy['formats'], 'maxImages': min(upstream['maxImages'], policy['maxImages']),
                    'appMaxReferences': min(upstream['appMaxReferences'], policy['maxReferences'])}
            if not policy['exactSize'] and item.get('exactSize'):
                item['exactSize'] = {**item['exactSize'], 'supported': False}
            models.append(item)
        readiness = {m: value for m, value in caps.get('localReadiness', {}).items() if self.model(m) and self.model(m)['enabled']}
        local = {m: p for m in LOCAL_MODELS if (p := self.model(m))['enabled']}
        return {**caps, 'models': models, 'localReadiness': readiness, 'localPolicies': local}

    def validate(self, user, data, *, local=False, retouch_rebuild=False):
        mid = data.get('model')
        model = self.model(mid)
        if user['role'] == 'admin':
            return
        workflow_allowed = retouch_rebuild and mid == 'gemini-nano-banana-2.1' and data.get('operation') == 'edit' and data.get('n') == 1
        if not model or (not model['enabled'] and not workflow_allowed) or (model['kind'] == 'local') != local:
            raise ModelPolicyError('该模型未对普通账号开放。', 'model_disabled')
        if not self.store.one('SELECT 1 AS active FROM studio_model_policy WHERE model=?', (mid,)):
            return  # existing provider validation still applies when no policy has been saved
        def reject():
            raise ModelPolicyError('当前模型未开放这组参数，请刷新后重新选择。', 'model_parameters_restricted')
        count = data.get('images', 1) if local else data.get('n')
        refs = data.get('promptimages' if local else 'reference_images', [])
        if type(count) is not int or not 1 <= count <= model['maxImages'] or not isinstance(refs, list) or len(refs) > model['maxReferences']:
            reject()
        if local:
            if max(data.get('width', 1024), data.get('height', 1024)) > model['maxSide'] or data.get('steps', 8) > model['maxSteps']:
                reject()
            return
        resolution = str(data.get('resolution', '1K')).upper()
        quality = data.get('quality') or ('medium' if mid.startswith('gpt-image-2.6-') else '')
        size, fmt = data.get('size', 'auto'), data.get('output_format', 'png')
        if (resolution not in model['resolutions'] or data.get('operation') not in model['operations'] or fmt not in model['formats']
                or (model['qualities'] and quality not in model['qualities'])):
            reject()
        if fmt != 'gif' and not (data.get('operation') == 'edit' and self.cloud_specs[mid].get('editUsesReferenceSize')) and size not in model['ratios'] and not (model['exactSize'] and isinstance(size, str) and re.fullmatch(r'[1-9][0-9]{0,4}x[1-9][0-9]{0,4}', size)):
            reject()

    def set_model(self, mid, value):
        base = self.catalog.get(mid) if isinstance(mid, str) else None
        keys = ('enabled', 'maxImages', 'maxReferences') + (('maxSide', 'maxSteps') if base and base['kind'] == 'local'
                                                          else (*MODEL_LISTS, 'exactSize'))
        if not base or not isinstance(value, dict) or set(value) != set(keys):
            raise ValueError('模型设置无效。')
        for key in keys:
            field = value[key]
            if type(base.get(key, True)) is bool:
                valid = type(field) is bool and (key == 'enabled' or not field or base[key])
            elif type(base[key]) is int:
                valid = type(field) is int and (64 if key == 'maxSide' else 0 if key == 'maxReferences' else 1) <= field <= base[key]
            else:
                valid = isinstance(field, list) and all(isinstance(x, str) and x in base[key] for x in field)
                valid = valid and len(set(field)) == len(field) and bool(field) == bool(base[key])
            if not valid:
                raise ValueError('参数只能从模型支持范围内选择。')
        with self.store.db:
            self.store.db.execute('INSERT INTO studio_model_policy VALUES(?,?) ON CONFLICT(model) DO UPDATE SET value=excluded.value', (mid,json.dumps(value)))

    def limits(self, uid):
        row = self.store.one('SELECT * FROM studio_user_credit_policy WHERE owner_id=?', (uid,))
        return (json.loads(row['limits']), row['reset_at']) if row else ({}, 0)

    def set_limits(self, uid, payload):
        self.require_user(uid)
        if not isinstance(payload, dict) or set(payload) != {'total', 'daily', 'models'} or not isinstance(payload['models'], dict):
            raise ValueError('积分限额无效。')
        def pair(row):
            if not isinstance(row, dict) or set(row) != {'total','daily'}:
                raise ValueError('积分限额无效。')
            result = {k: units(v) for k,v in row.items()}
            if any(v is not None and result[k] is None for k,v in row.items()):
                raise ValueError('请输入非负积分数，留空表示不限。')
            return result
        model_limits = {}
        for mid, rules in payload['models'].items():
            if self.catalog.get(mid, {}).get('kind') != 'cloud':
                raise ValueError('该模型没有服务商积分账单。')
            parsed = pair(rules)
            if any(v is not None for v in parsed.values()):
                model_limits[mid] = parsed
        value = {**pair({k: payload[k] for k in ('total','daily')}), 'models': model_limits}
        with self.store.db:
            self.store.db.execute('''INSERT INTO studio_user_credit_policy(owner_id,limits) VALUES(?,?)
                ON CONFLICT(owner_id) DO UPDATE SET limits=excluded.limits''', (uid,json.dumps(value)))

    def require_user(self, uid):
        if not isinstance(uid, str) or not self.store.one("SELECT id FROM users WHERE id=? AND role!='admin'", (uid,)):
            raise ModelPolicyError('普通账号不存在。', 'account_not_found', 404)

    def reset(self, uid=None):
        if uid is not None:
            self.require_user(uid)
        with self.store.db:
            result = self.store.db.execute('''INSERT INTO studio_user_credit_policy(owner_id,reset_at)
                SELECT u.id,max(?,coalesce((SELECT max(d.settled_at) FROM studio_credit_dispatch d WHERE d.owner_id=u.id),0))
                FROM users u WHERE u.role!='admin' AND (? IS NULL OR u.id=?)
                ON CONFLICT(owner_id) DO UPDATE SET reset_at=excluded.reset_at''', (time.time(),uid,uid))
        return result.rowcount

    def usage(self, uid, since, now):
        daily = day_start(now)
        totals = {}
        def add(mid, amount, when, held=False):
            if amount is None or not mid:
                return
            slot = totals.setdefault(mid, [0,0,0])
            if held:
                slot[2] += amount
            elif when > since:
                slot[0] += amount
                if when >= daily:
                    slot[1] += amount
        rows = self.store.all('SELECT * FROM studio_credit_dispatch WHERE owner_id=?', (uid,))
        known = {row['id'] for row in rows}
        for row in rows:
            if row['settled_at'] is None:
                add(row['model'], row['reserved'], now, True)
            else:
                add(row['model'], row['actual'], row['settled_at'])
        for row in self.store.all("SELECT id,model,started_at,credits,record_json FROM tasks WHERE owner_id=? AND kind='cloud' AND started_at>=?", (uid,since)):
            record = json.loads(row['record_json'])
            components = record.get('billing_components') or [dict(record, request_id=row['id'], model=row['model'], credits_cost=row['credits'])]
            for item in components:
                if item.get('request_id') not in known and not item.get('reference_billing'):
                    add(item.get('model'), units(item.get('credits_cost')), row['started_at'])
        return totals

    def snapshot(self, uid, now=None):
        now = time.time() if now is None else now
        policy, reset_at = self.limits(uid)
        balances = self.usage(uid, reset_at, now)
        overall = [sum(v[i] for v in balances.values()) for i in range(3)]
        def section(limits, usage):
            total, day, reserved = usage
            available = [max(0, limits[k]-used-reserved) for k,used in [('total',total),('daily',day)] if limits.get(k) is not None]
            return {'total': credits(limits.get('total')), 'daily': credits(limits.get('daily')), 'used': credits(total),
                    'usedToday': credits(day), 'pending': credits(reserved), 'available': credits(min(available)) if available else None}
        return {**section(policy,overall), 'models': {mid: section(policy.get('models',{}).get(mid,{}), balances.get(mid,[0,0,0]))
                                                      for mid, model in self.catalog.items() if model['kind']=='cloud'}}

    def has_limit(self, uid, model):
        limits, _ = self.limits(uid)
        return any(v.get(k) is not None for v in (limits,limits.get('models',{}).get(model,{})) for k in ('total','daily'))

    def reserve(self, user, tid, parent, data, estimate, *, retouch_rebuild=False):
        """Recheck inside the write transaction, after any asynchronous quote call."""
        uid, mid = user['id'], data['model']
        self.validate(user,data,retouch_rebuild=retouch_rebuild)
        db = self.store.db
        with db:
            db.execute('BEGIN IMMEDIATE')
            if self.store.one('SELECT id FROM studio_credit_dispatch WHERE id=?', (tid,)):
                raise ModelPolicyError('提交已登记，请核对原任务。', 'duplicate_dispatch', 409)
            restricted = user['role'] != 'admin' and self.has_limit(uid,mid)
            official_only = False
            reserved = None
            if restricted:
                snapshot = self.snapshot(uid)
                available = [units(v) for v in (snapshot['available'],snapshot['models'].get(mid,{}).get('available')) if v is not None]
                orphan = self.store.one('''SELECT id FROM studio_credit_dispatch WHERE owner_id=? AND id!=?
                                             AND settled_at IS NULL AND reserved IS NULL LIMIT 1''', (uid,tid))
                if estimate is None or estimate <= 0 or orphan or (available and estimate > min(available)):
                    if not official_possible(data):
                        raise ModelPolicyError('可用积分不足或扣费暂不可核对。', 'credit_limit', 429)
                    official_only, reserved = True, 0
                else:
                    reserved = estimate
            db.execute('INSERT INTO studio_credit_dispatch(id,parent_id,owner_id,model,reserved) VALUES(?,?,?,?,?)', (tid,parent,uid,mid,reserved))
        return official_only

    def settle(self, record):
        actual = units(record.get('credits_cost'))
        if record.get('reference_billing'):
            actual = 0
        if actual is None or record.get('status') not in TERMINAL:
            return
        row = self.store.one('SELECT owner_id FROM studio_credit_dispatch WHERE id=?',(record.get('request_id'),))
        if not row:
            return
        _, reset_at = self.limits(row['owner_id'])
        with self.store.db:
            self.store.db.execute('''UPDATE studio_credit_dispatch SET actual=?,settled_at=coalesce(settled_at,?)
                                    WHERE id=? AND (actual IS NULL OR actual <= ?)''', (actual,max(time.time(),math.nextafter(reset_at,math.inf)),record.get('request_id'),actual))
