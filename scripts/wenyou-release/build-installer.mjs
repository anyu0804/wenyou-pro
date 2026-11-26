/**
 * Wenyou Pro cross-platform installer builder and release archiver (Windows / macOS / Linux).
 * Author: 安钰
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const NPM_EXECPATH_BASENAME_PATTERN = /^npm(?:-cli)?\.[cm]?js$/i;
const RETRYABLE_RENAME_CODES = new Set(["EEXIST", "EPERM", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1000];

export const SUPPORTED_PLATFORMS = Object.freeze(["win", "mac", "linux"]);
export const POSIX_NTQQ_VFS_FILTER = Object.freeze([
	"**/*.py",
	"!**/__pycache__/**",
	"!**/*.pyc",
	"!**/*.pyo",
	"!python/**",
	"!**/*.exe",
	"!**/*.dll",
	"!**/*.pyd",
	"!**/*.cat",
]);

export const REQUIRED_COMMON_PREREQUISITES = Object.freeze([
	"packages/desktop/electron-builder.wenyou.yml",
	"packages/desktop/resources/ntqq-vfs/wenyou_read.py",
	"packages/desktop/resources/ntqq-vfs/wenyou_vfs_sync.py",
	"packages/desktop/resources/ntqq-vfs/ntqq_vfs.py",
	"packages/desktop/resources/ntqq-vfs/wenyou_ntqq_bridge.py",
	"packages/desktop/resources/wenyou-skills/wenyou-handwritten-policy/SKILL.md",
	"packages/desktop/resources/wenyou-skills/wenyou-situation-memory/SKILL.md",
]);

export const REQUIRED_PREREQUISITES = Object.freeze([
	"packages/desktop/electron-builder.wenyou.yml",
	"packages/desktop/build/wenyou-pro.ico",
	"packages/desktop/resources/ntqq-vfs/wenyou_read.py",
	"packages/desktop/resources/ntqq-vfs/wenyou_vfs_sync.py",
	"packages/desktop/resources/ntqq-vfs/ntqq_vfs.py",
	"packages/desktop/resources/ntqq-vfs/wenyou_ntqq_bridge.py",
	"packages/desktop/resources/ntqq-vfs/qq_dump_db.exe",
	"packages/desktop/resources/ntqq-vfs/python/python.exe",
	"packages/desktop/resources/wenyou-skills/wenyou-handwritten-policy/SKILL.md",
	"packages/desktop/resources/wenyou-skills/wenyou-situation-memory/SKILL.md",
	"packages/desktop/resources/update-diagnostics/collect.ps1",
]);

export const REQUIRED_MAC_PREREQUISITES = Object.freeze([
	"packages/desktop/electron-builder.wenyou.yml",
	"packages/desktop/build/icon.png",
	"packages/desktop/resources/ntqq-vfs/wenyou_read.py",
	"packages/desktop/resources/ntqq-vfs/wenyou_vfs_sync.py",
	"packages/desktop/resources/ntqq-vfs/ntqq_vfs.py",
	"packages/desktop/resources/ntqq-vfs/wenyou_ntqq_bridge.py",
	"packages/desktop/resources/wenyou-skills/wenyou-handwritten-policy/SKILL.md",
	"packages/desktop/resources/wenyou-skills/wenyou-situation-memory/SKILL.md",
]);

export const REQUIRED_LINUX_PREREQUISITES = REQUIRED_MAC_PREREQUISITES;

export function validateVersion(version) {
	if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
		throw new Error(`Invalid release version "${String(version)}": expected X.Y.Z format`);
	}
	return version;
}

export function resolveDefaultPlatform(hostPlatform = process.platform) {
	if (hostPlatform === "darwin") return "mac";
	if (hostPlatform === "linux") return "linux";
	if (hostPlatform === "win32") return "win";
	throw new Error(`Unsupported host platform "${String(hostPlatform)}": specify --platform win|mac|linux`);
}

export function validatePlatform(platform) {
	if (typeof platform !== "string" || !SUPPORTED_PLATFORMS.includes(platform)) {
		throw new Error(
			`Invalid target platform "${String(platform)}": expected one of ${SUPPORTED_PLATFORMS.join(", ")}`,
		);
	}
	return platform;
}

export function resolveTargetArchitectures(platform, arch) {
	const validPlatform = validatePlatform(platform);
	if (validPlatform === "mac") {
		const requested = arch ?? "all";
		if (requested === "all") return ["arm64", "x64"];
		if (requested === "arm64" || requested === "x64") return [requested];
		throw new Error(`Invalid macOS arch "${String(arch)}": expected arm64, x64, or all`);
	}
	if (validPlatform === "win") {
		const requested = arch ?? "x64";
		if (requested === "x64") return ["x64"];
		throw new Error(`Invalid Windows arch "${String(arch)}": expected x64`);
	}
	// linux
	const requested = arch ?? "x64";
	if (requested === "x64" || requested === "arm64") return [requested];
	throw new Error(`Invalid Linux arch "${String(arch)}": expected x64 or arm64`);
}

/**
 * Map CLI architecture names to electron-builder's AppImage `${arch}` macro expansion
 * (`builder-util` getArtifactArchName: `x64 -> x86_64`, `arm64 -> arm64`).
 */
export function formatLinuxArtifactArch(arch) {
	if (arch === "x64") return "x86_64";
	if (arch === "arm64") return "arm64";
	throw new Error(`Unsupported Linux AppImage arch "${String(arch)}": expected x64 or arm64`);
}

