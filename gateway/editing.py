"""Account-scoped image editing jobs with immutable originals and MCP checkpoints."""
import asyncio
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from PIL import Image
from .photocraft import PhotoCraft, PhotoCraftError, load_config
from .agent_limits import AgentError
from .quick_edits import checked_points, cutout, product_retouch, retouch_settings
from .image_uploads import MAX_IMAGE_PIXELS, copy_processing_input
from . import designer_workflow

PYTHON = {
    'image.resize':('图像大小', '{width:整数,height:整数} 等比需求请给出计算后的宽高'),
    'image.crop':('裁剪', '{x:整数,y:整数,width:整数,height:整数} 原图像素坐标'),
    'image.rotate':('旋转画布', '{angle:90|180|270} 逆时针'),
    'image.flip':('翻转画布', '{axis:"horizontal"|"vertical"}'),
}
COMMANDS = {
    'filter.cameraRaw':'Camera Raw 校正曝光、白平衡与纹理', 'paint.remove':'移除局部瑕疵',
    'select.object':'点选或框选物体', 'select.colorRange':'选择颜色范围',
    'layer.removeBackground':'抠出主体并建立蒙版',
    'image.crop':'裁剪', 'image.imageSize':'图像大小', 'image.canvasSize':'画布大小',
    'image.perspectiveCrop':'透视裁剪', 'select.subject':'选择主体',
    'select.all':'全选', 'select.deselect':'取消选择', 'select.inverse':'反向选择',
    'select.modify.feather':'羽化选区', 'select.modify.expand':'扩展选区', 'select.modify.contract':'收缩选区',
    'select.rect':'矩形选区',
    'layer.layerMask.revealSelection':'图层蒙版', 'layer.layerMask.revealAll':'添加图层蒙版',
    'layer.layerMask.edit':'调整蒙版边缘', 'layer.layerMask.hideSelection':'隐藏选区蒙版',
    'layer.newAdjustmentLayer.curves':'曲线调整图层', 'layer.newAdjustmentLayer.levels':'色阶调整图层',
    'layer.newAdjustmentLayer.hueSaturation':'色相/饱和度调整图层',
    'layer.newAdjustmentLayer.brightnessContrast':'亮度/对比度调整图层',
    'layer.newAdjustmentLayer.vibrance':'自然饱和度调整图层',
    'layer.new.layer':'新建图层', 'layer.duplicate':'复制图层', 'layer.select':'选择图层',
    'layer.delete':'删除工作图层',
    'layer.createClippingMask':'创建剪贴蒙版', 'layer.layerStyle.dropShadow':'投影',
    'layer.layerStyle.stroke':'描边', 'type.create':'文字图层', 'type.edit':'编辑文字',
    'filter.sharpen.smartSharpen':'智能锐化', 'filter.sharpen.unsharpMask':'USM锐化',
    'filter.blur.gaussianBlur':'高斯模糊', 'edit.contentAwareFill':'内容识别填充',
    'edit.fill':'填充', 'edit.transform':'自由变换',
    'paint.spotHealing':'污点修复', 'paint.cloneStamp':'仿制图章',
    'shape.create':'形状图层', 'layer.newFillLayer.solidColor':'纯色填充图层',
}


def cover_layout(ratio):
    width,height={'16:9':(1280,720),'9:16':(1080,1920),'1:1':(1200,1200)}[ratio]
    if ratio=='16:9':
        return width,height,(660,648),[916,360]
    return width,height,(round(width*.91),round(height*.66)),[width/2,height*.59]


