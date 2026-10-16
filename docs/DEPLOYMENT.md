# 源码部署说明

本文给出手动部署步骤，不依赖未上传的本机运维脚本。现有部署已运行并验证；以下源码安装流程尚未在另一台全新电脑上完成全流程验收。

## 1. 环境与端口

参考环境：Windows、Git、Python 3.12、.NET 8 SDK、Node.js 22.12+、pnpm。Agent 网关与 ComfyUI 使用独立 Python 环境，避免依赖冲突。本地推理的 PyTorch/CUDA 请按显卡和上游兼容要求安装；当前运行环境使用 Torch 2.9.1/cu130。

| 服务 | 绑定地址 | 用途 |
| --- | --- | --- |
| 账号网关 | `0.0.0.0:7801` | 唯一局域网入口 |
| SwarmUI | `127.0.0.1:7802` | 私有图像调度与云服务适配 |
| ComfyUI | `127.0.0.1:8188` | 本地 GPU 推理 |

防火墙仅向预期的局域网网段开放 7801，不开放 7802/8188。当前邮箱直接重置不验证所有权，适用于受信任的内部过渡环境，不应直接暴露到公网。

## 2. 准备源码

在新的安装目录执行；不要在已经部署的 `server/` 上重复克隆或覆盖。

```powershell
git clone https://github.com/seven-star9527/nandou-studio-web.git
Set-Location nandou-studio-web
$studioRoot = (Get-Location).Path
git clone https://github.com/mcmonkeyprojects/SwarmUI.git server/SwarmUI
git -C server/SwarmUI checkout ded28b1993993d65692ce12ea2c77dad171880a0
git clone https://github.com/Comfy-Org/ComfyUI.git server/ComfyUI
git -C server/ComfyUI checkout e0a32bce84f4603f2b61b16b50f8958e68fd6171
```

这些提交是当前本机使用的参考版本，并非承诺支持任意新版。上游升级时应重新检查补丁、模型支持和账号转发规则。

## 3. 安装项目集成

`integrations/swarm/overlay` 只包含本项目新增代码和无密钥的模型能力表，不是完整 SwarmUI。补丁为两处接入修改：注册云 API、提供 `/studio/` 入口。

```powershell
$studioPatch = Join-Path $studioRoot 'integrations/swarm/studio.patch'
git -C server/SwarmUI apply --check $studioPatch
git -C server/SwarmUI apply $studioPatch
Copy-Item -Path integrations/swarm/overlay/* -Destination server/SwarmUI -Recurse -Force
Copy-Item -LiteralPath integrations/comfy/qwen21_turbo_schedule -Destination server/ComfyUI/custom_nodes -Recurse -Force
dotnet publish server/SwarmUI/src/SwarmUI.csproj -c Release -o server/SwarmUI/bin/live
```

SwarmUI 初次启动会构建 `NandouCommerce` 扩展，因此运行机器需要 .NET SDK。该扩展提供提示词润色、质量上限及普通账号转发保护，不能省略。不要把未经扩展保护的 SwarmUI 当作多人生产后端。

扩展缓存按所属 Git 提交前8位命名，位于 `server/SwarmUI/src/bin/extensions/SwarmExtensionNandouCommerce/`。修改扩展时，须在维护窗口核对实际缓存版本并重新构建；只修改 `unknown.dll` 不会更新已存在的提交缓存。启动后通过 `GetStudioPolishCapabilities.version` 核对当前扩展版本（本发布为 `1.1.0`）。

## 4. 模型与 ComfyUI

按模型上游说明单独下载权重，并阅读相关许可。当前配置使用以下文件布局：

```text
models/qwen-image-2.1/
  diffusion_models/qwen_image_2.1_int8_convrot.safetensors
  diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors
  text_encoders/qwen3vl_8b_int8_convrot.safetensors
  vae/qwen_image_2.1_vae_bf16.safetensors
```

在 ComfyUI 的 `extra_model_paths.yaml` 中设置模型目录，以及 SwarmUI 的 `src/BuiltinExtensions/ComfyUIBackend/ExtraNodes` 自定义节点目录。将示例中的路径换成本机绝对路径：

