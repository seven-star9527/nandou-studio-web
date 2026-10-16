# Nandou Studio

面向电商视觉创作的局域网图像工作室。将本地 Qwen、云端图像模型、商品提示词和对话式 Agent 放在同一个网页中，适用于艺术用品、儿童玩具的商品主副图、A+、场景图与独立站素材。

仓库包含网页、账号网关和模型服务集成源码。模型权重、第三方推理引擎、密钥、账号数据库、用户作品、测试与运维脚本不随仓库发布。

## 功能

### 图片创作

- 文生图与参考图编辑，按模型选择比例、分辨率、质量和张数。
- 参考图堆叠、悬停预览、放大查看；图片创作与 Agent 分别保留文字和图片草稿。
- 展示 APIMart 剩余可用积分、任务预估积分和最终实际消耗。
- 38 个提示词模板，覆盖商品摄影、材质细节、Amazon 主副图、A+、独立站横幅等场景。
- AI 润色先预览、再手动应用；默认保持商品全新、干净、完整，不擅自添加磨损或做旧。
- 首页公共样张支持查看与复用提示词，内置模型选择指南。

### Agent 创作

- 根据需求理解、询问、制定计划、加载技能、生成图片、检查结果，再根据用户反馈继续修改。
- 需求明确时直接生成，信息不足时询问。采用 LangGraph 工具循环，支持流式回复和执行状态。
- 默认出图为 **GPT Image 2.5 Flare / medium / 1K**。智能比例不会自动升级画质或分辨率。
- 使用 DeepSeek，开启 `thinking` 和 `high` 推理强度；页面展示方案与执行状态，不展示内部推理原文。
- 默认每次提交最多 10 次模型调用、4 张图片，单账号最多一个活动轮次；不是聊天轮数上限。
- 长对话自动整理摘要，保留原始记录；跨对话偏好由用户手动保存、修改或清空。

### 多用户与任务

- 邮箱注册、密码登录，任务、原图、对话和长期偏好按账号隔离。
- 删除任务记录仅对本人隐藏，管理员仍可查看作品、费用和使用情况。
- 管理员只能从部署电脑的 `localhost` / `127.0.0.1` 入口登录，初始密码部署时设置，不内置在源码中。
- 本地 GPU 任务按顺序排队，显示位置、已等待时长与基于历史样本的预计等待时间；样本不足时显示未知。
- 生成请求使用幂等编号，网络异常不会自动重复提交付费生图。

## 模型选择

| 模型 | 运行方式 | 常用场景 |
| --- | --- | --- |
| Qwen-Image-2.1 标准 | 本地，40 步 | 本地生成与参考图编辑、细节对照 |
| Qwen-Image-2.1 Turbo | 本地，专用 8 步序列 | 快速尝试构图与迭代 |
| Nano Banana 2.1 | APIMart | 生成、编辑与不同视觉风格尝试 |
| GPT Image 2.5 Flare | APIMart | 默认云端生图，商品图与创意构图 |
| GPT Image 2.5 Sunburst | APIMart | 以商品参考图为基础进行编辑 |

两个 GPT 模型的质量默认 `medium`，禁用 `max`；更高质量须手动选择。Agent 当前使用三款云端模型，本地 Qwen 在「图片创作」使用。模型名称、规格和费用以接入服务能力表为准，不将不同版本的公开评分互相套用。

本地界面提供 1K / 1.5K / 2K；当前共享显卡部署未开放本地 4K 选项。云端规格随模型变化。分辨率、提示词、参考图、模型加载和其他 GPU 负载都会影响耗时，历史样例不是性能保证。

## 技术结构

```text
浏览器 / 局域网用户
         │ :7801
Python 账号网关 ── DeepSeek（Agent）
         │ 127.0.0.1:7802
SwarmUI + Nandou 扩展 ── APIMart / DeepSeek（润色）
         │ 127.0.0.1:8188
ComfyUI + Qwen 本地权重
```

- 前端：React 19、TypeScript、Vite、Three.js。
- 网关：Python 3.12、aiohttp、SQLite、LangGraph。
- 图像服务：SwarmUI、ComfyUI，以及项目自有的云接口、积分与提示词扩展。

