# 模块地图（ARCHITECTURE.md）

> 面向对象：接手本工程的 AI 协作开发者与人类维护者。
> 分工：《沙盘功能添加与AI协作开发者指南.md》讲图层树、appStore 事件与新增功能 SOP（先读它）；本文件补齐**文件级地图**——src/ 下 51 个文件各自管什么、按功能域怎么分组、哪些是契约与红线。
> 维护规则：**新增、删除、拆分 src/ 文件时必须同步更新本表**；改动 `battle-contract.ts`、`store.ts`、`theater-cache.ts` 任意一处后必须跑 `npm run check`。

## 总览

- 技术栈：Vite 5 + TypeScript 5（strict + noUnusedLocals/noUnusedParameters）+ Pixi.js 8 + idb-keyval（IndexedDB）。Node 22+ ESM。
- 组装方式：`src/main.ts` 是唯一组装根，各模块只暴露 `initXxx()`，在 `bootstrap()` 里按依赖顺序挂载。
- 跨模块通信：一律走 `src/store.ts` 的 `appStore`（全局状态 + 事件总线），禁止跨文件修改其他模块内部变量。
- 图层 Z 序（挂在 `worldViewport` 上）：terrainContainer → tacticalContainer → fieldBattleOverlay → garrisonContainer。渲染红线（不得直接操作 terrainContainer、反向缩放原则）见指南 §2。
- 启动方式：空沙盘启动、不内置底图；用户导入 .map 后经暂存边界建区（v0.6.0 裁定，背景见 walkthrough.md 2026-10-22 节）。

## 功能域与文件职责

### A. 启动与全局（7 个）

| 文件 | 职责 |
| --- | --- |
| `main.ts` | 组装根：创建 Pixi Application、按 Z 序挂图层、视口平移/滚轮缩放/空格漫游、按序 initXxx 各模块；启动失败兜底 UI（导出原始缓存 / 忽略缓存空沙盘重启）。 |
| `bridge.ts` | 嵌入宿主桥接器（`wenyou-map-bridge/v1`）：仅在 iframe 嵌入态向 `window.parent` 双向通信，校验 loopback / Electron `file://` 宿主来源，承接 `ping`/`sync_context`/`load_project`/`request_export_project` 并转发 `ready`/`selection_changed`/`focus_source`。 |
| `store.ts` | 全局中枢：`appStore`（mapData、interactionMode、事件总线、toMapCoords/findCellAt）+ terrain/tactical/garrison 三个全局 Container + 共享类型导出。 |
| `map-viewport.ts` | `worldViewport` 与 `fieldBattleOverlay` 两个全局容器的定义（仅 4 行，被所有渲染层引用，改名需全局替换）。 |
| `input-owner.ts` | 输入归属两态开关（`map` / `fieldbattle`）：野战窗口打开时主地图快捷键让位。 |
| `json-validation.ts` | 外部 JSON 导入的通用校验小工具，错误文案由各导入入口自定义。 |
| `planar-geometry.ts` | 平面几何基础（射线法点在环内判定等），无业务耦合。 |

### B. 地图导入 / 导出 / 战区（6 个）

| 文件 | 职责 |
| --- | --- |
| `map-loader.ts` | `.map` 解析入口：按第 2 行是否以 `{` 开头区分 FMG 1.108/1.139 与 1.154 两代头部布局；解析 cells/burgs/states 等段；`buildVoronoi` 重建网格。兼容口径以上游 FMG GitHub master 为准（见工作目录 AGENTS.md）。 |
| `image-map-builder.ts` | 静态图片底图导入：按 Pointy-top Odd-R 公式为任意 PNG/JPG/WEBP/SVG 生成六角格网与 `wenyouImageBase` 兼容 `MapData`，接入现有涂刷、城邦、标绘与野战链路。 |
| `map-serializer.ts` | 导出侧：`originalMapRecords` 保留 FMG 原始段重组导出 `.map`（版本正则 1.108/1.139/1.154，不猜造未加载数据）；`downloadText` 通用下载。 |
| `project-serializer.ts` | 推演工程存档的整体序列化/反序列化（serializeProject/parseProject）。 |
| `theater-cache.ts` | IndexedDB 战区缓存：capture/save/read、listTheaters、`exportRawCache`（损坏缓存导出）、`replaceBaseOnNextSave`（重导入重建基底）。**新增全局业务数据必须补快照字段，否则切战区丢数据。** |
| `theater-manager.ts` | 战区切换栏 UI 与生命周期：`restoreInitialTheater`（启动恢复或空沙盘）、`initTheaterSwitcher`；切换遵循"先存 → 再切 → 还原"。 |

