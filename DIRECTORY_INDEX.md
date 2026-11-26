# 司命 · 文游 Pro（Wenyou Pro）全仓目录索引

> 目标版本：**`v0.2.5`**｜公开仓库：`https://github.com/anyu0804/wenyou-pro`｜整理与维护：**安钰**（基于 [`Jaxton07/percho`](https://github.com/Jaxton07/percho) MIT 开源底座深度定制）
>
> 本文件提供全仓库的权威目录映射、四大核心工程包源码索引、发布与云端防锁死工具链清单，以及文游世界存档（Vault）的标准目录与权限门禁。如需按研发专题与底座子系统深入定位，请配合阅读 [docs/INDEX.md](docs/INDEX.md) 与 [ACCEPTANCE.md](ACCEPTANCE.md)。

---

## 1. 顶层架构与目录总览

### 1.1 入库根目录文件与目录

| 路径 | 类型 | 职责说明 |
| --- | --- | --- |
| [DIRECTORY_INDEX.md](DIRECTORY_INDEX.md) | 文档 | 本文件：全仓目录总览、源码级模块索引、工具链与 Vault 结构权威参考 |
| [README.zh.md](README.zh.md) / [README.md](README.md) | 文档 | 司命 · 文游 Pro（Wenyou Pro）中英双语项目主页、功能介绍、分发产物与上手指南 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 文档 | 协议白名单、视角强钳制、沙盘防串档、地图契约与跨平台真机验收标准 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 文档 | 贡献流程、代码规范、防开盒与云端防锁死提交流程及发版指南 |
| [SECURITY.md](SECURITY.md) | 文档 | 安全漏洞私密披露渠道、密钥/存档隔离边界与安全门禁范围说明 |
| [GLOSSARY.md](GLOSSARY.md) | 文档 | 底座会话管理领域术语表（归档、工作区移除、内存卸载） |
| [LICENSE](LICENSE) | 许可 | MIT 开源许可证（保留上游 `Jaxton07` 原始版权声明） |
| [package.json](package.json) / [package-lock.json](package-lock.json) | 配置 | npm workspaces 根配置与锁文件，定义开发、测试、防开盒、防锁死与打包脚本 |
| [tsconfig.base.json](tsconfig.base.json) / [biome.json](biome.json) | 配置 | TypeScript 公共编译基线与 Biome 格式化/静态检查规则（Tab 缩进、双引号、110 列宽） |
| [.gitignore](.gitignore) / [.gitattributes](.gitattributes) | 配置 | 本地隐私/产物忽略边界与行尾规范 |
| [packages/](packages) | 工程包 | 四大核心工程包：`shared`、`backend`、`desktop`、`pixi-sandbox` |
| [scripts/](scripts) | 工具链 | 文游发布与门禁脚本（`scripts/wenyou-release/`）、上游发版/性能/CDP 验收脚本 |
| [fixtures/](fixtures) | 夹具 | 脱敏演示战役（`demo-campaign/`）与契约黄金回归夹具（`golden-vault/`） |
| [docs/](docs) | 文档 | 文游架构方案、调研文档、底座源码改造地图与开发专题导航（入口见 [docs/INDEX.md](docs/INDEX.md)） |
| [.github/](.github) | CI/治理 | GitHub Actions 轻量 CI、跨平台发版流水线、`CODEOWNERS` 与 Issue/PR 模板 |
| [patches/](patches) | 补丁 | `patch-package` 维护的上游 `@earendil-works/*` 与 `thinking-orbs` 补丁 |

### 1.2 本地非入库目录边界（`.gitignore` 强隔离）

以下目录仅存在于开发者或用户本机工作区，**严禁纳入 Git 追踪或随源码公开**：

| 本地路径 | 隔离用途与边界说明 |
| --- | --- |
| `dist/`、`dist-electron/`、`out/` | Electron 编译输出与跨平台打包产物（安装包、便携压缩包、DMG、AppImage、`SHA256SUMS.txt`） |
| `.local/` | 本机私有运行态资料：设计稿（`design/`）、临时工单/草稿（`agent-work/`）、备份与本地快捷方式副本 |
| `worlds/` | 用户本机真实文游世界存档库（默认用户目录为 `~/.wenyou-pro/worlds/`；仓库内如有 `worlds/` 测试库亦完全忽略） |
| `_legacy_stage0_backup/`、`.percho-clone-staging/` | 历史 Stage 0 原工程归档与上游底座离线参考备份 |
| `packages/desktop/resources/pixi-sandbox/` | 内置 Pixi 沙盘编译静态产物（由 `npm --prefix packages/pixi-sandbox run build:desktop` 生成，CI 与打包前实时构建） |
| `packages/desktop/resources/ntqq-vfs/python/`、`__pycache__/` | Windows 打包阶段按需下载的嵌入式 Python 3.13 运行时与字节码缓存 |
| `packages/pixi-sandbox/dist/`、`packages/pixi-sandbox/work-packages/` | 沙盘独立开发构建输出与本地工单样例目录 |
| `node_modules/`、`.tmp/`、`.tmp-build/`、`.scratch/`、`.env` / `.env.local` | 第三方依赖、临时构建/测试证据与本机环境变量 |

---

## 2. 四大核心工程包模块与源码级索引

```text
packages/
├── shared/        # @percho/shared —— 跨进程纯类型、IPC 单源契约与 Transcript 纯函数（零 Node/Electron/React 依赖）
├── backend/       # @percho/backend —— 唯一引入 Pi SDK 的后端内核与文游领域服务（Vault / 门禁 / 国策 / 地图 / NTQQ）
├── desktop/       # @percho/desktop —— Electron 主进程、特权协议、React 19 文游工作台与随包资源
└── pixi-sandbox/  # wenyou-pixi-app —— 独立构建并离线内嵌的 Pixi.js 8 动态战略/战役/野战沙盘
```

### 2.1 `packages/shared/`（跨进程共享契约）

| 路径 | 职责说明 |
| --- | --- |
| [packages/shared/src/ipc-channels.ts](packages/shared/src/ipc-channels.ts) | 单源 IPC invoke 通道契约表（D5）：统一定义所有方法名、通道串、入参校验规则与返回类型 |
| [packages/shared/src/ipc.ts](packages/shared/src/ipc.ts) | 聚合导出 `PiApi`、`EnvironmentHandlers` 与主进程→渲染进程单向事件接口 |
| [packages/shared/src/wenyou.ts](packages/shared/src/wenyou.ts) | 文游核心跨进程领域类型与纯解析工具：`WENYOU_STANDARD_DIRS`、`ViewerScope`、`clampViewerScope`、`DiffPatchProposal`、`SituationBriefing`、`PolicyArtifact`、`PolicyLintReport`、`MapInspectResult`、`NtqqStatusSnapshot`、`WenyouCanvasEvent` 等 |
| [packages/shared/src/transcript/](packages/shared/src/transcript) | Transcript 纯函数状态机与轮次派生：`reducer.ts`、`chat-rows.ts`、`mapping.ts`、`turn-files.ts`、`turn-timings.ts`、`llm-errors.ts`、`parse-patch.ts`、`meta-summary.ts` |
| [packages/shared/src/model-visibility.ts](packages/shared/src/model-visibility.ts) | 模型可见性过滤、Provider 列表归一化与模型展示策略 |
| [packages/shared/src/settings.ts](packages/shared/src/settings.ts) / [packages/shared/src/session.ts](packages/shared/src/session.ts) | 设置项、会话元数据、历史分页与交互请求类型契约 |
| [packages/shared/src/errors.ts](packages/shared/src/errors.ts) / [packages/shared/src/mcp.ts](packages/shared/src/mcp.ts) / [packages/shared/src/lan.ts](packages/shared/src/lan.ts) / [packages/shared/src/ui-plugins.ts](packages/shared/src/ui-plugins.ts) | 错误分类、MCP 配置与状态、局域网跨设备互联与 UI 插件类型契约 |
| [packages/shared/src/index.ts](packages/shared/src/index.ts) | `@percho/shared` 统一出口 |

### 2.2 `packages/backend/`（Pi SDK 内核与文游领域服务）

#### 核心内核与通用底座

| 路径 | 职责说明 |
| --- | --- |
| [packages/backend/src/pi-backend.ts](packages/backend/src/pi-backend.ts) | **全仓唯一允许导入 `@earendil-works/pi-coding-agent` 的入口**：管理多会话生命周期、扩展绑定、权限门与文游扩展注入 |
| [packages/backend/src/execution-handlers.ts](packages/backend/src/execution-handlers.ts) | 与执行环境解耦的 IPC 处理器映射（本机 Electron 主进程与 SSH 远端独立服务共用同一契约） |
| [packages/backend/src/storage/path-policy.ts](packages/backend/src/storage/path-policy.ts) | 用户级数据目录隔离策略（`~/.wenyou-pro/agent` / `agent-dev` / `agent-beta`）与路径安全校验 |
| [packages/backend/src/permissions/](packages/backend/src/permissions) | 逐工具权限规则引擎、Bash 命令链解析、临时区隔离与权限审计日志（`permission-audit.jsonl`） |
| [packages/backend/src/session/](packages/backend/src/session) | 会话注册表、目录索引、历史分页、流式保护、图片媒体存储维护与归档恢复 |
| [packages/backend/src/tools/](packages/backend/src/tools) | 内置工具集群：子代理（`subagent/`）、多频道协作（`channels/`）、上下文蒸发（`context-evaporation/`）、压缩护栏（`compaction-guard/`）、`show-image.ts`、`todo.ts`、`webfetch/` |
| [packages/backend/src/settings/](packages/backend/src/settings) / [packages/backend/src/mcp/](packages/backend/src/mcp) / [packages/backend/src/runtime/](packages/backend/src/runtime) / [packages/backend/src/lan/](packages/backend/src/lan) | Provider/OAuth 登录、MCP 托管、SSH 远端独立服务运行时与局域网跨设备服务 |

#### `packages/backend/src/wenyou/` 文游领域全家桶（逐文件索引）

| 文件 | 职责说明 |
| --- | --- |
| [packages/backend/src/wenyou/index.ts](packages/backend/src/wenyou/index.ts) | 文游后端模块统一导出入口 |
| [packages/backend/src/wenyou/service.ts](packages/backend/src/wenyou/service.ts) | **Vault 管理与落盘中枢**：战役目录初始化、工作区概览聚合、L1 局势简报与跨群台账发布、国策生成落盘、`DiffPatchProposal` 创建与审批原子落盘（落盘前复验正史目录前缀与父目录 `realpath`）、视角切换（`setViewerScope`）及导出防泄密预检（`exportPreflight`） |
| [packages/backend/src/wenyou/extension.ts](packages/backend/src/wenyou/extension.ts) | **Agent 扩展与物理安全拦截钩子**：注册 9 个 `wenyou_*` 工具（`wenyou_init_campaign`、`wenyou_pull_qq`、`wenyou_lookup_source`、`wenyou_read_memory`、`wenyou_publish_briefing`、`wenyou_write_policy_docx`、`wenyou_open_maps`、`wenyou_inspect_map`、`wenyou_propose_canon`）；通过 `tool_call` 钩子强钳制 `maxViewer` 视角、物理阻断非 GM 读取 `private/` / `.wenyou/` / `00-群聊收集/` / `02-局势简报与台账/`，并阻断 `edit`/`write`/`bash` 直改正史目录、`manifest.json` 与 `03-国策与文书/` |
| [packages/backend/src/wenyou/secret-blocks.ts](packages/backend/src/wenyou/secret-blocks.ts) | **`:::secret[...]` 暗线裁剪与路径护栏**：按 `ViewerScope` 裁剪受限密文块、Frontmatter 解析、工作区相对路径规范化与 `realpath` 防逃逸校验 |
| [packages/backend/src/wenyou/policy-lint.ts](packages/backend/src/wenyou/policy-lint.ts) | **确定性国策静态门禁（零 LLM 依赖）**：硬拦截 Markdown 表格、二级及以上嵌套清单与高频 AI 公文套话，并对跨阵营透题与时间线穿帮发出预警 |
| [packages/backend/src/wenyou/docx-builder.ts](packages/backend/src/wenyou/docx-builder.ts) | **纯手写风国策 `.docx` 生成器**：零外部依赖纯 TypeScript 实现 CRC32/ZIP 与 OpenXML 文档组装，输出居中标题、自然段与原生编号的 `.docx` 国策书案（默认作者署名「安钰」） |
| [packages/backend/src/wenyou/map-state.ts](packages/backend/src/wenyou/map-state.ts) | **FMG `.map` 与沙盘工程解析器**：兼容含多行内嵌 `<svg>` 与高程行的标准 FMG `.map` 及 `wenyou-project` 工程快照，解析政权/城池/地形/编制兵力（识别 `scope === "inclusive"` 与 `parentUnitId` 防双倍累加）并支持双期地图差异对比 |
| [packages/backend/src/wenyou/ntqq-sync.ts](packages/backend/src/wenyou/ntqq-sync.ts) | **本机 NTQQ 同步调度器**：跨平台探测 Python 与只读 VFS 脚本（子进程强制注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` 消除中文路径乱码），管理密钥提取/导入、群列表查询与按群增量拉取 |
| [packages/backend/src/wenyou/qq-ingest.ts](packages/backend/src/wenyou/qq-ingest.ts) | **群聊离线解析与 L0 证据入库**：解析 `.txt` / `.json` 聊天记录及 VFS 结构化消息，执行发送者归一化、去重指纹计算、双游标（`lastIngestedSourceId` / `lastReportedSourceId`）维护与 `.wenyou/evidence.jsonl` 原子落盘 |

#### 文游后端回归测试（`packages/backend/test/`）

| 测试文件 | 覆盖范围 |
| --- | --- |
| [packages/backend/test/wenyou-service.test.ts](packages/backend/test/wenyou-service.test.ts) | Vault 概览、L0/L1/L2 记忆读写、正史提案审批落盘与导出防泄密预检 |
| [packages/backend/test/wenyou-extension.test.ts](packages/backend/test/wenyou-extension.test.ts) | `tool_call` 正史防直改、`maxViewer` 物理视角钳制与 `:::secret[...]` 剥离 |
| [packages/backend/test/wenyou-docx.test.ts](packages/backend/test/wenyou-docx.test.ts) | OpenXML ZIP 结构、原生编号、UTF-8 中文正文与默认署名「安钰」验证 |
| [packages/backend/test/wenyou-policy-lint.test.ts](packages/backend/test/wenyou-policy-lint.test.ts) | 禁用表格、嵌套列表、AI 套话与跨阵营/时间线静态门禁回归 |
| [packages/backend/test/wenyou-map-state.test.ts](packages/backend/test/wenyou-map-state.test.ts) | 多行 SVG FMG `.map` 解析、编制兵力防双算与双期态势对比 |
| [packages/backend/test/wenyou-ntqq-sync.test.ts](packages/backend/test/wenyou-ntqq-sync.test.ts) | NTQQ INI 解码、群绑定配置、Python 探测与 UTF-8 子进程环境回归 |
| [packages/backend/test/wenyou-demo-fixture.test.ts](packages/backend/test/wenyou-demo-fixture.test.ts) | 开箱演示战役 `fixtures/demo-campaign/` 完整性与门禁联调校验 |

> 说明：NTQQ 读取器双号段 `rowid` 降级扫描与本机发出消息（`40030=0`）专项回归测试位于 `packages/backend/test/wenyou-read-rc15.test.ts`（随 `v0.2.5` 版本吸收链路维护）。

### 2.3 `packages/desktop/`（Electron 桌面端与文游工作台）

#### Electron 主进程与 Preload（`packages/desktop/src/main/` & `src/preload/`）

| 路径 | 职责说明 |
| --- | --- |
| [packages/desktop/src/main/index.ts](packages/desktop/src/main/index.ts) | 主进程入口：窗口初始化、特权协议挂载、严格 CSP `frame-src` 策略与后端生命周期管理 |
| [packages/desktop/src/main/wenyou-protocol.ts](packages/desktop/src/main/wenyou-protocol.ts) | **`wenyou-asset://vault` 与 `wenyou-sandbox://app` 特权协议**：仅放行 `GET`/`HEAD`、校验授权工作区白名单、拒绝 `private/` 与 `.wenyou/` 越权访问、收紧精确 CORS 回显；同时解析随包技能、VFS 与内置沙盘目录 |
| [packages/desktop/src/main/wenyou-sandbox-probe.ts](packages/desktop/src/main/wenyou-sandbox-probe.ts) | 本机回环开发态 Pixi 沙盘探测（仅允许 `127.0.0.1` / `localhost` / `::1`，直连绕过系统代理/VPN） |
| [packages/desktop/src/main/wenyou-world-dir.ts](packages/desktop/src/main/wenyou-world-dir.ts) | 默认世界根目录（`~/.wenyou-pro/worlds`）与跨平台安全新建空白世界目录（防覆盖重名、防路径穿越） |
| [packages/desktop/src/main/app-identity.ts](packages/desktop/src/main/app-identity.ts) | 通道身份识别（`stable` / `beta` / `dev`）、`userData` 目录隔离与 `disableAutoUpdate` 自动更新总闸 |
| [packages/desktop/src/main/dev-agent-dir.ts](packages/desktop/src/main/dev-agent-dir.ts) | 在 SDK 导入前锁定 `PI_CODING_AGENT_DIR` 至 `~/.wenyou-pro/agent[-dev|-beta]`，避免污染外部 CLI 目录 |
| [packages/desktop/src/main/ipc/wenyou.ts](packages/desktop/src/main/ipc/wenyou.ts) | 文游域 IPC 注册：执行域委派 `createExecutionHandlers`，本机原生域负责 `.docx`/态势图导入导出对话框与世界目录选取 |
| [packages/desktop/src/preload/index.ts](packages/desktop/src/preload/index.ts) / [packages/desktop/src/preload/environment-api.ts](packages/desktop/src/preload/environment-api.ts) | CJS ContextBridge 预加载层与远端环境 `cwd` 前缀路由包装（含 `onWenyouCanvasEvent`） |
| [packages/desktop/src/main/wenyou-protocol.test.ts](packages/desktop/src/main/wenyou-protocol.test.ts) / [packages/desktop/src/main/wenyou-sandbox-probe.test.ts](packages/desktop/src/main/wenyou-sandbox-probe.test.ts) / [packages/desktop/src/main/wenyou-world-dir.test.ts](packages/desktop/src/main/wenyou-world-dir.test.ts) / [packages/desktop/src/main/app-identity.test.ts](packages/desktop/src/main/app-identity.test.ts) | 主进程协议安全、沙盘探测、世界目录创建与通道身份单测 |

#### Renderer 文游工作台（`packages/desktop/src/renderer/src/`）

| 路径 | 职责说明 |
| --- | --- |
| [packages/desktop/src/renderer/src/components/wenyou/WenyouCanvas.tsx](packages/desktop/src/renderer/src/components/wenyou/WenyouCanvas.tsx) | 右侧可拖拽宽度文游工作台主画布：页签切换、顶栏视角控制器（GM / 公开 / 阵营）与世界状态同步 |
| [packages/desktop/src/renderer/src/components/wenyou/BriefingPanel.tsx](packages/desktop/src/renderer/src/components/wenyou/BriefingPanel.tsx) | 局势简报与跨群滚动台账面板：区分已定案裁定与 `[未定案草案]`，支持一键追溯原文证据 |
| [packages/desktop/src/renderer/src/components/wenyou/PolicyDeskPanel.tsx](packages/desktop/src/renderer/src/components/wenyou/PolicyDeskPanel.tsx) | 国策书案工坊：实时静态门禁体检（禁用表格/嵌套/AI 套话/透题/穿帮）与手写风 `.docx` 一键导出 |
| [packages/desktop/src/renderer/src/components/wenyou/ProposalsExportPanel.tsx](packages/desktop/src/renderer/src/components/wenyou/ProposalsExportPanel.tsx) | 正史 Diff 审批台与双盲导出面板：逐条审核/落锤/驳回 Agent 提案、执行导出防泄密预检并导出离线编年史 HTML |
| [packages/desktop/src/renderer/src/components/wenyou/AtlasComparePanel.tsx](packages/desktop/src/renderer/src/components/wenyou/AtlasComparePanel.tsx) | 沙盘与图集面板：以 `?workspace=<cwd>` 物理隔离嵌入内置 Pixi 沙盘、双向同步 `sync_context` 与工程存档，并提供双期态势图单图/双屏/卷帘对比 |
| [packages/desktop/src/renderer/src/components/wenyou/SourceContextDrawer.tsx](packages/desktop/src/renderer/src/components/wenyou/SourceContextDrawer.tsx) | L0 群聊原始证据溯源抽屉：定位 GM 裁定、掷骰记录与发言前后文 |
| [packages/desktop/src/renderer/src/components/wenyou/CreateWorldDialog.tsx](packages/desktop/src/renderer/src/components/wenyou/CreateWorldDialog.tsx) | 新建文游世界向导弹窗（目录选择、初始世界创建与可选群绑定，单测见 [CreateWorldDialog.test.tsx](packages/desktop/src/renderer/src/components/wenyou/CreateWorldDialog.test.tsx)） |
| [packages/desktop/src/renderer/src/components/wenyou/NtqqGroupBindDialog.tsx](packages/desktop/src/renderer/src/components/wenyou/NtqqGroupBindDialog.tsx) | 本机 NTQQ 密钥状态管理、多群角色绑定（主群/骰子群/内阁密群/外交群）与增量同步弹窗 |
| [packages/desktop/src/renderer/src/components/wenyou/atlas-viewport.ts](packages/desktop/src/renderer/src/components/wenyou/atlas-viewport.ts) | 高清图集视口缩放（50%–500%）与双图比例检测纯函数（单测见 [atlas-viewport.test.ts](packages/desktop/src/renderer/src/components/wenyou/atlas-viewport.test.ts)） |
| [packages/desktop/src/renderer/src/components/wenyou/world-bootstrap.ts](packages/desktop/src/renderer/src/components/wenyou/world-bootstrap.ts) | 战役世界引导初始化、项目注册与首轮任务触发封装 |
| [packages/desktop/src/renderer/src/components/wenyou/wenyou-helpers.ts](packages/desktop/src/renderer/src/components/wenyou/wenyou-helpers.ts) | 工作区路径解包、行级 Diff 计算与离线编年史 HTML 生成工具 |
| [packages/desktop/src/renderer/src/stores/wenyou-canvas.ts](packages/desktop/src/renderer/src/stores/wenyou-canvas.ts) | 文游画布 Zustand 状态库：管理活跃世界概览、视角隔离状态、事件联动与切世界状态清空 |
| [packages/desktop/src/renderer/src/hooks/use-wenyou-bridge.ts](packages/desktop/src/renderer/src/hooks/use-wenyou-bridge.ts) | App 根层实时事件桥接 Hook：监听后端 `wenyou_*` 工具事件并自动驱动画布展开与聚焦 |
| [packages/desktop/src/renderer/src/i18n/brand-cleanliness.test.ts](packages/desktop/src/renderer/src/i18n/brand-cleanliness.test.ts) | 品牌洁净度回归门禁：确保用户可见文案统一为「司命 · 文游 Pro」同时完整保留 `Jaxton07/percho` MIT 致谢 |

#### 随包运行资源与构建清单（`packages/desktop/resources/` & `build/`）

| 路径 | 职责说明 |
| --- | --- |
| [packages/desktop/resources/ntqq-vfs/ntqq_vfs.py](packages/desktop/resources/ntqq-vfs/ntqq_vfs.py) | 跨平台零第三方依赖 NTQQ SQLCipher 只读页级 VFS（自动择优 Win32 CNG `bcrypt.dll` / macOS `CommonCrypto` / OpenSSL `libcrypto`，内存叠加 WAL，绝不锁改源库） |
| [packages/desktop/resources/ntqq-vfs/wenyou_vfs_sync.py](packages/desktop/resources/ntqq-vfs/wenyou_vfs_sync.py) | 按群增量只读同步器：将指定群聊从加密 NTQQ 库按需物化为干净的标准明文 SQLite |
| [packages/desktop/resources/ntqq-vfs/wenyou_read.py](packages/desktop/resources/ntqq-vfs/wenyou_read.py) | NTQQ 明文协议读取器：兼容双号段 `rowid` 损坏降级扫描、识别 `40027`/`40030=0` 本机发言并过滤系统灰条 |
| [packages/desktop/resources/ntqq-vfs/wenyou_ntqq_bridge.py](packages/desktop/resources/ntqq-vfs/wenyou_ntqq_bridge.py) | 供后端调用的 VFS CLI 桥接器（`list-groups` / `pull-messages` 输出结构化 UTF-8 JSON） |
| [packages/desktop/resources/ntqq-vfs/qq_dump_db.exe](packages/desktop/resources/ntqq-vfs/qq_dump_db.exe) | Windows 专属 NTQQ 密钥提取辅助程序（macOS / Linux 打包清单自动过滤排除） |
| [packages/desktop/resources/wenyou-skills/wenyou-handwritten-policy/SKILL.md](packages/desktop/resources/wenyou-skills/wenyou-handwritten-policy/SKILL.md) | 随包技能：纯手写「抓大放小」国策写作规范与门禁 SOP |
| [packages/desktop/resources/wenyou-skills/wenyou-situation-memory/SKILL.md](packages/desktop/resources/wenyou-skills/wenyou-situation-memory/SKILL.md) | 随包技能：多群防重报采集与 L0/L1/L2 三层局势记忆维护 SOP |
| [packages/desktop/resources/ui-plugins/SPEC.md](packages/desktop/resources/ui-plugins/SPEC.md) | UI 插件运行规范、TypeScript 类型声明（`percho-ui.d.ts`）与内置示例插件 |
| [packages/desktop/build/app-channels.json](packages/desktop/build/app-channels.json) / [packages/desktop/build/icon.svg](packages/desktop/build/icon.svg) | 多通道应用身份定义与书卷落笔风矢量主图标（含 `icon.png`、`wenyou-pro.ico`、`icon-beta.*`、`icon-dev.*`） |
| [packages/desktop/electron-builder.wenyou.yml](packages/desktop/electron-builder.wenyou.yml) | Wenyou Pro 跨平台打包清单（Windows NSIS/Portable、macOS arm64/x64 DMG/ZIP、Linux AppImage，`disableAutoUpdate: true`、`publish: null`） |

### 2.4 `packages/pixi-sandbox/`（内置离线 Pixi 动态推演沙盘）

完整 51 文件模块地图与图层渲染红线请参见 [packages/pixi-sandbox/ARCHITECTURE.md](packages/pixi-sandbox/ARCHITECTURE.md) 与 [packages/pixi-sandbox/README.md](packages/pixi-sandbox/README.md)；核心入口索引如下：

| 模块分组 | 关键文件路径 | 职责说明 |
| --- | --- | --- |
| 启动与宿主桥接 | [main.ts](packages/pixi-sandbox/src/main.ts)、[bridge.ts](packages/pixi-sandbox/src/bridge.ts)、[store.ts](packages/pixi-sandbox/src/store.ts)、[map-viewport.ts](packages/pixi-sandbox/src/map-viewport.ts)、[input-owner.ts](packages/pixi-sandbox/src/input-owner.ts) | Pixi 8 组装根、全局状态与事件总线、`wenyou-map-bridge/v1` 宿主双向桥接（携带 `workspaceKey` 防跨世界写穿） |
| 战区隔离与持久化 | [theater-cache.ts](packages/pixi-sandbox/src/theater-cache.ts)、[theater-manager.ts](packages/pixi-sandbox/src/theater-manager.ts)、[project-serializer.ts](packages/pixi-sandbox/src/project-serializer.ts) | 按工作区哈希隔离 IndexedDB 缓存、多战区「先存 → 再切 → 还原」事务切换与单文件推演工程序列化 |
| 地图解析与渲染 | [map-loader.ts](packages/pixi-sandbox/src/map-loader.ts)、[image-map-builder.ts](packages/pixi-sandbox/src/image-map-builder.ts)、[map-renderer.ts](packages/pixi-sandbox/src/map-renderer.ts)、[map-serializer.ts](packages/pixi-sandbox/src/map-serializer.ts)、[retouch-layer.ts](packages/pixi-sandbox/src/retouch-layer.ts)、[terrain-heightmap.ts](packages/pixi-sandbox/src/terrain-heightmap.ts)、[river-renderer.ts](packages/pixi-sandbox/src/river-renderer.ts)、[label-lod.ts](packages/pixi-sandbox/src/label-lod.ts) | FMG v1.108/1.139/1.154 `.map` 解析与回写、静态图片生成六角格战区、分块渲染、底图修补擦字笔与缩放分级标签 |
| 涂刷、城池与驻军 | [brush-panel.ts](packages/pixi-sandbox/src/brush-panel.ts)、[burg-editor.ts](packages/pixi-sandbox/src/burg-editor.ts)、[tactical-toolbar.ts](packages/pixi-sandbox/src/tactical-toolbar.ts)、[tactical-drawer.ts](packages/pixi-sandbox/src/tactical-drawer.ts)、[military-symbols.ts](packages/pixi-sandbox/src/military-symbols.ts)、[garrison-layer.ts](packages/pixi-sandbox/src/garrison-layer.ts)、[garrison-panel.ts](packages/pixi-sandbox/src/garrison-panel.ts)、[map-unit-edit-target.ts](packages/pixi-sandbox/src/map-unit-edit-target.ts) | 政权/省份涂刷（联动更新城池归属）、城池层级编辑、战术箭头/防线/公里测距标绘与自定义兵牌设计器 |
| 战役展开（`battle-*`） | [battle-contract.ts](packages/pixi-sandbox/src/battle-contract.ts)、[battle-orbat.ts](packages/pixi-sandbox/src/battle-orbat.ts)、[battle-orbat-editor.ts](packages/pixi-sandbox/src/battle-orbat-editor.ts)、[battle-deployment.ts](packages/pixi-sandbox/src/battle-deployment.ts)、[battle-terrain.ts](packages/pixi-sandbox/src/battle-terrain.ts)、[battle-editor.ts](packages/pixi-sandbox/src/battle-editor.ts)、[battle-import.ts](packages/pixi-sandbox/src/battle-import.ts)、[battle-review.ts](packages/pixi-sandbox/src/battle-review.ts)、[battle-export.ts](packages/pixi-sandbox/src/battle-export.ts)、[battle-layer.ts](packages/pixi-sandbox/src/battle-layer.ts)、[battle-panel.ts](packages/pixi-sandbox/src/battle-panel.ts) 等 16 文件 | 团级战役展开（BATTLE-1）：编制树（ORBAT）与兵力统计、防线部署求解、AI 提案审阅与高清 PNG 战役简报导出 |
| 独立野战窗口（`field-battle-*`） | [field-battle-types.ts](packages/pixi-sandbox/src/field-battle-types.ts)、[field-battle-window.ts](packages/pixi-sandbox/src/field-battle-window.ts)、[field-battle-scene.ts](packages/pixi-sandbox/src/field-battle-scene.ts)、[field-battle-paint.ts](packages/pixi-sandbox/src/field-battle-paint.ts)、[field-battle-terrain.ts](packages/pixi-sandbox/src/field-battle-terrain.ts)、[field-battle-units.ts](packages/pixi-sandbox/src/field-battle-units.ts)、[field-battle-overlay.ts](packages/pixi-sandbox/src/field-battle-overlay.ts)、[field-battle-validate.ts](packages/pixi-sandbox/src/field-battle-validate.ts)、[field-battle-history.ts](packages/pixi-sandbox/src/field-battle-history.ts) | 主地图圈选连通地块冻结地形/水系/城池/部队，独立窗口推演且不污染主地图 |
| 单测与回归套件 | [packages/pixi-sandbox/tests/](packages/pixi-sandbox/tests)（含 `unit.test.mjs`、`battle-*.test.mjs`、`field-battle-*.test.mjs`、`map-bridge-v1.test.mjs`、`image-sandbox.test.mjs` 与 `tests/fixtures/`）及根目录 `bugfix.test.mjs`、`theater-switch.test.mjs`、`export-import.test.mjs` | 单元测试、战役 12 套测试、Playwright 浏览器集成与野战验收测试 |

---

## 3. 发布、门禁、云端防锁死与本地同步工具链

### 3.1 `scripts/wenyou-release/` 工具链索引

| 脚本与对应单测 | 核心职责与 CLI 契约 |
| --- | --- |
| [scripts/wenyou-release/scan-repo-paths.mjs](scripts/wenyou-release/scan-repo-paths.mjs)（单测：[scan-repo-paths.test.mjs](scripts/wenyou-release/scan-repo-paths.test.mjs)） | **全仓防开盒与本机路径脱敏硬门禁**（`npm run check:paths`）：扫描全部入库及未忽略文本文件，拦截含系统用户名的本机绝对路径与硬编码盘符工作区路径，零违规时输出 `ok: true` |
| [scripts/wenyou-release/configure-github-repo.mjs](scripts/wenyou-release/configure-github-repo.mjs)（单测：`scripts/wenyou-release/configure-github-repo.test.mjs`） | **云端防锁死校验与配置器**（`npm run repo:guard` 对应 `--verify`）：支持 `--verify`（离线校验 `CODEOWNERS`、工作流 `timeout-minutes <= 60`、并发取消与 `electron-builder.wenyou.yml` 离线发布约束）、`--dry-run [--repo <owner/name>]`（输出 Actions 最小权限与 Anti-Lockout Branch Ruleset JSON 载荷）及 `--apply [--repo <owner/name>]`（通过 `gh api` 幂等应用，确保 Repository Admin 始终拥有绕过权且无单人自锁规则） |
| [scripts/wenyou-release/generate-wenyou-icons.mjs](scripts/wenyou-release/generate-wenyou-icons.mjs)（单测：[generate-wenyou-icons.test.mjs](scripts/wenyou-release/generate-wenyou-icons.test.mjs)） | **图标构建管线**（`npm run icons:wenyou`）：生成书卷落笔风 1024px PNG、多分辨率 Windows `.ico`、LAN Web 图标及 `beta`/`dev` 角标变体 |
| [scripts/wenyou-release/build-installer.mjs](scripts/wenyou-release/build-installer.mjs)（单测：[build-installer.test.mjs](scripts/wenyou-release/build-installer.test.mjs)） | **跨平台打包与归档器**（`npm run package:wenyou` / `npm run package:wenyou:mac`）：统筹内置沙盘编译、Electron 打包（Windows NSIS/Portable、macOS arm64/x64 DMG/ZIP、Linux AppImage），自动生成 `SHA256SUMS.txt` 与对应平台 `使用说明.txt` |
| [scripts/wenyou-release/verify-package.mjs](scripts/wenyou-release/verify-package.mjs)（单测：[verify-package.test.mjs](scripts/wenyou-release/verify-package.test.mjs)） | **产物闭包与签名验包器**（`npm run package:wenyou:verify` / `package:wenyou:verify:mac`）：校验 `app.asar`、跨架构 `@esbuild` 二进制、macOS ad-hoc `codesign` 与 `hdiutil` 挂载、Windows 便携版解压闭包、SHA256 哈希及包内路径脱敏 |
| [scripts/wenyou-release/sync-shortcut.mjs](scripts/wenyou-release/sync-shortcut.mjs) & [sync-shortcut.ps1](scripts/wenyou-release/sync-shortcut.ps1)（单测：[sync-shortcut.test.mjs](scripts/wenyou-release/sync-shortcut.test.mjs)） | **Windows 桌面快捷方式原子同步器**（`npm run shortcut:sync`）：将桌面「司命 · 文游 Pro.lnk」安全指向最新打包产物，支持 fail-closed 目标核验、字节级备份、回读校验与异常回滚 |

### 3.2 `.github/` 云端工作流与治理配置

| 路径 | 职责说明 |
| --- | --- |
| [.github/CODEOWNERS](.github/CODEOWNERS) | 仓库代码所有者配置（指向 `@anyu0804`，防止误锁仓库维护者） |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | `Wenyou Pro CI` 轻量门禁（Ubuntu Node 22，硬超时与并发取消）：依次跑 `check:paths`、`repo:guard`、沙盘测试与构建、全仓 `typecheck`、`test:release`、`wenyou-release` 单测与 `vitest` |
| [.github/workflows/wenyou-release.yml](.github/workflows/wenyou-release.yml) | 文游 Pro 正式跨平台发版流水线（响应 `wenyou-v*` 标签或手动 `workflow_dispatch`）：执行路径/脚本自检、macOS（arm64/x64）与 Windows（x64 + 嵌入式 Python）构建验包，并发布 GitHub Release |
| [.github/workflows/desktop-package.yml](.github/workflows/desktop-package.yml) / [.github/workflows/remote-runtime.yml](.github/workflows/remote-runtime.yml) / [.github/workflows/release.yml](.github/workflows/release.yml) | 保留契约兼容的归档工作流（仅支持 `workflow_call` / 手动 `workflow_dispatch`，已配硬超时且不自动拦截日常提交或普通 `v*` 标签） |
| [.github/pull_request_template.md](.github/pull_request_template.md) / [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE) | PR 清单与 Bug / 需求反馈模板 |

### 3.3 常用 `npm run` 命令速查表

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 自动预构建 LAN Web 与内置 Pixi 沙盘，并启动桌面开发态窗口 |
| `npm run check:paths` | 运行全仓防开盒与本机绝对路径扫描门禁（提交前必跑） |
| `npm run repo:guard` | 运行云端防锁死静态规则校验（对应 `configure-github-repo.mjs --verify`，提交前必跑） |
| `npm run lint` | 运行 Biome 格式化与代码静态检查 |
| `npm run typecheck` | 全工作区 TypeScript 严格类型检查（`shared` + `backend` + `desktop` node/web） |
| `npm run test` | 运行发布脚本单测与工作区 Vitest 测试套件 |
| `npm run test:release` | 仅运行 `scripts/release/*.test.mjs` 发布契约单测 |
| `npm --prefix packages/pixi-sandbox run test` | 运行 Pixi 沙盘基础单测 |
| `npm --prefix packages/pixi-sandbox run build:desktop` | 编译内置 Pixi 沙盘静态资源至 `packages/desktop/resources/pixi-sandbox/` |
| `npm run icons:wenyou` | 重新生成全套书卷落笔风 PNG / ICO / 多通道应用图标 |
| `npm run package:wenyou` / `npm run package:wenyou:mac` | 打包 Windows x64（Setup + Portable）或 macOS（arm64/x64 DMG + ZIP）分发包 |
| `npm run package:wenyou:verify` / `npm run package:wenyou:verify:mac` | 对打包产物执行闭包、签名与脱敏验包 |
| `npm run shortcut:sync` | （Windows）原子同步桌面快捷方式至最新打包可执行文件 |

---

## 4. 文游世界存档（Vault）标准目录结构与权限门禁

标准文游世界由 [fixtures/demo-campaign/](fixtures/demo-campaign) 定义，并向后兼容 [fixtures/golden-vault/](fixtures/golden-vault) 的轻量回归结构（`wiki/`、`chronicle/`、`sources/`）：

```text
<world-vault>/
├── manifest.json             # 世界元数据、分支、地图实体绑定与 maxViewer / exportedViewer 上限
├── 00-群聊收集/               # 离线导出的 QQ 群聊 .txt / .json 原始投放区
├── 01-设定与国力实册/          # [L2 正史] 各国国力实册、条约与人物档案（旧夹具对应 wiki/）
├── 02-局势简报与台账/          # [L1 记忆] 三段式局势简报（briefings/）与跨群滚动台账（rolling-ledger.json）
├── 03-国策与文书/              # 手写体裁国策 .md 与原生编号 .docx 书案
├── 04-编年史与条约/            # [L2 正史] 大事编年史与正式条约文本（旧夹具对应 chronicle/）
├── 05-沙盘与图集/              # 态势图（SVG/PNG）、FMG .map 与沙盘工程快照（active-sandbox.json）
├── private/                  # [GM 绝对密区] GM 暗线笔记与待审正史提案队列（private/proposals/）
└── .wenyou/                  # [L0 证据库] 原始消息归档（evidence.jsonl）与多群双游标（cursors.json）
```

### 目录读写门禁与视角隔离矩阵

| Vault 路径 | 记忆层 | Agent 写入权限 | 非 GM 视角读取权限 | 特权协议 `wenyou-asset://vault` |
| --- | --- | --- | --- | --- |
| `00-群聊收集/` | 原始导入区 | 仅限用户/导入同步写入 | **物理阻断**（`tool_call` 拦截） | 允许已授权工作区图片（仅限图片白名单扩展名） |
| `01-设定与国力实册/`（及 `wiki/`） | **L2 正史** | **物理禁止直改**；强制走 `wenyou_propose_canon` → 人类审批落盘 | 按 Frontmatter `visibility` 与 `:::secret[...]` 裁剪后只读 | 仅公开/受控资产 |
| `02-局势简报与台账/` | **L1 局势** | 经 `wenyou_publish_briefing` 受控发布（未定案草案强制标 `[未定案草案]`） | **物理阻断直读**；仅经 `wenyou_read_memory` 按视角剥离暗线后返回 | 不适用 |
| `03-国策与文书/` | 国策产物 | **物理禁止直写**；强制经 `wenyou_write_policy_docx` 过静态门禁后生成 `.md` + `.docx` | 按阵营/公开视角隔离过滤 | 不适用（导出走主进程 `.docx` 对话框校验） |
| `04-编年史与条约/`（及 `chronicle/`） | **L2 正史** | **物理禁止直改**；强制走 `wenyou_propose_canon` → 人类审批落盘 | 按 `visibility` 与 `:::secret[...]` 裁剪后只读 | 不适用 |
| `05-沙盘与图集/` | 沙盘与图集 | 通过沙盘桥接或地图快照工具原子保存 | 仅展示当前视角允许的态势图与战区 | **白名单放行**（严格校验工作区与图片 MIME） |
| `private/`（含 `private/proposals/`） | **GM 密区** | 仅内部提案队列写入 | **彻底物理阻断** | **硬拒绝（403）** |
| `.wenyou/`（及 `sources/evidence.jsonl`） | **L0 证据** | 仅 `wenyou_pull_qq` / NTQQ 同步追加写入，不篡改原文 | **彻底物理阻断直读**（按视角受控检索） | **硬拒绝（403）** |
| `manifest.json` | 世界契约 | **物理禁止 Agent 直改** | 只读元信息（`maxViewer` 物理钳制上限） | 不适用 |