```text
frontend/                   网页源码、依赖锁文件和公共素材
gateway/                    登录、账号隔离、任务队列、Agent 与记忆
integrations/swarm/         SwarmUI 增量补丁和项目自有服务代码
integrations/comfy/         Qwen Turbo 采样调度集成
docs/DEPLOYMENT.md           依赖、手动安装和启动步骤
AGENTS.md                   开发、验证与提交约定
```

## 部署与配置

当前参考环境为 Windows、Python 3.12、.NET 8、Node.js 和 pnpm。本地推理还需要兼容的 NVIDIA/CUDA 环境；已使用 RTX 5060 Ti 16GB 进行本机验证，显存需求取决于规格与其他程序占用。

**完整步骤见 [部署说明](docs/DEPLOYMENT.md)。** 需要单独准备 SwarmUI、ComfyUI、模型权重，并应用仓库中的集成代码；仅安装前端依赖不能完成模型服务部署。

在仓库根目录自行创建 `.env`，仅服务端读取：

```dotenv
APIMART_API_KEY=填写你的APIMart密钥
DEEPSEEK_API_KEY=填写你的DeepSeek密钥
```

不使用 `VITE_` 前缀保存密钥。缺少相应密钥时，对应云服务不可用。DeepSeek 与 APIMart 分别计费，界面 APIMart 积分不包含 DeepSeek 用量。

前端构建：

```powershell
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend build
```

部署后本机访问 `http://localhost:7801/studio/`，局域网访问 `http://<部署电脑的局域网IP>:7801/studio/`。SwarmUI 和 ComfyUI 只绑定回环地址，用户通过账号网关访问。

## 数据与适用边界

- 服务端账本默认位于 `runtime/studio-accounts.sqlite3`。部署前后应备份数据库与私有作品。
- 草稿保存于当前浏览器、当前站点地址的 IndexedDB，并按账号区分；清除站点数据会清除草稿，不自动跨设备同步。
- 长期偏好保存在服务端，只有点击保存才会成为跨对话偏好。摘要仍可能遗漏细节，关键商品约束应再次明确。
- 当前忘记密码采用内部过渡方案：普通用户凭邮箱设置新密码，**不验证邮箱所有权**；管理员不走此接口。因此当前版本只适用于受信任的内部局域网，不能直接作为公网账号系统。
- `frontend/public` 中的样张、模板、指南及登录背景是公共素材；私人商品图和用户生成作品不得放入此目录。
- 模型检查不能保证每张图的数量、几何、文字或商品真实性。正式上架前应人工核对，避免虚构材质、认证、适龄和卖点。

## 开发与验证

开发约定见 [AGENTS.md](AGENTS.md)。仓库按维护者要求不发布测试文件、评测产物和运维脚本；本地工作目录可保留这些文件。不要将构建成功视为真实生图或账号隔离验收完成。

当前本地版本已完成 37 项网关检查、55 项前端检查，以及真实生成/编辑、浏览器交互、账号隔离、队列和草稿恢复验证。测试材料未随此次源码发布；新环境仍须验证登录、两个普通账号的资源隔离、上传预览、任务状态与实际生成。

## 来源与说明

- 推理服务：[SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI)、[ComfyUI](https://github.com/Comfy-Org/ComfyUI)。上游参考提交记录在部署文档，第三方引擎未整体打包。
- 本地模型：[Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1)。使用权重时应单独阅读模型许可；平台代码不授予权重的商业使用权。
- 提示词方法：[OpenAI imagegen](https://github.com/openai/skills/tree/main/skills/.system/imagegen)、[Awesome GPT Image 2](https://github.com/freestylefly/awesome-gpt-image-2)、[Awesome Nano Banana Images](https://github.com/PicoTrex/Awesome-Nano-Banana-images)。模板来源保留在提示词库内。
- 登录背景见 [图片来源清单](frontend/public/auth-gallery/credits.json)；官方评分图来源保留在模型指南中。
- 本仓库未另行添加开源许可；第三方代码、模型、素材各自遵循其原始许可和使用条件。

## 使用指南

站内 [Agent 使用指南](frontend/public/agent-guide.html) 面向创作者介绍参考图、技能、生成偏好和连续修改；访问 `/studio/agent-guide.html` 查看。部署与配置仍见 [部署说明](docs/DEPLOYMENT.md)。