### C. 主地图渲染（5 个）

| 文件 | 职责 |
| --- | --- |
| `map-renderer.ts` | 渲染总管：terrainContainer 的分块管理、高清图片底图 Sprite 与半透明疆域遮罩、地块填充与海岸带、政权/省份涂刷落笔与撤销重做（paintAt/undoPaint/redoPaint/repaintMap）。 |
| `retouch-layer.ts` | 图片底图纹理与离屏像素缓存、像素级吸色器（3×3 邻域均值转 `#rrggbb`）、擦除旧字修补画笔（`retouch-erase`/`retouch-pick` 及 Alt+左键快捷吸色）与撤销栈。 |
| `terrain-heightmap.ts` | 高度图渲染：等高线链收集、湖泊收集、地块配色。 |
| `river-renderer.ts` | 河流渲染：锚点 → FMG 曲流插值 → 锐角松弛 → Catmull-Rom 加密 → 源细口粗多边形（不直接采用存档 width）。 |
| `label-lod.ts` | 标签系统：8 方向候选槽位自动避让、短引线与港口角标、按视口缩放的 LOD 显隐。 |

### D. 编辑面板（DOM UI，2 个）

| 文件 | 职责 |
| --- | --- |
| `brush-panel.ts` | 在线刷政权/刷省份及图片底图透明度与修补擦字笔控制面板（只管 UI 与参数，落笔与重绘在 map-renderer / retouch-layer）。 |
| `burg-editor.ts` | 城市编辑（改名/增删/层级），含 recomputeBurgTiers 重算层级。 |

### E. 战术标绘（2 个）

| 文件 | 职责 |
| --- | --- |
| `tactical-toolbar.ts` | 右侧工具栏：交互模式切换（漫游/战线/箭头/选择/测距尺/涂选战场）与全图宽度比例尺（km）配置。 |
| `tactical-drawer.ts` | 战术态势绘制：进攻箭头/锯齿防线/比例尺公里测距折线的画布交互、选择/删除/撤销（画在 tacticalContainer）。 |

### F. 兵牌与驻军（4 个）

| 文件 | 职责 |
| --- | --- |
| `military-symbols.ts` | 军标符号库：军衔层级规格、自绘军标符号（getEchelonSymbol/renderUnitSymbolToContext）、文化样式。 |
| `garrison-layer.ts` | 主地图驻军层（garrisonContainer 的兵牌渲染与交互接入）。 |
| `garrison-panel.ts` | 兵牌编辑与自定义徽记设计器弹窗（openGarrisonCustomModal）。 |
| `map-unit-edit-target.ts` | FB-E 桥：供兵牌设计器读写主地图部队数据的编辑目标。 |

### G. 战场域核心（battle-*，16 个）

> 纯逻辑与面板层。`battle-contract.ts` 是唯一类型契约，所有 battle-* 与 field-battle-* 都依赖它。

