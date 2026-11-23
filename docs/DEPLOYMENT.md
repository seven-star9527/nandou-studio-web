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


主图自动识别使用本地 CLIP 图像编码器与类目描述向量，未识别的商品使用通用精修。将 [CLIP ONNX 固定版本](https://huggingface.co/Xenova/clip-vit-base-patch32/tree/6b7c523703ae26e39be4b03774966f8571c7f523) 的 `onnx/vision_model_quantized.onnx`、`onnx/text_model_quantized.onnx`、`tokenizer.json` 以文件名放在 `models/product-recognition/`。用装有 onnxruntime、numpy、Pillow、tokenizers 的准备环境执行 `python -m gateway.product_recognition models/product-recognition` 生成 `subjects.npz`；运行服务只读视觉模型和生成好的向量。视觉模型 SHA-256 为 `583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299`。手选类目跳过识别。

Windows 高清工具使用 [Real-ESRGAN 官方 Windows 包](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0) 中的 `realesrgan-ncnn-vulkan-20220424-windows.zip`，SHA-256 为 `abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d`。可执行文件和随附 DLL 放在 `models/upscale_models/realesrgan/`，摄影模型 `realesrgan-x4plus.param` 与 `.bin` 放在它的 `models/` 子目录。Vulkan 显卡执行重叠分块推理，结果按指定倍率输出，透明覆盖由原图提供。未安装该包时，细节增强使用网关锁定的 OpenCV contrib 包。将 [FSRCNN 的两份模型](https://github.com/Saafke/FSRCNN_Tensorflow/tree/6a4812c4ef1c4f5947d79beafa32a05a6eb4a94d/models) 放入网关根目录的 `models/upscale_models/`。文件 `FSRCNN_x2.pb` 的 SHA-256 为 `366b33f0084c7b3f2bf6724f0a2c77bca94fcec9d7b6d72389d330073b380d5c`，`FSRCNN_x4.pb` 为 `5c68d18db561aed8ead4ffedf1b897ea615baaf60ebf6c35f8e641f8fa4a21bf`。保真放大使用 Pillow。

快捷抠图与主图精修的纯白背景使用本机 BiRefNet。将 [BiRefNet General Lite ONNX 权重](https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx) 放到网关根目录的 `models/birefnet-general-lite.onnx`，核对 MD5 为 `4fab47adc4ff364be1713e97b7e66334`。模型只在第一次处理时加载。点选主体还需要将 [MobileSAM ONNX](https://huggingface.co/Acly/MobileSAM/tree/0d3b403339b4674a82493d5e97964dd78089ddc8) 的 `mobile_sam_image_encoder.onnx` 和 `sam_mask_decoder_multi.onnx` 放在同一目录。两者的 SHA-256 分别为 `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` 和 `8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe`。修图 Agent 自动识别手部另需 [MediaPipe 手掌检测模型](https://github.com/opencv/opencv_zoo/tree/main/models/palm_detection_mediapipe) 的 `palm_detection_mediapipe_2023feb.onnx`，SHA-256 为 `78ff51c38496b7fc8b8ebdb6cc8c1abb02fa6c38427c6848254cdaba57fcce7c`。画布视频上传需要网关进程能从 PATH 找到 ffprobe。

在项目根目录自行创建 `.env`，填写 `APIMART_API_KEY` 与 `DEEPSEEK_API_KEY`。GPT 图片生成与参考图编辑支持在同一文件设置 `OPENAI_API_KEYS`，多个 Key 以英文逗号分隔，单个 Key 也可使用 `OPENAI_API_KEY`。保存后新任务生效。任务轮流选择起始 Key，只有明确的余额或支出额度耗尽才换下一个，全部耗尽才调用 APIMart。额度已耗尽的 Key 暂停 5 分钟，之后可重新参与轮询。未配置官方 Key 时沿用 APIMart，参考图编辑输出 SVG 也保留 APIMart。官方成功任务按相同参数显示参考积分，实际 Studio 积分记为零，OpenAI API 费用由对应账户结算。以上配置仅由服务端读取，不要写入浏览器配置或使用 `VITE_` 前缀。

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

公网入口使用 `https://nandouai.cn/studio/`。在 Coolify 入口服务器为 Studio 新增独立动态配置，原样转发 `/studio`、`/studio/`、`/studio-auth/`、`/studio-agent/`、`/studio-references/`、`/studio-results/`、`/API/`、`/View/`、`/Output/` 到 7801。不要代理 `/health` 或直接发布 SwarmUI / ComfyUI。网关启动时使用 `--trusted-proxy <实际来源IPv4>`；只有 TCP 对端与该地址一致，且原始 Host、转发 Host 和 HTTPS 协议匹配时，才接受代理信息。Traefik 应向网关追加其实际对端到 `X-Forwarded-For`。公网登录仅限已有普通账号，注册和邮箱直接重置在网关拒绝，管理员仍仅可本机登录。公网路由撤销时只撤销 Studio 独立配置，并复查官网和局域网入口。

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

### AI 精修文字保护（2026-11-16 已上线）

发布前必须通过原片与交付图的文字、标志局部对齐验收。低对比浮雕补充增强检测；重复颜料槽、表格格子先剔除位置不符合原构图的特征匹配，避免错配到相邻单元。整图位置一致但局部特征不足时，使用梯度轮廓做双向局部配准，并检查变形幅度、相关度与往返一致性。往返误差仅是算法自洽检查，不能替代可见错位、漏字、重影和贴片色差的人工验收。检测到的范围外保持生成结果不变。

原尺寸交付在模型精修、去纹和局部平滑之后，从原片定位印刷区域，对齐并保留原片字形，只匹配区域的宽缓光照，不用 OCR 识别结果重新排字。依赖现有 OpenCV 与 ONNX Runtime，无需新增 Python 包。将 [RapidOCR 1.4.4 发布包](https://pypi.org/project/rapidocr-onnxruntime/1.4.4/) 中的 `rapidocr_onnxruntime/models/ch_PP-OCRv4_det_infer.onnx` 放到 `models/text-preservation/`，SHA-256 为 `d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9`；模型来自 RapidAI 转换的 PaddleOCR PP-OCRv4，遵循上游 Apache-2.0 许可证。模型不入库。

字形取自本人任务保存的原图，模型原稿保持不变。没有检测到文字时不贴回；检测到文字但配准证据不足或构图变化过大时，停止最终交付并提示文字无法可靠对齐，保留模型稿，不自动重新付费生成。文字检测可能遗漏极小或特殊字形，不能把检测成功当作全图逐字校对通过。部署时同时更新 `gateway/text_preservation.py`、`gateway/ai_retouch.py` 与错误提示所在的 `gateway/server.py`。

### 颜料精修去纹与文字融合优化（2026-11-17）

本轮用户已验收暖色颜料套装、绿盒颜料两张 6336 × 6336 成片并授权上线。精修链路保持 GPT Image 2.6 Sunburst / high / 4K → Gemini 内部去纹重建 → 原尺寸处理 → 文字保护 → PNG。Gemini 仍不在普通用户模型列表开放，内部去纹权限与用户选模权限分开校验。

本次效果主要来自生成后的局部算法修复，没有增加生图调用，也没有用设计师图片覆盖商品细节。设计师稿用于视觉验收和调色方向；新增调色指令尚未经过新的付费生图验证。

| 问题 | 原因与实现 |
| --- | --- |
| 包装彩点、文字周围出现保护图层色块 | OCR 检测可能把装饰彩点判作文字。旧方法直接贴回原片并把光照补偿限制在 ±24，原图与精修图明暗差较大时留下矩形色差。本次改为局部梯度域融合：保留已配准的原图字形梯度，由目标图边界求解区域光照；区域外像素保持不变。对 OpenCV 传入掩模副本，避免其内部修改掩模后误用。该修复消除贴片接缝，不声称 OCR 已能完全区分文字和彩点。 |
| 浮雕品牌末尾 I 漏失 | 低对比检测范围不足。在小面积、长条文字区域沿文字方向补充约一个字符的上下文；大块标志不向周围盒面扩张。字形仍来自原图，不依靠模型猜字或 OCR 识别后重排。 |
| 浅粉、浅蓝与红色色块残留细纹 | 降低浅色颜料的处理门槛，把平坦区域平滑尺度从 sigma 3 增至 9，并扩大分块重叠区避免接缝。另定位白槽框包围的紧凑长方形色块，仅对内缩后的低对比平面拟合宽缓二次色面，修正幅度限制在每通道 ±8；高对比槽壁反光、色块边界和文字不参与均匀化。 |
| 色调偏亮、偏艳 | 颜料材质提示增加自然克制调色、中性白槽框、避免整体泛紫、粉紫荧光和蓝绿过饱和的要求；保留色相身份、色块顺序，用户明确风格优先。不把设计师稿变成每次任务的必需输入。 |

配准仍使用整体特征匹配和必要时的双向局部检查，没有降低原有拒绝阈值。无法可靠对齐时停止最终交付，保留模型原稿，不自动重新付费生成。文字保护在平滑后执行，保持透明度；最终 PNG 按原图尺寸保存。原尺寸插值恢复不等于模型凭空获得原片全部细节。

验收：19 项相关自动测试通过；四份既有生成稿重处理成功，两张当前问题图经用户视觉确认；另一份原有错位样本仍被正确拒绝。覆盖文字替换、区域外像素、透明度、强光照差接缝、末尾覆盖、浅色色带、高光与白槽框保护。上线只替换 `gateway/ai_retouch.py` 与 `gateway/text_preservation.py`，本轮不修改前端、不增加付费调用。

本地交付在 `runtime/retouch-deliveries/20261117/`，包含各自原图、已验收精修 PNG、设计师稿。发布前后文件哈希、回滚副本、部署回验与清理清单在 `runtime/maintenance/retouch-quality-20261117/`。这些本地素材与运维文件不入库。历史生成任务不批量覆盖；新精修任务使用更新后的处理链路。后续验收仍需抽查真实文字、反光和色面，不能把有限样本通过写成所有商品永久无纹或逐字识别保证。

上线回验：空闲检查确认没有运行中的生成、Agent、精修与快捷修图任务后，更新两个部署副本并重启所属网关进程。源码与部署副本 SHA-256 一致；网关健康检查和公网 `/studio/` 返回正常，精修报价接口返回 200，普通用户模型列表仍隐藏 Gemini。独立调用部署目录中的完整交付函数，重跑两张已验收素材，输出与验收稿逐像素一致；没有覆盖原任务或发起付费生图。

测试目录清理：移除 3,565 个临时文件，共 10,298,138,387 字节（约 9.59 GiB）；其中 1,144 个较小的记录及脚本、共约 125 MiB 已在本机归档。保留产品原图、有效回归代码、3 处目录链接及被引用的资源，不遍历链接外的前端依赖。交付图已迁出 `tests`。清理后重新运行上述 19 项测试，全部通过。

### 精修新任务文字对齐失败修复（2026-11-17）

新的绿盒精修任务暴露了此前验收缺口：已验收图片重处理成功不能证明新模型输出均能交付。该任务的普通灰度 SIFT 只有 19 个内点，未达到 20 个的整体配准门槛，未进入实际可以通过的局部配准。前端又把失败时保留的 GPT 原稿放入“精修图”滑动对照并提供加入画布操作，造成交付成功的误导。

修复只在普通整体匹配失败后，以 CLAHE 对比度归一化重新提取特征；不改变匹配比例、至少 20 个内点、位移、方向与形变门槛。增强匹配恢复的结果必须逐区通过原有双向局部检查，不能直接用整体变换交付。本次失败稿恢复为 27 个内点；两处浮雕局部相关度约 0.82 / 0.81，往返误差约 0.41 / 0.13 个预览像素。字形依旧从上传原片取回，模型原稿不修改。

失败任务只展示“模型原稿（未完成精修）”，不开放成品下载或加入对比画布；错误在预览上方展示，重新生成明确标注付费。完成任务保留默认滑动对照。隔离 Chrome 验证失败、刷新、完成、键盘滑动；类型检查与构建通过。当前失败样本与改变构图反例新增两项回归通过，原九项文字测试通过，原有错位实图仍拒绝。暖色已验收图逐像素一致；绿盒重跑有极小融合数值差异（全图平均绝对误差约 0.000041，最大 3 个色阶，仅文字区），不能宣称逐像素一致。

发布与这笔任务的本地恢复记录在 `runtime/maintenance/retouch-alignment-20261117/`。复用已经付费的 GPT / Gemini 产物，不重新提交上游任务、不改费用；验证范围为本次真实失败任务的恢复和上述回归，未发起新的随机付费生图。

上线回验：网关空闲时替换文字配准部署副本并重启，SwarmUI 未重启。公网页面及 JS 返回 200，JS 哈希与本次构建一致。使用部署代码重处理本次失败任务，输出与检查稿逐像素一致；恢复同一任务的成品及归属，费用不变。正式网关的任务查询、PNG 下载哈希及 Chrome 桌面视口中的滑动对照、报价、下载与画布入口已验证；临时验收登录会话随后撤销。

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


## 南斗工作台免登录

在目标组织的 Hosted Web App 清单注册应用 `nandou-studio`，入口为 `https://nandouai.cn/studio/`，允许来源为 `https://nandouai.cn`，登录方式为 `launch_ticket`。先停用登记项，在网页账号网关的服务环境中配置下列两项，再验收并启用入口。

- `NANDOU_ORG_ID` 为登记应用的组织 UUID。
- `NANDOU_HOSTED_APP_SECRET` 为登记时南斗服务端一次性返回的 `data.sso_client_secret`。仅配置在该组织使用的 Studio 网页网关中。不要写入前端配置。

从工作台点“打开”后，网页向同源 `/studio-auth/nandou-sso` 提交短时票据，网关向南斗核销。每个组织成员以独立的普通 Studio 身份使用，成员改名后仍可访问自己的历史。同名或同邮箱的原网页登录账号保留独立作品。直接通过网址访问继续使用原网页登录流程。草稿在当前设备上按账号保存。
