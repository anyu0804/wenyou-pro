# 开发导航

> 全仓权威目录地图见 [../DIRECTORY_INDEX.md](../DIRECTORY_INDEX.md)；协议安全、沙盘隔离与真机验收标准见 [../ACCEPTANCE.md](../ACCEPTANCE.md)。

本页帮助开发者按任务快速定位文档与源码入口，无需通读全仓。

## 文游 Pro 核心专题

| 需要了解 | 文档 |
| --- | --- |
| 全仓目录总览、四大包源码索引、发布工具链与 Vault 目录结构 | [全仓目录索引](../DIRECTORY_INDEX.md) |
| 特权协议安全、沙盘防串档、地图契约与跨平台验收清单 | [安全与沙盘验收标准](../ACCEPTANCE.md) |
| 独立文游 Agent 工作台立项背景、L0/L1/L2 记忆与总体架构设计 | [立项与架构方案](独立文游Agent工作台立项与架构方案.md) |
| 上游 Percho 底座勘察、包结构映射与文游工作台改造路线图 | [底座源码勘察与改造地图](Percho底座源码勘察与文游改造地图.md) |
| 国内国策推演文游玩家/GM 痛点调研与分阶段功能演进 | [需求调研与功能演进](国内国策推演文游需求调研与功能演进.md) |
| 内置 Pixi 动态推演沙盘 50 文件模块地图与渲染契约 | [Pixi 沙盘模块地图](../packages/pixi-sandbox/ARCHITECTURE.md) |

## 底座工程专题

| 需要了解 | 文档 |
| --- | --- |
| 包边界、IPC、会话数据与状态所有权 | [架构](architecture.md) |
| 界面风格、字号、浮层、共享组件 | [UI 规范](ui.md) |
| CDP、截图、交互验收、测试实例管理 | [UI 调试](ui-debugging.md) |
| 交互/性能统一入口、留档、基线与趋势 | [性能评测](performance-testing.md) |
| 图片输入/展示边界、资源归属与备份 | [会话图片](session-images.md) |
| 用户级目录隔离、升级迁移、失败恢复 | [用户数据](local-agent-storage.md) |
| SDK 行为、升级、资源释放、上下文 | [SDK 集成](sdk.md) |
| pi 扩展在 GUI 中实际支持哪些交互 | [扩展 UI](extension-ui.md) |
| 发版、Release note、公开核验、失败恢复 | [发版流程](release.md) |
| 本地构建、打包、包内资源与运行包约束 | [构建与验包](build-release.md) |
| Windows 更新取证、恢复 | [Windows 更新](WINDOWS-UPDATES.md) |
| 按症状选择排查方向 | [排障入口](PITFALLS.md) |

## 文游工作台代码入口

以下路径相对仓库根目录，聚焦司命 · 文游 Pro 专属领域能力：

