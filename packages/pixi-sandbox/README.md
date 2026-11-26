# 文游动态战略沙盘

当前版本：**v0.9.1**

面向文字战棋、架空世界跑团与历史推演的离线网页战略沙盘，基于 Vite 5、TypeScript 5 与 Pixi.js 8 构建。程序默认以空沙盘启动，不内置底图，拖入 Azgaar Fantasy Map Generator（FMG）导出的 `.map` 文件即可建区推演。全部编辑状态实时保存在本地浏览器的 IndexedDB 中，既能导出单文件推演工程 JSON 跨设备迁移，也能将修改后的领土与城市回写为标准 FMG `.map`。

---

## 核心功能

### 地图导入与多战区管理

- **FMG `.map` 兼容**：支持 FMG `v1.108`、`v1.139` 及 `v1.154` 存档格式，自动识别两代头部布局（竖线选项行与参数 JSON / 生物群系 JSON 数组），并按上游 `Azgaar/Fantasy-Map-Generator`（`master` 分支）规范以 CRLF 拆分顶级记录段，正确保留 `nameBases` 等字段内的裸换行。
- **多战区隔离与切换**：每张导入的地图以 `mapId` 独立建区，切战区遵循「先落盘暂存 → 再切换 → 恢复目标战区」的事务顺序，各战区的底图修改、兵牌、战线与局部战场相互隔离。
- **同图更新与战区删除**：重新导入同 `mapId` 的新版 `.map` 时弹出覆盖确认，确认后用新文件重建底图基线，取消则保留原有缓存。战区栏提供「删除战区」按钮，可原子清理缓存与基线；删光最后一个战区后干净回到空沙盘。

### 底图视图、地名与涂刷编辑

- **四视图与四工具**：支持地形、群系、政权、省份四种视图切换，提供漫游、刷政权、刷省份、城市编辑四种工具（支持画笔半径调节、等高线开关、政权和省份归属涂刷以及城市增删改名与层级重算）。高度与宗教底层数据随存档保留。
- **城市名手动字号与动态双开关**：左侧「显示与历史」面板支持独立调整城市名大小（`50%–240%`，仅影响城市名，不改变国名与省名），并可分别开关「城市名随缩放变大」与「城市名按缩放分级显示」（关闭后者后全图城市名常驻显示，不做缩放分级隐藏和密度避让）。

### 兵牌系统、编制树与战役展开

- **三样式兵牌与高清缩放**：提供标准（`96×30`）、紧凑（`76×28`）和纯军标（`34×34`）三种兵牌样式，兵牌整体缩放支持 `35%–240%` 并显示实时百分比，渲染时按比例提高文字超采样分辨率。
- **编制与自定义兵牌设计器**：支持 8 个人数区间对应的 7 档军标（连至方面军），支持自定义部队名、字体颜色（含 6 色高对比预设）、外框颜色、中心字与本地图片上传；支持将已有部队按份数拆分为真实下属单位，保持总兵力不变。
- **团级战役展开（BATTLE-1）**：内置编制树（ORBAT）与兵力汇总面板，支持局部战场地形障碍与通行口编辑、沿防线或部署区自动求解占地面、多单位成组拖动与朝向旋转、AI 提案 JSON 导入审阅（字段级来源与证据记录）以及高分辨率 PNG 战役简报导出。

### 战术标绘与独立战场快照

- **主地图战术标绘**：支持进攻箭头、锯齿防线、测距折线绘制与选中删除，在高倍率缩放（最高 32 倍）下仍保持单次成线与稳定的屏幕线宽。
- **独立局部战场窗口**：可在主地图上涂选连通地块（最多 2000 格，支持 `Alt + 左键` 擦除），一键冻结当时的地形、河流、海岸线、城市与选区内已知位置部队，生成独立战场快照。战场窗口独立于主地图运行，自带缩放平移、兵牌样式与大小滑块、城市名大小及动态双开关、新建与拖拽部署、独立撤销重做栈，窗口内修改不回写主地图。