export function parseBuildArgs(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			version: { type: "string" },
			platform: { type: "string" },
			arch: { type: "string" },
			"skip-build": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
		strict: true,
	});
	if (positionals.length > 0) {
		throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
	}
	const version = values.version !== undefined ? validateVersion(values.version) : undefined;
	const platform = values.platform !== undefined ? validatePlatform(values.platform) : undefined;
	const arch = values.arch;
	if (arch !== undefined) {
		if (!["x64", "arm64", "all"].includes(arch)) {
			throw new Error(`Invalid target arch "${String(arch)}": expected x64, arm64, or all`);
		}
		if (platform !== undefined) {
			resolveTargetArchitectures(platform, arch);
		}
	}
	return {
		version,
		platform,
		arch,
		skipBuild: Boolean(values["skip-build"]),
		dryRun: Boolean(values["dry-run"]),
		help: Boolean(values.help),
	};
}

export async function readDefaultVersion(repoRoot) {
	const desktopPkgPath = resolve(repoRoot, "packages/desktop/package.json");
	const raw = await readFile(desktopPkgPath, "utf8");
	const parsed = JSON.parse(raw);
	return validateVersion(parsed.version);
}

export function resolveReleasePaths(repoRoot, version, options = {}) {
	const validVersion = validateVersion(version);
	const platform = options.platform !== undefined ? validatePlatform(options.platform) : "win";
	const archs = resolveTargetArchitectures(platform, options.arch);

	if (platform === "win") {
		const releaseDir = resolve(repoRoot, "dist", `wenyou-pro-${validVersion}-win-x64`);
		const rawDir = join(releaseDir, "raw");
		const unpackedDir = join(rawDir, "win-unpacked");
		const setupFileName = `Wenyou-Pro-Setup-${validVersion}-x64.exe`;
		const portableFileName = `Wenyou-Pro-Portable-${validVersion}-x64.zip`;
		return {
			platform: "win",
			archs,
			version: validVersion,
			releaseDir,
			rawDir,
			unpackedDir,
			setupFileName,
			portableFileName,
			expectedArtifacts: [setupFileName, portableFileName],
			setupRawPath: join(rawDir, setupFileName),
			portableRawPath: join(rawDir, portableFileName),
			setupDestPath: join(releaseDir, setupFileName),
			portableDestPath: join(releaseDir, portableFileName),
			sha256Path: join(releaseDir, "SHA256SUMS.txt"),
			notesPath: join(releaseDir, "使用说明.txt"),
			builderOutputRelative: `../../dist/wenyou-pro-${validVersion}-win-x64/raw`,
		};
	}

	if (platform === "mac") {
		const releaseDir = resolve(repoRoot, "dist", `wenyou-pro-${validVersion}-mac`);
		const rawDir = join(releaseDir, "raw");
		const expectedArtifacts = archs.flatMap((a) => [
			`Wenyou-Pro-${validVersion}-mac-${a}.dmg`,
			`Wenyou-Pro-${validVersion}-mac-${a}.zip`,
		]);
		const unpackedDirs = archs.map((a) => {
			const unpackedFolder = a === "arm64" ? "mac-arm64" : "mac";
			return {
				arch: a,
				dir: join(rawDir, unpackedFolder),
				appBundle: join(rawDir, unpackedFolder, "Wenyou Pro.app"),
			};
		});
		return {
			platform: "mac",
			archs,
			version: validVersion,
			releaseDir,
			rawDir,
			unpackedDirs,
			expectedArtifacts,
			sha256Path: join(releaseDir, "SHA256SUMS.txt"),
			notesPath: join(releaseDir, "使用说明.txt"),
			builderOutputRelative: `../../dist/wenyou-pro-${validVersion}-mac/raw`,
		};
	}

	// linux
	const targetArch = archs[0];
	const releaseDir = resolve(repoRoot, "dist", `wenyou-pro-${validVersion}-linux-${targetArch}`);
	const rawDir = join(releaseDir, "raw");
	const unpackedDir = join(rawDir, "linux-unpacked");
	const expectedArtifacts = archs.map(
		(a) => `Wenyou-Pro-${validVersion}-linux-${formatLinuxArtifactArch(a)}.AppImage`,
	);
	return {
		platform: "linux",
		archs,
		version: validVersion,
		releaseDir,
		rawDir,
		unpackedDir,
		expectedArtifacts,
		sha256Path: join(releaseDir, "SHA256SUMS.txt"),
		notesPath: join(releaseDir, "使用说明.txt"),
		builderOutputRelative: `../../dist/wenyou-pro-${validVersion}-linux-${targetArch}/raw`,
	};
}

/**
 * Build a standalone electron-builder override config object that extends
 * `electron-builder.wenyou.yml` (resolved relative to `packages/desktop`) and overrides
 * `directories.output` + `extraMetadata.version`.
 *
 * Platform-specific `extraResources` (filtering `ntqq-vfs` to `.py`-only on macOS/Linux
 * and scoping `update-diagnostics` + `wenyou-pro.ico` exclusively to Windows) live under
 * `win`/`mac`/`linux` in `electron-builder.wenyou.yml` because electron-builder's
 * `deepAssign` concatenates arrays when merging `extends`.
 */
export function buildElectronBuilderConfigOverride(
	versionOrRepoRoot,
	maybeVersionOrOptions,
	maybeOptions,
) {
	let version;
	let options = {};
	if (typeof maybeVersionOrOptions === "string") {
		version = maybeVersionOrOptions;
		options = maybeOptions ?? {};
	} else if (maybeVersionOrOptions && typeof maybeVersionOrOptions === "object") {
		version = versionOrRepoRoot;
		options = maybeVersionOrOptions;
	} else {
		version = versionOrRepoRoot;
	}

	const validVersion = validateVersion(version);
	const platform = options.platform !== undefined ? validatePlatform(options.platform) : "win";
	const archs = resolveTargetArchitectures(platform, options.arch);
	const output =
		platform === "win"
			? `../../dist/wenyou-pro-${validVersion}-win-x64/raw`
			: platform === "mac"
				? `../../dist/wenyou-pro-${validVersion}-mac/raw`
				: `../../dist/wenyou-pro-${validVersion}-linux-${archs[0]}/raw`;

	return {
		extends: "electron-builder.wenyou.yml",
		directories: {
			output,
		},
		extraMetadata: {
			version: validVersion,
		},
	};
}

