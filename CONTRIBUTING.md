# Contributing to Wenyou Pro (司命 · 文游 Pro)

Thanks for your interest in contributing to [`anyu0804/wenyou-pro`](https://github.com/anyu0804/wenyou-pro)! This document covers the development workflow, mandatory privacy/safety gates, and architectural conventions that keep the codebase maintainable.

For a complete file-by-file map and developer navigation, start with [DIRECTORY_INDEX.md](DIRECTORY_INDEX.md), [docs/INDEX.md](docs/INDEX.md), and [ACCEPTANCE.md](ACCEPTANCE.md).

## Getting started

1. Fork [`https://github.com/anyu0804/wenyou-pro`](https://github.com/anyu0804/wenyou-pro) and clone your fork.
2. Install **Node.js >= 22.19**.
3. Install dependencies and start the desktop workbench:

```bash
npm install
npm run dev
```

If you are in China and the Electron binary download stalls, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` first.

## Pull request workflow

1. Create a branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Make your changes within a focused scope.
3. **Mandatory pre-commit & pre-PR gates** — run these locally before pushing:

```bash
npm run check:paths   # 防开盒与本机路径脱敏门禁（严禁出现真实姓名、OS 用户名或本机盘符绝对路径）
npm run repo:guard    # 云端防锁死规则与工作流静态门禁（configure-github-repo.mjs --verify）
npm run lint          # Biome 格式化与静态检查
npm run typecheck     # 全工作区 TypeScript 类型检查
npm run test          # 发布门禁与工作区单元测试
```

When modifying `packages/pixi-sandbox/`, also run `npm --prefix packages/pixi-sandbox run test` and `npm --prefix packages/pixi-sandbox run build:desktop`.

4. Open a PR against `main` in [`anyu0804/wenyou-pro`](https://github.com/anyu0804/wenyou-pro/pulls). `Wenyou Pro CI` (`.github/workflows/ci.yml`) runs the same checks and must be green before merge.
5. PRs are merged with squash merge — please write a clear Conventional Commit PR title, since it becomes the squashed commit message.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `refactor: ...`, `docs: ...`, `test: ...`, `chore: ...`.

## Project conventions

These are hard-won invariants — please follow them strictly:

- **Privacy & path sanitization (`npm run check:paths`)**: Never hardcode personal names, OS usernames, or local workspace drive paths in code, docs, tests, or commit messages. Always use relative paths, `~`, `%APPDATA%`, `%USERPROFILE%`, `<workspace>`, or runtime APIs (`os.homedir()`).
- **Cloud anti-lockout hygiene (`npm run repo:guard`)**: Every normal GitHub Actions job with `steps:` must declare an explicit `timeout-minutes <= 60` (reusable workflow caller jobs using `uses:` must omit `timeout-minutes` per GitHub Actions schema). Keep `.github/CODEOWNERS` aligned with `@anyu0804` and preserve `disableAutoUpdate: true` / `publish: null` in `packages/desktop/electron-builder.wenyou.yml`.
- **Formatting** is enforced by Biome: tabs, double quotes, line width 110. Run `npm run lint` instead of hand-formatting.
- **Renderer never imports Pi packages.** It talks to the main process exclusively through `window.pi` (preload contextBridge). Single-source IPC channel definitions live in [packages/shared/src/ipc-channels.ts](packages/shared/src/ipc-channels.ts) and [packages/shared/src/ipc.ts](packages/shared/src/ipc.ts).
- **`packages/backend/src/pi-backend.ts` is the only file** allowed to import the Pi SDK (`@earendil-works/*`). SDK versions are pinned — do not upgrade casually.
- **Wenyou Vault & perspective security**: Never bypass `makeWenyouExtension` `tool_call` gates, `maxViewer` clamping, `:::secret[...]` stripping, or `wenyou-asset://vault` workspace allowlists. All canon updates must flow through `DiffPatchProposal` human approval.
- **i18n & brand cleanliness**: User-facing strings go through `useT()` and must be added to both `zh` and `en` dictionaries in `packages/desktop/src/renderer/src/i18n/`. Preserve the upstream MIT attribution to `Jaxton07/percho` while keeping user-facing brand strings clean (`brand-cleanliness.test.ts`).
- **Zustand selectors must return stable references** (module-level constants for empty values). Inline `?? []` creates a new array every render and causes infinite loops.
- **Never commit API keys, NTQQ `key_map.json`, or campaign secrets.** `models.json` uses environment variable references (`$VAR`); keys live only in your local environment.

## Architecture pointers

- **Multi-session support**: `SessionRegistry` (`packages/backend/src/session/registry.ts`) holds multiple `AgentSession` instances.
- **Wenyou domain engine**: `packages/backend/src/wenyou/` (`service.ts`, `extension.ts`, `secret-blocks.ts`, `policy-lint.ts`, `docx-builder.ts`, `map-state.ts`, `ntqq-sync.ts`, `qq-ingest.ts`).
- **Permission prompts** are injected via `session.bindExtensions(...)` — adjust the `confirm` handler in `makeUiContext` rather than rewriting the whole UI context.
- **Preload bundle** must stay CJS (`format: "cjs"`, `index.cjs`) so sandboxed renderers can load it.

## Releasing

Cross-platform Wenyou Pro releases are built by `.github/workflows/wenyou-release.yml` and published to [`anyu0804/wenyou-pro/releases`](https://github.com/anyu0804/wenyou-pro/releases):

1. Bump `version` consistently across `package.json`, `packages/shared/package.json`, `packages/backend/package.json`, `packages/desktop/package.json`, `package-lock.json`, and `packages/desktop/electron-builder.wenyou.yml`, then commit.
2. Run `npm run check:paths && npm run repo:guard && npm run typecheck && npm run test` locally.
3. Push a release tag matching `wenyou-vX.Y.Z` (`git tag wenyou-vX.Y.Z && git push origin wenyou-vX.Y.Z`) or trigger `Wenyou Pro Release Build` via `workflow_dispatch`.
4. To inspect or idempotently configure cloud Actions permissions and the Anti-Lockout branch ruleset on GitHub, use `node scripts/wenyou-release/configure-github-repo.mjs --dry-run` and `--apply`.

## Reporting bugs

Open an issue at [`https://github.com/anyu0804/wenyou-pro/issues/new/choose`](https://github.com/anyu0804/wenyou-pro/issues/new/choose) using the bug report template. Include your OS, app version, and reproduction steps. Never paste API keys, `auth.json`, `key_map.json`, or private campaign files into public issues.