### 本地存档、回写导出与恢复

- **自动暂存与防丢失**：编辑操作经 500ms 合并后写入浏览器 IndexedDB（`wenyou-theaters/theaters`，当前为缓存 `v5`、`TheaterState v4`），写入事务完成后在顶栏提示「当前战区已自动暂存」；页面切换至后台会立即触发落盘，未落盘或写入中关闭页面会触发浏览器离页确认。
- **单文件工程与 `.map` 导出**：推演工程 JSON（`v4`）打包全部战区、底图修改、兵牌、战线与局部战场快照，并兼容旧版工程（`v1–v3`）与旧缓存（`v1–v4`）自动迁移；标准 `.map` 导出保留原始未编辑记录段，只回写变动后的地块归属与城市信息。
- **异常兜底**：若本地缓存损坏，启动兜底页允许先下载原始缓存用于诊断，再选择忽略缓存进入空沙盘，重新导入同图即可重建健康缓存。

---

## 快速启动

### 方式一：独立便携发布包（推荐，免装环境）

上级目录中的 `Wenyou-Pixi-v0.9.1-Release.zip` 内置了独立 Node `v24.22.1` 运行时与构建产物，适合直接发给玩家或离线使用：

1. 将 `Wenyou-Pixi-v0.9.1-Release.zip` 解压到普通磁盘目录。
2. 双击目录内的 `启动沙盘.bat` 启动本地服务（默认监听 `http://127.0.0.1:5174/`）。
3. 使用 Chrome 或独立 Chromium 打开该地址，导入 `.map` 文件即可开始。

> Windows 提醒：若工作目录树带有 NTFS 低完整性标签，直接在其内部运行解压前的 `runtime\node.exe` 可能报 `0xC0000142`；解压到普通磁盘目录后双击 `启动沙盘.bat` 即可正常启动。

### 方式二：源码目录日常秒开（静态构建模式）

适合在本地已经装好 Node.js 22+ 且完成了 `npm run build` 的日常使用，页面约 1 秒内就绪，无需等待 Vite 冷启动：

- 双击 `启动静态沙盘.cmd`（或 `启动文游地图-静态版.lnk`），由 `serve-dist.mjs` 直接托管 `dist/`，监听 `http://127.0.0.1:5173/`。
- 该模式与 `npm run dev` 共用 `5173` 端口，因此浏览器 IndexedDB 战区缓存完全互通；若端口已被占用，脚本不会抢占端口，直接打开现有页面。
- 修改 `src/` 后记得重新运行 `npm run build`，否则静态版仍会服务旧 `dist/`。

### 方式三：开发模式（热更新）

环境要求：Node.js 22+（当前基线为 Node `v24.22.1`，依赖版本由 `package-lock.json` 锁定）。

```bash
npm ci
npm run dev
```

开发服务器固定监听 `http://127.0.0.1:5173/`（已启用 `--strictPort`，若静态版正在占用 `5173` 端口会直接提示退出，避免静默换端口导致 IndexedDB 缓存隔离）。

如需启用可选的世界资料接口（支持 `immortal-game1` 与 `civ4-game2`），在启动服务的同一终端中设置 `WENYOU_WORLDS_ROOT` 指向实际的 `worlds` 目录即可；未配置不影响沙盘与工程导入导出：

```powershell
$env:WENYOU_WORLDS_ROOT = 'D:/path/to/wenyou-world-data/worlds'
npm run dev
```

---

## 常用操作与快捷键