export function buildElectronBuilderArgs(configPath = "electron-builder.wenyou.yml", options = {}) {
	const platform = options.platform !== undefined ? validatePlatform(options.platform) : "win";
	const archs = resolveTargetArchitectures(platform, options.arch);
	const archFlags = archs.map((a) => `--${a}`);

	if (platform === "win") {
		return ["--config", configPath, "--win", "nsis", "zip", ...archFlags, "--publish", "never"];
	}
	if (platform === "mac") {
		return ["--config", configPath, "--mac", "dmg", "zip", ...archFlags, "--publish", "never"];
	}
	return ["--config", configPath, "--linux", "AppImage", ...archFlags, "--publish", "never"];
}

export function validateMultiSizeIcoBuffer(buffer, label = "wenyou-pro.ico") {
	if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
		throw new Error(
			`Invalid ICO file "${label}": expected at least 22 bytes (ICONDIR + 1 entry), got ${buffer ? buffer.length : 0}`,
		);
	}

	const reserved = buffer.readUInt16LE(0);
	const type = buffer.readUInt16LE(2);
	const count = buffer.readUInt16LE(4);
	if (reserved !== 0 || type !== 1 || count < 1) {
		throw new Error(
			`Invalid ICO header in "${label}": reserved=${reserved}, type=${type}, count=${count} (expected reserved=0, type=1, count>=1)`,
		);
	}

	const directoryEnd = 6 + count * 16;
	if (buffer.length < directoryEnd) {
		throw new Error(
			`Truncated ICO directory in "${label}": expected at least ${directoryEnd} bytes for ${count} entries, got ${buffer.length}`,
		);
	}

	const sizes = [];
	let has256 = false;
	for (let i = 0; i < count; i += 1) {
		const offset = 6 + i * 16;
		const rawWidth = buffer[offset];
		const rawHeight = buffer[offset + 1];
		const bytesInRes = buffer.readUInt32LE(offset + 8);
		const imageOffset = buffer.readUInt32LE(offset + 12);

		if (bytesInRes === 0 || imageOffset < directoryEnd || imageOffset + bytesInRes > buffer.length) {
			throw new Error(
				`Corrupted ICO entry #${i} in "${label}": imageOffset=${imageOffset}, bytesInRes=${bytesInRes}, fileBytes=${buffer.length}`,
			);
		}

		const width = rawWidth === 0 ? 256 : rawWidth;
		const height = rawHeight === 0 ? 256 : rawHeight;
		sizes.push(`${width}x${height}`);
		if (rawWidth === 0 && rawHeight === 0) {
			const isPngPayload =
				bytesInRes >= 8 &&
				buffer[imageOffset] === 0x89 &&
				buffer[imageOffset + 1] === 0x50 &&
				buffer[imageOffset + 2] === 0x4e &&
				buffer[imageOffset + 3] === 0x47 &&
				buffer[imageOffset + 4] === 0x0d &&
				buffer[imageOffset + 5] === 0x0a &&
				buffer[imageOffset + 6] === 0x1a &&
				buffer[imageOffset + 7] === 0x0a;
			const isDibPayload = bytesInRes >= 40 && buffer.readUInt32LE(imageOffset) === 40;
			if (!isPngPayload && !isDibPayload) {
				throw new Error(
					`Invalid 256x256 ICO frame payload in "${label}": expected PNG signature (89 50 4E 47) or BITMAPINFOHEADER DIB (28 00 00 00)`,
				);
			}
			has256 = true;
		}
	}

	if (!has256) {
		throw new Error(
			`ICO file "${label}" is missing a 256x256 frame (found: ${sizes.join(", ")})`,
		);
	}

	return {
		count,
		sizes,
		has256: true,
	};
}

export function validatePngIconBuffer(buffer, label = "icon.png", minDimension = 512) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
		throw new Error(
			`Invalid PNG icon "${label}": expected at least 24 bytes (signature + IHDR), got ${buffer ? buffer.length : 0}`,
		);
	}
	const isPngSig =
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a;
	if (!isPngSig) {
		throw new Error(`Invalid PNG signature in "${label}"`);
	}
	const ihdrLen = buffer.readUInt32BE(8);
	const ihdrType = buffer.subarray(12, 16).toString("ascii");
	if (ihdrLen !== 13 || ihdrType !== "IHDR") {
		throw new Error(`Invalid PNG IHDR chunk in "${label}": type=${ihdrType}, length=${ihdrLen}`);
	}
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	if (width < minDimension || height < minDimension) {
		throw new Error(
			`PNG icon "${label}" dimensions ${width}x${height} are below minimum ${minDimension}x${minDimension}`,
		);
	}
	return { width, height, bytes: buffer.length };
}

export function getRequiredPrerequisites(platform = "win") {
	const validPlatform = validatePlatform(platform);
	if (validPlatform === "win") return REQUIRED_PREREQUISITES;
	if (validPlatform === "mac") return REQUIRED_MAC_PREREQUISITES;
	return REQUIRED_LINUX_PREREQUISITES;
}

export async function checkPrerequisites(repoRoot, options = {}) {
	const platform = options.platform !== undefined ? validatePlatform(options.platform) : "win";
	const requiredFiles = getRequiredPrerequisites(platform);
	const missing = [];
	const empty = [];
	const checked = [];

	for (const relPath of requiredFiles) {
		const absPath = resolve(repoRoot, relPath);
		try {
			const info = await stat(absPath);
			if (!info.isFile()) {
				missing.push(relPath);
			} else if (info.size <= 0) {
				empty.push(relPath);
			} else {
				checked.push({ path: relPath, bytes: info.size });
			}
		} catch {
			missing.push(relPath);
		}
	}

	if (missing.length > 0 || empty.length > 0) {
		const parts = [];
		if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
		if (empty.length > 0) parts.push(`empty: ${empty.join(", ")}`);
		throw new Error(
			`Wenyou release prerequisite check failed for ${platform} (${parts.join("; ")})`,
		);
	}

	let icon;
	if (platform === "win") {
		const icoRelPath = "packages/desktop/build/wenyou-pro.ico";
		const icoBuffer = await readFile(resolve(repoRoot, icoRelPath));
		icon = validateMultiSizeIcoBuffer(icoBuffer, icoRelPath);
	} else {
		const pngRelPath = "packages/desktop/build/icon.png";
		const pngBuffer = await readFile(resolve(repoRoot, pngRelPath));
		icon = validatePngIconBuffer(pngBuffer, pngRelPath, 512);
	}

	return { ok: true, platform, checked, icon };
}

