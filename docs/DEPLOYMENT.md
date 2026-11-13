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

扩展缓存按所属 Git 提交前8位命名，位于 `server/SwarmUI/src/bin/extensions/SwarmExtensionNandouCommerce/`。修改扩展时，须在维护窗口核对实际缓存版本并重新构建；只修改 `unknown.dll` 不会更新已存在的提交缓存。启动后通过 `GetStudioPolishCapabilities.version` 核对当前扩展版本（本次润色更新为 `1.2.0`）。

润色支持通用创作与电商商品图；通用模式无需平台、品类、用途预设。润色仍只读取文字，不会自动识别参考图；可在补充要求中填写图片内容和准确标题，预览后手动应用。

新提交的本地及云端任务在生成前将上传原图保存到 `runtime/task-references/<task-id>/`，由账号网关校验任务归属后提供查看。隐藏任务后本人不能再读取参考图，管理员仍可审计。旧任务未保存的原图不能凭尺寸或复用的 ComfyUI 临时文件名自动还原。

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

快捷模板的实测预览采用独立静态素材包。将对应版本的「南斗模板预览素材」解压到 `frontend/public/`，使其中的 `template-previews/*.webp` 与 `prompt-library.json` 的 `preview` 路径对应，再构建前端。也可解压至同版本已部署的 `/studio/` 静态目录。当前验收配套文件为 `南斗模板预览素材-20261113.zip`（SHA-256：`c1f949bcd7ae5922e55162d953b4aedf1a1ef707e1de9665a27bf560282b49e1`）。发布后在模板详情检查样图和「仅用作参考图」。