| 场景 | 操作 | 说明 |
| --- | --- | --- |
| 视口浏览 | 鼠标滚轮 / 中键或右键拖动 / 按住 `Space` 拖动 | 缩放与平移地图 |
| 涂选战场 | 左键点击或拖动 / `Alt + 左键` | 添加连通地块 / 擦除地块（阻止选区断开） |
| 标绘与兵牌编辑 | `Delete` 或 `Backspace` | 删除当前选中的标绘或战场兵牌 |
| 撤销与重做 | `Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`） | 主地图按当前工具归属撤回画笔或战术标绘；战场窗口使用独立撤销栈 |
| 战场窗口 | 单击地图战场按钮 / 双击 / 右键 | 打开窗口 / 重命名 / 重命名或删除战场 |

完整玩家向操作步骤见 [使用说明.md](./使用说明.md)。

---

## 目录结构与模块分工

```text
wenyou-pixi-app/
├── index.html                  # 页面入口与基础样式
├── server.mjs                  # 独立发布包静态服务（默认 5174，支持 gzip/ETag 与边界校验）
├── serve-dist.mjs              # 源码目录日常秒开服务（固定 5173，托管 dist/）
├── world-data.mjs              # 可选世界资料 API 数据读取器
├── 启动静态沙盘.cmd             # Windows 日常静态秒开脚本（纯 ASCII）
├── src/                        # 48 个 TypeScript 源码模块
│   ├── main.ts                 # 唯一组装根：Pixi Application、图层 Z 序与按序初始化
│   ├── store.ts                # 全局状态与事件总线（appStore）
│   ├── map-loader.ts           # FMG .map 解析与 Voronoi 网格重建
│   ├── map-serializer.ts       # .map 原段保留回写导出
│   ├── project-serializer.ts   # 推演工程 JSON 序列化与迁移
│   ├── theater-cache.ts        # IndexedDB 战区缓存与原子删除
│   ├── theater-manager.ts      # 战区切换、同图覆盖确认与空沙盘生命周期
│   ├── map-renderer.ts         # 分块地形渲染、海岸带与涂刷撤销
│   ├── label-lod.ts            # 城市/政权/省份标签避让与动态 LOD
│   ├── brush-panel.ts          # 左侧视图、画笔与城市名显示控制面板
│   ├── garrison-*.ts           # 兵牌层、兵牌设计器弹窗与军标渲染（military-symbols.ts）
│   ├── battle-*.ts             # 团级战役契约、几何求解、ORBAT 编辑器、AI 审阅与 PNG 导出
│   └── field-battle-*.ts       # 独立局部战场涂选、地形裁剪、窗口与场景
├── tests/                      # 21 个测试文件及固定回归 fixture
├── public/                     # 静态附属文件（AI 提案模板与第三方声明）
├── ARCHITECTURE.md             # 48 个源文件的完整职责地图与开发红线
├── 沙盘功能添加与AI协作开发者指南.md # 图层树、事件约定与新增功能步骤
├── 使用说明.md                  # 面向玩家的中文操作手册
└── walkthrough.md              # 按版本追加的交付与排障日志
```

修改 `src/` 前请先阅读 [ARCHITECTURE.md](./ARCHITECTURE.md) 与 [沙盘功能添加与AI协作开发者指南.md](./沙盘功能添加与AI协作开发者指南.md)。

---

## 测试与验收

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | TypeScript 严格模式类型检查（`tsc --noEmit`） |
| `npm run build` | 类型检查并产出生产静态包到 `dist/` |
| `npm test` | 运行基础单元测试（`tests/unit.test.mjs`，覆盖解析、分层、工程往返与城市名双开关） |
| `npm run test:battle` | 运行 12 组团级战役域测试（编制、几何、部署求解、导入导出、军标与面板） |
| `npm run test:browser` | 运行 3 组 Playwright 浏览器端到端回归（`bugfix`、`theater-switch`、`export-import`） |
| `npm run check` | **修改 `src/` 后的最低验收门槛**：依次运行 `typecheck`、`test`、`test:battle`、`test:browser` 与 `tests/field-battle-acceptance.test.mjs`（11 组野战场景） |
| `npm run test:package` | 发布包全量验收（`tests/battle-release.test.mjs`），在全新解压的 Release 目录上运行 |
| `npm run setup:browser` | 安装 Playwright 测试用独立 Chromium Headless Shell |

