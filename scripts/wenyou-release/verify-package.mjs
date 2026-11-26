#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	delimiter,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(MODULE_PATH), "../..");

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_LINE_PATTERN = /^([a-f0-9]{64}) [ *](.+)$/;
const IGNORED_HTML_REF_PATTERN =
	/^(?:data:|https?:|wenyou-|mailto:|javascript:|blob:|about:|file:|#|\/\/)/i;

const REQUIRED_ASAR_CORE_FILES = [
	"out/main/index.js",
	"out/preload/index.cjs",
	"out/renderer/index.html",
];

const REQUIRED_NTQQ_VFS_PY_FILES = [
	"wenyou_read.py",
	"wenyou_vfs_sync.py",
	"ntqq_vfs.py",
	"wenyou_ntqq_bridge.py",
];

const REQUIRED_NTQQ_VFS_FILES = [
	...REQUIRED_NTQQ_VFS_PY_FILES,
	"qq_dump_db.exe",
	"python/python.exe",
];

const REQUIRED_WENYOU_SKILLS_FILES = [
	"wenyou-handwritten-policy/SKILL.md",
	"wenyou-situation-memory/SKILL.md",
];

const REQUIRED_PI_PACKAGE_FILES = [
	"pi-package/dist/core/export-html/template.html",
	"pi-package/dist/core/export-html/vendor/marked-cjk-friendly.min.js",
];

const REQUIRED_OTHER_RESOURCE_FILES = [
	...REQUIRED_PI_PACKAGE_FILES,
	"update-diagnostics/collect.ps1",
];

const ALLOWED_USER_SEGMENTS = new Set([
	"public",
	"default",
	"default user",
	"all users",
]);

const FORBIDDEN_ASAR_NODE_MODULES = [
	"happy-dom",
	"esbuild",
	"@esbuild",
	"qrcode",
	"monaco-editor",
	"stream-monaco",
	"mermaid",
	"katex",
	"shiki",
	"react-dom",
];

const ALLOWED_LOCALE_PAKS = ["en-US.pak", "zh-CN.pak"];

function normalizeSlashes(value) {
	return String(value).replaceAll("\\", "/");
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizePathForDisplay(inputPath) {
	if (typeof inputPath !== "string" || inputPath.length === 0) return "";
	const home = homedir();
	if (!home) return inputPath;
	const homePosix = normalizeSlashes(home).replace(/\/+$/, "");
	if (!homePosix) return inputPath;

	const variants = [];
	const winDriveMatch = /^([A-Za-z]):\/(.+)$/.exec(homePosix);
	if (winDriveMatch) {
		const drive = winDriveMatch[1];
		const restSegments = winDriveMatch[2].split("/").filter(Boolean).map(escapeRegex);
		const restPattern = restSegments.join("[\\\\/]+");
		// Windows & mixed/double-slash forms: C:\Users\<user>, C:/Users/<user>, C:\Users/<user>, C:\\Users\\<user>
		variants.push(`${escapeRegex(drive)}:[\\\\/]+${restPattern}`);
		// MSYS / Git Bash / Cygwin / WSL forms: /c/Users/<user>, /mnt/c/Users/<user>, /cygdrive/c/Users/<user>
		variants.push(`/+(?:(?:mnt|cygdrive)/+)?${escapeRegex(drive)}[\\\\/]+${restPattern}`);
	} else {
		const segments = homePosix.split("/").filter(Boolean).map(escapeRegex);
		if (segments.length > 0) {
			variants.push(`[\\\\/]+${segments.join("[\\\\/]+")}`);
		}
	}

	if (variants.length === 0) return inputPath;
	const pattern = new RegExp(
		`(^|[^A-Za-z0-9_])(?:${variants.join("|")})(?=$|[\\\\/\\s"'\\])},;.:：，。！？（）()\\[\\]{}<>|])`,
		"gi",
	);
	return inputPath.replace(pattern, "$1~");
}

export function assertValidVersion(version) {
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		throw new Error(`Invalid release version "${String(version)}" (expected X.Y.Z semver format)`);
	}
	return version;
}

export function validateVerifyPlatform(platform) {
	if (platform !== "win" && platform !== "mac") {
		throw new Error(`Invalid verify platform "${String(platform)}" (expected win or mac)`);
	}
	return platform;
}

export function resolveVerifyPlatform({ platform, releaseDir, hostPlatform = process.platform } = {}) {
	if (platform !== undefined) {
		return validateVerifyPlatform(platform);
	}
	if (releaseDir) {
		const dirName = basename(resolve(releaseDir));
		if (/(?:^|[-_])mac(?:[-_](?:arm64|x64))?$/i.test(dirName)) {
			return "mac";
		}
		if (/(?:^|[-_])win(?:[-_]x64)?$/i.test(dirName)) {
			return "win";
		}
	}
	return hostPlatform === "darwin" ? "mac" : "win";
}

export function resolveVerifyArchitectures(platform, arch) {
	const validPlatform = validateVerifyPlatform(platform);
	if (validPlatform === "win") {
		const requested = arch ?? "x64";
		if (requested !== "x64") {
			throw new Error(`Invalid Windows verify arch "${String(arch)}" (expected x64)`);
		}
		return ["x64"];
	}
	const requested = arch ?? "all";
	if (requested === "all") return ["arm64", "x64"];
	if (requested === "arm64" || requested === "x64") return [requested];
	throw new Error(`Invalid macOS verify arch "${String(arch)}" (expected arm64, x64, or all)`);
}

export function getExpectedArtifactNames(version, options = {}) {
	assertValidVersion(version);
	const platform = options.platform !== undefined ? validateVerifyPlatform(options.platform) : "win";
	if (platform === "win") {
		const setupExe = `Wenyou-Pro-Setup-${version}-x64.exe`;
		const portableZip = `Wenyou-Pro-Portable-${version}-x64.zip`;
		return {
			setupExe,
			portableZip,
			sha256Sums: "SHA256SUMS.txt",
			readme: "使用说明.txt",
		};
	}

	const archs = resolveVerifyArchitectures("mac", options.arch);
	const dmgFiles = archs.map((a) => `Wenyou-Pro-${version}-mac-${a}.dmg`);
	const zipFiles = archs.map((a) => `Wenyou-Pro-${version}-mac-${a}.zip`);
	const artifacts = archs.flatMap((a) => [
		`Wenyou-Pro-${version}-mac-${a}.dmg`,
		`Wenyou-Pro-${version}-mac-${a}.zip`,
	]);
	return {
		platform: "mac",
		archs,
		dmgFiles,
		zipFiles,
		artifacts,
		sha256Sums: "SHA256SUMS.txt",
		readme: "使用说明.txt",
	};
}

export function parseVerifyArgs(argv) {
	const result = {
		version: undefined,
		platform: undefined,
		arch: undefined,
		releaseDir: undefined,
		repoRoot: undefined,
		extractCheck: false,
		help: false,
	};

	const readValue = (flag, index) => {
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("-")) {
			throw new Error(`Missing value for CLI option ${flag}`);
		}
		return next;
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--extract-check") {
			result.extractCheck = true;
		} else if (arg === "--version") {
			result.version = readValue("--version", i);
			i += 1;
		} else if (arg.startsWith("--version=")) {
			const val = arg.slice("--version=".length);
			if (!val) throw new Error("Missing value for CLI option --version");
			result.version = val;
		} else if (arg === "--platform") {
			result.platform = validateVerifyPlatform(readValue("--platform", i));
			i += 1;
		} else if (arg.startsWith("--platform=")) {
			const val = arg.slice("--platform=".length);
			if (!val) throw new Error("Missing value for CLI option --platform");
			result.platform = validateVerifyPlatform(val);
		} else if (arg === "--arch") {
			result.arch = readValue("--arch", i);
			i += 1;
		} else if (arg.startsWith("--arch=")) {
			const val = arg.slice("--arch=".length);
			if (!val) throw new Error("Missing value for CLI option --arch");
			result.arch = val;
		} else if (arg === "--release-dir") {
			result.releaseDir = readValue("--release-dir", i);
			i += 1;
		} else if (arg.startsWith("--release-dir=")) {
			const val = arg.slice("--release-dir=".length);
			if (!val) throw new Error("Missing value for CLI option --release-dir");
			result.releaseDir = val;
		} else if (arg === "--repo-root") {
			result.repoRoot = readValue("--repo-root", i);
			i += 1;
		} else if (arg.startsWith("--repo-root=")) {
			const val = arg.slice("--repo-root=".length);
			if (!val) throw new Error("Missing value for CLI option --repo-root");
			result.repoRoot = val;
		} else {
			throw new Error(`Unknown CLI argument: ${arg}`);
		}
	}

	if (result.arch !== undefined) {
		if (!["x64", "arm64", "all"].includes(result.arch)) {
			throw new Error(`Invalid CLI option --arch "${result.arch}" (expected x64, arm64, or all)`);
		}
		if (result.platform !== undefined) {
			resolveVerifyArchitectures(result.platform, result.arch);
		}
	}

	return result;
}

