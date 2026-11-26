# Wenyou Pro 地图、内置动态沙盘与安全门禁验收标准（ACCEPTANCE.md）

> 整理：安钰｜覆盖范围：`packages/shared`、`packages/pixi-sandbox`、`packages/desktop`、`packages/backend`、`packages/desktop/resources/ntqq-vfs`

## 1. 特权协议、视角强钳制与国策门禁验收
1. **`wenyou-asset://` 工作区白名单与收紧 CORS**（`packages/desktop/src/main/wenyou-protocol.ts` + `index.ts`）：
   - `handleWenyouAssetRequest` 仅放行 `GET` / `HEAD` 且强制 `url.hostname === "vault"`，校验 `cwd` 属于已授权工作区且拒绝任何以 `private` / `.wenyou` 为根或子段的越权路径；
   - `Access-Control-Allow-Origin` 仅针对 `wenyou-sandbox://app`、应用自身渲染源及本机回环开发源精确回显，禁止 `*` 通配，CSP `frame-src` 仅放行 `'self' wenyou-sandbox: http://127.0.0.1:* http://localhost:* http://[::1]:*`。
2. **视角隔离与内部证据库保护**（`packages/backend/src/wenyou/extension.ts` + `service.ts`）：
   - GM 视角允许 Agent 直接读写维护 `01-设定与国力实册/`、`03-国策与文书/`、`04-编年史与条约/` 与 `manifest.json`，仅对 `.wenyou/` 与 `private/` 保留 bash 防误删保护；`wenyou_write_policy_docx` 默认校验手写风格并支持 `force: true` 强制落盘；
   - 非 GM 视角（受 `clampViewerScope` 与 `manifest.json` `maxViewer` 钳制）物理阻断内置工具读取或写入 `private/`、`.wenyou/`、`00-群聊收集/` 及未授权/含暗线密档；`wenyou_read_memory`、`getOverview` 与 `exportPreflight` 全链路剥离受限 `:::secret[...]` 块并隔离非公开简报与国策。
3. **路径安全与编码门禁**：
   - `writePolicyDocx` 严格校验清洗 `serialNo` 并核验工作区边界；
   - `ntqq-sync.ts` 子进程注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，中文用户名或中文解压路径下 `detectPythonExecutable` 零乱码；`wenyou_read.py` 与 `wenyou_vfs_sync.py` 兼容双号段 `rowid`、本人发言 `40030=0`（`40003=0`）并过滤 `40030=0 & 40033=0` 系统灰条。

## 2. 桌面端跨世界隔离、图片入沙盘与双向同步验收
1. **按工作区物理隔离沙盘与防串档**（`AtlasComparePanel.tsx` + `theater-cache.ts` + `bridge.ts`）：
   - 内置沙盘 URL 携带 `?workspace=<cwd>`，沙盘侧按 `workspace` 哈希隔离 IndexedDB 库名并在桥接载荷回传 `workspaceKey`；切换世界时强制重建沙盘实例、重置待导入引用与自动保存队列，杜绝跨世界写穿 `05-沙盘与图集/active-sandbox.json` 或多世界战区混包；
   - 沙盘收到宿主连接或发出 `ready/pong` 时双向同步 `sync_context`；删除末战区不会触发旧快照僵尸复活；载入沙盘列表仅展示 `wenyou-project` 完整工程。
2. **前端视角/世界切换无残留与监听无泄漏**：
   - 切换世界或视角时同步后端 `wenyou:setViewerScope`，立即重拉或清空 `ProposalsExportPanel` 正史预览、`PolicyDeskPanel` 草稿与 `preflightResult`；
   - `environment-api.ts` 为 `onWenyouCanvasEvent` 正确包装远端环境 `cwd` 前缀；`SessionTabBar` 横向滚轮回调 `ref` 正确返回卸载函数零监听器泄漏。

## 3. 后端与沙盘跨包地图契约验收
1. **多行 SVG `.map`、编制兵力与城池归属**（`map-state.ts` + `pixi-sandbox`）：
   - 正确解析含多行内嵌 `<svg>` 的标准 FMG `.map` 及真实高程行（记录 18），保留 FMG 战区自定义比例尺 `kmPerPixel` / `mapWidthKm`；
   - `parseUnits` 识别 `personnel.scope === "inclusive"` 与 `parentUnitId` 防止拆分编制兵力双倍累加；政权笔刷涂抹疆域同步更新格内城池归属；高分辨率图片战区 `lookupNearestCell` 动态适配 `hexRadius` 零点击死区。

## 4. 门禁、验证层级与排障日志入口
- **自动化验证命令**：
  1. `npm run test:release`（发布与元数据门禁单测全绿）；
  2. `npm --prefix packages/pixi-sandbox run test` 与 `npm --prefix packages/pixi-sandbox run build:desktop`（沙盘单测与内置静态资源编译通过）；
  3. `npm run typecheck`（`shared`、`backend`、`desktop` node+web 全部 `0 error`）；
  4. `npx vitest run`（`packages/backend` 与 `packages/desktop` 单元与回归测试全绿）。
- **真机人工验证边界与失败排障日志入口（Windows / macOS / Linux 全平台）**：
  - **跨平台核心真机冒烟**：开发态执行 `npm run dev`（或运行对应平台分发包）启动真实桌面窗口，实测切换两个文游世界沙盘涂画互不串档、顶栏切换「公开视角」即时剥离正史暗线，并按平台验证群聊入库链路；
  - **本机 NTQQ 与离线导入边界**：本机 NTQQ「一键提取密钥」为 **Windows 专属**能力（Windows 实测「一键提取密钥 / 同步群聊」）；**macOS / Linux** 推荐将导出的 `.txt` / `.json` 聊天记录放入世界目录 `00-群聊收集/` 离线导入，若高级用户已备好 `key_map.json` 与本机 `nt_db` 目录，也可手动导入密钥并启用只读直读；
  - **Windows**：
    - 启动入口：`Wenyou Pro.exe`；
    - 运行日志：`%APPDATA%\Wenyou Pro\logs\`（开发态 `%APPDATA%\Wenyou Pro Dev\logs\`）；
    - 权限审计：`~/.wenyou-pro/agent[-dev]/permission-audit.jsonl`（即 `%USERPROFILE%\.wenyou-pro\agent[-dev]\permission-audit.jsonl`）；
    - DevTools Console 快捷键：`Ctrl+Shift+I`。
  - **macOS**：
    - 启动入口：`Wenyou Pro.app`（未公证包首次打开请在「系统设置 → 隐私与安全性」点「仍要打开」，或执行 `xattr -cr "/Applications/Wenyou Pro.app"`）；
    - 运行日志：`~/Library/Application Support/Wenyou Pro/logs/`（开发态 `~/Library/Application Support/Wenyou Pro Dev/logs/`）；
    - 权限审计：`~/.wenyou-pro/agent[-dev]/permission-audit.jsonl`；
    - DevTools Console 快捷键：`Cmd+Option+I`。
  - **Linux**：
    - 启动入口：`Wenyou-Pro-*.AppImage`（赋予可执行权限后运行）；
    - 运行日志：`~/.config/Wenyou Pro/logs/`（开发态 `~/.config/Wenyou Pro Dev/logs/`）；
    - 权限审计：`~/.wenyou-pro/agent[-dev]/permission-audit.jsonl`；
    - DevTools Console 快捷键：`Ctrl+Shift+I`。