def validate_params(value, depth=0):
    if depth > 8:
        raise ValueError('parameters too deep')
    if isinstance(value, dict):
        for w,h in [('width','height'),('targetWidth','targetHeight')]:
            if type(value.get(w)) in (int,float) and type(value.get(h)) in (int,float) and value[w]*value[h]>MAX_IMAGE_PIXELS:
                raise ValueError('pixel budget exceeded')
        for key, item in value.items():
            if re.search(r'path|file|url|uri|script|token|command|document|plugin|preset|profile', key, re.I):
                raise ValueError('external resource parameters forbidden')
            validate_params(item, depth+1)
            if key in {'width','height','targetWidth','targetHeight'} and (type(item) not in (int,float) or not 1 <= item <= 16384):
                raise ValueError('invalid dimension')
    elif isinstance(value, list):
        if len(value)>4096:
            raise ValueError('parameters too large')
        for item in value: validate_params(item,depth+1)
    elif type(value) in (int,float) and (not math.isfinite(value) or abs(value)>1_000_000):
        raise ValueError('numeric parameter out of bounds')
    elif isinstance(value,str) and len(value)>4000:
        raise ValueError('text too long')


class Editing:
    def __init__(self, agent):
        self.agent = agent
        self.root = agent.g.root / 'runtime/agent-edits'
        self.root.mkdir(parents=True, exist_ok=True)
        self.limit = asyncio.Semaphore(2)
        self.desktop_lock = asyncio.Lock()
        try:
            self.config = load_config(agent.g.root)
        except (ValueError,OSError,TypeError):
            # A broken optional editor configuration must not take down accounts or generation.
            self.config = {'executable':'','bridge':None,'token_file':None,'timeout':120}
        self.catalog = None
        self.db = agent.store.db
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS edit_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,turn_id TEXT NOT NULL,
            source_id TEXT NOT NULL,engine TEXT NOT NULL,request_json TEXT NOT NULL,status TEXT NOT NULL,
            completed_steps INTEGER NOT NULL DEFAULT 0,result_json TEXT,created_at REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS edit_projects(asset_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,
            source_id TEXT NOT NULL,project_path TEXT NOT NULL);
        ''')
        self.db.execute("UPDATE edit_jobs SET status='outcome_unknown' WHERE status IN ('running','queued')")
        self.db.commit()

    def connection(self, workspace, desktop=False):
        if not self.config['executable'] or not Path(self.config['executable']).is_file():
            raise AgentError('PhotoCraft MCP 尚未配置，Python 图片工具仍可使用。')
        if desktop and (not self.config['bridge'] or not self.config['token_file']):
            raise AgentError('PhotoCraft 客户端桥接尚未配置。')
        return PhotoCraft(self.config['executable'], workspace,
            self.config['bridge'] if desktop else None, self.config['token_file'] if desktop else None,
            self.config['timeout'])

    async def tools(self, engine, filter_text=''):
        if engine not in {'python','photocraft','desktop'} or not isinstance(filter_text,str) or len(filter_text)>80:
            raise ValueError()
        if engine=='python':
            return [{'command':k,'title':v[0],'params':v[1]} for k,v in PYTHON.items()]
        if self.catalog is None:
            async with self.connection(self.root) as mcp:
                self.catalog = {c['id']:c for c in await mcp.call('command_list') if c['id'] in COMMANDS}
        commands = [{'command':k,'title':COMMANDS[k],'params':v['params']} for k,v in self.catalog.items()
                    if not filter_text or filter_text.lower() in (k+COMMANDS[k]+v['label']).lower()]
        commands.append({'command':'doc.place','title':'置入智能对象', 'params':'{ref_id:本会话素材ID,scale:百分比?,center:[x,y]?}；只能引用本人素材'})
        return commands

    def source(self, cid, user, aid):
        asset = self.agent.resolve_asset(cid,user,aid)
        project = self.agent.g.store.one('SELECT * FROM edit_projects WHERE asset_id=?',(aid,))
        path = Path(project['project_path']) if project else Path(asset['path'])
        if project and (not path.resolve().is_relative_to(self.root.resolve()) or not path.is_file()):
            raise ValueError('project unavailable')
        return asset,path

    async def inspect(self, cid, user, aid):
        _,source = self.source(cid,user,aid)
        folder=self.root / ('inspect-'+uuid.uuid4().hex)
        folder.mkdir()
        target=folder/('input'+source.suffix)
        target = await asyncio.to_thread(copy_processing_input, source, target)
        try:
            async with self.connection(folder) as mcp:
                await mcp.call('doc_open',path=str(target))
                return public_document(await mcp.call('doc_inspect'))
        finally:
            # Only our ephemeral directory; never a user path.
            if folder.resolve().parent == self.root.resolve(): shutil.rmtree(folder)

    async def cutout(self, cid, tid, user, aid, ctx, points=None, selection='auto'):
        if selection not in ('auto','hands','include','pick') or (selection in ('auto','hands') and points is not None):
            raise ValueError('invalid subject selection')
        if selection!='auto':
            if selection!='hands':
                checked_points(points)
            return await self.edit({'ref_id':aid, 'engine':'photocraft', 'steps':[], 'format':'png',
                                    'cutout':True,'selection':selection,'points':points},cid,tid,user,ctx)
        asset = self.agent.resolve_asset(cid,user,aid)
        def already_isolated():
            with Image.open(asset['path']) as image:
                if 'A' not in image.getbands() and 'transparency' not in image.info:
                    return False
                alpha = image.convert('RGBA').getchannel('A')
                bounds = alpha.getbbox()
                if not bounds:
                    raise AgentError('原图已完全透明，没有可保留的主体。')
                # Only pass through if all four edges are already clear.
                left, top, right, bottom = bounds
                return left > 0 and top > 0 and right < image.width and bottom < image.height
        isolated = await asyncio.to_thread(already_isolated)
        steps = [] if isolated else [{'command':'layer.removeBackground', 'params':{}}]
        engine = 'python' if isolated else 'photocraft'
        return await self.edit({'ref_id':aid, 'engine':engine, 'steps':steps, 'format':'png', 'cutout':True},
                               cid,tid,user,ctx)

    async def product(self,cid,tid,user,aid,category,background,center,ctx,designer=False):
        if type(center) is not bool:
            raise ValueError('invalid product framing')
        option='|'.join((category,background,'0','center' if center else 'frame'))
        retouch_settings(option)
        if designer:
            if background!='white' or center:
                return {'error':'设计师白底工作流保留原图构图，请选白底且关闭居中。'}
            return await self.edit({'ref_id':aid,'engine':'photocraft','designer':category,'steps':[],'format':'png'},
                                   cid,tid,user,ctx)
        return await self.edit({'ref_id':aid,'engine':'photocraft','retouch':option,'steps':[],'format':'png'},
                               cid,tid,user,ctx)

    async def cover(self,cid,tid,user,aid,ratio,title,ctx):
        if ratio not in ('16:9','9:16','1:1') or not isinstance(title,str) or not title.strip() or len(title)>80:
            raise ValueError('封面需要有效的画幅和 1 至 80 字的标题。')
        w,h,_,_=cover_layout(ratio)
        wide=ratio=='16:9'
        box=[round(w*.055),round(h*(.28 if wide else .115)),round(w*(.38 if wide else .89)),round(h*(.62 if wide else .25))]
        # Reserve several lines, including space for a long unbroken CJK title.
        size=min(58, max(20, int((box[2]*box[3]/(max(1,len(title))*1.65))**.5)))
        steps=[{'command':'type.create','params':{'name':'封面标题','text':title.strip(),
               'box':box,'x':box[0],'y':box[1], 'size':size,'color':'#22252b'}}]
        return await self.edit({'ref_id':aid,'engine':'photocraft','cover':ratio,'steps':steps,'format':'png'},
                               cid,tid,user,ctx)

    def update(self,jid,status,completed=None,result=None):
        with self.db:
            self.db.execute('UPDATE edit_jobs SET status=?, completed_steps=COALESCE(?,completed_steps),result_json=COALESCE(?,result_json) WHERE id=?',
                (status,completed,json.dumps(result,ensure_ascii=False) if result is not None else None,jid))

    async def health(self):
        status={'python':'available','mcp':'not_configured','desktop':'not_configured'}
        if self.config['executable']:
            try:
                async with self.connection(self.root) as mcp:
                    await mcp.rpc('tools/list',{})
                status['mcp']='connected'
            except (OSError,PhotoCraftError,TimeoutError,AgentError): status['mcp']='unavailable'
        if self.config['bridge']:
            try:
                async with self.connection(self.root,True) as mcp:
                    await mcp.call('ui_inspect')
                status['desktop']='connected'
            except (OSError,PhotoCraftError,TimeoutError,AgentError): status['desktop']='unavailable'
        return status

    def publish(self,jid,cid,tid,user,args,folder):
        if args.get('designer') and not (folder/'result.pcraft').is_file():
            raise AgentError('分层工程未保存完整，本次未交付。')
        existing=self.agent.g.store.one('SELECT status,result_json FROM edit_jobs WHERE id=?',(jid,))
        if existing and existing['status']=='completed': return json.loads(existing['result_json'])
        fmt=args['format']; output=folder/('result.'+fmt); project=folder/'result.pcraft'
        with Image.open(output) as im:
            if im.width * im.height > MAX_IMAGE_PIXELS: raise AgentError(f'输出超过 {MAX_IMAGE_PIXELS // 10000} 万像素上限。')
            im.load()
            dimensions={'width':im.width,'height':im.height,'format':im.format,'alpha':'A' in im.getbands()}
            if args.get('cutout'):
                source = self.agent.resolve_asset(cid,user,args['ref_id'])
                with Image.open(source['path']) as original:
                    size = original.size[::-1] if original.getexif().get(274) in {5,6,7,8} else original.size
                hist = im.getchannel('A').histogram() if dimensions['alpha'] else []
                if im.format != 'PNG' or im.size != size or not hist or not hist[0] or not sum(hist[1:]):
                    raise AgentError('抠图未能同时保留主体、透明背景和原尺寸，本次未交付。')
                dimensions['transparent_pixels'] = hist[0]
        aid=self.agent.store.asset(cid,'修图结果.'+fmt,output)
        if project.is_file():
            with self.db: self.db.execute('INSERT INTO edit_projects VALUES(?,?,?,?)',(aid,jid,args['ref_id'],str(project)))
            project_id=self.agent.store.asset(cid,'可编辑工程.pcraft',project)
        else: project_id=None
        result={'request_id':jid,'status':'completed','source_id':args['ref_id'],
            'images':[{'ref_id':aid,'url':'/studio-agent/assets/'+aid,'name':'修图结果.'+fmt}],
            'files':[{'name':'可编辑工程.pcraft','url':'/studio-agent/assets/'+project_id}] if project_id else [], **dimensions}
        count = len(designer_workflow.STAGES) if args.get('designer') else len(args['steps'])
        self.update(jid,'completed',count,result)
        self.agent.store.event(cid,tid,'result',result)
        return result

    async def reconcile(self,cid,jid,user):
        if not self.agent.store.chat(cid,user,write=True): raise ValueError('chat unavailable')
        job=self.agent.g.store.one('SELECT * FROM edit_jobs WHERE id=? AND chat_id=?',(jid,cid))
        if not job: raise ValueError('job unavailable')
        if job['status']=='completed': return json.loads(job['result_json'])
        if job['turn_id'] in self.agent.jobs: return {'status':job['status'],'pending':True}
        args=json.loads(job['request_json']); folder=self.root/user['id']/cid/jid
        if job['engine']=='desktop':
            async with self.desktop_lock:
                async with DesktopLease(Path(self.config['token_file']).parent):
                    async with self.connection(self.root,True) as mcp:
                        state=await mcp.call('ui_inspect')
                        if any(state.get('jobs',{}).get(k) for k in ('running','saving','opening')):
                            return {'status':'outcome_unknown','pending':True}
                        docs=state.get('session',{}).get('documents',[])
                        for doc in reversed(docs):
                            path=Path(doc.get('path','')).resolve()
                            if path.is_relative_to(folder.resolve()) and not doc.get('dirty'):
                                await mcp.call('control_call',method='engine.execute',params={'command':'file.close','params':{'document':doc['index']}})
                            elif path.is_relative_to(folder.resolve()):
                                await mcp.call('doc_save',path=str(folder/'recovered-checkpoint.pcraft'),index=doc['index'])
                                await mcp.call('control_call',method='engine.execute',params={'command':'file.close','params':{'document':doc['index']}})
        output=folder/('result.'+args['format'])
        expected = len(designer_workflow.STAGES) if args.get('designer') else len(args['steps'])
        if job['completed_steps']==expected and output.is_file():
            result=self.publish(jid,cid,job['turn_id'],user,args,folder)
            for event in self.agent.store.events(cid):
                if event['kind']=='result' and event['data'].get('request_id')==jid and event['data'].get('status')!='completed':
                    self.agent.store.update_event(event['id'],{'request_id':jid,'status':'reconciled','images':[],'error':'此任务已核对，恢复结果见下方。'})
            return result
        self.update(jid,'interrupted')
        return {'status':'interrupted','error':'没有完整输出；未重放操作，原图和检查点保留，可提出新的修改要求。'}

    async def edit(self, args, cid, tid, user, ctx):
        engine,steps,fmt=args['engine'],args['steps'],args['format']
        if engine not in {'python','photocraft','desktop'} or fmt not in {'png','jpg','webp'} or not isinstance(steps,list) or len(steps)>12:
            raise ValueError()
        if ctx['generated']>=4:
            return {'error':'本轮已交付4个结果，请下一轮继续。'}
        asset,source=self.source(cid,user,args['ref_id'])
        if args.get('cutout') or args.get('cover') or args.get('retouch') or args.get('designer'):
            # Segment the selected visible composite, never just the active project layer.
            source = Path(asset['path'])
        if engine=='python' and source.suffix.lower()=='.pcraft':
            return {'error':'此图具有可编辑工程，请使用PhotoCraft保留图层。'}
        catalog={c['command']:c for c in await self.tools(engine)}
        prepared=[]
        for step in steps:
            if not isinstance(step,dict) or set(step)!={'command','params'} or step['command'] not in catalog or not isinstance(step['params'],dict):
                raise ValueError('unsupported edit command')
            if engine=='python' and step['command'] not in PYTHON: raise ValueError()
            validate_params(step['params'])
            if len(json.dumps(step['params']))>20000: raise ValueError()
            if step['command']=='doc.place':
                if set(step['params'])-{'ref_id','scale','center'}: raise ValueError()
                self.agent.resolve_asset(cid,user,step['params']['ref_id'])
            prepared.append({**step,'title':catalog[step['command']]['title']})
        request=json.dumps(args,sort_keys=True,ensure_ascii=False)
        jid=hashlib.sha256((tid+request).encode()).hexdigest()[:32]
        previous=self.agent.g.store.one('SELECT * FROM edit_jobs WHERE id=?',(jid,))
        if previous:
            return json.loads(previous['result_json']) if previous['status']=='completed' else {'error':'该操作已执行或结果待核对，不重复修改。','status':previous['status']}
        # An interrupted/unknown document must not be retried under a different command fingerprint.
        if self.agent.g.store.one("SELECT 1 FROM edit_jobs WHERE chat_id=? AND status IN ('running','outcome_unknown')",(cid,)):
            return {'error':'此对话有修图结果待核对，请先检查已保存版本，不能重复派发。'}
        with self.db:
            self.db.execute('INSERT INTO edit_jobs(id,chat_id,turn_id,source_id,engine,request_json,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
                (jid,cid,tid,args['ref_id'],engine,request,'queued',time.time()))
        emit=lambda kind,data:self.agent.store.event(cid,tid,kind,data)
        backend={'python':'Python / Pillow','photocraft':'PhotoCraft MCP','desktop':'PhotoCraft 客户端'}[engine]
        plan=[{'title':s['title'],'tool':f"{backend} · {s['command']}"} for s in prepared]
        if args.get('selection') in ('hands','pick','include'):
            plan.insert(0,{'title':'识别点选主体','tool':'MobileSAM' if args['selection']=='pick' else '手掌检测 + BiRefNet + MobileSAM' if args['selection']=='hands' else 'BiRefNet + MobileSAM'})
        if args.get('retouch'):
            plan.insert(0,{'title':'按商品类目精修','tool':'南斗本地商品精修'})
        if args.get('cover'):
            plan.insert(0,{'title':'新建封面并放置商品','tool':'PhotoCraft · doc_new / doc_place'})
        plan.append({'title':f'导出 {fmt.upper()}','tool':f"{backend} · {'Image.save' if engine=='python' else 'doc_save'}"})
        if args.get('designer'):
            plan=[{'title':title,'tool':tool} for title,tool in designer_workflow.STAGES]
        emit('plan',{'summary':'保留原图，处理后另存新版本','steps':[p['title'] for p in plan],'operations':plan,'request_id':jid})
        emit('status',{'text':'正在等待修图执行器'})
        folder=self.root/user['id']/cid/jid
        folder.mkdir(parents=True,exist_ok=True)
        local=folder/('input'+source.suffix.lower())
        local = await asyncio.to_thread(copy_processing_input, source, local)
        output=folder/('result.'+fmt)
        project=folder/'result.pcraft'
        try:
            async with self.limit:
                if engine=='desktop':
                    async with self.desktop_lock:
                        async with DesktopLease(Path(self.config['token_file']).parent):
                            await self.run_mcp(folder,local,output,project,prepared,jid,emit,cid,user,True)
                elif engine=='photocraft' and args.get('designer'):
                    self.update(jid,'running')
                    def phase(i,state):
                        return {**plan[i],'request_id':jid,'status':state}
                    def complete(eid,i):
                        self.agent.store.update_event(eid,phase(i,'completed'))
                        self.update(jid,'running',i+1)
                    async with self.connection(folder,False) as editor:
                        category=await designer_workflow.render(editor,self.agent.g.workbench.cutout_model,local,folder,args['designer'],
                            lambda i:emit('edit_step',phase(i,'running')),complete)
                        label={'brush':'画笔','paper':'水彩纸／本','palette':'调色盘','paint':'颜料','toy':'玩具','miniature':'微缩模型','general':'通用商品'}[category]
                        origin='自动识别' if args['designer']=='auto' else '手动指定'
                        emit('notice',{'text':f'{origin}采用「{label}」精修。'})
                elif engine=='photocraft':
                    if args.get('selection') in ('hands','pick','include'):
                        eid=emit('edit_step',{**plan[0],'status':'running','request_id':jid})
                        subject=folder/'subject.png'
                        await cutout(self.agent.g.workbench.cutout_model,local,subject,args.get('points'),args['selection']=='pick',args['selection']=='hands')
                        self.agent.store.update_event(eid,{**plan[0],'status':'completed','request_id':jid})
                        local=subject
                    if args.get('retouch'):
                        eid=emit('edit_step',{**plan[0],'status':'running','request_id':jid})
                        retouched=folder/'retouched.png'
                        await product_retouch(self.agent.g.workbench.cutout_model,local,retouched,args['retouch'])
                        self.agent.store.update_event(eid,{**plan[0],'status':'completed','request_id':jid})
                        local=retouched
                    await self.run_mcp(folder,local,output,project,prepared,jid,emit,cid,user,False,args.get('cover'))
                else:
                    self.update(jid,'running')
                    eid=emit('edit_step',{'title':' / '.join(p['title'] for p in plan),'tool':backend,'status':'running','request_id':jid})
                    payload=folder/'request.json'
                    payload.write_text(json.dumps({'input':str(local),'output':str(output),'steps':steps}),encoding='utf-8')
                    process=await asyncio.create_subprocess_exec(sys.executable,'-m','gateway.image_worker',str(payload),
                        cwd=str(Path(__file__).resolve().parents[1]),stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                    try:
                        await asyncio.wait_for(process.wait(),60)
                        if process.returncode: raise AgentError('图片处理失败，请检查裁切范围、尺寸和透明背景的导出格式。')
                    finally:
                        if process.returncode is None:
                            process.kill(); await process.wait()
                    self.agent.store.update_event(eid,{'title':' / '.join(p['title'] for p in plan),'tool':backend,'status':'completed','request_id':jid})
                    self.update(jid,'running',len(steps))
                result=self.publish(jid,cid,tid,user,args,folder)
                ctx['generated']+=1
                return result
        except BaseException as exc:
            unknown=engine=='desktop' and isinstance(exc,(asyncio.CancelledError,TimeoutError,PhotoCraftError))
            state='outcome_unknown' if unknown else 'interrupted' if isinstance(exc,asyncio.CancelledError) else 'failed'
            self.update(jid,state)
            for event in self.agent.store.events(cid):
                if event['kind']=='edit_step' and event['data'].get('request_id')==jid and event['data'].get('status')=='running':
                    self.agent.store.update_event(event['id'],{**event['data'],'status':state})
            emit('result',{'request_id':jid,'agent':'retouch','status':state,'images':[], 'error':'本次编辑未交付，原图保留。桌面任务可能仍在运行，请先核对。' if unknown else '本次编辑未完成，原图和已保存的检查点保留。'})
            if isinstance(exc,asyncio.CancelledError): raise
            ctx.update(halt=True,status='failed')
            return {'error':str(exc) if isinstance(exc,(AgentError,PhotoCraftError)) else '修图未完成，请检查工具前置条件与服务状态。','status':state}

    async def run_mcp(self,folder,local,output,project,steps,jid,emit,cid,user,desktop,cover=None):
        self.update(jid,'running')
        async with self.connection(folder,desktop) as mcp:
            if desktop:
                sessions=await mcp.call('session_list')
                # Never replace a document left behind by an uncertain prior request.
                if sessions.get('documents') or sessions.get('session',{}).get('documents'):
                    raise AgentError('专用客户端仍有未清理文档，请管理员先核对；本轮未修改。')
            if cover:
                event={'title':'新建封面并放置商品','tool':'PhotoCraft · doc_new / doc_place','request_id':jid}
                eid=emit('edit_step',{**event,'status':'running'})
                w,h,box,center=cover_layout(cover)
                from PIL import ImageOps
                def fit_photo():
                    with Image.open(local) as image:
                        # Bound the placed bitmap to its print size on this cover.
                        image.draft('RGB',box)
                        photo=ImageOps.exif_transpose(image).convert('RGBA')
                        photo.thumbnail(box,Image.Resampling.LANCZOS)
                        photo.save(folder/'product.png')
                await asyncio.to_thread(fit_photo)
                await mcp.call('doc_new',width=w,height=h,background='white',name='商品封面')
                await mcp.call('doc_place',path=str(folder/'product.png'),scale=100,center=center)
                self.agent.store.update_event(eid,{**event,'status':'completed'})
            else:
                await mcp.call('doc_open',path=str(local))
            await mcp.call('doc_save',path=str(folder/'checkpoint-0.pcraft'))
            for index,step in enumerate(steps,1):
                tool='PhotoCraft 客户端' if desktop else 'PhotoCraft MCP'
                event={'title':step['title'],'tool':tool+' · '+step['command'],'status':'running','request_id':jid}
                eid=emit('edit_step',event)
                if step['command']=='doc.place':
                    params=dict(step['params'])
                    ref=self.agent.resolve_asset(cid,user,params.pop('ref_id'))
                    source=Path(ref['path'])
                    placed=folder/(f'placed-{index}'+source.suffix)
                    placed = await asyncio.to_thread(copy_processing_input, source, placed)
                    await mcp.call('doc_place',path=str(placed),**params)
                else:
                    await mcp.call('command_run',id=step['command'],params=step['params'])
                await mcp.call('doc_save',path=str(folder/f'checkpoint-{index}.pcraft'))
                self.update(jid,'running',index)
                self.agent.store.update_event(eid,{**event,'status':'completed'})
            await mcp.call('doc_save',path=str(project))
            eid=emit('edit_step',{'title':'导出成图','tool':tool+' · doc_save' if steps else 'PhotoCraft · doc_save','status':'running','request_id':jid})
            if output.suffix=='.jpg':
                check=folder/'transparency-check.png'
                await mcp.call('doc_save',path=str(check))
                with Image.open(check) as image:
                    if 'A' in image.getbands() and image.getchannel('A').getextrema()[0]<255:
                        raise AgentError('图片含透明区域，请先明确铺底色或改用 PNG / WebP。')
            result=await mcp.call('doc_save',path=str(output))
            warnings=result.get('warnings',[])
            unexpected=[str(w) for w in warnings if 'flattened; layers, masks and blend modes are not kept' not in str(w)]
            if unexpected: emit('notice',{'text':'导出存在格式兼容性提示，请检查输出；可编辑工程已保留。'})
            self.agent.store.update_event(eid,{'title':'导出成图','tool':'PhotoCraft · doc_save','status':'completed','request_id':jid})
            if desktop:
                # doc_close is headless-only in PhotoCraft 0.8.2. The saved GUI tab
                # is closed through its supported control command, never the user's app.
                await mcp.call('control_call',method='engine.execute',params={'command':'file.close','params':{}})

    async def export(self,cid,tid,user,aid):
        if not isinstance(aid,str): raise ValueError("invalid project reference")
        aid=aid.removeprefix('/studio-agent/assets/')
        # Both the preview and its .pcraft download identify the same owned version.
        project=self.agent.g.store.one(
            "SELECT p.asset_id FROM agent_assets f JOIN edit_projects p ON p.project_path=f.path "
            "JOIN agent_assets preview ON preview.id=p.asset_id AND preview.chat_id=f.chat_id "
            "WHERE f.id=? AND f.chat_id=?", (aid,cid))
        if project: aid=project['asset_id']
        _,source=self.source(cid,user,aid)
        if source.suffix!='.pcraft': return {'error':'此图片没有可编辑工程，请使用修图结果的预览图或 .pcraft 文件引用。'}
        for event in reversed(self.agent.store.events(cid)):
            data=event['data']
            if event['kind']=='result' and data.get('export_ref_id')==aid and data.get('files'):
                if event['turn_id'] != tid:
                    self.agent.store.event(cid,tid,'result',data)
                return data
        folder=self.root/user['id']/cid/('export-'+uuid.uuid4().hex)
        folder.mkdir(parents=True)
        local=folder/'input.pcraft'; shutil.copyfile(source,local)
        output=folder/'project.psd'
        async with self.connection(folder) as mcp:
            await mcp.call('doc_open',path=str(local))
            response=await mcp.call('doc_save',path=str(output))
            await mcp.call('doc_open',path=str(output))
            await mcp.call('doc_inspect')
        file_id=self.agent.store.asset(cid,'修图工程.psd',output)
        result={'export_ref_id':aid,'files':[{'name':'修图工程.psd','url':'/studio-agent/assets/'+file_id}], 'images':[], 'status':'completed'}
        if response.get('warnings'): result['error']='PSD导出存在兼容性提示，请在目标软件检查；原生工程保留。'
        self.agent.store.event(cid,tid,'result',result)
        return result


class DesktopLease:
    """OS lock also excludes a second gateway process using the same desktop worker."""
    def __init__(self,root): self.path=root/'desktop.lock'; self.file=None
    async def __aenter__(self):
        self.file=self.path.open('a+b')
        self.file.write(b'0'); self.file.flush()
        deadline=time.monotonic()+120
        try:
            while True:
                try:
                    self.file.seek(0)
                    if os.name=='nt':
                        import msvcrt
                        msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
                    else:
                        import fcntl
                        fcntl.flock(self.file,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    return self
                except OSError:
                    if time.monotonic()>deadline: raise AgentError('客户端繁忙，本次尚未执行。')
                    await asyncio.sleep(.25)
        except BaseException:
            self.file.close(); raise
    async def __aexit__(self,*args): self.file.close()


def public_document(value):
    if isinstance(value,dict):
        return {k:public_document(v) for k,v in value.items() if not re.search(r'path|file|token',k,re.I)}
    if isinstance(value,list): return [public_document(v) for v in value]
    return value