| 想改什么 | 从哪里开始 |
| --- | --- |
| 文游跨进程领域契约与 IPC 通道 | [packages/shared/src/wenyou.ts](../packages/shared/src/wenyou.ts)、[packages/shared/src/ipc-channels.ts](../packages/shared/src/ipc-channels.ts) |
| Vault 初始化、三段式简报台账、设定与编年史索引及工作区路径护栏 | [packages/backend/src/wenyou/service.ts](../packages/backend/src/wenyou/service.ts)、[packages/backend/src/wenyou/vault-paths.ts](../packages/backend/src/wenyou/vault-paths.ts) |
| `wenyou_*` 工具集与世界上下文注入 | [packages/backend/src/wenyou/extension.ts](../packages/backend/src/wenyou/extension.ts) |
| 宋体自然段与原生编号 `.docx` 国策生成器 | [packages/backend/src/wenyou/docx-builder.ts](../packages/backend/src/wenyou/docx-builder.ts) |
| FMG `.map` / 沙盘快照解析、兵力汇总与双期态势对比 | [packages/backend/src/wenyou/map-state.ts](../packages/backend/src/wenyou/map-state.ts) |
| 离线群聊入库、L0 双游标证据库与本机 NTQQ 同步调度 | [packages/backend/src/wenyou/qq-ingest.ts](../packages/backend/src/wenyou/qq-ingest.ts)、[packages/backend/src/wenyou/ntqq-sync.ts](../packages/backend/src/wenyou/ntqq-sync.ts) |
| 跨平台零依赖 NTQQ 只读 VFS 与随包文游技能 | [packages/desktop/resources/ntqq-vfs/](../packages/desktop/resources/ntqq-vfs)、[packages/desktop/resources/wenyou-skills/](../packages/desktop/resources/wenyou-skills) |
| `wenyou-asset://` & `wenyou-sandbox://` 协议、世界目录与原生 IPC | [packages/desktop/src/main/wenyou-protocol.ts](../packages/desktop/src/main/wenyou-protocol.ts)、[packages/desktop/src/main/wenyou-sandbox-probe.ts](../packages/desktop/src/main/wenyou-sandbox-probe.ts)、[packages/desktop/src/main/wenyou-world-dir.ts](../packages/desktop/src/main/wenyou-world-dir.ts)、[packages/desktop/src/main/ipc/wenyou.ts](../packages/desktop/src/main/ipc/wenyou.ts) |
| 右侧文游画布、简报/国策/沙盘图集/设定与编年史面板与事件桥接 | [packages/desktop/src/renderer/src/components/wenyou/](../packages/desktop/src/renderer/src/components/wenyou)、[packages/desktop/src/renderer/src/stores/wenyou-canvas.ts](../packages/desktop/src/renderer/src/stores/wenyou-canvas.ts)、[packages/desktop/src/renderer/src/hooks/use-wenyou-bridge.ts](../packages/desktop/src/renderer/src/hooks/use-wenyou-bridge.ts) |
| 内置 Pixi 动态推演沙盘（桥接、战区隔离、涂刷、战役与野战） | [packages/pixi-sandbox/src/bridge.ts](../packages/pixi-sandbox/src/bridge.ts)、[packages/pixi-sandbox/src/theater-cache.ts](../packages/pixi-sandbox/src/theater-cache.ts)、[packages/pixi-sandbox/src/map-loader.ts](../packages/pixi-sandbox/src/map-loader.ts)、[packages/pixi-sandbox/ARCHITECTURE.md](../packages/pixi-sandbox/ARCHITECTURE.md) |
| 防开盒路径门禁、云端防锁死配置、跨平台打包、验包与快捷方式同步 | [scripts/wenyou-release/scan-repo-paths.mjs](../scripts/wenyou-release/scan-repo-paths.mjs)、[scripts/wenyou-release/configure-github-repo.mjs](../scripts/wenyou-release/configure-github-repo.mjs)、[scripts/wenyou-release/build-installer.mjs](../scripts/wenyou-release/build-installer.mjs)、[scripts/wenyou-release/verify-package.mjs](../scripts/wenyou-release/verify-package.mjs)、[scripts/wenyou-release/generate-wenyou-icons.mjs](../scripts/wenyou-release/generate-wenyou-icons.mjs)、[scripts/wenyou-release/sync-shortcut.mjs](../scripts/wenyou-release/sync-shortcut.mjs) |

## 底座通用代码入口

以下路径相对各包的 `src/`；renderer 路径相对 `packages/desktop/src/renderer/src/`。先从入口跟调用链，不在此维护完整导出清单。