```yaml
qwen_studio:
  base_path: <项目绝对路径>/models/qwen-image-2.1
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
  custom_nodes: <项目绝对路径>/server/SwarmUI/src/BuiltinExtensions/ComfyUIBackend/ExtraNodes
```

为 ComfyUI 创建独立虚拟环境，安装兼容 GPU 的 PyTorch 和其 `requirements.txt`。通过 SwarmUI 本机管理界面将 ComfyUI 后端指向 `http://127.0.0.1:8188`，设置同一模型目录，并完成上游初始配置。

标准模式是40步 Euler/simple；Turbo使用独立权重和专用8步序列，不能仅把标准模型步数改成8。参考图编辑需 `textencodedimage=auto`。当前取消默认强制小块 VAE 解码，以避免曾出现的淡彩竖条；高分辨率更依赖可用显存。

仅使用云模型时仍需 SwarmUI 云接口适配，但可以不启动 ComfyUI、不下载本地权重。

## 5. 网关、密钥和网页

```powershell
py -3.12 -m venv runtime/venv-gateway
& runtime/venv-gateway/Scripts/python.exe -m pip install -r gateway/requirements-lock.txt
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
New-Item -ItemType Directory -Path server/SwarmUI/src/wwwroot/studio -Force
Copy-Item -Path frontend/dist/* -Destination server/SwarmUI/src/wwwroot/studio -Recurse -Force
```

在项目根目录自行创建 `.env`，填写 `APIMART_API_KEY` 与 `DEEPSEEK_API_KEY`。这两个值仅由服务端读取，不要写入浏览器配置或使用 `VITE_` 前缀。

初始化管理员：

```powershell
& runtime/venv-gateway/Scripts/python.exe -m gateway.server --bootstrap-admin
```

命令从标准输入读取一行初始密码（6–256字符），没有固定默认密码；交互式终端输入时可能回显，请在私有终端操作。用户名为 `admin`。已存在的管理员不会被覆盖，数据库只保存加盐密码哈希和会话令牌哈希。

## 6. 启动

分别在独立终端启动。各终端的项目根路径均应明确设置，以下以已经进入项目根目录为前提。

ComfyUI：使用自己准备的 Comfy Python 环境，在 `server/ComfyUI` 中运行 `python main.py --listen 127.0.0.1 --port 8188`。GPU优化参数按实际环境选择。

SwarmUI：

```powershell
$env:QWEN_STUDIO_ROOT = (Get-Location).Path
Set-Location server/SwarmUI
dotnet bin/live/SwarmUI.dll --launch_mode none --host 127.0.0.1 --port 7802
```

账号网关（在项目根目录的新终端）：

```powershell
$studioRoot = (Get-Location).Path
& runtime/venv-gateway/Scripts/python.exe -m gateway.server --root $studioRoot --host 0.0.0.0 --port 7801 --upstream http://127.0.0.1:7802
```

本机访问 `http://localhost:7801/studio/`；普通用户通过局域网 IP 访问7801。管理员身份需要数据库角色、真实回环来源与本机 Host 同时满足，不能通过伪造请求头获取。

## 7. 验收与备份

1. 确认7801的登录页、静态素材及`/health`可用；这只证明入口可达。
2. 使用两个普通账号检查互相看不到任务、原图、上传素材、Agent对话和记忆，直接图片地址也不能越权访问。
3. 验证本机管理员可查看所有作品；普通用户隐藏任务后，管理员仍可查看。
4. 验证文字和参考图切换模式、刷新后恢复；润色先预览再应用。
5. 在明确预算内提交必要的真实生成，确认原图落盘、积分、队列和恢复行为。超时不重复提交付费请求。

需备份的私有数据包括 `runtime/studio-accounts.sqlite3`、`runtime/agent-uploads`、SwarmUI输出、`Data/StudioCloudTasks`、`src/wwwroot/studio-results` 及私有引擎配置。数据库正在写入时使用 SQLite backup API 或停服快照，不只复制主文件而遗漏 WAL。

测试、评测、备份、下载和启停脚本按项目发布范围仅保留本地。公开仓库没有这些文件，不应把旧本机脚本作为安装前提。