### 开发与验收红线

1. **禁止启动 Microsoft Edge**：本项目所有浏览器测试与手动验证均使用 Chrome 或 Playwright 安装的独立 Chromium（Windows 下显式使用 `ANGLE d3d11`），不得启动 Edge 或读写用户浏览器配置。
2. **`.map` 兼容口径以上游仓库为准**：验证 `.map` 导入导出兼容性时，对照 GitHub `Azgaar/Fantasy-Map-Generator` 的 `master` 分支源码，不以本地魔改版 FMG 副本为依据。
3. **Windows 临时目录受限绕过**：若本机 `%TEMP%` 导致 esbuild 自清理报 `Access is denied`，构建或跑测试前在当前终端将 `TMP` 和 `TEMP` 指向 `.tmp-build/tmp` 即可：

```bash
mkdir -p .tmp-build/tmp
TMP=.tmp-build/tmp TEMP=.tmp-build/tmp npm run build
TMP=.tmp-build/tmp TEMP=.tmp-build/tmp npm run check
```

4. **不修改回归基线**：`tests/fixtures/fmg-legacy-default.map` 与 `work-packages/` 下的测试样例被自动化套件直接引用，切勿删除或覆写。

---

## 独立发布包构建与验收

发布目录位于上级目录（当前为 `../Wenyou-Pixi-v0.9.1-Release/` 及同名 `.zip`，历史发布包统一归档在 `../_archive/releases/`）。单个发布包包含：

- `runtime/node.exe`：独立 Node 运行时（当前为 `v24.22.1`）
- `www/`：由 `npm run build` 完整产出的 `dist/`（含 `index.html`、`assets/*`、`battle-ai-template.json`、`THIRD-PARTY-NOTICES.txt`）
- `server.mjs` 与 `world-data.mjs`：离线静态服务与可选世界资料读取器
- `启动沙盘.bat`：纯 ASCII + CRLF 编码的 Windows 启动脚本
- `VERSION.txt`、`使用说明.md`、`walkthrough.md`：版本标记与说明文档（UTF-8）

打包完成后，将最终 `.zip` 解压到全新目录并设置 `PACKAGED_RELEASE_DIR` 运行包验收，确认内置运行时、资源依赖闭包、全量 HTTP 200 及核心浏览器工作流均正常：

```powershell
$env:PACKAGED_RELEASE_DIR = 'D:/temp/verify/Wenyou-Pixi-v0.9.1-Release'
npm run test:package
```

---

## 版本演进

- **v0.9.1**：修复新版 FMG `.map` 中 `nameBases` 含裸换行导致的解析错位；新增同 `mapId` 重导入覆盖确认与「删除战区」回空沙盘功能；主地图与野战窗口同步新增城市名手动大小（`50%–240%`）与动态双开关；扩大兵牌缩放至 `35%–240%` 并新增字体颜色自定义、移除战术图腾；放大标准/紧凑兵牌修复重叠溢出，修复野战按钮重复「战场」后缀及编制编辑器排版挤压。
- **v0.9.0**：合并自 `v0.6.0-hotfix4` 起的全部迭代，涵盖城市密集度分级 LOD 避让优化、移除战史编年史模块、本地静态服务路径边界加固，并将内置运行时升级至 Node `v24.22.1`。
- **v0.6.0 系列**：新增独立局部战场快照与窗口、真实部队拆分、空沙盘启动与 FMG `v1.154` 头部布局兼容。
- **v0.5.0 – v0.5.1**：引入 BATTLE-1 团级战役展开（ORBAT、部署求解、AI 提案审阅、PNG 简报）、8 档兵力军标、自定义图片兵牌与 32 倍短战线绘制。

各版本的详细改动背景、测试证据与环境边界记录在 [walkthrough.md](./walkthrough.md)。