| 想改什么 | 从哪里开始 |
| --- | --- |
| 跨进程 API、事件和共享类型 | shared `ipc-channels.ts`、`ipc.ts`；desktop `main/ipc/`、`preload/index.ts` |
| 会话创建、打开、关闭、分叉、撤回、重试 | backend `pi-backend.ts` → `session/`；renderer `stores/sessions.ts` |
| 导航、并发装载、历史就绪 | renderer `stores/session-navigation.ts`、`session-loading.ts`、`session-history.ts` |
| 会话目录、项目、左栏分组 | renderer `stores/projects.ts`、`lib/sidebar-groups.ts`、`components/sidebar/` |
| 顶栏胶囊、左侧轨道、工作区恢复 | renderer `stores/session-workspace*.ts`、`components/session/`；移出动作 `lib/workspace-actions.ts` |
| 会话自动卸载、频道成员与消息 | renderer `lib/session-gc*.ts`、`lib/use-session-gc.ts`；backend `tools/channels/` |
| 消息事件、历史回放、轮次派生 | shared `transcript/`；backend `session/messages.ts`；renderer `stores/transcript.ts` |
| 消息气泡、Markdown、工具卡 | renderer `components/chat/`；流式合流 `stores/event-conflator.ts` |
| 输入、发送、停止、排队、斜杠与 @ 补全 | renderer `components/composer/`、`stores/drafts.ts`；backend `slash-commands.ts` |
| 图片附件与历史图资源 | renderer `lib/image-attachment.ts`、`lib/image-fit.ts`、`components/chat/history-image/`、`ImagePreview.tsx` |
| 错误卡、分类、手动重试 | shared `errors.ts`、`transcript/llm-errors.ts`；renderer `stores/session-retry.ts`、`components/chat/ErrorNote.tsx` |
| 工具权限、项目边界、信任 | backend `permissions/`、`project/trust*.ts`、`project/workspace-store.ts` |
| provider、登录、模型可见性、子代理偏好 | backend `settings/`；shared `model-visibility.ts`；renderer `stores/settings.ts`、`components/settings/providers/` |
| MCP 配置、状态与重连 | backend `mcp/`、`tools/mcp-inventory.ts`；renderer `stores/mcp.ts`、`components/settings/mcp/` |
| 内置工具、自定义子代理、todo、频道协作 | backend `tools/`；子代理只读检视与返回关系在 renderer `stores/subagent-return.ts` |
| 上下文蒸发、压缩护栏 | backend `tools/context-evaporation/`、`tools/compaction-guard/` |
| 扩展选择题、输入、确认、通知 | backend `session/ui-context.ts`、`extension-dialog-host.ts`；renderer `components/session/InteractionDock.tsx` |
| 设置页及按域加载 | renderer `components/settings/`、`stores/settings.ts`；新增分类入口 `SettingsDialog.tsx` |
| 主题、字号、基础样式、文案 | renderer `styles/`、`stores/theme.ts`、`lib/typography.ts`、`i18n/`；字号档位在 shared `typography.ts` |
| 窗口、退出、尺寸恢复、开发数据隔离 | desktop `main/window.ts`、`window-bounds.ts`、`dev-agent-dir.ts`、`app-identity.ts` |
| 自动更新和诊断 | desktop `main/updater.ts`、`update-policy.ts`、`update-diagnostics.ts`、`build/update-diagnostics.nsh` |
| 日志、事件 trace 与崩溃 | backend `log.ts`、`session/trace*.ts`；desktop `main/renderer-watchdog.ts` |

## 验证工具

自动检查用根目录 `check:paths` / `repo:guard` / `typecheck` / `test` / `lint`。专项脚本都在 `scripts/`，**具体参数、安全前提和断言以脚本文件头为准**，不在索引复制。

- 文游安全与发版门禁：`scripts/wenyou-release/scan-repo-paths.mjs`、`configure-github-repo.mjs`、`verify-package.mjs`、`build-installer.mjs`、`sync-shortcut.mjs`。
- SDK 与后端：`smoke-sdk.mts`、`smoke-backend.mts`、`smoke-error-events.mts`、`smoke-subagent.mts`、`smoke-extension-dialogs.mts`。
- 状态重放：`replay-trace.mts`、`repro-full.mjs`；上下文调参：`replay-evaporation.mts`、`replay-compaction-bound.mts`。
- UI/CDP：`cdp-eval.mjs`、`cdp-shot.mjs`；按功能查找 `check-*`、`verify-*`、`shoot-*`。

## 临时资料

`.local/` 不入库：`design/` 为设计稿，`agent-work/` 为临时 spec/plan/channel。正式发版与验收规则只维护在 [../ACCEPTANCE.md](../ACCEPTANCE.md)、[../DIRECTORY_INDEX.md](../DIRECTORY_INDEX.md) 及上面的专题文档中，不依赖本机临时资料。