export function formatReleaseNotes(version) {
	const validVersion = validateVersion(version);
	const setupName = `Wenyou-Pro-Setup-${validVersion}-x64.exe`;
	const portableName = `Wenyou-Pro-Portable-${validVersion}-x64.zip`;
	const lines = [
		`司命 · 文游 Pro（Wenyou Pro v${validVersion} Windows x64）使用说明`,
		"制作与整理：安钰（基于 Jaxton07/percho MIT 开源底座深度定制）",
		"项目仓库：https://github.com/anyu0804/wenyou-pro",
		"================================================================",
		"",
		"一、安装包选择",
		`1. 安装版：${setupName}`,
		"   双击运行中文安装向导，支持自选安装目录，自动创建名为「司命 · 文游 Pro」的桌面与开始菜单快捷方式，自带卸载程序。",
		`2. 绿色免安装便携版：${portableName}`,
		"   解压到任意目录后，直接双击其中的 Wenyou Pro.exe 即可运行，适合群文件分发或免安装试用。",
		"",
		`二、v${validVersion} 核心特性（零外部依赖开箱即用）`,
		"1. 全新「司命 · 文游 Pro」品牌视觉与 7 层高清图标（防桌面图标缓存残留）",
		"   - 桌面与开始菜单快捷方式正式定名为「司命 · 文游 Pro」，同步清理旧名快捷方式并保留自动备份。",
		"   - 全新重制 7 层多尺寸高清 .ico 图标（覆盖 16x16 至 256x256 图层），并配套版本化独立图标与 Shell 刷新机制，避免 Windows Explorer 缓存旧图标。",
		"2. 跨世界动态沙盘物理隔离与 FMG .map 精准解析",
		"   - 通过内置特权协议 wenyou-sandbox:// 离线直载 Pixi 动态沙盘，支持工作区 PNG/JPG/WEBP/SVG",
		"     地图一键「在沙盘中编辑此图」、自动静默落盘并在重开时恢复，支持比例尺公里测距与邻国核账。",
		"   - 强化跨世界动态沙盘物理隔离与防串档机制，切换不同世界目录时草稿与态势状态互不污染。",
		"   - 完整支持 FMG .map 多行 SVG 渲染以及高程与拆分编制兵力数据的精准解析。",
		"3. 三段式 L1 局势简报、宋体 .docx 国策书案与设定编年史速览",
		"   - 基于多群 L0 原始证据与增量游标自动汇总三段式 L1 局势简报与跨群滚动台账，关键节点附带原文溯源。",
		"   - 原生输出标准宋体自然段 .docx 国策书案，右侧工作台提供设定实册与编年史只读速览。",
		"4. 随包内置官方签名 Python 3.13 运行时（彻底免装 Python）",
		"   - 已直接内置 Python Software Foundation 官方签名的 Windows 绿色嵌入式运行时，",
		"     普通玩家无需安装 Python 或任何第三方依赖；只要电脑登录着 PC 版 QQ，即可一键提取密钥并只读直采群聊。",
		"5. 修复本人发言（40030=0）漏采与最高 20,000 条长程传话溯源",
		"   - 统一以 40027 群号索引列读取本机 NTQQ 群聊记录，完整保留用户本人发出的消息与回复上下文。",
		"   - 「核查群内传闻辨明真伪」支持全库长程回溯（最高 20,000 条/群），按最早原话（earliest）到最新传播还原",
		"     「最初原话 -> 转述走样点」；原文上下文抽屉默认 ±30 条，并支持一键切至 ±100 / ±300 / ±1000",
		"     及首尾连续翻页追源。",
		"   - 新建世界与「绑定 QQ 群」弹窗支持自选单群拉取历史深度（500 / 2,000 / 5,000 / 20,000 条）",
		"     与回溯补抓更早历史（按时间线幂等去重合入，不污染未汇报游标）。",
		"",
		"三、Windows 首次运行提示",
		"由于本版本为社区自编译安装包（未购买商业代码签名证书），首次双击安装或运行时，",
		"如果 Windows Defender SmartScreen 弹出“Windows 已保护你的电脑”，",
		"请点击“更多信息” -> “仍要运行”即可继续。",
		"",
		"四、首次打开两步配置",
		"1. 第 1 步：接入模型",
		"   - DeepSeek、Google Gemini、硅基流动、火山方舟、阿里百炼等使用 API Key 的服务商，",
		"     请在「填写 API Key」或「自定义中转站」页签中填入密钥。",
		"   - ChatGPT / OpenAI Codex、Claude、GitHub Copilot、Kimi Code 等支持官方 OAuth",
		"     登录的订阅账号，请在「接入订阅账号」页签中点击登录。",
		"2. 第 2 步：绑定本人 QQ 号（可选，无需安装 Python）",
		"   - 保持 PC 版 QQ 处于已登录状态，填入本人 QQ 号并点击「一键提取密钥」即可启用本机只读直采。",
		"   - 暂不使用本机直采也可先跳过，后续直接把导出的 .txt / .json 聊天记录放入世界目录的",
		"     00-群聊收集/ 文件夹即可。",
		"",
		"五、隐私与数据安全说明",
		"- 所有个人配置、模型 API Key、聊天证据与世界目录默认保存在你本机用户目录",
		"  %USERPROFILE%\\.wenyou-pro\\ 下，不会上传到任何第三方中转服务器。",
		"- 本机 NTQQ 采集全程为只读解析，绝不修改 QQ 原数据库，也绝不代发任何 QQ 消息。",
		"- 世界存档、聊天证据与工作区设定均保存在你自选的本地世界目录中，完全由你自主掌控。",
		"",
		"六、开源致谢",
		"本软件基于 MIT 协议的开源项目 Percho（https://github.com/Jaxton07/percho）定制开发，",
		"随包内置的嵌入式 Python 3.13 运行时遵循 Python Software Foundation License v2（详见 resources/ntqq-vfs/python/LICENSE.txt）。",
	];
	return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function formatMacReleaseNotes(version, archs = ["arm64", "x64"]) {
	const validVersion = validateVersion(version);
	const normalizedArchs =
		Array.isArray(archs) && archs.length > 0 ? archs : ["arm64", "x64"];
	const installLines = [];
	if (normalizedArchs.includes("arm64")) {
		installLines.push(
			"1. Apple Silicon（M1 / M2 / M3 / M4 芯片 Mac）：",
			`   - 推荐磁盘镜像安装包：Wenyou-Pro-${validVersion}-mac-arm64.dmg`,
			`   - 便携压缩包：Wenyou-Pro-${validVersion}-mac-arm64.zip`,
		);
	}
	if (normalizedArchs.includes("x64")) {
		const idx = normalizedArchs.includes("arm64") ? 2 : 1;
		installLines.push(
			`${idx}. Intel 芯片 Mac：`,
			`   - 推荐磁盘镜像安装包：Wenyou-Pro-${validVersion}-mac-x64.dmg`,
			`   - 便携压缩包：Wenyou-Pro-${validVersion}-mac-x64.zip`,
		);
	}

	const lines = [
		`司命 · 文游 Pro（Wenyou Pro v${validVersion} macOS）使用说明`,
		"制作与整理：安钰（基于 Jaxton07/percho MIT 开源底座深度定制）",
		"项目仓库：https://github.com/anyu0804/wenyou-pro",
		"================================================================",
		"",
		"一、安装包选择与安装",
		...installLines,
		"安装方法：双击 .dmg 磁盘镜像后，将 Wenyou Pro.app 拖入 Applications（应用程序）文件夹即可。",
		"提示：不知道本机芯片类型时，点击屏幕左上角「苹果图标 -> 关于本机」，查看“芯片”或“处理器”一栏。",
		"",
		"二、macOS 首次打开 Gatekeeper 放行步骤（必读）",
		"本版本为社区自编译发行版，采用本地临时签名（ad-hoc signing），未购买 Apple Developer 公证证书。",
		"首次启动时，macOS Gatekeeper 可能会提示“无法验证开发者”或阻止打开，请按以下任一方式放行：",
		"方法 1（图形界面推荐）：",
		"  1. 先双击一次应用程序中的 Wenyou Pro.app（触发系统记录后点“完成”或“取消”）；",
		"  2. 打开「系统设置 -> 隐私与安全性」，向下滚动到“安全性”区域；",
		"  3. 点击 Wenyou Pro 旁的「仍要打开」，并输入本机开机密码确认即可正常启动。",
		"方法 2（终端一键清除隔离属性）：",
		"  将 Wenyou Pro.app 放入「应用程序」文件夹后，打开“终端（Terminal）”执行：",
		'  xattr -cr "/Applications/Wenyou Pro.app"',
		"",
		`三、v${validVersion} 核心特性`,
		"1. 全新「司命 · 文游 Pro」原生 1024x1024 品牌图标与跨世界动态沙盘物理隔离",
		"   - 通过内置特权协议 wenyou-sandbox:// 离线直载 Pixi 动态沙盘，支持工作区 PNG/JPG/WEBP/SVG",
		"     地图一键「在沙盘中编辑此图」、自动静默落盘并在重开时恢复，支持比例尺公里测距与邻国核账。",
		"   - 强化跨世界动态沙盘物理隔离与防串档机制，切换不同世界目录时草稿与态势状态互不污染。",
		"   - 完整支持 FMG .map 多行 SVG 渲染以及高程与拆分编制兵力数据的精准解析。",
		"2. 三段式 L1 局势简报、宋体 .docx 国策书案与设定编年史速览",
		"   - 基于多群 L0 原始证据与增量游标自动汇总三段式 L1 局势简报与跨群滚动台账，关键节点附带原文溯源。",
		"   - 原生输出标准宋体自然段 .docx 国策书案，右侧工作台提供设定实册与编年史只读速览。",
		"3. 最高 20,000 条长程传话溯源、增量游标与上下文抽屉",
		"   - 「核查群内传闻辨明真伪」支持全库长程回溯（最高 20,000 条/群）与双游标增量同步，还原「最初原话 -> 转述走样点」。",
		"",
		"四、首次打开两步配置与群聊导入",
		"1. 第 1 步：接入模型",
		"   - DeepSeek、Google Gemini、硅基流动、火山方舟、阿里百炼等使用 API Key 的服务商，",
		"     请在「填写 API Key」或「自定义中转站」页签中填入密钥。",
		"   - ChatGPT / OpenAI Codex、Claude、GitHub Copilot、Kimi Code 等支持官方 OAuth",
		"     登录的订阅账号，请在「接入订阅账号」页签中点击登录。",
		"2. 第 2 步：导入群聊记录（macOS 推荐方式）",
		"   - 通用零门槛方式：直接将导出的 .txt / .json 聊天记录放入对应世界目录的",
		"     00-群聊收集/ 文件夹中即可在 Wenyou Pro 内整理、核查传闻与起草国策。",
		"   - 高级用户本机 NTQQ 只读解析：macOS 发行包内置纯 Python 只读 VFS 脚本（通过系统自带 python3",
		"     与 macOS 原生 CommonCrypto 解密，零第三方包、且不含任何 Windows .exe/.dll 组件）。",
		"     如你已准备好 macOS NTQQ 数据库目录与导出的 key_map.json，可在设置页指定目录与密钥文件启用只读采集。",
		"",
		"五、隐私与数据安全说明",
		"- 所有个人配置、模型 API Key、聊天证据与世界目录默认保存在你本机用户目录 ~/.wenyou-pro/ 下；",
		"  桌面端运行状态与日志保存在 ~/Library/Application Support/Wenyou Pro/ 下，不会上传到任何第三方中转服务器。",
		"- 本机聊天解析全程为只读操作，绝不修改原数据库，也绝不代发任何消息。",
		"- 世界存档、聊天证据与工作区设定均保存在你自选的本地世界目录中，完全由你自主掌控。",
		"",
		"六、开源致谢",
		"本软件基于 MIT 协议的开源项目 Percho（https://github.com/Jaxton07/percho）定制开发。",
	];
	return `\uFEFF${lines.join("\n")}\n`;
}

export function formatLinuxReleaseNotes(version, archs = ["x64"]) {
	const validVersion = validateVersion(version);
	const normalizedArchs = Array.isArray(archs) && archs.length > 0 ? archs : ["x64"];
	const artifactLines = normalizedArchs.map((a, idx) => {
		const artifactArch = formatLinuxArtifactArch(a);
		return `${idx + 1}. AppImage (${artifactArch})：Wenyou-Pro-${validVersion}-linux-${artifactArch}.AppImage`;
	});
	const lines = [
		`司命 · 文游 Pro（Wenyou Pro v${validVersion} Linux）使用说明`,
		"制作与整理：安钰（基于 Jaxton07/percho MIT 开源底座深度定制）",
		"项目仓库：https://github.com/anyu0804/wenyou-pro",
		"================================================================",
		"",
		"一、安装包与运行方式",
		...artifactLines,
		"赋予可执行权限后直接运行：chmod +x Wenyou-Pro-*.AppImage && ./Wenyou-Pro-*.AppImage",
		"",
		"二、群聊导入与隐私说明",
		"- 将导出的 .txt / .json 聊天记录放入对应世界目录的 00-群聊收集/ 文件夹即可使用。",
		"- 个人配置与世界目录默认保存在 ~/.wenyou-pro/ 下，桌面运行状态保存在 ~/.config/Wenyou Pro/ 下。",
		"",
		"三、开源致谢",
		"本软件基于 MIT 协议的开源项目 Percho（https://github.com/Jaxton07/percho）定制开发。",
	];
	return `\uFEFF${lines.join("\n")}\n`;
}

export function formatSha256Sums(entries) {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw new Error("formatSha256Sums requires a non-empty array of { name, sha256 } entries");
	}
	const lines = entries.map((entry) => {
		const name = entry?.name;
		const digest = typeof entry?.sha256 === "string" ? entry.sha256.toLowerCase() : "";
		if (typeof name !== "string" || name.length === 0 || /[/\\]/.test(name) || name.includes("..")) {
			throw new Error(`Invalid artifact filename for SHA256SUMS: "${String(name)}"`);
		}
		if (!SHA256_HEX_PATTERN.test(digest)) {
			throw new Error(`Invalid SHA-256 digest for "${name}": "${String(entry?.sha256)}"`);
		}
		return `${digest}  ${name}\n`;
	});
	return lines.join("");
}