export async function readDefaultVersion(repoRoot = DEFAULT_REPO_ROOT) {
	const pkgPath = resolve(repoRoot, "packages/desktop/package.json");
	const raw = await readFile(pkgPath, "utf8");
	const parsed = JSON.parse(raw);
	return assertValidVersion(parsed.version);
}

export function loadAsarModule(options = {}) {
	if (options.asarModule) return options.asarModule;

	const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
	const candidates = [
		() => createRequire(import.meta.url)("@electron/asar"),
		() => createRequire(resolve(repoRoot, "package.json"))("@electron/asar"),
		() => createRequire(resolve(process.cwd(), "package.json"))("@electron/asar"),
	];

	if (process.env.WENYOU_ASAR_PATH) {
		const customPath = resolve(process.env.WENYOU_ASAR_PATH);
		candidates.push(() => createRequire(import.meta.url)(customPath));
	}

	if (process.env.NODE_PATH) {
		for (const entry of process.env.NODE_PATH.split(delimiter).filter(Boolean)) {
			const target = resolve(entry, "@electron/asar");
			candidates.push(() => createRequire(import.meta.url)(target));
		}
	}

	const errors = [];
	for (const loader of candidates) {
		try {
			const mod = loader();
			if (mod && typeof mod.listPackage === "function" && typeof mod.extractFile === "function") {
				return mod;
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	throw new Error(
		`Unable to load @electron/asar from workspace or NODE_PATH. Last error: ${sanitizePathForDisplay(errors.at(-1) ?? "not found")}`,
	);
}

async function assertNonEmptyFile(filePath, label) {
	let info;
	try {
		info = await stat(filePath);
	} catch {
		throw new Error(`Missing required file: ${label}`);
	}
	if (!info.isFile()) {
		throw new Error(`Expected regular file but found non-file: ${label}`);
	}
	if (info.size <= 0) {
		throw new Error(`File must be non-empty (0 bytes): ${label}`);
	}
	return info;
}

async function assertDirectoryExists(dirPath, label) {
	let info;
	try {
		info = await stat(dirPath);
	} catch {
		throw new Error(`Missing required directory: ${label}`);
	}
	if (!info.isDirectory()) {
		throw new Error(`Expected directory but found non-directory: ${label}`);
	}
	return info;
}

async function assertPathAbsent(
	targetPath,
	label,
	reason = "Forbidden Windows-only resource present in non-Windows package",
) {
	try {
		await lstat(targetPath);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
	throw new Error(`${reason}: ${label}`);
}

export async function computeFileSha256(filePath) {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	for await (const chunk of stream) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

export async function verifyTopLevelArtifacts(releaseDir, version, options = {}) {
	await assertDirectoryExists(releaseDir, `releaseDir (${sanitizePathForDisplay(releaseDir)})`);
	const platform = options.platform !== undefined ? validateVerifyPlatform(options.platform) : "win";
	const names = getExpectedArtifactNames(version, { platform, arch: options.arch });
	const required =
		platform === "win"
			? [names.setupExe, names.portableZip, names.sha256Sums, names.readme]
			: [...names.artifacts, names.sha256Sums, names.readme];
	const files = {};

	for (const name of required) {
		const fullPath = join(releaseDir, name);
		const info = await assertNonEmptyFile(fullPath, name);
		files[name] = { size: info.size };
	}

	return { files };
}

function assertSafeSingleFileName(fileName, releaseDir) {
	if (!fileName || fileName !== fileName.trim()) {
		throw new Error(`Invalid filename in SHA256SUMS.txt: "${fileName}"`);
	}
	if (
		fileName.includes("/") ||
		fileName.includes("\\") ||
		fileName.includes("..") ||
		fileName.includes("\0") ||
		fileName.includes(":") ||
		isAbsolute(fileName) ||
		basename(fileName) !== fileName
	) {
		throw new Error(`Path traversal or unsafe filename in SHA256SUMS.txt: "${fileName}"`);
	}
	const resolved = resolve(releaseDir, fileName);
	const rel = relative(resolve(releaseDir), resolved);
	if (rel !== fileName || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Path escape detected in SHA256SUMS.txt: "${fileName}"`);
	}
}

export async function verifySha256Sums(releaseDir, version, options = {}) {
	const platform = options.platform !== undefined ? validateVerifyPlatform(options.platform) : "win";
	const names = getExpectedArtifactNames(version, { platform, arch: options.arch });
	const shaPath = join(releaseDir, names.sha256Sums);
	await assertNonEmptyFile(shaPath, names.sha256Sums);

	const rawText = await readFile(shaPath, "utf8");
	const lines = rawText
		.split(/\r?\n/)
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => line.length > 0);

	if (lines.length === 0) {
		throw new Error("SHA256SUMS.txt contains no checksum entries");
	}

	const expectedFiles = platform === "win" ? [names.setupExe, names.portableZip] : names.artifacts;
	const expectedSet = new Set(expectedFiles);
	const recorded = new Map();

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const match = SHA256_LINE_PATTERN.exec(line);
		if (!match) {
			throw new Error(`Malformed line ${i + 1} in SHA256SUMS.txt`);
		}
		const [, digest, fileName] = match;
		assertSafeSingleFileName(fileName, releaseDir);
		if (recorded.has(fileName)) {
			throw new Error(`Duplicate entry in SHA256SUMS.txt: ${fileName}`);
		}
		if (!expectedSet.has(fileName)) {
			throw new Error(`Unexpected dirty entry in SHA256SUMS.txt: ${fileName}`);
		}
		recorded.set(fileName, digest);
	}

	for (const expectedName of expectedFiles) {
		if (!recorded.has(expectedName)) {
			throw new Error(`Missing required entry in SHA256SUMS.txt: ${expectedName}`);
		}
	}

	const verified = {};
	for (const fileName of expectedFiles) {
		const expectedHash = recorded.get(fileName);
		const filePath = join(releaseDir, fileName);
		await assertNonEmptyFile(filePath, fileName);
		const actualHash = await computeFileSha256(filePath);
		if (actualHash !== expectedHash) {
			throw new Error(
				`SHA-256 mismatch for ${fileName}: expected ${expectedHash}, actual ${actualHash}`,
			);
		}
		verified[fileName] = actualHash;
	}

	return { entries: verified };
}

function isAllowedUserSegment(segment, tailAfterSegment = "") {
	const cleaned = segment.trim();
	if (!cleaned) return true;
	const lower = cleaned.toLowerCase();
	if (ALLOWED_USER_SEGMENTS.has(lower)) return true;

	// Allow "Default User" and "All Users" when separated by whitespace.
	const combined = `${lower}${tailAfterSegment}`.toLowerCase();
	if (/^(?:default user|all users)(?:$|[\\/\s"'<>|;:,，。！？（）()[\]{}])/.test(combined)) {
		return true;
	}

	// Allow environment variables and angle-bracket placeholders.
	if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(cleaned)) return true;
	if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(cleaned)) return true;
	if (/^<[^<>\\/\r\n]+>$/.test(cleaned)) return true;

	return false;
}

export function scanUnmaskedLocalPaths(text) {
	const findings = [];
	const lines = text.split(/\r?\n/);

	const patterns = [
		{
			kind: "windows-users-path",
			regex:
				/(?:^|[^\w])([A-Za-z]:[\\/]+Users[\\/]+([^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/gi,
		},
		{
			kind: "msys-users-path",
			regex:
				/(?:^|file:\/\/|[^\w:/.-])(\/(?:(?:mnt|cygdrive)\/)?[A-Za-z]\/Users\/([^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/gi,
		},
		{
			kind: "posix-home-path",
			regex:
				/(?:^|file:\/\/|[^\w:/.-])(\/(?:Users|home)\/([^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/g,
		},
		{
			kind: "unc-users-path",
			regex:
				/(?:^|[^\w\\])(\\\\[A-Za-z0-9._-]+\\+Users\\+([^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/gi,
		},
	];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const lineText = lines[lineIndex];
		for (const { kind, regex } of patterns) {
			regex.lastIndex = 0;
			let match;
			while ((match = regex.exec(lineText)) !== null) {
				const fullMatch = match[1];
				const userSegment = match[2];
				const matchEndIndex = match.index + match[0].length;
				const tail = lineText.slice(matchEndIndex, matchEndIndex + 16);
				if (isAllowedUserSegment(userSegment, tail)) continue;
				const redactedMatch = `${fullMatch.slice(0, fullMatch.length - userSegment.length)}<REDACTED>`;
				findings.push({
					kind,
					line: lineIndex + 1,
					match: sanitizePathForDisplay(redactedMatch),
				});
			}
		}
	}

	return findings;
}

export async function verifyReadmeFile(readmePath, version, options = {}) {
	const platform = options.platform !== undefined ? validateVerifyPlatform(options.platform) : "win";
	const names = getExpectedArtifactNames(version, { platform, arch: options.arch });
	await assertNonEmptyFile(readmePath, names.readme);
	const rawBuffer = await readFile(readmePath);

	if (
		rawBuffer.length < 3 ||
		rawBuffer[0] !== 0xef ||
		rawBuffer[1] !== 0xbb ||
		rawBuffer[2] !== 0xbf
	) {
		throw new Error(
			`${names.readme} must start with UTF-8 BOM (0xEF 0xBB 0xBF), got [${Array.from(rawBuffer.subarray(0, 3))
				.map((b) => `0x${b.toString(16).padStart(2, "0")}`)
				.join(", ")}]`,
		);
	}

	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer.subarray(3));
	} catch (error) {
		throw new Error(
			`${names.readme} contains invalid UTF-8 byte sequence: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const requiredTokens =
		platform === "win"
			? [`v${version}`, names.setupExe, names.portableZip]
			: [`v${version}`, ...names.artifacts];
	for (const token of requiredTokens) {
		if (!text.includes(token)) {
			throw new Error(`${names.readme} is missing required text: "${token}"`);
		}
	}

	if (platform === "mac" && /%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%/i.test(text)) {
		throw new Error(
			`${names.readme} for macOS must not contain Windows environment path placeholders (%USERPROFILE%/%APPDATA%)`,
		);
	}

	const leaks = scanUnmaskedLocalPaths(text);
	if (leaks.length > 0) {
		const summary = leaks.map((item) => `line ${item.line} (${item.kind}: ${item.match})`).join("; ");
		throw new Error(`${names.readme} failed path sanitization gate (unmasked local user path): ${summary}`);
	}

	return {
		bomVerified: true,
		bytes: rawBuffer.length,
		requiredTokens,
	};
}

export function extractLocalHtmlAssetRefs(html) {
	const stripped = String(html)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<style\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\s\S]*?<\/style\s*>/gi, "")
		.replace(/(<script\b(?:"[^"]*"|'[^']*'|[^>"'])*>)[\s\S]*?(<\/script\s*>)/gi, "$1$2");
	const tagRegex = /<(script|link)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
	const attrTokenRegex =
		/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

	const refs = [];
	let tagMatch;
	while ((tagMatch = tagRegex.exec(stripped)) !== null) {
		const tag = tagMatch[1].toLowerCase();
		const targetAttr = tag === "script" ? "src" : "href";
		const attrsText = (tagMatch[2] ?? "").replace(/\/\s*$/, "");

		attrTokenRegex.lastIndex = 0;
		let attrMatch;
		while ((attrMatch = attrTokenRegex.exec(attrsText)) !== null) {
			const attrName = attrMatch[1].toLowerCase();
			if (attrName !== targetAttr) continue;
			const rawValue = (attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "").trim();
			if (!rawValue) continue;
			if (IGNORED_HTML_REF_PATTERN.test(rawValue)) continue;

			const withoutQueryHash = rawValue.split(/[?#]/, 1)[0].trim();
			if (!withoutQueryHash) continue;

			let decodedPath = withoutQueryHash;
			try {
				decodedPath = decodeURIComponent(withoutQueryHash);
			} catch {
				decodedPath = withoutQueryHash;
			}

			refs.push({
				tag,
				attr: targetAttr,
				raw: rawValue,
				path: normalizeSlashes(decodedPath),
			});
		}
	}

	return refs;
}

function asarLookupCandidates(posixRelPath) {
	const clean = posixRelPath.replace(/^\/+/, "");
	const platformRel = clean.split("/").join(sep);
	return platformRel === clean ? [clean] : [platformRel, clean];
}

function extractAsarFile(asar, archivePath, posixRelPath) {
	let lastError;
	for (const candidate of asarLookupCandidates(posixRelPath)) {
		try {
			return asar.extractFile(archivePath, candidate);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Failed to extract "${posixRelPath}" from app.asar: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

function statAsarEntry(asar, archivePath, posixRelPath) {
	if (typeof asar.statFile !== "function") return null;
	for (const candidate of asarLookupCandidates(posixRelPath)) {
		try {
			return asar.statFile(archivePath, candidate);
		} catch {
			// try next separator form
		}
	}
	return null;
}

function assertAsarFilePresent(asar, archivePath, entrySet, posixRelPath, label = posixRelPath) {
	if (!entrySet.has(posixRelPath)) {
		throw new Error(`Missing packaged entry in app.asar: ${label}`);
	}
	const info = statAsarEntry(asar, archivePath, posixRelPath);
	if (info && info.files) {
		throw new Error(`Expected file in app.asar but found directory: ${label}`);
	}
	if (info && typeof info.size === "number" && info.size <= 0) {
		throw new Error(`Packaged file in app.asar is empty (0 bytes): ${label}`);
	}
}

function resolvePosixAssetRef(baseDirPosix, refPath, allowRootRelative = false) {
	const cleanedBase = baseDirPosix.replace(/^\/+|\/+$/g, "");
	if (!allowRootRelative && refPath.startsWith("/")) {
		throw new Error(
			`Root-relative asset path "${refPath}" is not allowed under ${cleanedBase}/ (use relative "./" path for Electron loadFile compatibility)`,
		);
	}
	const normalized = refPath.startsWith("/")
		? posix.normalize(posix.join(cleanedBase, refPath.replace(/^\/+/, "")))
		: posix.normalize(posix.join(cleanedBase, refPath));

	if (
		!normalized.startsWith(`${cleanedBase}/`) ||
		normalized === cleanedBase ||
		normalized.includes("/../") ||
		normalized.startsWith("..")
	) {
		throw new Error(`HTML asset reference escapes ${cleanedBase}/: "${refPath}"`);
	}
	return normalized;
}

export async function verifyPixiSandbox(resourcesDir) {
	const sandboxDir = resolve(resourcesDir, "pixi-sandbox");
	await assertDirectoryExists(sandboxDir, "resources/pixi-sandbox");
	const indexHtmlPath = join(sandboxDir, "index.html");
	await assertNonEmptyFile(indexHtmlPath, "resources/pixi-sandbox/index.html");

	const html = await readFile(indexHtmlPath, "utf8");
	const refs = extractLocalHtmlAssetRefs(html);
	if (refs.length === 0) {
		throw new Error("resources/pixi-sandbox/index.html contains no local JS/CSS static asset references");
	}

	const checkedAssets = [];
	const missing = [];
	for (const ref of refs) {
		const targetRel = ref.path.startsWith("/") ? ref.path.replace(/^\/+/, "") : ref.path;
		const resolvedTarget = resolve(sandboxDir, targetRel);
		const relFromSandbox = relative(sandboxDir, resolvedTarget);
		if (
			!relFromSandbox ||
			relFromSandbox === ".." ||
			relFromSandbox.startsWith(`..${sep}`) ||
			isAbsolute(relFromSandbox)
		) {
			throw new Error(`pixi-sandbox/index.html asset reference escapes sandbox dir: "${ref.raw}"`);
		}
		try {
			await assertNonEmptyFile(resolvedTarget, `resources/pixi-sandbox/${normalizeSlashes(relFromSandbox)}`);
			checkedAssets.push(normalizeSlashes(relFromSandbox));
		} catch {
			missing.push(ref.raw);
		}
	}

	if (missing.length > 0) {
		throw new Error(
			`Broken static asset closure in resources/pixi-sandbox/index.html; missing: ${missing.join(", ")}`,
		);
	}

	return { checkedAssets };
}

async function scanForbiddenNtqqArtifacts(rootDir, currentDir, { forbidWindowsBinaries }, results) {
	const entries = await readdir(currentDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(currentDir, entry.name);
		const relPosix = normalizeSlashes(relative(rootDir, fullPath));
		if (entry.isDirectory()) {
			const lowerName = entry.name.toLowerCase();
			if (lowerName === "__pycache__") {
				results.cacheViolations.push(relPosix);
				continue;
			}
			if (forbidWindowsBinaries && lowerName === "python") {
				results.windowsViolations.push(`${relPosix}/`);
				continue;
			}
			await scanForbiddenNtqqArtifacts(rootDir, fullPath, { forbidWindowsBinaries }, results);
		} else if (/\.py[co]$/i.test(entry.name)) {
			results.cacheViolations.push(relPosix);
		} else if (forbidWindowsBinaries && /\.(?:exe|dll|pyd|cat)$/i.test(entry.name)) {
			results.windowsViolations.push(relPosix);
		}
	}
}

export async function verifyNtqqVfs(resourcesDir, options = {}) {
	const platform = options.platform !== undefined ? validateVerifyPlatform(options.platform) : "win";
	const ntqqDir = resolve(resourcesDir, "ntqq-vfs");
	await assertDirectoryExists(ntqqDir, "resources/ntqq-vfs");

	const requiredFiles = platform === "win" ? REQUIRED_NTQQ_VFS_FILES : REQUIRED_NTQQ_VFS_PY_FILES;
	for (const relFile of requiredFiles) {
		await assertNonEmptyFile(join(ntqqDir, relFile), `resources/ntqq-vfs/${relFile}`);
	}

	const scanResults = { cacheViolations: [], windowsViolations: [] };
	await scanForbiddenNtqqArtifacts(
		ntqqDir,
		ntqqDir,
		{ forbidWindowsBinaries: platform !== "win" },
		scanResults,
	);
	if (scanResults.cacheViolations.length > 0) {
		throw new Error(
			`Forbidden Python cache artifacts found under resources/ntqq-vfs: ${scanResults.cacheViolations.join(", ")}`,
		);
	}
	if (scanResults.windowsViolations.length > 0) {
		throw new Error(
			`Forbidden Windows binaries found under non-Windows resources/ntqq-vfs: ${scanResults.windowsViolations.join(", ")}`,
		);
	}

	return {
		verifiedFiles: [...requiredFiles],
		cacheViolations: 0,
		windowsViolations: 0,
	};
}

export function validateIcoHas256Frame(buffer, label = "resources/wenyou-pro.ico") {
	if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
		throw new Error(
			`Invalid ICO file (${label}): expected at least 22 bytes, got ${buffer ? buffer.length : 0}`,
		);
	}

	const reserved = buffer.readUInt16LE(0);
	const type = buffer.readUInt16LE(2);
	const count = buffer.readUInt16LE(4);
	if (reserved !== 0 || type !== 1 || count < 1) {
		throw new Error(
			`Invalid ICO header (${label}): reserved=${reserved}, type=${type}, count=${count}`,
		);
	}

	const directoryEnd = 6 + count * 16;
	if (buffer.length < directoryEnd) {
		throw new Error(
			`Truncated ICO directory (${label}): expected at least ${directoryEnd} bytes for ${count} entries, got ${buffer.length}`,
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
				`Corrupted ICO entry #${i} (${label}): imageOffset=${imageOffset}, bytesInRes=${bytesInRes}, fileBytes=${buffer.length}`,
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
					`Invalid 256x256 ICO frame payload (${label}): expected PNG signature (89 50 4E 47) or BITMAPINFOHEADER DIB (28 00 00 00)`,
				);
			}
			has256 = true;
		}
	}

	if (!has256) {
		throw new Error(
			`ICO file (${label}) is missing a 256x256 frame (found: ${sizes.join(", ")})`,
		);
	}

	return {
		count,
		sizes,
		has256: true,
	};
}

export async function verifyExtraResources(resourcesDir, options = {}) {
	const platform = options.platform !== undefined ? validateVerifyPlatform(options.platform) : "win";
	await assertDirectoryExists(resourcesDir, "resources");
	const pixiSandbox = await verifyPixiSandbox(resourcesDir);
	const ntqqVfs = await verifyNtqqVfs(resourcesDir, { platform });

	const skillsDir = join(resourcesDir, "wenyou-skills");
	await assertDirectoryExists(skillsDir, "resources/wenyou-skills");
	for (const relFile of REQUIRED_WENYOU_SKILLS_FILES) {
		await assertNonEmptyFile(join(skillsDir, relFile), `resources/wenyou-skills/${relFile}`);
	}

	const otherFiles = platform === "win" ? REQUIRED_OTHER_RESOURCE_FILES : REQUIRED_PI_PACKAGE_FILES;
	for (const relFile of otherFiles) {
		await assertNonEmptyFile(join(resourcesDir, relFile), `resources/${relFile}`);
	}

	let appIcon = null;
	if (platform === "win") {
		const iconPath = join(resourcesDir, "wenyou-pro.ico");
		const iconStat = await assertNonEmptyFile(iconPath, "resources/wenyou-pro.ico");
		const iconBuffer = await readFile(iconPath);
		const iconMeta = validateIcoHas256Frame(iconBuffer, "resources/wenyou-pro.ico");
		appIcon = {
			file: "wenyou-pro.ico",
			bytes: iconStat.size,
			...iconMeta,
		};
	} else {
		await assertPathAbsent(join(resourcesDir, "update-diagnostics"), "resources/update-diagnostics");
		await assertPathAbsent(join(resourcesDir, "wenyou-pro.ico"), "resources/wenyou-pro.ico");
	}

	await assertPathAbsent(
		join(resourcesDir, "ui-plugins"),
		"resources/ui-plugins",
		"Forbidden removed resource present in package",
	);

	return {
		pixiSandbox,
		ntqqVfs,
		skills: [...REQUIRED_WENYOU_SKILLS_FILES],
		otherFiles: [...otherFiles],
		...(appIcon ? { appIcon } : {}),
	};
}

export async function verifyAppAsar(archivePath, version, options = {}) {
	assertValidVersion(version);
	const asarInfo = await assertNonEmptyFile(archivePath, "resources/app.asar");

	const asar = loadAsarModule(options);
	if (typeof asar.uncache === "function") {
		asar.uncache(archivePath);
	}

	let metadata;
	const rendererCheckedAssets = [];
	let rendererJsCount = 0;
	let rendererCssCount = 0;

	try {
		const rawEntries = asar.listPackage(archivePath);
		const normalizedEntries = rawEntries.map((entry) =>
			normalizeSlashes(entry).replace(/^\/+/, ""),
		);
		const entrySet = new Set(normalizedEntries);

		assertAsarFilePresent(asar, archivePath, entrySet, "package.json");
		metadata = JSON.parse(extractAsarFile(asar, archivePath, "package.json").toString("utf8"));

		if (metadata.version !== version) {
			throw new Error(
				`app.asar package.json version mismatch: expected "${version}", actual "${String(metadata.version)}"`,
			);
		}
		if (metadata.releaseChannel !== "stable") {
			throw new Error(
				`app.asar package.json releaseChannel mismatch: expected "stable", actual "${String(metadata.releaseChannel)}"`,
			);
		}
		if (metadata.productName !== "Wenyou Pro") {
			throw new Error(
				`app.asar package.json productName mismatch: expected "Wenyou Pro", actual "${String(metadata.productName)}"`,
			);
		}

		for (const coreFile of REQUIRED_ASAR_CORE_FILES) {
			assertAsarFilePresent(asar, archivePath, entrySet, coreFile);
		}

		const rendererJsAssets = normalizedEntries.filter((entry) =>
			/^out\/renderer\/assets\/.+\.js$/i.test(entry),
		);
		const rendererCssAssets = normalizedEntries.filter((entry) =>
			/^out\/renderer\/assets\/.+\.css$/i.test(entry),
		);
		rendererJsCount = rendererJsAssets.length;
		rendererCssCount = rendererCssAssets.length;

		if (rendererJsCount === 0) {
			throw new Error("Missing .js bundle under app.asar out/renderer/assets/");
		}
		if (rendererCssCount === 0) {
			throw new Error("Missing .css bundle under app.asar out/renderer/assets/");
		}

		const forbiddenAsarPattern = new RegExp(
			`(?:^|/)node_modules/(?:${FORBIDDEN_ASAR_NODE_MODULES.map(escapeRegex).join("|")})(?:/|$)`,
			"i",
		);
		const forbiddenBundledDeps = normalizedEntries.filter((entry) =>
			forbiddenAsarPattern.test(entry),
		);
		if (forbiddenBundledDeps.length > 0) {
			throw new Error(
				`Forbidden dependency bundled into production app.asar: ${forbiddenBundledDeps.slice(0, 3).join(", ")}`,
			);
		}

		const rendererHtml = extractAsarFile(asar, archivePath, "out/renderer/index.html").toString(
			"utf8",
		);
		const rendererRefs = extractLocalHtmlAssetRefs(rendererHtml);
		if (rendererRefs.length === 0) {
			throw new Error("app.asar out/renderer/index.html contains no local static asset references");
		}

		const missingRendererAssets = [];
		for (const ref of rendererRefs) {
			const asarAssetPath = resolvePosixAssetRef("out/renderer", ref.path, false);
			try {
				assertAsarFilePresent(asar, archivePath, entrySet, asarAssetPath);
				rendererCheckedAssets.push(asarAssetPath);
			} catch {
				missingRendererAssets.push(`${ref.raw} -> ${asarAssetPath}`);
			}
		}

		if (missingRendererAssets.length > 0) {
			throw new Error(
				`Broken static asset closure in app.asar out/renderer/index.html; missing: ${missingRendererAssets.join(", ")}`,
			);
		}
	} finally {
		if (typeof asar.uncache === "function") {
			asar.uncache(archivePath);
		}
	}

	return {
		asarSize: asarInfo.size,
		metadata: {
			version: metadata.version,
			releaseChannel: metadata.releaseChannel,
			productName: metadata.productName,
			disableAutoUpdate: metadata.disableAutoUpdate,
		},
		renderer: {
			jsCount: rendererJsCount,
			cssCount: rendererCssCount,
			checkedAssets: rendererCheckedAssets,
		},
	};
}

export async function verifyUnpackedLocales(appDir, options = {}) {
	const statFn = options.statFn ?? stat;
	const localesDir = join(appDir, "locales");
	let info;
	try {
		info = await statFn(localesDir);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			return { present: false, checkedPaks: [] };
		}
		throw error;
	}
	if (!info.isDirectory()) {
		throw new Error("Expected locales to be a directory in unpacked app");
	}
	const entries = await readdir(localesDir, { withFileTypes: true });
	const pakFiles = entries
		.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".pak"))
		.map((entry) => entry.name)
		.sort();
	const pakSet = new Set(pakFiles);
	const missing = ALLOWED_LOCALE_PAKS.filter((name) => !pakSet.has(name));
	if (missing.length > 0) {
		throw new Error(`Missing required locale .pak file(s) under locales/: ${missing.join(", ")}`);
	}
	for (const requiredPak of ALLOWED_LOCALE_PAKS) {
		await assertNonEmptyFile(join(localesDir, requiredPak), `locales/${requiredPak}`);
	}
	const allowedSet = new Set(ALLOWED_LOCALE_PAKS);
	const extra = pakFiles.filter((name) => !allowedSet.has(name));
	if (extra.length > 0) {
		throw new Error(
			`Unexpected extra locale .pak file(s) under locales/ (only zh-CN.pak and en-US.pak allowed): ${extra.join(", ")}`,
		);
	}
	return {
		present: true,
		checkedPaks: pakFiles,
	};
}

export async function verifyUnpackedApp(appDir, version, options = {}) {
	assertValidVersion(version);
	await assertDirectoryExists(appDir, `unpacked appDir (${sanitizePathForDisplay(appDir)})`);

	const exePath = join(appDir, "Wenyou Pro.exe");
	const exeInfo = await assertNonEmptyFile(exePath, "Wenyou Pro.exe");

	const resourcesDir = join(appDir, "resources");
	await assertDirectoryExists(resourcesDir, "resources");

	const archivePath = join(resourcesDir, "app.asar");
	const asarReport = await verifyAppAsar(archivePath, version, options);
	const extraResources = await verifyExtraResources(resourcesDir, { platform: "win" });
	const locales = await verifyUnpackedLocales(appDir);

	return {
		exeSize: exeInfo.size,
		...asarReport,
		extraResources,
		locales,
	};
}

export async function resolveMacAppBundlePath(rawDir, arch) {
	const candidates =
		arch === "arm64"
			? [join(rawDir, "mac-arm64", "Wenyou Pro.app")]
			: [join(rawDir, "mac", "Wenyou Pro.app"), join(rawDir, "mac-x64", "Wenyou Pro.app")];

	for (const candidate of candidates) {
		try {
			const info = await stat(candidate);
			if (info.isDirectory()) return candidate;
		} catch {
			// try next candidate
		}
	}
	throw new Error(
		`Missing macOS unpacked app bundle for ${arch}: expected ${candidates.map((p) => sanitizePathForDisplay(p)).join(" or ")}`,
	);
}

export async function verifyMacAppBundle(appBundlePath, version, options = {}) {
	assertValidVersion(version);
	await assertDirectoryExists(appBundlePath, `macOS app bundle (${sanitizePathForDisplay(appBundlePath)})`);

	const executablePath = join(appBundlePath, "Contents", "MacOS", "Wenyou Pro");
	const exeInfo = await assertNonEmptyFile(executablePath, "Contents/MacOS/Wenyou Pro");

	const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
	const plistInfo = await assertNonEmptyFile(infoPlistPath, "Contents/Info.plist");

	const resourcesDir = join(appBundlePath, "Contents", "Resources");
	await assertDirectoryExists(resourcesDir, "Contents/Resources");

	const archivePath = join(resourcesDir, "app.asar");
	const asarReport = await verifyAppAsar(archivePath, version, options);
	const extraResources = await verifyExtraResources(resourcesDir, { platform: "mac" });

	return {
		appBundle: sanitizePathForDisplay(appBundlePath),
		executableSize: exeInfo.size,
		infoPlistSize: plistInfo.size,
		...asarReport,
		extraResources,
	};
}

export async function verifyMacNativeArtifacts({
	releaseDir,
	version,
	archs,
	appBundlePaths,
	hostPlatform = process.platform,
	execFileFn = execFileAsync,
}) {
	if (hostPlatform !== "darwin") {
		return {
			executed: false,
			skippedReason: `native macOS codesign/hdiutil verification skipped on ${hostPlatform}`,
		};
	}

	const codesignVerified = [];
	for (const { arch, appBundlePath } of appBundlePaths) {
		try {
			await execFileFn("codesign", ["--verify", "--deep", "--strict", appBundlePath], {
				maxBuffer: 10 * 1024 * 1024,
			});
			codesignVerified.push(arch);
		} catch (error) {
			const detail = sanitizePathForDisplay(
				error?.stderr || (error instanceof Error ? error.message : String(error)),
			);
			throw new Error(`codesign verification failed for mac-${arch}: ${detail.trim()}`);
		}
	}

	const hdiutilVerified = [];
	for (const arch of archs) {
		const dmgName = `Wenyou-Pro-${version}-mac-${arch}.dmg`;
		const dmgPath = join(releaseDir, dmgName);
		try {
			await execFileFn("hdiutil", ["verify", dmgPath], {
				maxBuffer: 10 * 1024 * 1024,
			});
			hdiutilVerified.push(dmgName);
		} catch (error) {
			const detail = sanitizePathForDisplay(
				error?.stderr || (error instanceof Error ? error.message : String(error)),
			);
			throw new Error(`hdiutil verify failed for ${dmgName}: ${detail.trim()}`);
		}
	}

	return {
		executed: true,
		codesignVerified,
		hdiutilVerified,
	};
}

async function extractZipArchive(zipPath, destinationDir) {
	const resolvedZip = resolve(zipPath);
	const resolvedDest = resolve(destinationDir);

	if (process.platform === "win32") {
		const psCommand = [
			"$ProgressPreference = 'SilentlyContinue'",
			"Add-Type -AssemblyName System.IO.Compression.FileSystem",
			"[System.IO.Compression.ZipFile]::ExtractToDirectory($env:WENYOU_ZIP_PATH, $env:WENYOU_EXTRACT_DIR)",
		].join("; ");
		const execOptions = {
			env: {
				...process.env,
				WENYOU_ZIP_PATH: resolvedZip,
				WENYOU_EXTRACT_DIR: resolvedDest,
			},
			maxBuffer: 10 * 1024 * 1024,
		};

		let lastError;
		for (const shell of ["pwsh", "powershell"]) {
			try {
				await execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", psCommand], execOptions);
				return;
			} catch (error) {
				lastError = error;
				if (error && typeof error === "object" && error.code === "ENOENT") {
					continue;
				}
				throw error;
			}
		}
		throw lastError;
	}

	await execFileAsync("unzip", ["-q", resolvedZip, "-d", resolvedDest], {
		maxBuffer: 10 * 1024 * 1024,
	});
}

export async function verifyPortableZipExtract(zipPath, version, options = {}) {
	assertValidVersion(version);
	await assertNonEmptyFile(zipPath, basename(zipPath));

	const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
	let tempParent = options.tempDir ? resolve(options.tempDir) : resolve(repoRoot, ".local/tmp");
	try {
		await mkdir(tempParent, { recursive: true });
	} catch {
		tempParent = join(tmpdir(), "wenyou-pro-verify");
		await mkdir(tempParent, { recursive: true });
	}

	const extractDir = await mkdtemp(join(tempParent, "portable-extract-"));
	try {
		await extractZipArchive(zipPath, extractDir);
		const unpackedSummary = await verifyUnpackedApp(extractDir, version, options);
		return {
			extractedChecked: true,
			unpacked: unpackedSummary,
		};
	} finally {
		await rm(extractDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

export async function verifyWenyouRelease(options = {}) {
	const repoRoot = options.repoRoot ? resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
	const version = options.version
		? assertValidVersion(options.version)
		: await readDefaultVersion(repoRoot);
	const hostPlatform = options.hostPlatform ?? process.platform;
	const platform = resolveVerifyPlatform({
		platform: options.platform,
		releaseDir: options.releaseDir,
		hostPlatform,
	});
	const archs = resolveVerifyArchitectures(platform, options.arch);
	const releaseDir = options.releaseDir
		? resolve(options.releaseDir)
		: resolve(
				repoRoot,
				"dist",
				platform === "win" ? `wenyou-pro-${version}-win-x64` : `wenyou-pro-${version}-mac`,
			);
	const extractCheck = Boolean(options.extractCheck);
	const names = getExpectedArtifactNames(version, { platform, arch: options.arch });

	const topLevel = await verifyTopLevelArtifacts(releaseDir, version, {
		platform,
		arch: options.arch,
	});
	const sha256 = await verifySha256Sums(releaseDir, version, {
		platform,
		arch: options.arch,
	});
	const readme = await verifyReadmeFile(join(releaseDir, names.readme), version, {
		platform,
		arch: options.arch,
	});

	if (platform === "win") {
		const unpackedDir = join(releaseDir, "raw", "win-unpacked");
		const unpacked = await verifyUnpackedApp(unpackedDir, version, {
			repoRoot,
			asarModule: options.asarModule,
		});

		let portableExtract = null;
		if (extractCheck) {
			portableExtract = await verifyPortableZipExtract(
				join(releaseDir, names.portableZip),
				version,
				{
					repoRoot,
					tempDir: options.tempDir,
					asarModule: options.asarModule,
				},
			);
		}

		return {
			ok: true,
			platform: "win",
			archs,
			version,
			releaseDir: sanitizePathForDisplay(releaseDir),
			topLevel,
			sha256,
			readme,
			unpacked,
			portableExtract,
		};
	}

	// macOS verification
	const rawDir = join(releaseDir, "raw");
	const appBundles = {};
	const resolvedBundlePaths = [];
	for (const a of archs) {
		const appBundlePath = await resolveMacAppBundlePath(rawDir, a);
		resolvedBundlePaths.push({ arch: a, appBundlePath });
		appBundles[a] = await verifyMacAppBundle(appBundlePath, version, {
			repoRoot,
			asarModule: options.asarModule,
			arch: a,
		});
	}

	const nativeVerification = await verifyMacNativeArtifacts({
		releaseDir,
		version,
		archs,
		appBundlePaths: resolvedBundlePaths,
		hostPlatform,
		execFileFn: options.execFileFn,
	});

	return {
		ok: true,
		platform: "mac",
		archs,
		version,
		releaseDir: sanitizePathForDisplay(releaseDir),
		topLevel,
		sha256,
		readme,
		appBundles,
		nativeVerification,
	};
}

function printUsage() {
	console.log(
		[
			"Usage: node scripts/wenyou-release/verify-package.mjs [options]",
			"",
			"Options:",
			"  --platform <win|mac>   Target platform (default: auto-detected from --release-dir or host OS)",
			"  --arch <x64|arm64|all> Target architecture (mac default: all; win default: x64)",
			"  --version <ver>        Target release version (default: packages/desktop/package.json)",
			"  --release-dir <dir>    Release directory (default: dist/wenyou-pro-<ver>-win-x64 or -mac)",
			"  --extract-check        [Windows] Extract Portable.zip to a clean temp dir and re-verify closure",
			"  --repo-root <dir>      Override repository root path",
			"  -h, --help             Show this help message",
		].join("\n"),
	);
}

function isMainModule() {
	if (!process.argv[1]) return false;
	const invoked = resolve(process.argv[1]);
	const self = resolve(MODULE_PATH);
	return process.platform === "win32"
		? invoked.toLowerCase() === self.toLowerCase()
		: invoked === self;
}

async function main() {
	const args = parseVerifyArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}
	const report = await verifyWenyouRelease({
		version: args.version,
		platform: args.platform,
		arch: args.arch,
		releaseDir: args.releaseDir,
		repoRoot: args.repoRoot,
		extractCheck: args.extractCheck,
	});
	console.log(JSON.stringify(report, null, 2));
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[verify-package] FAILED: ${sanitizePathForDisplay(message)}`);
		process.exitCode = 1;
	});
}
