# 司命 · 文游 Pro（Wenyou Pro）发版与验包流程

> 公开仓库：[`anyu0804/wenyou-pro`](https://github.com/anyu0804/wenyou-pro)｜维护者：**安钰**（基于 [`Jaxton07/percho`](https://github.com/Jaxton07/percho) MIT 开源底座定制）

本页用于准备、触发、验包与核验 **Wenyou Pro** 正式发版。全仓目录索引见 [DIRECTORY_INDEX.md](../DIRECTORY_INDEX.md)，安全与真机验收标准见 [ACCEPTANCE.md](../ACCEPTANCE.md)，底座打包细节与历史内测参考见 [构建与验包](build-release.md)。

**主流程：版本对齐与本地门禁 → 推送 `wenyou-vX.Y.Z` 标签（或 `workflow_dispatch`）→ 云端构建与验包 → 公开 Release 附件核验。**

---

## 1. 确定版本与前置本地门禁

1. 确认目标变更已合入 `main`，工作区干净。
2. 对齐以下文件的 `version` 字段并提交：
   - 根 `package.json`、`packages/shared/package.json`、`packages/backend/package.json`、`packages/desktop/package.json`、`package-lock.json`
   - [packages/desktop/electron-builder.wenyou.yml](../packages/desktop/electron-builder.wenyou.yml) 中的 `extraMetadata.version` 与 `directories.output`
3. 在仓库根目录执行发版前必过门禁（失败即停）：

```bash
npm run check:paths
npm run repo:guard
npm run typecheck
npm --prefix packages/pixi-sandbox run test:ci
node --test scripts/wenyou-release/*.test.mjs
npm run test
```

各核心脚本职责：
- [scan-repo-paths.mjs](../scripts/wenyou-release/scan-repo-paths.mjs)：全仓防开盒与本机绝对路径硬门禁（`npm run check:paths`）。
- [configure-github-repo.mjs](../scripts/wenyou-release/configure-github-repo.mjs)：校验 `CODEOWNERS`、工作流 `timeout-minutes <= 60` 与防锁死规则（`npm run repo:guard`）。
- [build-installer.mjs](../scripts/wenyou-release/build-installer.mjs)：跨平台安装包构建与 `SHA256SUMS.txt` / `使用说明.txt` 归档。
- [verify-package.mjs](../scripts/wenyou-release/verify-package.mjs)：校验 `app.asar`、内置沙盘静态资源闭包、`locales/` 裁剪、SHA-256 与路径脱敏（支持 `--platform win|mac|linux`）。
- [stage-release-assets.mjs](../scripts/wenyou-release/stage-release-assets.mjs)：递归归集 Actions 下载产物并执行防空包硬门禁，防止 0 附件空 Release。

---

## 2. 触发云端正式发版（`wenyou-release.yml`）

正式发版由 [.github/workflows/wenyou-release.yml](../.github/workflows/wenyou-release.yml) 驱动，支持以下两种触发方式：

### 方式 A：推送 `wenyou-vX.Y.Z` 标签（推荐，自动构建 macOS + Windows 并发布 Release）

```bash
release_version="$(node -p "require('./packages/desktop/package.json').version")"
release_tag="wenyou-v${release_version}"

git fetch origin main --tags
git tag -a "${release_tag}" origin/main -m "Release Wenyou Pro v${release_version}"
git push origin "refs/tags/${release_tag}"

gh run list --repo anyu0804/wenyou-pro --workflow wenyou-release.yml --limit 3
```

### 方式 B：手动触发 `workflow_dispatch`（按需仅测 macOS 或附带 Windows / 发布 Release）

```bash
gh workflow run wenyou-release.yml \
  --repo anyu0804/wenyou-pro \
  --ref main \
  -f mac_arch=all \
  -f include_windows=true \
  -f create_github_release=true
```

> 说明：上游遗留的 `.github/workflows/release.yml` 已归档为仅手动触发（不监听任何 `push` tag），避免干扰 `wenyou-v*` 正式发布。

---

## 3. 云端流水线与产物清单

[.github/workflows/wenyou-release.yml](../.github/workflows/wenyou-release.yml) 依次执行 4 个任务（所有 job 均满足 `timeout-minutes <= 60`）：

1. **`hygiene-and-tests`**（Ubuntu）：运行 `npm run check:paths` 与 `node --test scripts/wenyou-release/*.test.mjs`。
2. **`build-macos`**（macOS）：执行 `build-installer.mjs --platform mac --arch "${TARGET_MAC_ARCH}"` 与 `verify-package.mjs --platform mac --arch "${TARGET_MAC_ARCH}"`（含 ad-hoc `codesign` 与 `hdiutil verify`），上传 `.dmg`、`.zip`、`SHA256SUMS.txt`、`使用说明.txt`。
3. **`build-windows`**（Windows x64，`push` 标签或 `include_windows=true` 时运行）：预置嵌入式 Python 3.13 运行时，执行 `npm run package:wenyou` 与 `npm run package:wenyou:verify`，上传 Setup `.exe`、Portable `.zip`、`SHA256SUMS.txt`、`使用说明.txt`。
4. **`github-release`**（Ubuntu）：下载各平台构建产物，通过 [stage-release-assets.mjs](../scripts/wenyou-release/stage-release-assets.mjs) 兼容平铺与嵌套子目录归集至 `release-upload/`，**强制断言非空 macOS（及启用 Windows 时的 Windows x64）全套文件齐全后**，再调用 `gh release create` / `gh release upload --clobber`。

### GitHub Releases 自动发布的标准附件

| 平台 | 标准附件 |
| --- | --- |
| macOS (Apple Silicon) | `Wenyou-Pro-<ver>-mac-arm64.dmg`、`Wenyou-Pro-<ver>-mac-arm64.zip` |
| macOS (Intel) | `Wenyou-Pro-<ver>-mac-x64.dmg`、`Wenyou-Pro-<ver>-mac-x64.zip` |
| macOS 校验与说明 | `SHA256SUMS-macOS.txt`、`README-macOS.txt` |
| Windows (x64) | `Wenyou-Pro-Setup-<ver>-x64.exe`、`Wenyou-Pro-Portable-<ver>-x64.zip` |
| Windows 校验与说明 | `SHA256SUMS-Windows-x64.txt`、`README-Windows-x64.txt` |

### Linux (x64 `.AppImage`) 按需源码构建与验包

GitHub Releases 默认自动发布 Windows x64 与 macOS 预编译包；Linux x64 `.AppImage` 支持在 Linux 宿主机按需使用仓库打包配置构建与校验：

```bash
node scripts/wenyou-release/build-installer.mjs --platform linux --arch x64
node scripts/wenyou-release/verify-package.mjs --platform linux --arch x64
```

产物输出至 `dist/wenyou-pro-<ver>-linux-x64/`，包含 `Wenyou-Pro-<ver>-linux-x86_64.AppImage`、`SHA256SUMS.txt` 与 `使用说明.txt`。

---

## 4. 公开 Release 核验与异常处理

流水线完成后，在终端核对线上 Release 附件数量与大小均非零：

```bash
release_tag="wenyou-v$(node -p "require('./packages/desktop/package.json').version")"
gh release view "${release_tag}" --repo anyu0804/wenyou-pro --json tagName,isDraft,assets \
  --jq '{tagName, isDraft, assetCount: (.assets | length), assets: [.assets[] | {name, size}]}'
```

| 异常情况 | 处理方式 |
| --- | --- |
| 某一步骤或验包失败 | 使用 `gh run view <run-id> --repo anyu0804/wenyou-pro --log-failed` 定位根因；若为网络抖动可 `gh run rerun <run-id> --failed`，若为代码缺陷请修复后升级新版本号发版。 |
| `stage-release-assets.mjs` 报错阻断发布 | 检查上游 `upload-artifact` 产物日志与 `release-staging/` 目录内容，严禁绕过非空门禁发布 0 附件空 Release。 |
| 仅需补充或修正 Release 说明 | 使用 `gh release edit "${release_tag}" --repo anyu0804/wenyou-pro --notes-file <notes.md>`，无需重跑构建。 |
| 需同步 GitHub 仓库防锁死配置 | 先运行 `node scripts/wenyou-release/configure-github-repo.mjs --dry-run` 预览载荷，确认无误再执行 `--apply`。 |