export async function computeSha256(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function renameWithRetry(sourcePath, destinationPath) {
	let lastError;
	for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			await rename(sourcePath, destinationPath);
			return;
		} catch (error) {
			lastError = error;
			const code = error && typeof error === "object" ? error.code : undefined;
			if (!RETRYABLE_RENAME_CODES.has(code) || attempt === RENAME_RETRY_DELAYS_MS.length) {
				throw error;
			}
			await delay(RENAME_RETRY_DELAYS_MS[attempt]);
		}
	}
	throw lastError;
}

export async function moveFileSafely(sourcePath, destinationPath) {
	const resolvedSrc = resolve(sourcePath);
	const resolvedDest = resolve(destinationPath);
	const isSamePath =
		process.platform === "win32"
			? resolvedSrc.toLowerCase() === resolvedDest.toLowerCase()
			: resolvedSrc === resolvedDest;
	if (isSamePath) return;

	await mkdir(dirname(resolvedDest), { recursive: true });
	try {
		await renameWithRetry(resolvedSrc, resolvedDest);
		return;
	} catch (error) {
		const code = error && typeof error === "object" ? error.code : undefined;
		if (code !== "EXDEV" && !RETRYABLE_RENAME_CODES.has(code)) {
			throw error;
		}
	}

	const stagedPath = `${resolvedDest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	try {
		await copyFile(resolvedSrc, stagedPath);
		await renameWithRetry(stagedPath, resolvedDest);
	} catch (error) {
		await rm(stagedPath, { force: true }).catch(() => {});
		throw error;
	}
	await rm(resolvedSrc, { force: true });
}

export async function collectReleaseArtifacts({
	releaseDir,
	rawDir,
	version,
	platform = "win",
	arch,
}) {
	const validVersion = validateVersion(version);
	const validPlatform = validatePlatform(platform);
	const archs = resolveTargetArchitectures(validPlatform, arch);
	if (!releaseDir) {
		throw new Error("collectReleaseArtifacts requires releaseDir");
	}
	const resolvedReleaseDir = resolve(releaseDir);
	const resolvedRawDir = resolve(rawDir ?? join(resolvedReleaseDir, "raw"));

	const expectedFiles =
		validPlatform === "win"
			? [
					`Wenyou-Pro-Setup-${validVersion}-x64.exe`,
					`Wenyou-Pro-Portable-${validVersion}-x64.zip`,
				]
			: validPlatform === "mac"
				? archs.flatMap((a) => [
						`Wenyou-Pro-${validVersion}-mac-${a}.dmg`,
						`Wenyou-Pro-${validVersion}-mac-${a}.zip`,
					])
				: archs.map((a) => `Wenyou-Pro-${validVersion}-linux-${formatLinuxArtifactArch(a)}.AppImage`);

	for (const fileName of expectedFiles) {
		const srcPath = join(resolvedRawDir, fileName);
		let info;
		try {
			info = await stat(srcPath);
		} catch {
			throw new Error(`Missing built artifact in raw directory: ${fileName}`);
		}
		if (!info.isFile() || info.size <= 0) {
			throw new Error(`Built artifact is empty or not a regular file: ${fileName}`);
		}
	}

	await mkdir(resolvedReleaseDir, { recursive: true });
	const artifacts = [];
	for (const fileName of expectedFiles) {
		const srcPath = join(resolvedRawDir, fileName);
		const destPath = join(resolvedReleaseDir, fileName);
		await moveFileSafely(srcPath, destPath);
		const info = await stat(destPath);
		const digest = await computeSha256(destPath);
		artifacts.push({
			name: fileName,
			path: destPath,
			bytes: info.size,
			sha256: digest,
		});
	}

	const sha256Path = join(resolvedReleaseDir, "SHA256SUMS.txt");
	const sha256Content = formatSha256Sums(artifacts);
	await writeFile(sha256Path, sha256Content, "utf8");

	const notesPath = join(resolvedReleaseDir, "使用说明.txt");
	const notesContent =
		validPlatform === "win"
			? formatReleaseNotes(validVersion)
			: validPlatform === "mac"
				? formatMacReleaseNotes(validVersion, archs)
				: formatLinuxReleaseNotes(validVersion, archs);
	await writeFile(notesPath, notesContent, "utf8");

	return {
		platform: validPlatform,
		archs,
		version: validVersion,
		releaseDir: resolvedReleaseDir,
		rawDir: resolvedRawDir,
		artifacts,
		sha256Path,
		notesPath,
	};
}

export function sanitizeTextForLog(input, homeDir = os.homedir()) {
	const text = typeof input === "string" ? input : String(input ?? "");
	if (!homeDir) return text;
	const trimmedHome = homeDir.replace(/[\\/]+$/, "");
	if (!trimmedHome) return text;

	const segments = trimmedHome.split(/[\\/]+/).filter(Boolean);
	if (segments.length === 0) return text;

	const boundaryAfter = "(?=$|[\\\\/\\s\"'`,;)\\]}:.<>，。；：！？、】【（）])";
	const patterns = [];
	const driveMatch = /^([A-Za-z]):$/.exec(segments[0]);
	if (driveMatch) {
		const driveLetter = driveMatch[1];
		const restPattern = segments.slice(1).map(escapeRegExp).join("[\\\\/]+");
		if (restPattern) {
			patterns.push(
				new RegExp(
					`(^|[^A-Za-z0-9_])${escapeRegExp(driveLetter)}:[\\\\/]+${restPattern}${boundaryAfter}`,
					"gi",
				),
			);
			patterns.push(
				new RegExp(
					`(^|[^A-Za-z0-9_])/${escapeRegExp(driveLetter)}[\\\\/]+${restPattern}${boundaryAfter}`,
					"gi",
				),
			);
		}
	} else {
		const joined = segments.map(escapeRegExp).join("[\\\\/]+");
		const flags = process.platform === "win32" ? "gi" : "g";
		patterns.push(new RegExp(`(^|[^A-Za-z0-9_])[\\\\/]+${joined}${boundaryAfter}`, flags));
	}

	let sanitized = text;
	for (const pattern of patterns) {
		sanitized = sanitized.replace(pattern, "$1~");
	}
	return sanitized;
}