| 文件 | 职责 |
| --- | --- |
| `battle-contract.ts` | 战场域类型契约（BattlePoint/BattleWorkspace/BattleUnit/BattleEditBatch/BattleTerrainFeature…）。改它牵一发动全身，必跑 `npm run test:battle`。 |
| `battle-geometry.ts` | 几何原语：容差、环/多边形/多重多边形有效性与重叠判定。 |
| `battle-terrain.ts` | 战场地形查询：点在障碍内、通行走廊、可部署性判定、距离量算。 |
| `battle-terrain-editor.ts` | 地形编辑批次构造器：增删改地形要素/边界/比例尺 → BattleEditBatch。 |
| `battle-deployment.ts` | 部署求解 calculateBattleDeployment：沿防线/区域生成部署位（样例在 work-packages/BATTLE-1，被测试引用，勿删）。 |
| `battle-collections.ts` | 数组 upsert 等集合小工具。 |
| `battle-actions.ts` | 编辑应用与撤销/重做栈（applyBattleEdits/undo/redo/preview）、getBattleWorkspace 当前工作区。 |
| `battle-editor.ts` | 几何变换（平移/旋转朝向 → edit batch）与 BattleEditor 类。 |
| `battle-import.ts` | AI 候选导入解析与筛选、AI 提案模板生成。 |
| `battle-export.ts` | 战场 PNG 导出：绘制到画布、图例与比例尺注记、证据收集。 |
| `battle-storage.ts` | 持久化结构：emptyBattleState、旧档迁移、工作区校验。 |
| `battle-orbat.ts` | ORBAT（编队组织树）构建与查询：树构建、人员汇总、折叠态、批量解析。 |
| `battle-orbat-editor.ts` | ORBAT 编辑器 UI（全项目最大文件）：编队树编辑、单位增删改、断言与证据录入。 |
| `battle-panel.ts` | 战场面板总 UI：战场列表、进入编辑、撤销重做入口。 |
| `battle-review.ts` | AI 提案审核面板（回调注入 getWorkspace/applyBatch）。 |
| `battle-layer.ts` | 战场在主地图上的渲染层：renderBattle、兵牌徽记与朝向。 |

### H. 野战窗口（field-battle-*，9 个）

| 文件 | 职责 |
| --- | --- |
| `field-battle-types.ts` | 野战窗口内部类型（FieldRing/FieldUnit/FieldTerrainSnapshot…）。 |
| `field-battle-window.ts` | 窗口壳：独立 Pixi 共享 App、开关窗口、场景工厂注入（main.ts 里 setFieldBattleSceneFactory 接线）。 |
| `field-battle-scene.ts` | 野战场景：独立 pixi-viewport、地形与单位渲染。 |
| `field-battle-overlay.ts` | 主地图上的野战入口按钮与战场覆盖提示（fieldBattleOverlay 容器）。 |
| `field-battle-paint.ts` | 主地图上圈画战场范围：格子选取与连通性判定、预览、generateFieldBattle 生成。 |
| `field-battle-terrain.ts` | 主地图 → 野战快照：outline 裁剪、frame 计算、buildFieldTerrainSnapshot。 |
| `field-battle-units.ts` | 战场域单位拷入野战窗口、改名/删除。 |
| `field-battle-validate.ts` | 野战数据校验（契约冻结口径，不随集成进度放宽）。 |
| `field-battle-history.ts` | 野战撤销栈：一次 apply = 一个撤销步，按 battleId 内存隔离，关窗即 reset。 |

## 测试布局与验收入口

| 命令 | 内容 |
| --- | --- |
| `npm run check` | **改任何 src 后的最低验收门槛** = typecheck + 单测（unit）+ 战场域 12 套（test:battle，node --test 经 vite ssrLoadModule 加载 TS）+ 浏览器 3 套（test:browser：bugfix/theater-switch/export-import，各自起 vite + Playwright Chromium headless）+ 野战验收 11 场景（field-battle-acceptance）。 |
| `npm run test:package` | 发布检查（battle-release），在全新解压的 Release 目录上跑，日常改动不跑。 |

- 浏览器测试禁用 Edge，只用 Playwright Chromium（AGENTS.md 红线）；证据输出在 `.tmp-build/`。
- 测试 fixture：`tests/fixtures/fmg-legacy-default.map`（E 群岛原字节副本）是回归基线，勿改。
- `work-packages/` 内的样例被 battle 测试引用，勿当废弃文档清理。
- 本机构建注意：`%TEMP%` 的 esbuild 自清理报 Access is denied 时，以 `TMP/TEMP` 指向 `.tmp-build/tmp` 绕过（见 walkthrough.md 2026-10-22 节）。

## 已归档的过时材料（勿作权威来源）

- `_archive/多战区切换-完整TypeScript代码.md`、`_archive/地图导出与工程存档-完整TypeScript代码.md`：v0.4.8 时期的全量代码快照，与当前 src 已脱节，仅作历史参考。
- walkthrough.md 是按日期追加的工作日志（历史记录不回改）；各 WORK-PACKAGES-*.md 是对应版本的工单，同样只反映当时状态。
