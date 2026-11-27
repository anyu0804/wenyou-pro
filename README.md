<p align="center">
  <img src="packages/desktop/build/icon.svg" alt="Wenyou Pro (司命 · 文游 Pro) scroll and calligraphy brush icon" width="120" height="120">
</p>
<h1 align="center">Wenyou Pro (司命 · 文游 Pro)</h1>
<p align="center">
  Standalone desktop Agent workbench for grand-strategy text roleplay, alternate-history campaigns, and tabletop GMs / advisors.<br>
  Combines autonomous campaign archive maintenance, an offline Pixi tactical sandbox, natural-paragraph Songti <code>.docx</code> policy drafting, and three-tier group-chat memory.
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/anyu0804/wenyou-pro?style=flat-square" alt="License"></a>
  <a href="https://github.com/anyu0804/wenyou-pro/releases"><img src="https://img.shields.io/github/v/release/anyu0804/wenyou-pro?style=flat-square" alt="Release"></a>
  <a href="https://github.com/anyu0804/wenyou-pro/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/anyu0804/wenyou-pro/ci.yml?label=CI&style=flat-square" alt="CI"></a>
  <a href="https://github.com/anyu0804/wenyou-pro/actions/workflows/wenyou-release.yml"><img src="https://img.shields.io/github/actions/workflow/status/anyu0804/wenyou-pro/wenyou-release.yml?label=Release%20Build&style=flat-square" alt="Release Build"></a>
  <img src="https://img.shields.io/badge/version-v0.2.7-C83E37?style=flat-square" alt="Version v0.2.7">
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=nodedotjs&style=flat-square" alt="Node >=22.19">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Windows | macOS | Linux">
</p>
<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">简体中文</a>
</p>

---

## Why Wenyou Pro?

Long-running grand-strategy text roleplay and alternate-history campaigns typically suffer from two extremes: purely manual spreadsheets and static paint maps collapse under ledger fatigue and timeline contradictions after dozens of turns, while unguarded LLM chat readily loses track of prior rulings, invents troop counts, or drifts away from campaign records.