export function sanitizePathForLog(targetPath, repoRoot, homeDir = os.homedir()) {
	if (repoRoot) {
		const rel = relative(repoRoot, targetPath);
		if (rel && !rel.startsWith("..") && !rel.includes(":")) {
			return rel.replace(/\\/g, "/");
		}
	}
	return sanitizeTextForLog(targetPath, homeDir).replace(/\\/g, "/");
}

function runCommand(command, args, options = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		const stop = (signal) => child.kill(signal);
		const onSigInt = () => stop("SIGINT");
		const onSigTerm = () => stop("SIGTERM");
		process.once("SIGINT", onSigInt);
		process.once("SIGTERM", onSigTerm);
		const cleanup = () => {
			process.off("SIGINT", onSigInt);
			process.off("SIGTERM", onSigTerm);
		};
		child.once("error", (error) => {
			cleanup();
			rejectPromise(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			if (code === 0) resolvePromise();
			else rejectPromise(new Error(`${command} exited with ${signal ?? code}`));
		});
	});
}

export function resolveNpmCommand(
	npmArgs,
	{ env = process.env, execPath = process.execPath, existsFn = existsSync, platform = process.platform } = {},
) {
	const npmExecPath = env?.npm_execpath;
	if (
		typeof npmExecPath === "string" &&
		NPM_EXECPATH_BASENAME_PATTERN.test(posix.basename(npmExecPath.replaceAll("\\", "/"))) &&
		existsFn(npmExecPath)
	) {
		return { command: execPath, args: [npmExecPath, ...npmArgs], shell: false };
	}
	const bundledNpmCli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (existsFn(bundledNpmCli)) {
		return { command: execPath, args: [bundledNpmCli, ...npmArgs], shell: false };
	}
	if (platform === "win32") {
		return { command: "npm.cmd", args: npmArgs, shell: true };
	}
	return { command: "npm", args: npmArgs, shell: false };
}