快捷抠图与主图精修的纯白背景使用本机 BiRefNet。将 [BiRefNet General Lite ONNX 权重](https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx) 放到网关根目录的 `models/birefnet-general-lite.onnx`，核对 MD5 为 `4fab47adc4ff364be1713e97b7e66334`。模型只在第一次处理时加载。点选主体还需要将 [MobileSAM ONNX](https://huggingface.co/Acly/MobileSAM/tree/0d3b403339b4674a82493d5e97964dd78089ddc8) 的 `mobile_sam_image_encoder.onnx` 和 `sam_mask_decoder_multi.onnx` 放在同一目录。两者的 SHA-256 分别为 `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` 和 `8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe`。修图 Agent 自动识别手部另需 [MediaPipe 手掌检测模型](https://github.com/opencv/opencv_zoo/tree/main/models/palm_detection_mediapipe) 的 `palm_detection_mediapipe_2023feb.onnx`，SHA-256 为 `78ff51c38496b7fc8b8ebdb6cc8c1abb02fa6c38427c6848254cdaba57fcce7c`。画布视频上传需要网关进程能从 PATH 找到 ffprobe。

在项目根目录自行创建 `.env`，填写 `APIMART_API_KEY` 与 `DEEPSEEK_API_KEY`。这两个值仅由服务端读取，不要写入浏览器配置或使用 `VITE_` 前缀。

初始化管理员：

```powershell
& runtime/venv-gateway/Scripts/python.exe -m gateway.server --bootstrap-admin
```

命令从标准输入读取一行初始密码（6–256字符），没有固定默认密码；交互式终端输入时可能回显，请在私有终端操作。用户名为 `admin`。已存在的管理员不会被覆盖，数据库只保存加盐密码哈希和会话令牌哈希。

## 6. 启动

本机当前南斗专用 ComfyUI 使用 `127.0.0.1:8189`，SwarmUI 后端已指向该地址，`scripts/Start-Studio.ps1` 的 `ComfyPort` 默认同为 8189。8188 属于独立的 Minimax-H3 项目，不停止或复用该进程。下文 8188 为通用部署示例，新部署应按实际端口同步配置。

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


## Agent 长上下文与视觉预算

以下为可选服务端 `.env` 配置，重启网关生效；不向浏览器暴露密钥。非法值会拒绝启动并仅报告配置项名称。

| 配置项 | 默认 | 允许范围 / 含义 |
| --- | --- | --- |
| `STUDIO_AGENT_MAX_CALLS` | 10 | 1–20；每条消息的常规模型调用预算。用尽后有文件最多再调用两次（仅收尾工具、文字交付），无文件最多一次文字交付；摘要另计 |
| `STUDIO_AGENT_OUTPUT_TOKENS` | 32768 | 1024–393216；单次模型输出预算，包含思考消耗，不是目标回复长度 |
| `STUDIO_AGENT_SUMMARY_TOKENS` | 5000 | 1024–16384；摘要输出预算，关闭思考 |
| `STUDIO_AGENT_CONTEXT_BUDGET` | 262144 | 32768–1048576；应用预算，需大于输出预算 + 8192 |
| `STUDIO_AGENT_TIMEOUT_SECONDS` | 300 | 30–1800；单次模型总超时，连接 15 秒、流空闲 90 秒 |
| `STUDIO_AGENT_REASONING_EFFORT` | high | low / high；主循环开启思考，不保存内部推理 |

官方 Flash 当前上下文为 1M、最大输出 384K。应用默认保留余量，而非每次要求输出满额。每次模型调用前，用 UTF-8 文本字节保守估计、每图预留 1280 单位，并加上工具 schema 和输出预算；这是安全预算，不是供应商精确 tokenizer。最终真实用量以响应 usage 为准。超预算明确停止，不静默截断输入或重发付费任务。

视觉输入使用最长边 1280 的 JPEG 预览、high 细节参数；同图去重，最多保留最近 24 个不同预览，旧素材仍在账户内，按需使用 inspect_images。每轮最多 8 张上传/引用，生成最多 4 张。新上传文件完整保存；仅发送给生图服务的参考副本缩为最长边 2048，模型理解使用独立预览，两者都不覆盖原图。请求体限制为 40 MiB，低于供应商的 48 MiB。官方图像 token 按尺寸计算，每图上限 1024，不能把 base64 字节数当作文本 token。

超过 40 条公开事件或 24,000 字符时整理较早对话，保留至少最近 4 个完整轮次与 12 条事件。摘要分批输入，不删除原记录；所有批次成功后才推进摘要游标。达到输出长度上限、缺失流结束标志或工具 JSON 不完整时，不执行本次工具指令，也不自动续写/重试付费动作。

参考：[模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[Chat Completion 参数](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)、[图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision)。核对日期：2026-10-16。

## 修图 Agent 与 PhotoCraft MCP

网关自行启动 PhotoCraft CLI 的 stdio MCP 连接，不复用 Codex MCP 会话。配置保存在不入库的 `runtime/photocraft.json`：

```json
{
  "executable": "C:/path/to/photocraft-cli.exe",
  "bridge": "127.0.0.1:17821",
  "token_file": "E:/qwen-image-2.1/runtime/photocraft-private/control.token",
  "timeout": 120
}
```

`executable` 也可用 `NANDOU_PHOTOCRAFT_CLI` 环境变量指定。没有桥接配置时仍支持无界面 MCP；没有 CLI 时仍支持 Python 工具。配置变更后重启网关。`GET /studio-agent/editing/status` 在登录后返回 Python、MCP 和桌面连接的实际探测状态，不返回本机路径或凭据。

启动专用桌面实例前先创建 `runtime/agent-edits`，确认端口空闲，给 `runtime/photocraft-private` 设置仅运行账号可访问的 ACL。使用 PhotoCraft 的 `--control`、`--control-token-file`、`--automation-read-root`、`--automation-write-root` 参数，读写根均指向 `runtime/agent-edits`；token 由 PhotoCraft 写入受限文件，不传明文命令行、不输出日志。不要复用用户正在编辑的客户端。

### 本机自启配置（2026-10-17）

本机已注册以下 Windows 计划任务。配置绑定本机路径与运行账号，不作为其他电脑的通用安装包；运维脚本、任务 XML、状态和日志仅放在不入库的 `runtime/autostart`。

| 任务 | 触发与身份 | 负责范围 |
| --- | --- | --- |
| `NandouStudio-Gateway` | 开机延迟 20 秒；当前账号的 S4U 批处理登录，无需保存密码 | `0.0.0.0:7801` 账号网关 |
| `NandouStudio-ComfyUI` | 开机延迟 10 秒；当前账号的 S4U 批处理登录 | `127.0.0.1:8189` 南斗专用 cu130 推理服务 |
| `NandouStudio-SwarmUI` | 开机延迟 20 秒；当前账号的 S4U 批处理登录 | `127.0.0.1:7802` 图像调度，后端固定指向南斗 8189 |
| `NandouStudio-PhotoCraft` | 当前 Windows 账号登录后延迟 15 秒；交互式会话 | `127.0.0.1:17821` 专用桌面桥接 |

四项任务另有每分钟一次的检查触发器，禁止任务重叠；已经运行的正确进程直接复用，退出后再启动。启动器同时核对可执行文件、完整参数与监听地址；发现其他程序占用端口时只记录 `port_conflict`，不会停止进程或抢占端口。仍存活但未通过健康检查的进程只报告异常，不自动强杀正在执行的任务。检查失败由计划任务重试，单次执行最长 2 分钟；允许电池供电，不因切换电源停止服务。

计划任务以没有控制台的 `pythonw.exe` 为入口，通过 `CREATE_NO_WINDOW` 启动 PowerShell 检查器；检查器的 Python 探针同样设置 `CreateNoWindow`，避免每分钟检查时弹出控制台。仅使用 `-WindowStyle Hidden` 不能替代无控制台创建。启动器使用进程范围的 `RemoteSigned`，不修改系统执行策略。桥接探针通过带鉴权的 MCP `ui_inspect` 验证连接，不读取或打印 token 内容。`Gateway.status.json` / `PhotoCraft.status.json` 保存最近状态，`*.events.jsonl` 仅记录状态变化，日志轮换限制为 1 MiB 加一个上一份文件。

PhotoCraft 客户端依赖桌面会话：**重启后需要登录配置的 Windows 账号，客户端桥接才会恢复**。网关、SwarmUI 和南斗 ComfyUI 在 Session 0 运行，不依赖桌面登录；两项新增服务已验证计划任务冷启动与 API 健康，尚未执行整机重启验收。此配置不启用 Windows 自动登录；Minimax-H3 的 8188、Vite 和用户手动打开的 PhotoCraft 不受这些任务管理。无界面 Python / PhotoCraft MCP 修图不依赖该桌面桥接。

检查与暂停自启（暂停任务不停止已经运行的服务）：

```powershell
Get-ScheduledTask -TaskName NandouStudio-Gateway,NandouStudio-PhotoCraft,NandouStudio-SwarmUI,NandouStudio-ComfyUI
Get-ScheduledTaskInfo -TaskName NandouStudio-Gateway
Get-ScheduledTaskInfo -TaskName NandouStudio-PhotoCraft
Get-Content runtime/autostart/Gateway.status.json,runtime/autostart/PhotoCraft.status.json
Disable-ScheduledTask -TaskName NandouStudio-Gateway
Disable-ScheduledTask -TaskName NandouStudio-PhotoCraft
```

需要恢复时对对应任务运行 `Enable-ScheduledTask`，再执行 `Start-ScheduledTask`。维护期间若要手动停止服务，应先暂停对应任务，避免一分钟后被重新拉起。

本机验收已实际停止空闲的网关和专用桥接，由定时任务重新拉起并通过探针；随后在与网关相同的 S4U 身份、Session 0 下通过两项真实 PhotoCraft 测试（无界面 MCP、桌面桥接，含图片落盘及 PSD 重开）。对话模型和临时账号上游为测试替身，没有调用付费模型。未执行整机重启；开机与登录触发器已回读确认，整机重启后的首次登录仍属于待实机回验范围。

无界面会话以单个任务目录为读写根，桌面会话通过命令白名单、素材归属校验及私有 token 目录下的跨进程锁串行执行。PhotoCraft 0.8.2 桌面桥接的 `doc_close` 不可用，网关通过 `control_call` 的 `engine.execute / file.close` 关闭自己保存的任务文档。

修图原始文件位于 `runtime/agent-uploads`，工作副本、逐步检查点、PNG/JPG/WebP 和 `.pcraft` 工程位于 `runtime/agent-edits/<user>/<chat>/<job>`，均不入库。内存任务取消会停止后续操作，重启不会重放写命令；结果不明时使用“核对任务”，先检查已有输出和后台任务状态。若客户端不可用，先恢复原专用实例或检查工作目录，不能重发未知操作。

本地验收应分别报告：模拟模型编排、真实 MCP 命令处理、桌面处理、图片落盘与工程重开、浏览器下载和双账号隔离。模拟模型加真实 PhotoCraft 验收不代表真实对话供应商已完成端到端验收；不为测试擅自发起付费生图。