**Wenyou Pro (司命 · 文游 Pro)** builds upon the open-source [`Jaxton07/percho`](https://github.com/Jaxton07/percho) (MIT) desktop foundation and [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (Pi SDK), anchoring every campaign in a deterministic local file Vault:

- **Autonomous Campaign Archive & Read-Only Lore/Chronicle Browser**: The Agent reads and maintains campaign dossiers (`01-设定与国力实册/`, `04-编年史与条约/`, `manifest.json`) while ingesting group chats and decrees, tagging key facts with clickable `[sourceId]` citations. The right-hand workbench provides a dedicated read-only **Lore & Chronicles (`设定与编年史`)** viewer for quick reference alongside chat.
- **Built-in Offline Pixi Strategic Sandbox & FMG `.map` Parser**: Served offline via the privileged `wenyou-sandbox://` protocol (and compatible with `http(s)` local/LAN hosts) with workspace-hash-isolated IndexedDB storage so multiple campaign worlds never cross-contaminate. Parses FMG v1.108 / 1.139 / 1.154 `.map` files (including multiline `<svg>` and elevation rows) as well as static image hex-grid theaters; supports state/province brushing synced to burg ownership, ORBAT unit trees with double-count protection, battle deployment, independent field-battle snapshots, and side-by-side / curtain atlas comparison.
- **Natural-Paragraph Songti `.docx` Policy Desk**: Bundled writing guidance helps the Agent draft plain, natural-paragraph strategic decrees free of bloated markdown tables. Generates clean, centered-title, natively numbered Songti `.docx` files via an in-house zero-dependency OpenXML builder (blank author metadata by default, with optional `author` override) and previews archived policies directly inside the Policy Desk panel.
- **Windows Zero-Copy Read-Only NTQQ VFS + macOS/Linux Offline Chat Ingest**:
  - **Windows**: Ships a zero-dependency page-level read-only SQLCipher VFS (accelerated via Win32 CNG `bcrypt.dll`) plus one-click key extraction that **never locks or mutates** QQ's encrypted source databases, handling dual-range `rowid` fallback scans, self-sent messages (`40030=0`), and up to 20,000-message rumor traceability;
  - **macOS / Linux**: Drop exported `.txt` / `.json` chat logs into `00-群聊收集/` for offline ingestion (power users with `key_map.json` can also use native CommonCrypto / OpenSSL read-only VFS);
  - All platforms share the **L0 raw evidence & incremental dual cursors → L1 three-section situation briefings & rolling ledger (`[未定案草案]` draft markers) → L2 world dossiers & chronicles** three-tier memory architecture with one-click source-context lookup.
- **BYOK / OAuth Subscriptions / MCP Multi-Channel Engine**: Inherits the Pi SDK & Percho runtime—BYOK API keys (Anthropic, OpenAI, Gemini, DeepSeek, etc.), custom base-URL relay gateways, in-app OAuth subscription sign-in, MCP server integration, user-defined `.md` subagents, and context evaporation. User data is isolated under `~/.wenyou-pro/agent/`.

---

## Download & Installation

Prebuilt **Windows (x64)** and **macOS (Apple Silicon / Intel)** packages and checksums are published automatically on [GitHub Releases](https://github.com/anyu0804/wenyou-pro/releases) (maintained by **安钰**, each release ships with `SHA256SUMS` verification manifests). **Linux (x64 `.AppImage`)** is supported via on-demand source packaging and verification using the repository's release toolchain.

| Platform | Artifact Naming | Distribution | Notes |
| --- | --- | --- | --- |
| Windows (x64 Installer) | `Wenyou-Pro-Setup-<version>-x64.exe` | GitHub Releases (prebuilt) | NSIS wizard installer with desktop shortcut and bundled embedded Python + NTQQ read-only VFS |
| Windows (x64 Portable) | `Wenyou-Pro-Portable-<version>-x64.zip` | GitHub Releases (prebuilt) | Extract and run, no installation required |
| macOS (Apple Silicon M1–M4) | `Wenyou-Pro-<version>-mac-arm64.dmg` | GitHub Releases (prebuilt) | `.zip` archive also provided; offline chat import recommended |
| macOS (Intel) | `Wenyou-Pro-<version>-mac-x64.dmg` | GitHub Releases (prebuilt) | `.zip` archive also provided; offline chat import recommended |
| Linux (x64) | `Wenyou-Pro-<version>-linux-x86_64.AppImage` | On-demand source build | Not auto-published to Releases; build & verify locally via `node scripts/wenyou-release/build-installer.mjs --platform linux` and `verify-package.mjs --platform linux` (Ubuntu 22.04+/24.04+ requires `libfuse2`) |

> **First-Launch Gatekeeper / SmartScreen Notes (Offline-First)**
>
> - **macOS (ad-hoc signed, un-notarized)**: After dragging `Wenyou Pro.app` to `/Applications`, if Gatekeeper blocks the first launch, go to **System Settings → Privacy & Security** and click **Open Anyway**, or clear the quarantine attribute in Terminal:
>   ```bash
>   xattr -cr "/Applications/Wenyou Pro.app"
>   ```
> - **Windows**: Click **More info → Run anyway** if Windows SmartScreen prompts on first launch.
> - **Linux (self-built AppImage)**: Run `chmod +x Wenyou-Pro-<version>-linux-x86_64.AppImage` before executing.
> - Standalone builds stay offline-first by default; download Windows/macOS upgrades from [Releases](https://github.com/anyu0804/wenyou-pro/releases) and verify `SHA256SUMS`.

---

## Development & Architecture

Prerequisites: **Node.js >= 22.19**. If Electron binary downloads are slow in China, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` first.

```bash
npm install
npm run dev
```

This repository is a monorepo composed of four packages: `packages/shared` (IPC & Wenyou domain contracts), `packages/backend` (the sole Pi SDK importer and Wenyou campaign engine), `packages/desktop` (Electron + React 19 + Tailwind 4 + Zustand desktop workbench), and `packages/pixi-sandbox` (offline Pixi.js 8 strategic & tactical sandbox).

Recommended local verification gates before opening a PR:

```bash
npm run check:paths   # Repository-wide anti-doxxing & hardcoded local path gate
npm run repo:guard    # Offline GitHub anti-lockout workflow & ruleset verification
npm run typecheck     # Workspace-wide strict TypeScript check
npm run test          # Release contract tests & Vitest workspace suites
```

### Documentation Map

- **[DIRECTORY_INDEX.md](DIRECTORY_INDEX.md)** — Authoritative repository directory map, four-package source index, release toolchain, and Vault directory layout
- **[docs/INDEX.md](docs/INDEX.md)** — Developer topic map, Wenyou workbench code entry points, and base runtime guides
- **[ACCEPTANCE.md](ACCEPTANCE.md)** — Protocol security, sandbox isolation, map contract, and cross-platform troubleshooting criteria
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Contribution workflow, coding conventions, pre-PR gates, and releasing guide
- **[SECURITY.md](SECURITY.md)** — Private vulnerability reporting, credential boundaries, and Vault isolation scope

---

## Acknowledgments & Disclaimer

- **Wenyou Pro (司命 · 文游 Pro)** (maintained by **安钰**) is built upon the open-source **[`Jaxton07/percho`](https://github.com/Jaxton07/percho)** (MIT License) desktop foundation. The upstream [LICENSE](LICENSE) and attribution are preserved in full.
- Powered by **[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** (Pi SDK). This is an independent community project and is **not** affiliated with or endorsed by the Pi team (earendil-works).
- The built-in tactical sandbox uses Pixi.js 8 and maintains `.map` format compatibility with Azgaar Fantasy Map Generator.

## License

[MIT](LICENSE)