function resolveElectronBuilderCli(repoRoot) {
	const desktopPkgPath = resolve(repoRoot, "packages/desktop/package.json");
	const req = createRequire(desktopPkgPath);
	return join(dirname(req.resolve("electron-builder/package.json")), "cli.js");
}

async function createTempBuilderConfigDir(repoRoot) {
	const localTmpBase = resolve(repoRoot, ".local", "tmp");
	try {
		await mkdir(localTmpBase, { recursive: true });
		return await mkdtemp(join(localTmpBase, "wenyou-builder-cfg-"));
	} catch {
		return await mkdtemp(join(os.tmpdir(), "wenyou-builder-cfg-"));
	}
}

export async function buildWenyouInstaller({
	repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
	version,
	platform,
	arch,
	hostPlatform = process.platform,
	skipBuild = false,
	dryRun = false,
	runFn = runCommand,
	resolveBuilderCli = resolveElectronBuilderCli,
} = {}) {
	const resolvedRoot = resolve(repoRoot);
	const resolvedPlatform =
		platform !== undefined ? validatePlatform(platform) : resolveDefaultPlatform(hostPlatform);
	const archs = resolveTargetArchitectures(resolvedPlatform, arch);
	const resolvedVersion =
		version !== undefined ? validateVersion(version) : await readDefaultVersion(resolvedRoot);
	const prereq = await checkPrerequisites(resolvedRoot, { platform: resolvedPlatform });
	const paths = resolveReleasePaths(resolvedRoot, resolvedVersion, {
		platform: resolvedPlatform,
		arch,
	});
	const builderConfigOverride = buildElectronBuilderConfigOverride(resolvedVersion, {
		platform: resolvedPlatform,
		arch,
	});

	if (dryRun) {
		const previewArgs = buildElectronBuilderArgs("electron-builder.wenyou.yml", {
			platform: resolvedPlatform,
			arch,
		});
		return {
			dryRun: true,
			platform: resolvedPlatform,
			archs,
			version: resolvedVersion,
			skipBuild,
			prerequisites: prereq.checked.map((item) => item.path),
			icon: prereq.icon,
			steps: [
				...(skipBuild ? [] : ["npm run build -w packages/desktop"]),
				`electron-builder ${previewArgs.join(" ")} (override directories.output=${paths.builderOutputRelative}, extraMetadata.version=${resolvedVersion})`,
				`collect artifacts into ${sanitizePathForLog(paths.releaseDir, resolvedRoot)}`,
			],
			builderArgs: previewArgs,
			builderConfigOverride,
			releaseDir: paths.releaseDir,
			rawDir: paths.rawDir,
			outputs: [...paths.expectedArtifacts, "SHA256SUMS.txt", "使用说明.txt"],
		};
	}

	if (!skipBuild) {
		const npmInvocation = resolveNpmCommand(["run", "build", "-w", "packages/desktop"]);
		await runFn(npmInvocation.command, npmInvocation.args, {
			cwd: resolvedRoot,
			shell: npmInvocation.shell,
			env: process.env,
		});
	}

	const builderCli = resolveBuilderCli(resolvedRoot);
	const tempConfigDir = await createTempBuilderConfigDir(resolvedRoot);
	const overrideConfigPath = join(tempConfigDir, "electron-builder.override.json");
	try {
		await writeFile(overrideConfigPath, `${JSON.stringify(builderConfigOverride, null, 2)}\n`, "utf8");
		const builderArgs = buildElectronBuilderArgs(overrideConfigPath, {
			platform: resolvedPlatform,
			arch,
		});
		await runFn(process.execPath, [builderCli, ...builderArgs], {
			cwd: resolve(resolvedRoot, "packages/desktop"),
			shell: false,
			env: process.env,
		});
	} finally {
		await rm(tempConfigDir, { recursive: true, force: true });
	}

	const archived = await collectReleaseArtifacts({
		releaseDir: paths.releaseDir,
		rawDir: paths.rawDir,
		version: resolvedVersion,
		platform: resolvedPlatform,
		arch,
	});

	return {
		dryRun: false,
		version: resolvedVersion,
		skipBuild,
		...archived,
	};
}

