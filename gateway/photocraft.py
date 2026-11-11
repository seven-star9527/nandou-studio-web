"""Private stdio MCP connection. No shell, no shared Codex session, no credentials in logs."""
import asyncio
import json
import os
import subprocess
from pathlib import Path


class PhotoCraftError(RuntimeError):
    pass


class PhotoCraft:
    def __init__(self, executable, workspace, bridge=None, token_file=None, timeout=120):
        self.executable = str(executable)
        self.workspace = Path(workspace).resolve()
        self.bridge, self.token_file, self.timeout = bridge, token_file, timeout
        self.process = None
        self.sequence = 0

    async def __aenter__(self):
        args = [self.executable, 'mcp']
        if self.bridge:
            # PhotoCraft 0.17: bridge roots belong to the authenticated desktop server.
            args += ['--bridge', self.bridge, '--control-token-file', str(self.token_file)]
        else:
            args += ['--automation-read-root', str(self.workspace), '--automation-write-root', str(self.workspace)]
        try:
            self.process = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=16 * 1024 * 1024,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            await self.rpc('initialize', {'protocolVersion':'2024-11-05', 'capabilities':{}, 'clientInfo':{'name':'nandou-studio','version':'1.0'}})
            await self.write({'jsonrpc':'2.0','method':'notifications/initialized'})
            return self
        except BaseException:
            await self.close()
            raise

    async def write(self, value):
        self.process.stdin.write((json.dumps(value, ensure_ascii=False) + '\n').encode())
        await self.process.stdin.drain()

    async def rpc(self, method, params):
        self.sequence += 1
        ident = self.sequence
        await self.write({'jsonrpc':'2.0','id':ident,'method':method,'params':params})
        async with asyncio.timeout(self.timeout):
            while True:
                raw = await self.process.stdout.readline()
                if not raw:
                    raise PhotoCraftError('PhotoCraft 连接已断开，结果待核对。')
                reply = json.loads(raw)
                if reply.get('method') == 'ping' and 'id' in reply:
                    await self.write({'jsonrpc':'2.0','id':reply['id'],'result':{}})
                if reply.get('id') != ident:
                    continue
                if 'error' in reply:
                    raise PhotoCraftError('PhotoCraft MCP 请求失败。')
                return reply.get('result', {})

    async def call(self, name, **arguments):
        result = await self.rpc('tools/call', {'name':name,'arguments':arguments})
        texts = [item.get('text','') for item in result.get('content',[]) if item.get('type')=='text']
        if result.get('isError'):
            # Engine errors may contain local paths; do not return raw diagnostics to accounts.
            raise PhotoCraftError(f'PhotoCraft {name} 未完成，请检查参数、文档前置条件或客户端连接。')
        if texts:
            try:
                return json.loads('\n'.join(texts))
            except ValueError:
                return {'message':'工具已返回', 'text': '\n'.join(texts)[:2000]}
        return result.get('structuredContent', {})

    async def close(self):
        if self.process and self.process.returncode is None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()

    async def __aexit__(self, *args):
        await self.close()


def load_config(root):
    path = Path(root) / 'runtime/photocraft.json'
    value = json.loads(path.read_text(encoding='utf-8-sig')) if path.is_file() else {}
    executable = value.get('executable') or os.environ.get('NANDOU_PHOTOCRAFT_CLI', '')
    bridge = value.get('bridge')
    if bridge:
        import re
        if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', bridge) or not 1 <= int(bridge.split(':')[1]) <= 65535:
            raise ValueError('PhotoCraft bridge must be loopback')
    return {'executable': executable, 'bridge':bridge, 'token_file':value.get('token_file'),
            'timeout':min(300, max(10, int(value.get('timeout',120))))}
