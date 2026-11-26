<p align="center">
  <img src="packages/desktop/build/icon.svg" alt="司命 · 文游 Pro（Wenyou Pro）书卷落笔风图标" width="120" height="120">
</p>
<h1 align="center">司命 · 文游 Pro（Wenyou Pro）</h1>
<p align="center">
  面向国策推演、历史架空与跑团主持 / 参谋的独立桌面 Agent 工作台。<br>
  将多群抓取建档、物理视角隔离、内置离线 Pixi 动态沙盘、手写风原生国策书案与三层记忆融为一体。
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/anyu0804/wenyou-pro?style=flat-square" alt="License"></a>
  <a href="https://github.com/anyu0804/wenyou-pro/releases"><img src="https://img.shields.io/github/v/release/anyu0804/wenyou-pro?style=flat-square" alt="Release"></a>
  <a href="https://github.com/anyu0804/wenyou-pro/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/anyu0804/wenyou-pro/ci.yml?label=CI&style=flat-square" alt="CI"></a>
  <a href="https://github.com/anyu0804/wenyou-pro/actions/workflows/wenyou-release.yml"><img src="https://img.shields.io/github/actions/workflow/status/anyu0804/wenyou-pro/wenyou-release.yml?label=Release%20Build&style=flat-square" alt="Release Build"></a>
  <img src="https://img.shields.io/badge/version-v0.2.5-C83E37?style=flat-square" alt="Version v0.2.5">
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=nodedotjs&style=flat-square" alt="Node >=22.19">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Windows | macOS | Linux">
</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

## 为什么做「司命 · 文游 Pro」？

长周期国策推演与架空历史文游常常陷入两难：纯手工维护 Word/表格与静态涂色图，几十回合后极易因查旧账过劳与时间线穿帮崩局；直接用裸大模型聊天，又容易吃书、凭空造兵、偷看 GM 暗线，甚至越权覆写正式档案。