function printUsage() {
	console.log(
		[
			"Usage: node scripts/wenyou-release/build-installer.mjs [options]",
			"",
			"Options:",
			"  --platform <win|mac|linux>  Target platform (default: auto-mapped from process.platform)",
			"  --arch <x64|arm64|all>      Target architecture (mac default: all; win/linux default: x64)",
			"  --version <X.Y.Z>           Override target release version (default: packages/desktop/package.json)",
			"  --skip-build                Skip `npm run build -w packages/desktop` and run packaging directly",
			"  --dry-run                   Validate prerequisites and print the release plan without building",
			"  -h, --help                  Show this help message",
		].join("\n"),
	);
}

async function main() {
	const args = parseBuildArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const result = await buildWenyouInstaller({
		repoRoot,
		version: args.version,
		platform: args.platform,
		arch: args.arch,
		skipBuild: args.skipBuild,
		dryRun: args.dryRun,
	});
	const summary = {
		...result,
		releaseDir: sanitizePathForLog(result.releaseDir, repoRoot),
		rawDir: sanitizePathForLog(result.rawDir, repoRoot),
		...(result.sha256Path ? { sha256Path: sanitizePathForLog(result.sha256Path, repoRoot) } : {}),
		...(result.notesPath ? { notesPath: sanitizePathForLog(result.notesPath, repoRoot) } : {}),
		...(result.artifacts
			? {
					artifacts: result.artifacts.map((item) => ({
						name: item.name,
						bytes: item.bytes,
						sha256: item.sha256,
						path: sanitizePathForLog(item.path, repoRoot),
					})),
				}
			: {}),
	};
	console.log(JSON.stringify(summary, null, 2));
}

const currentFile = resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
const isDirectRun =
	invokedFile.length > 0 &&
	(process.platform === "win32"
		? currentFile.toLowerCase() === invokedFile.toLowerCase()
		: currentFile === invokedFile);

if (isDirectRun) {
	main().catch((error) => {
		const rawMessage = error instanceof Error ? error.message : String(error);
		console.error(sanitizeTextForLog(rawMessage));
		process.exitCode = 1;
	});
}