**司命 · 文游 Pro（Wenyou Pro）** 在 [`Jaxton07/percho`](https://github.com/Jaxton07/percho)（MIT 开源底座）与 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（Pi SDK）之上深度重构，以本地文件 Vault 为确定性真相源，把 AI 严格关进文游规则与双盲隔离的笼子里：

- **抓群直建档案与设定/编年史自动维护**：在默认 GM 视角下，Agent 拉取群聊与国策记录后可直接读写更新 `01-设定与国力实册/`、`04-编年史与条约/` 与 `manifest.json`，关键史实附带可点击 `[sourceId]` 溯源，右侧画布随时速览档案并支持按视角一键导出离线图史包。
- **`maxViewer` 物理视角钳制与 `:::secret[...]` 暗线裁剪**：支持 `gm` / `public` / `faction:<id>` 多重视角，非 GM 视角物理阻断读取 `private/`、`.wenyou/`、`00-群聊收集/` 与未授权密档；全链路自动剥离受限 `:::secret[...]` 暗线块，并在对外导出前执行防泄密预检（`exportPreflight`）。
- **内置离线 Pixi 动态推演沙盘与 FMG `.map` 解析**：通过 `wenyou-sandbox://` 特权协议零外网直载 Pixi.js 8 沙盘，按工作区哈希物理隔离 IndexedDB 彻底杜绝多世界串档；兼容 FMG v1.108 / 1.139 / 1.154 `.map`（含多行 `<svg>` 与高程行）及静态图片六角格建区，支持政权/省份涂刷联动城池归属、ORBAT 编队树、兵力防双算统计、团级战役展开与独立野战窗口、以及双期态势图单图/双屏/卷帘对比。
- **手写体裁零 AI 味原生编号 `.docx` 国策书案**：内置零 LLM 依赖的确定性国策静态门禁，硬拦截 Markdown 表格、多层嵌套清单、高频 AI 公文套话，并对跨阵营透题与时间线穿帮预警；通过原生 OpenXML 生成器直接输出居中标题、平实自然段与原生编号的 `.docx` 正式书案。
- **Windows NTQQ 零拷贝只读 VFS + macOS/Linux 离线群聊导入**：
  - **Windows**：内置零第三方依赖的页级只读 SQLCipher VFS（Win32 CNG `bcrypt.dll` 硬件加速）与一键密钥提取，**绝不锁死、绝不修改** QQ 加密源库，完整兼容双号段 `rowid` 损坏降级与本机发言（`40030=0`）读取；
  - **macOS / Linux**：支持将导出的 `.txt` / `.json` 聊天记录放入世界目录 `00-群聊收集/` 离线解析入库（高级用户亦可导入 `key_map.json` 启用原生 CommonCrypto / OpenSSL 只读 VFS）；
  - 全平台共享 **L0 原始证据库 + 双游标防重报 → L1 三段式局势简报与跨群滚动台账（未定案草案硬标 `[未定案草案]`）→ L2 正史实册**三层记忆架构，支持原文上下文一键溯源。
- **BYOK / 官方 CLI 订阅 / MCP 多通道引擎**：完整继承 Pi SDK 与 Percho 底座的强大基础设施——支持 Anthropic、OpenAI、Gemini、DeepSeek 等 API Key（BYOK）、自定义中转站 Base URL、应用内 OAuth 订阅登录、MCP 工具扩展、内置子代理、上下文蒸发、SSH 远端工作区与局域网跨设备查看；独立用户数据存放于 `~/.wenyou-pro/agent/`。

---

## 下载与安装

预编译跨平台安装包与校验文件发布于 [GitHub Releases](https://github.com/anyu0804/wenyou-pro/releases)（维护者：**安钰**，每次发布均附带 `SHA256SUMS` 校验清单）。

| 平台 | 分发产物命名 | 说明 |
| --- | --- | --- |
| Windows (x64 安装版) | `Wenyou-Pro-Setup-<version>-x64.exe` | NSIS 向导安装器，自动创建桌面「司命 · 文游 Pro」快捷方式，内置嵌入式 Python 与 NTQQ 只读 VFS |
| Windows (x64 绿色便携版) | `Wenyou-Pro-Portable-<version>-x64.zip` | 解压即用，免安装 |
| macOS (Apple Silicon M1–M4) | `Wenyou-Pro-<version>-mac-arm64.dmg` | 同时提供 `.zip` 归档；推荐离线导入群聊 |
| macOS (Intel) | `Wenyou-Pro-<version>-mac-x64.dmg` | 同时提供 `.zip` 归档；推荐离线导入群聊 |
| Linux (x64) | `Wenyou-Pro-<version>-linux-x86_64.AppImage` | 赋予可执行位后运行；Ubuntu 22.04+/24.04+ 需先安装 `libfuse2` |

> **首次启动放行指引（离线优先，默认关闭自动更新）**
>
> - **macOS（ad-hoc 临时签名，未走 Apple 公证）**：将 `Wenyou Pro.app` 拖入「应用程序」后，首次打开若被 Gatekeeper 拦截，请在 **系统设置 → 隐私与安全性 → 安全性** 点击**「仍要打开」**，或在终端执行：
>   ```bash
>   xattr -cr "/Applications/Wenyou Pro.app"
>   ```
> - **Windows**：若出现 SmartScreen 提示，点击**「更多信息」→「仍要运行」**即可。
> - **Linux**：首次运行前执行 `chmod +x Wenyou-Pro-<version>-linux-x86_64.AppImage`。
> - 为避免误连外部源，独立分发包默认配置 `disableAutoUpdate: true`，升级请直接前往 [Releases](https://github.com/anyu0804/wenyou-pro/releases) 下载新版并核对 `SHA256SUMS`。

---

## 开发与架构

前置环境：**Node.js >= 22.19**。国内如遇 Electron 二进制下载缓慢，可先设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

```bash
npm install
npm run dev
```

仓库采用 monorepo 结构，包含四大核心工程包：`packages/shared`（IPC 与文游领域契约）、`packages/backend`（唯一导入 Pi SDK 的后端与文游服务）、`packages/desktop`（Electron + React 19 + Tailwind 4 + Zustand 桌面工作台）以及 `packages/pixi-sandbox`（内置离线 Pixi.js 8 动态战略沙盘）。

提交前推荐运行核心本地门禁：

```bash
npm run check:paths   # 防开盒与本机绝对路径脱敏硬门禁
npm run repo:guard    # 云端防锁死工作流与规则静态校验
npm run typecheck     # 全工作区 TypeScript 严格类型检查
npm run test          # 发布门禁与全工作区单元测试
```

### 核心文档索引

- **[DIRECTORY_INDEX.md](DIRECTORY_INDEX.md)** —— 全仓目录总览、四大包源码级索引、发布工具链与 Vault 权限矩阵
- **[docs/INDEX.md](docs/INDEX.md)** —— 研发专题导航、文游工作台代码入口与底座子系统指南
- **[ACCEPTANCE.md](ACCEPTANCE.md)** —— 特权协议白名单、视角强钳制、沙盘防串档、地图契约与跨平台排障验收标准
- **[CONTRIBUTING.md](CONTRIBUTING.md)** —— 参与贡献规范、PR 检查清单与发版指南
- **[SECURITY.md](SECURITY.md)** —— 安全漏洞私密披露、凭据与 Vault 隐私隔离策略

---

## 致谢与声明

- 本项目（**司命 · 文游 Pro / Wenyou Pro**，维护与整理：**安钰**）基于上游开源项目 **[`Jaxton07/percho`](https://github.com/Jaxton07/percho)**（MIT License）深度定制演进，完整保留其原始 [LICENSE](LICENSE) 版权声明并致以诚挚感谢。
- 核心 Agent 执行引擎由 **[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**（Pi SDK）驱动；本项目为独立社区衍生工程，并非 Pi 团队（earendil-works）官方出品。
- 内置战略沙盘基于 Pixi.js 8 构建，并兼容 Azgaar Fantasy Map Generator（`.map`）格式规范。

## License

[MIT](LICENSE)
