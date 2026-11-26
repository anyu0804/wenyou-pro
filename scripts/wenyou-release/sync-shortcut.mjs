/**
 * Synchronize Windows desktop (and optional repo-local) shortcut for Wenyou Pro
 * to point cleanly to the packaged win-unpacked executable, with fail-closed
 * target checks, atomic byte-level backup, readback verification, rollback, and path sanitization.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path, { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const PS1_SCRIPT_PATH = resolve(__dirname, "sync-shortcut.ps1");
export const DEFAULT_SHORTCUT_NAME = "司命 · 文游 Pro.lnk";
export const DEFAULT_DESCRIPTION = "司命 · 文游 Pro";
export const LEGACY_SHORTCUT_NAMES = Object.freeze(["Wenyou Pro.lnk", "Percho.lnk"]);
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const MAX_BACKUP_ATTEMPTS = 1000;

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildHomePatterns(homeDir) {
	const cleaned = String(homeDir ?? "").trim().replace(/[\\/]+$/, "");
	if (!cleaned) return [];

	const patterns = [];
	const segments = cleaned.split(/[\\/]+/).filter(Boolean);
	const leadingSep = /^[\\/]+/.test(cleaned) ? "[\\\\/]" : "";
	if (segments.length > 0) {
		patterns.push(`${leadingSep}${segments.map(escapeRegExp).join("[\\\\/]+")}`);
	}

	const driveMatch = /^([A-Za-z]):[\\/](.+)$/.exec(cleaned);
	if (driveMatch) {
		const driveLetter = driveMatch[1].toLowerCase();
		const restSegments = driveMatch[2].split(/[\\/]+/).filter(Boolean);
		if (restSegments.length > 0) {
			patterns.push(
				`[\\\\/]${escapeRegExp(driveLetter)}[\\\\/]+${restSegments.map(escapeRegExp).join("[\\\\/]+")}`,
			);
		}
	}

	return patterns;
}

export function assertWindowsShortcutHost(hostPlatform = process.platform, options = {}) {
	if (
		hostPlatform === "win32" ||
		typeof options.runPowerShell === "function" ||
		typeof options.runShortcutPowerShell === "function"
	) {
		return;
	}
	throw new Error(
		`Windows .lnk desktop shortcut synchronization is only supported on Windows (current platform: ${hostPlatform}). On macOS/Linux, launch Wenyou Pro directly from Applications or your desktop launcher.`,
	);
}

/**
 * Validate a release version string against semver format.
 */
export function validateVersion(version, sourceLabel = "version") {
	const trimmed = typeof version === "string" ? version.trim() : "";
	if (!trimmed || !SEMVER_PATTERN.test(trimmed)) {
		throw new Error(
			`Invalid ${sourceLabel}: ${JSON.stringify(version)} (expected semver X.Y.Z).`,
		);
	}
	return trimmed;
}

/**
 * Sanitize paths/strings for display and reports by replacing os.homedir()
 * prefixes with "~" (case- and slash-insensitive) to prevent leaking the OS username.
 */
export function sanitizePathForDisplay(input, options = {}) {
	if (input === null || input === undefined) return "";
	const raw = String(input);
	if (!raw) return "";

	const candidateHomes = [];
	if (options.homeDir !== undefined) {
		if (options.homeDir) candidateHomes.push(options.homeDir);
	} else {
		const detectedHome = os.homedir();
		if (detectedHome) candidateHomes.push(detectedHome);
		if (process.env.USERPROFILE && process.env.USERPROFILE !== detectedHome) {
			candidateHomes.push(process.env.USERPROFILE);
		}
	}
	if (Array.isArray(options.extraHomeDirs)) {
		for (const extra of options.extraHomeDirs) {
			if (extra) candidateHomes.push(extra);
		}
	}

	const uniquePatterns = [
		...new Set(candidateHomes.flatMap((dir) => buildHomePatterns(dir))),
	].sort((a, b) => b.length - a.length);

	if (uniquePatterns.length === 0) return raw;

	const cjkClosingPunct = "\\u3002\\uff0c\\uff1a\\uff1b\\uff01\\uff1f\\uff09\\u3011\\u300b\\u300d\\u300f\\u3001\\u201d\\u2019";
	const boundaryAfter = `(?=$|[\\\\/"'\`,:;\\s)\\]}>!?${cjkClosingPunct}]|\\.(?=$|\\s|["'\`,:;)\\]}>!?${cjkClosingPunct}]))`;
	const boundaryBefore = "(^|[^A-Za-z0-9_])";
	let sanitized = raw;

	for (const pattern of uniquePatterns) {
		const regex = new RegExp(`${boundaryBefore}(?:${pattern})${boundaryAfter}`, "gi");
		sanitized = sanitized.replace(regex, "$1~");
	}

	// Normalize standalone home-relative paths to forward slashes for clean cross-tool output.
	if (/^~([\\/]|$)/.test(sanitized)) {
		const normalized = sanitized.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		return normalized === "~/" ? "~" : normalized;
	}

	return sanitized.replace(/~\\/g, "~/");
}

/**
 * Canonicalize a Windows filesystem path for case- and separator-insensitive comparison.
 */
export function normalizeWinPath(input) {
	if (!input || typeof input !== "string") return "";
	const trimmed = input.trim();
	if (!trimmed) return "";
	let normalized = path.win32.normalize(trimmed.replace(/\//g, "\\"));
	if (!/^[A-Za-z]:\\$/.test(normalized)) {
		normalized = normalized.replace(/\\+$/, "");
	}
	return normalized.toLowerCase();
}

function sanitizeShortcutRecord(record, options = {}) {
	if (!record) return null;
	return {
		shortcutPath: sanitizePathForDisplay(record.shortcutPath, options),
		exists: Boolean(record.exists),
		targetPath: sanitizePathForDisplay(record.targetPath, options),
		arguments: sanitizePathForDisplay(record.arguments, options),
		workingDirectory: sanitizePathForDisplay(record.workingDirectory, options),
		iconLocation: sanitizePathForDisplay(record.iconLocation, options),
		description: sanitizePathForDisplay(record.description ?? "", options),
	};
}

function buildShortcutEnv(fields) {
	return {
		...process.env,
		WENYOU_SHORTCUT_PATH: String(fields.shortcutPath ?? ""),
		WENYOU_TARGET_EXE: String(fields.targetExe ?? ""),
		WENYOU_WORKING_DIR: String(fields.workingDir ?? ""),
		WENYOU_ICON_LOCATION: String(fields.iconLocation ?? ""),
		WENYOU_DESCRIPTION: String(fields.description ?? ""),
		WENYOU_ARGUMENTS: String(fields.arguments ?? ""),
		WENYOU_ARGUMENTS_B64: String(fields.argumentsBase64 ?? ""),
	};
}

async function runPowerShell(args, options = {}) {
	const shellCandidates = options.pwshPath ? [options.pwshPath] : ["pwsh", "powershell"];
	let lastError = null;

	for (let i = 0; i < shellCandidates.length; i += 1) {
		const exe = shellCandidates[i];
		try {
			const execOptions = {
				encoding: "utf8",
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024,
			};
			if (options.env) {
				execOptions.env = options.env;
			}
			const { stdout } = await execFileAsync(exe, args, execOptions);
			return stdout;
		} catch (error) {
			lastError = error;
			if (error?.code === "ENOENT" && i < shellCandidates.length - 1) {
				continue;
			}
			const stderrText = sanitizePathForDisplay(error?.stderr || error?.message || String(error));
			throw new Error(`PowerShell (${exe}) execution failed: ${stderrText.trim()}`);
		}
	}

	throw new Error(
		`Failed to locate PowerShell executable: ${sanitizePathForDisplay(lastError?.message || "not found")}`,
	);
}

function parseJsonFromPowerShell(stdout, contextLabel) {
	const cleaned = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
	if (!cleaned) {
		throw new Error(`Empty JSON output from ${contextLabel}`);
	}
	const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const jsonLine = lines[lines.length - 1];
	try {
		return JSON.parse(jsonLine);
	} catch (error) {
		throw new Error(
			`Failed to parse JSON output from ${contextLabel}: ${sanitizePathForDisplay(error.message)}`,
		);
	}
}

/**
 * Dynamically resolve the current user's Windows Desktop directory via pwsh
 * without hardcoding any username; falls back to join(os.homedir(), "Desktop").
 */
export async function resolveDesktopDir(options = {}) {
	const fallback = join(os.homedir(), "Desktop");
	const runner = typeof options.runPowerShell === "function" ? options.runPowerShell : runPowerShell;
	try {
		const stdout = await runner(
			[
				"-NoProfile",
				"-Command",
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')",
			],
			options,
		);
		const lines = String(stdout ?? "")
			.replace(/^\uFEFF/, "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const detected = lines.at(-1) ?? "";
		if (detected) {
			return resolve(detected);
		}
	} catch {
		// Fall through to os.homedir() fallback.
	}
	return resolve(fallback);
}

/**
 * Read default app version from packages/desktop/package.json.
 */
export async function resolveDefaultVersion(repoRoot = REPO_ROOT) {
	const pkgPath = join(repoRoot, "packages", "desktop", "package.json");
	const raw = await readFile(pkgPath, "utf8");
	const pkg = JSON.parse(raw);
	return validateVersion(pkg?.version, `version in ${sanitizePathForDisplay(pkgPath)}`);
}

/**
 * Inspect an on-disk .lnk (or .lnk.bak backup) via sync-shortcut.ps1 -Mode Read.
 * Returns raw on-disk shortcut metadata for exact programmatic assertions.
 */
export async function inspectShortcut(shortcutPath, options = {}) {
	if (!shortcutPath || typeof shortcutPath !== "string") {
		throw new Error("shortcutPath must be a non-empty string.");
	}
	assertWindowsShortcutHost(options.platform ?? process.platform, options);
	const resolvedPath = resolve(shortcutPath);
	const ps1Path = options.ps1ScriptPath ? resolve(options.ps1ScriptPath) : PS1_SCRIPT_PATH;
	const runner =
		typeof options.runShortcutPowerShell === "function"
			? options.runShortcutPowerShell
			: runPowerShell;
	const stdout = await runner(
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			ps1Path,
			"-Mode",
			"Read",
			"-UseEnv",
		],
		{
			...options,
			env: buildShortcutEnv({ shortcutPath: resolvedPath }),
		},
	);
	const data = parseJsonFromPowerShell(stdout, "sync-shortcut.ps1 -Mode Read");
	return {
		shortcutPath: String(data.shortcutPath ?? resolvedPath),
		exists: Boolean(data.exists),
		targetPath: String(data.targetPath ?? ""),
		arguments: String(data.arguments ?? ""),
		workingDirectory: String(data.workingDirectory ?? ""),
		iconLocation: String(data.iconLocation ?? ""),
		description: String(data.description ?? ""),
	};
}

function splitIconLocation(iconLocation) {
	const raw = String(iconLocation ?? "").trim();
	const lastComma = raw.lastIndexOf(",");
	if (lastComma === -1) {
		return { iconPath: raw, iconIndex: "" };
	}
	return {
		iconPath: raw.slice(0, lastComma).trim(),
		iconIndex: raw.slice(lastComma + 1).trim(),
	};
}

/**
 * Verify readback properties of a shortcut against expected packaged executable settings.
 */
export function verifyShortcutProperties(actual, expected) {
	const mismatches = [];

	if (!actual || !actual.exists) {
		mismatches.push("shortcut does not exist on disk");
		return { ok: false, mismatches };
	}

	if (normalizeWinPath(actual.targetPath) !== normalizeWinPath(expected.targetPath)) {
		mismatches.push(
			`targetPath mismatch: expected "${sanitizePathForDisplay(expected.targetPath)}", got "${sanitizePathForDisplay(actual.targetPath)}"`,
		);
	}

	if (actual.arguments !== "") {
		mismatches.push(
			`arguments must be empty, got ${JSON.stringify(sanitizePathForDisplay(actual.arguments))}`,
		);
	}

	if (normalizeWinPath(actual.workingDirectory) !== normalizeWinPath(expected.workingDirectory)) {
		mismatches.push(
			`workingDirectory mismatch: expected "${sanitizePathForDisplay(expected.workingDirectory)}", got "${sanitizePathForDisplay(actual.workingDirectory)}"`,
		);
	}

	const expectedIcon = splitIconLocation(expected.iconLocation);
	const actualIcon = splitIconLocation(actual.iconLocation);
	if (
		normalizeWinPath(actualIcon.iconPath) !== normalizeWinPath(expectedIcon.iconPath) ||
		actualIcon.iconIndex !== expectedIcon.iconIndex
	) {
		mismatches.push(
			`iconLocation mismatch: expected "${sanitizePathForDisplay(expected.iconLocation)}", got "${sanitizePathForDisplay(actual.iconLocation)}"`,
		);
	}

	return {
		ok: mismatches.length === 0,
		mismatches,
	};
}

function formatBackupTimestamp(date = new Date()) {
	const pad2 = (n) => String(n).padStart(2, "0");
	const pad3 = (n) => String(n).padStart(3, "0");
	return [
		date.getFullYear(),
		pad2(date.getMonth() + 1),
		pad2(date.getDate()),
		"-",
		pad2(date.getHours()),
		pad2(date.getMinutes()),
		pad2(date.getSeconds()),
		"-",
		pad3(date.getMilliseconds()),
	].join("");
}

async function createVerifiedBackup(sourceShortcutPath, backupDir, shortcutName, tag = "") {
	await mkdir(backupDir, { recursive: true });
	const baseName = shortcutName.replace(/\.lnk$/i, "");
	const stamp = formatBackupTimestamp(new Date());
	const tagSuffix = tag ? `.${tag}` : "";

	const sourceStat = await stat(sourceShortcutPath);
	let backupFileName = "";
	let backupPath = "";

	for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt += 1) {
		backupFileName =
			attempt === 0
				? `${baseName}.${stamp}${tagSuffix}.lnk.bak`
				: `${baseName}.${stamp}-${attempt}${tagSuffix}.lnk.bak`;
		backupPath = join(backupDir, backupFileName);
		try {
			await copyFile(sourceShortcutPath, backupPath, fsConstants.COPYFILE_EXCL);
			break;
		} catch (error) {
			if (error?.code === "EEXIST" && attempt < MAX_BACKUP_ATTEMPTS - 1) {
				continue;
			}
			throw error;
		}
	}

	const backupStat = await stat(backupPath);
	if (backupStat.size !== sourceStat.size) {
		try {
			await rm(backupPath, { force: true });
		} catch {
			// Best-effort cleanup of mismatched backup file.
		}
		throw new Error(
			`Shortcut backup size mismatch: source=${sourceStat.size} bytes, backup=${backupStat.size} bytes (${sanitizePathForDisplay(backupPath)})`,
		);
	}

	const [sourceBytes, backupBytes] = await Promise.all([
		readFile(sourceShortcutPath),
		readFile(backupPath),
	]);
	if (!sourceBytes.equals(backupBytes)) {
		try {
			await rm(backupPath, { force: true });
		} catch {
			// Best-effort cleanup of corrupted backup file.
		}
		throw new Error(
			`Shortcut backup content verification failed for ${sanitizePathForDisplay(backupPath)}`,
		);
	}

	return {
		backupPath,
		backupFileName,
		backupSizeBytes: backupStat.size,
	};
}

export function isLegacyShortcutName(shortcutName) {
	const lower = String(shortcutName ?? "").trim().toLowerCase();
	return LEGACY_SHORTCUT_NAMES.some((name) => name.toLowerCase() === lower);
}

/**
 * Determine whether an inspected .lnk shortcut belongs to Wenyou Pro / Percho
 * (packaged or dev Electron launcher) so legacy cleanup never touches unrelated shortcuts.
 */
export function isAppOwnedShortcut(record) {
	if (!record || !record.exists) return false;
	const target = normalizeWinPath(record.targetPath ?? "");
	const args = String(record.arguments ?? "").toLowerCase();
	const workDir = normalizeWinPath(record.workingDirectory ?? "");
	const icon = normalizeWinPath(record.iconLocation ?? "");

	if (
		target.includes("wenyou") ||
		target.includes("percho") ||
		/(?:^|\\)electron\.exe$/i.test(target)
	) {
		return true;
	}
	if (
		args.includes("wenyou") ||
		args.includes("percho") ||
		args.includes("packages\\desktop") ||
		args.includes("packages/desktop")
	) {
		return true;
	}
	if (workDir.includes("wenyou") || workDir.includes("percho")) {
		return true;
	}
	if (icon.includes("wenyou") || icon.includes("percho")) {
		return true;
	}
	return false;
}

async function resolveVersionedIconPlan({ appDir, repoRoot, version, resolvedTargetExe }) {
	const candidates = [
		join(appDir, "resources", "wenyou-pro.ico"),
		join(repoRoot, "packages", "desktop", "build", "wenyou-pro.ico"),
	];

	let sourceIcoPath = null;
	for (const candidate of candidates) {
		try {
			const info = await stat(candidate);
			if (info.isFile() && info.size > 0) {
				sourceIcoPath = candidate;
				break;
			}
		} catch {
			// Candidate not present; try next fallback.
		}
	}

	if (!sourceIcoPath) {
		return {
			usesVersionedIcon: false,
			sourceIcoPath: null,
			versionedIconPath: null,
			iconLocation: `${resolvedTargetExe},0`,
		};
	}

	const versionedFileName = version ? `wenyou-pro-${version}.ico` : "wenyou-pro.ico";
	const versionedIconPath = join(appDir, versionedFileName);
	return {
		usesVersionedIcon: true,
		sourceIcoPath,
		versionedIconPath,
		iconLocation: `${versionedIconPath},0`,
	};
}

async function ensureVersionedIconFile(sourceIcoPath, versionedIconPath) {
	if (normalizeWinPath(sourceIcoPath) === normalizeWinPath(versionedIconPath)) {
		return { copied: false };
	}

	const sourceBytes = await readFile(sourceIcoPath);
	try {
		const existingBytes = await readFile(versionedIconPath);
		if (existingBytes.equals(sourceBytes)) {
			return { copied: false };
		}
	} catch {
		// Destination does not exist yet; proceed to copy.
	}

	await copyFile(sourceIcoPath, versionedIconPath);
	return { copied: true };
}

async function recycleFileToBin(filePath, options = {}) {
	const resolvedFilePath = resolve(filePath);
	if (typeof options.recycleFile === "function") {
		await options.recycleFile(resolvedFilePath);
		return;
	}

	const runner = typeof options.runPowerShell === "function" ? options.runPowerShell : runPowerShell;
	const psCommand = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName Microsoft.VisualBasic",
		"$legacyPath = [System.IO.Path]::GetFullPath($env:WENYOU_LEGACY_SHORTCUT_PATH)",
		"if ([System.IO.File]::Exists($legacyPath)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($legacyPath, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
	].join("; ");

	await runner(["-NoProfile", "-NonInteractive", "-Command", psCommand], {
		...options,
		env: {
			...process.env,
			WENYOU_LEGACY_SHORTCUT_PATH: resolvedFilePath,
		},
	});
}

async function removeLegacyShortcutFile(filePath, legacyDeleteMode, options = {}) {
	if (legacyDeleteMode === "unlink") {
		await rm(filePath, { force: true });
		return;
	}
	await recycleFileToBin(filePath, options);
}

async function scanLegacyShortcutsInDir({ dir, activeShortcutPaths, scope, options }) {
	const findings = [];
	const errors = [];
	const activeSet = new Set(activeShortcutPaths.map((p) => normalizeWinPath(p)));

	for (const legacyName of LEGACY_SHORTCUT_NAMES) {
		const legacyPath = join(dir, legacyName);
		if (activeSet.has(normalizeWinPath(legacyPath))) continue;

		let info;
		try {
			info = await stat(legacyPath);
		} catch {
			continue;
		}
		if (!info.isFile()) continue;

		let inspected;
		try {
			inspected = await inspectShortcut(legacyPath, options);
		} catch (error) {
			errors.push({
				scope,
				shortcutName: legacyName,
				shortcutPath: sanitizePathForDisplay(legacyPath),
				stage: "inspect",
				backupPath: null,
				message: sanitizePathForDisplay(error instanceof Error ? error.message : String(error)),
			});
			continue;
		}
		if (!inspected.exists) continue;

		findings.push({
			scope,
			shortcutName: legacyName,
			legacyPath,
			shortcutPath: sanitizePathForDisplay(legacyPath),
			appOwned: isAppOwnedShortcut(inspected),
			inspected,
		});
	}

	return { findings, errors };
}

async function cleanupLegacyShortcutsInDir({
	dir,
	activeShortcutPaths,
	scope,
	backupDir,
	legacyDeleteMode,
	options,
}) {
	const { findings, errors: scanErrors } = await scanLegacyShortcutsInDir({
		dir,
		activeShortcutPaths,
		scope,
		options,
	});
	const cleaned = [];
	const skipped = [];
	const errors = [...scanErrors];

	for (const item of findings) {
		if (!item.appOwned) {
			skipped.push({
				scope: item.scope,
				shortcutName: item.shortcutName,
				shortcutPath: item.shortcutPath,
				reason: "not-app-owned",
				previousShortcut: sanitizeShortcutRecord(item.inspected),
			});
			continue;
		}

		let backup = null;
		try {
			if (scope === "desktop") {
				backup = await createVerifiedBackup(item.legacyPath, backupDir, item.shortcutName, "legacy");
			}
			await removeLegacyShortcutFile(item.legacyPath, legacyDeleteMode, options);

			cleaned.push({
				scope: item.scope,
				shortcutName: item.shortcutName,
				shortcutPath: item.shortcutPath,
				deleteMode: legacyDeleteMode,
				backupPath: backup ? sanitizePathForDisplay(backup.backupPath) : null,
				backupFileName: backup ? backup.backupFileName : null,
				backupSizeBytes: backup ? backup.backupSizeBytes : null,
				previousShortcut: sanitizeShortcutRecord(item.inspected),
			});
		} catch (error) {
			errors.push({
				scope: item.scope,
				shortcutName: item.shortcutName,
				shortcutPath: item.shortcutPath,
				stage: backup ? "delete" : scope === "desktop" ? "backup" : "delete",
				backupPath: backup ? sanitizePathForDisplay(backup.backupPath) : null,
				message: sanitizePathForDisplay(error instanceof Error ? error.message : String(error)),
			});
		}
	}

	return { cleaned, skipped, errors };
}

async function invokeSyncPs1(shortcutPath, expected, options = {}) {
	assertWindowsShortcutHost(options.platform ?? process.platform, options);
	const ps1Path = options.ps1ScriptPath ? resolve(options.ps1ScriptPath) : PS1_SCRIPT_PATH;
	const resolvedShortcutPath = resolve(shortcutPath);
	const psArgs = [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		ps1Path,
		"-Mode",
		"Sync",
		"-UseEnv",
	];
	if (options.refreshShell) {
		psArgs.push("-RefreshShell");
	}
	const runner =
		typeof options.runShortcutPowerShell === "function"
			? options.runShortcutPowerShell
			: runPowerShell;
	const stdout = await runner(psArgs, {
		...options,
		env: buildShortcutEnv({
			shortcutPath: resolvedShortcutPath,
			targetExe: expected.targetPath,
			workingDir: expected.workingDirectory,
			iconLocation: expected.iconLocation,
			description: expected.description,
			arguments: "",
			argumentsBase64: "",
		}),
	});
	const data = parseJsonFromPowerShell(stdout, "sync-shortcut.ps1 -Mode Sync");
	return {
		shortcutPath: String(data.shortcutPath ?? resolvedShortcutPath),
		exists: Boolean(data.exists),
		targetPath: String(data.targetPath ?? ""),
		arguments: String(data.arguments ?? ""),
		workingDirectory: String(data.workingDirectory ?? ""),
		iconLocation: String(data.iconLocation ?? ""),
		description: String(data.description ?? ""),
		shellRefreshed: Boolean(data.shellRefreshed),
	};
}

function validateShortcutName(shortcutName) {
	if (!shortcutName || typeof shortcutName !== "string") {
		throw new Error("shortcutName must be a non-empty string.");
	}
	const trimmed = shortcutName.trim();
	if (
		!trimmed ||
		trimmed !== basename(trimmed) ||
		/[\\/]|\.\./.test(trimmed) ||
		!/\.lnk$/i.test(trimmed)
	) {
		throw new Error(`Invalid shortcutName "${trimmed}": must be a plain filename ending with .lnk.`);
	}
	return trimmed;
}

async function assertTargetExecutableExists(targetExe) {
	let targetStat;
	try {
		targetStat = await stat(targetExe);
	} catch {
		throw new Error(
			`Target executable does not exist: ${sanitizePathForDisplay(targetExe)}`,
		);
	}
	if (!targetStat.isFile()) {
		throw new Error(
			`Target executable path is not a regular file: ${sanitizePathForDisplay(targetExe)}`,
		);
	}
}

/**
 * Synchronize (or dry-run / verify-only) the Wenyou Pro desktop shortcut and optional local copy.
 * All returned path fields are sanitized with sanitizePathForDisplay().
 */
export async function syncDesktopShortcut(options = {}) {
	assertWindowsShortcutHost(options.platform ?? process.platform, options);
	const repoRoot = options.repoRoot ? resolve(options.repoRoot) : REPO_ROOT;
	const dryRun = Boolean(options.dryRun);
	const verifyOnly = Boolean(options.verifyOnly);
	const force = Boolean(options.force);
	const noLocalCopy = Boolean(options.noLocalCopy) || options.localCopy === null || options.localCopy === false;
	const cleanupLegacy = options.cleanupLegacy !== undefined ? Boolean(options.cleanupLegacy) : true;
	const refreshShell = options.refreshShell !== undefined ? Boolean(options.refreshShell) : true;
	const legacyDeleteMode = options.legacyDeleteMode ?? "recycle";

	if (legacyDeleteMode !== "recycle" && legacyDeleteMode !== "unlink") {
		throw new Error(
			`Invalid legacyDeleteMode "${String(legacyDeleteMode)}": expected "recycle" or "unlink".`,
		);
	}

	if (dryRun && verifyOnly) {
		throw new Error("Cannot combine --dry-run and --verify-only.");
	}

	const shortcutName = validateShortcutName(options.shortcutName ?? DEFAULT_SHORTCUT_NAME);
	const description = typeof options.description === "string" ? options.description : DEFAULT_DESCRIPTION;

	let version = "";
	if (options.version !== undefined) {
		version = validateVersion(options.version, "version");
	}

	let resolvedTargetExe;
	if (options.targetExe) {
		resolvedTargetExe = resolve(options.targetExe);
		if (!version) {
			try {
				version = await resolveDefaultVersion(repoRoot);
			} catch {
				version = "";
			}
		}
	} else {
		if (!version) {
			version = await resolveDefaultVersion(repoRoot);
		}
		resolvedTargetExe = resolve(
			repoRoot,
			"dist",
			`wenyou-pro-${version}-win-x64`,
			"raw",
			"win-unpacked",
			"Wenyou Pro.exe",
		);
	}

	// Gate 1: Verify target executable exists and is a regular file BEFORE touching any shortcut or backup.
	await assertTargetExecutableExists(resolvedTargetExe);

	const desktopDir = options.desktopDir
		? resolve(options.desktopDir)
		: await resolveDesktopDir(options);
	const desktopShortcutPath = join(desktopDir, shortcutName);
	const backupDir = options.backupDir
		? resolve(options.backupDir)
		: join(repoRoot, ".local", "backups", "shortcuts");

	let localCopyPath = null;
	if (!noLocalCopy) {
		localCopyPath = options.localCopy
			? resolve(options.localCopy)
			: join(repoRoot, ".local", shortcutName);
		if (!/\.lnk$/i.test(localCopyPath)) {
			throw new Error(
				`Invalid localCopy "${sanitizePathForDisplay(localCopyPath)}": must end with .lnk.`,
			);
		}
	}

	const appDir = dirname(resolvedTargetExe);
	const iconPlan = await resolveVersionedIconPlan({
		appDir,
		repoRoot,
		version,
		resolvedTargetExe,
	});

	const expected = {
		targetPath: resolvedTargetExe,
		arguments: "",
		workingDirectory: appDir,
		iconLocation: iconPlan.iconLocation,
		description,
	};

	const shouldHandleLocalCopy =
		Boolean(localCopyPath) &&
		normalizeWinPath(localCopyPath) !== normalizeWinPath(desktopShortcutPath);

	const canCleanupDesktopLegacy = cleanupLegacy && !isLegacyShortcutName(shortcutName);
	const canCleanupLocalLegacy =
		shouldHandleLocalCopy &&
		cleanupLegacy &&
		!isLegacyShortcutName(basename(localCopyPath)) &&
		normalizeWinPath(dirname(localCopyPath)) !== normalizeWinPath(desktopDir);

	if (verifyOnly) {
		const errors = [];
		if (iconPlan.usesVersionedIcon && iconPlan.versionedIconPath) {
			try {
				const icoStat = await stat(iconPlan.versionedIconPath);
				if (!icoStat.isFile() || icoStat.size <= 0) {
					errors.push(
						`Versioned icon file is empty or invalid (${sanitizePathForDisplay(iconPlan.versionedIconPath)})`,
					);
				}
			} catch {
				errors.push(
					`Versioned icon file is missing (${sanitizePathForDisplay(iconPlan.versionedIconPath)})`,
				);
			}
		}

		const desktopActual = await inspectShortcut(desktopShortcutPath, options);
		const desktopCheck = verifyShortcutProperties(desktopActual, expected);
		if (!desktopCheck.ok) {
			errors.push(
				`Desktop shortcut (${sanitizePathForDisplay(desktopShortcutPath)}): ${desktopCheck.mismatches.join("; ")}`,
			);
		}

		let localActual = null;
		if (shouldHandleLocalCopy) {
			localActual = await inspectShortcut(localCopyPath, options);
			const localCheck = verifyShortcutProperties(localActual, expected);
			if (!localCheck.ok) {
				errors.push(
					`Local copy (${sanitizePathForDisplay(localCopyPath)}): ${localCheck.mismatches.join("; ")}`,
				);
			}
		}

		if (errors.length > 0) {
			throw new Error(`Shortcut verification failed:\n- ${errors.join("\n- ")}`);
		}

		return {
			ok: true,
			mode: "verify-only",
			version: version || null,
			shortcutName,
			targetExe: sanitizePathForDisplay(resolvedTargetExe),
			desktopShortcut: sanitizePathForDisplay(desktopShortcutPath),
			localCopy: shouldHandleLocalCopy ? sanitizePathForDisplay(localCopyPath) : null,
			iconLocation: sanitizePathForDisplay(expected.iconLocation),
			versionedIconPath: iconPlan.versionedIconPath
				? sanitizePathForDisplay(iconPlan.versionedIconPath)
				: null,
			backupCreated: false,
			backupPath: null,
			backupFileName: null,
			backupSizeBytes: null,
			previousDesktopShortcut: sanitizeShortcutRecord(desktopActual),
			verifiedDesktop: sanitizeShortcutRecord(desktopActual),
			verifiedLocalCopy: localActual ? sanitizeShortcutRecord(localActual) : null,
		};
	}

	const previousDesktop = await inspectShortcut(desktopShortcutPath, options);
	const desktopAlreadyMatches =
		previousDesktop.exists &&
		verifyShortcutProperties(previousDesktop, expected).ok &&
		previousDesktop.description === expected.description;

	if (dryRun) {
		const previousLocal = shouldHandleLocalCopy
			? await inspectShortcut(localCopyPath, options)
			: null;
		const wouldUpdateDesktop = force || !desktopAlreadyMatches;

		const wouldCleanupLegacy = [];
		const legacyScanErrors = [];
		const activePaths = [desktopShortcutPath, ...(shouldHandleLocalCopy ? [localCopyPath] : [])];
		if (canCleanupDesktopLegacy) {
			const desktopScan = await scanLegacyShortcutsInDir({
				dir: desktopDir,
				activeShortcutPaths: activePaths,
				scope: "desktop",
				options,
			});
			legacyScanErrors.push(...desktopScan.errors);
			for (const item of desktopScan.findings) {
				wouldCleanupLegacy.push({
					scope: item.scope,
					shortcutName: item.shortcutName,
					shortcutPath: item.shortcutPath,
					appOwned: item.appOwned,
					previousShortcut: sanitizeShortcutRecord(item.inspected),
				});
			}
		}
		if (canCleanupLocalLegacy) {
			const localScan = await scanLegacyShortcutsInDir({
				dir: dirname(localCopyPath),
				activeShortcutPaths: activePaths,
				scope: "local",
				options,
			});
			legacyScanErrors.push(...localScan.errors);
			for (const item of localScan.findings) {
				wouldCleanupLegacy.push({
					scope: item.scope,
					shortcutName: item.shortcutName,
					shortcutPath: item.shortcutPath,
					appOwned: item.appOwned,
					previousShortcut: sanitizeShortcutRecord(item.inspected),
				});
			}
		}

		return {
			ok: true,
			mode: "dry-run",
			version: version || null,
			shortcutName,
			targetExe: sanitizePathForDisplay(resolvedTargetExe),
			desktopShortcut: sanitizePathForDisplay(desktopShortcutPath),
			localCopy: shouldHandleLocalCopy ? sanitizePathForDisplay(localCopyPath) : null,
			iconLocation: sanitizePathForDisplay(expected.iconLocation),
			versionedIconPath: iconPlan.versionedIconPath
				? sanitizePathForDisplay(iconPlan.versionedIconPath)
				: null,
			wouldUpdateDesktop,
			wouldBackup: previousDesktop.exists && wouldUpdateDesktop,
			wouldCleanupLegacy,
			legacyScanErrors,
			backupDir: sanitizePathForDisplay(backupDir),
			backupCreated: false,
			backupPath: null,
			backupFileName: null,
			backupSizeBytes: null,
			previousDesktopShortcut: sanitizeShortcutRecord(previousDesktop),
			previousLocalCopy: previousLocal ? sanitizeShortcutRecord(previousLocal) : null,
			expected: {
				targetPath: sanitizePathForDisplay(expected.targetPath),
				arguments: "",
				workingDirectory: sanitizePathForDisplay(expected.workingDirectory),
				iconLocation: sanitizePathForDisplay(expected.iconLocation),
				description: sanitizePathForDisplay(expected.description),
			},
		};
	}

	let versionedIconCopied = false;
	if (iconPlan.usesVersionedIcon && iconPlan.sourceIcoPath && iconPlan.versionedIconPath) {
		const copyResult = await ensureVersionedIconFile(
			iconPlan.sourceIcoPath,
			iconPlan.versionedIconPath,
		);
		versionedIconCopied = copyResult.copied;
	}

	const desktopNeedsWrite = force || !desktopAlreadyMatches || versionedIconCopied;
	let backupInfo = null;

	// Gate 2: Automatic atomic byte-level backup before modifying an existing desktop shortcut.
	if (previousDesktop.exists && desktopNeedsWrite) {
		backupInfo = await createVerifiedBackup(desktopShortcutPath, backupDir, shortcutName);
	}

	// Gate 3: Write and strongly verify readback for desktop shortcut, with rollback/cleanup on failure.
	let verifiedDesktopRaw = previousDesktop;
	let shellRefreshed = false;
	if (desktopNeedsWrite) {
		try {
			verifiedDesktopRaw = await invokeSyncPs1(desktopShortcutPath, expected, {
				...options,
				refreshShell,
			});
			shellRefreshed = Boolean(verifiedDesktopRaw.shellRefreshed);
			const desktopCheck = verifyShortcutProperties(verifiedDesktopRaw, expected);
			if (!desktopCheck.ok) {
				throw new Error(
					`Desktop shortcut readback verification failed (${sanitizePathForDisplay(desktopShortcutPath)}): ${desktopCheck.mismatches.join("; ")}`,
				);
			}
		} catch (error) {
			if (backupInfo?.backupPath) {
				try {
					await copyFile(backupInfo.backupPath, desktopShortcutPath);
				} catch {
					// Preserve original error and backup file even if rollback copy fails.
				}
			} else if (!previousDesktop.exists) {
				try {
					await rm(desktopShortcutPath, { force: true });
				} catch {
					// Best-effort cleanup of dirty newly created shortcut.
				}
			}
			throw error;
		}
	}

	// Only after the new desktop shortcut is verified on disk, back up and safely clean legacy desktop shortcuts.
	const legacyCleaned = [];
	const legacySkipped = [];
	const legacyErrors = [];
	let desktopLegacyCleanedCount = 0;
	const activeShortcutPaths = [
		desktopShortcutPath,
		...(shouldHandleLocalCopy ? [localCopyPath] : []),
	];
	if (canCleanupDesktopLegacy) {
		const desktopLegacy = await cleanupLegacyShortcutsInDir({
			dir: desktopDir,
			activeShortcutPaths,
			scope: "desktop",
			backupDir,
			legacyDeleteMode,
			options,
		});
		legacyCleaned.push(...desktopLegacy.cleaned);
		legacySkipped.push(...desktopLegacy.skipped);
		legacyErrors.push(...desktopLegacy.errors);
		desktopLegacyCleanedCount = desktopLegacy.cleaned.length;
	}

	// If desktop shortcut was unchanged but legacy desktop shortcuts were just removed, trigger Shell refresh.
	if (refreshShell && !shellRefreshed && desktopLegacyCleanedCount > 0) {
		try {
			const refreshResult = await invokeSyncPs1(desktopShortcutPath, expected, {
				...options,
				refreshShell: true,
			});
			shellRefreshed = Boolean(refreshResult.shellRefreshed);
		} catch {
			// Best-effort shell refresh after legacy cleanup; main desktop shortcut is already verified.
		}
	}

	// Sync and strongly verify readback for local repo copy (.local/司命 · 文游 Pro.lnk) if enabled.
	let verifiedLocalRaw = null;
	if (shouldHandleLocalCopy) {
		try {
			verifiedLocalRaw = await invokeSyncPs1(localCopyPath, expected, {
				...options,
				refreshShell: false,
			});
			const localCheck = verifyShortcutProperties(verifiedLocalRaw, expected);
			if (!localCheck.ok) {
				throw new Error(
					`Local copy shortcut readback verification failed (${sanitizePathForDisplay(localCopyPath)}): ${localCheck.mismatches.join("; ")}`,
				);
			}
		} catch (error) {
			const baseMsg = sanitizePathForDisplay(
				error instanceof Error ? error.message : String(error),
			);
			const desktopNote = desktopNeedsWrite
				? `desktop shortcut was already updated (${sanitizePathForDisplay(desktopShortcutPath)})`
				: `desktop shortcut was unchanged (${sanitizePathForDisplay(desktopShortcutPath)})`;
			const backupNote = backupInfo?.backupPath
				? `desktop backup preserved at ${sanitizePathForDisplay(backupInfo.backupPath)}`
				: "no desktop backup was created";
			throw new Error(`${baseMsg} [Note: ${desktopNote}; ${backupNote}]`, { cause: error });
		}

		if (canCleanupLocalLegacy) {
			const localLegacy = await cleanupLegacyShortcutsInDir({
				dir: dirname(localCopyPath),
				activeShortcutPaths,
				scope: "local",
				backupDir,
				legacyDeleteMode,
				options,
			});
			legacyCleaned.push(...localLegacy.cleaned);
			legacySkipped.push(...localLegacy.skipped);
			legacyErrors.push(...localLegacy.errors);
		}
	}

	// Gate 4: Return fully sanitized report.
	return {
		ok: true,
		mode: "sync",
		version: version || null,
		shortcutName,
		targetExe: sanitizePathForDisplay(resolvedTargetExe),
		desktopShortcut: sanitizePathForDisplay(desktopShortcutPath),
		localCopy: shouldHandleLocalCopy ? sanitizePathForDisplay(localCopyPath) : null,
		iconLocation: sanitizePathForDisplay(expected.iconLocation),
		versionedIconPath: iconPlan.versionedIconPath
			? sanitizePathForDisplay(iconPlan.versionedIconPath)
			: null,
		versionedIconCopied,
		shellRefreshed,
		desktopUpdated: desktopNeedsWrite,
		backupCreated: Boolean(backupInfo),
		backupPath: backupInfo ? sanitizePathForDisplay(backupInfo.backupPath) : null,
		backupFileName: backupInfo ? backupInfo.backupFileName : null,
		backupSizeBytes: backupInfo ? backupInfo.backupSizeBytes : null,
		previousDesktopShortcut: sanitizeShortcutRecord(previousDesktop),
		verifiedDesktop: sanitizeShortcutRecord(verifiedDesktopRaw),
		verifiedLocalCopy: verifiedLocalRaw ? sanitizeShortcutRecord(verifiedLocalRaw) : null,
		legacyCleanup: {
			enabled: canCleanupDesktopLegacy || canCleanupLocalLegacy,
			deleteMode: legacyDeleteMode,
			cleaned: legacyCleaned,
			skipped: legacySkipped,
			errors: legacyErrors,
		},
	};
}

export function parseCliArgs(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		allowPositionals: false,
		options: {
			version: { type: "string" },
			"target-exe": { type: "string" },
			"desktop-dir": { type: "string" },
			"shortcut-name": { type: "string" },
			"backup-dir": { type: "string" },
			"local-copy": { type: "string" },
			"no-local-copy": { type: "boolean", default: false },
			"no-cleanup-legacy": { type: "boolean", default: false },
			"no-refresh-shell": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			"verify-only": { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			description: { type: "string" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	if (values["dry-run"] && values["verify-only"]) {
		throw new Error("Cannot pass both --dry-run and --verify-only.");
	}

	return {
		help: values.help,
		json: values.json,
		version: values.version,
		targetExe: values["target-exe"],
		desktopDir: values["desktop-dir"],
		shortcutName: values["shortcut-name"],
		backupDir: values["backup-dir"],
		localCopy: values["no-local-copy"] ? null : values["local-copy"],
		noLocalCopy: values["no-local-copy"],
		cleanupLegacy: !values["no-cleanup-legacy"],
		refreshShell: !values["no-refresh-shell"],
		dryRun: values["dry-run"],
		verifyOnly: values["verify-only"],
		force: values.force,
		description: values.description,
	};
}

function formatUsage() {
	return [
		"Usage: node scripts/wenyou-release/sync-shortcut.mjs [options]",
		"",
		"Options:",
		"  --version <ver>         Release version (defaults to packages/desktop/package.json)",
		"  --target-exe <path>     Packaged Wenyou Pro.exe path",
		"  --desktop-dir <dir>     Target desktop directory (defaults to Windows Desktop folder)",
		`  --shortcut-name <name>  Shortcut filename (default: "${DEFAULT_SHORTCUT_NAME}")`,
		"  --backup-dir <dir>      Backup directory (default: .local/backups/shortcuts)",
		`  --local-copy <path>     Repo-local shortcut copy (default: .local/${DEFAULT_SHORTCUT_NAME})`,
		"  --no-local-copy         Skip syncing the repo-local shortcut copy",
		"  --no-cleanup-legacy     Keep legacy Wenyou Pro.lnk / Percho.lnk shortcuts untouched",
		"  --no-refresh-shell      Skip Win32 SHChangeNotify shell icon refresh after sync",
		"  --dry-run               Inspect and validate without modifying any shortcut",
		"  --verify-only           Verify existing shortcuts match the packaged target",
		"  --force                 Force rewrite and backup even if desktop shortcut already matches",
		"  --json                  Print report as JSON",
		"  -h, --help              Show this help message",
	].join("\n");
}

function formatHumanReport(report) {
	const lines = [
		`[shortcut-sync] mode=${report.mode} ok=${report.ok}`,
		`  targetExe:       ${report.targetExe}`,
		`  desktopShortcut: ${report.desktopShortcut}`,
	];
	if (report.iconLocation) {
		lines.push(`  iconLocation:    ${report.iconLocation}`);
	}
	if (report.localCopy) {
		lines.push(`  localCopy:       ${report.localCopy}`);
	}
	if (report.backupCreated && report.backupPath) {
		lines.push(`  backupPath:      ${report.backupPath} (${report.backupSizeBytes} bytes)`);
	} else if (report.mode === "dry-run") {
		lines.push(`  wouldUpdate:     ${report.wouldUpdateDesktop} (wouldBackup=${report.wouldBackup})`);
	}
	if (report.previousDesktopShortcut?.exists) {
		lines.push(
			`  previousTarget:  ${report.previousDesktopShortcut.targetPath} (args=${JSON.stringify(report.previousDesktopShortcut.arguments)})`,
		);
	}
	if (report.verifiedDesktop) {
		lines.push(
			`  verifiedTarget:  ${report.verifiedDesktop.targetPath} (args=${JSON.stringify(report.verifiedDesktop.arguments)})`,
		);
	}
	if (report.legacyCleanup?.cleaned?.length) {
		for (const item of report.legacyCleanup.cleaned) {
			lines.push(
				`  legacyCleaned:   [${item.scope}] ${item.shortcutPath} (mode=${item.deleteMode}${item.backupPath ? `, backup=${item.backupPath}` : ""})`,
			);
		}
	}
	if (report.legacyCleanup?.errors?.length) {
		for (const item of report.legacyCleanup.errors) {
			lines.push(
				`  legacyWarning:   [${item.scope}/${item.stage}] ${item.shortcutPath}: ${item.message}${item.backupPath ? ` (backup=${item.backupPath})` : ""}`,
			);
		}
	}
	if (report.shellRefreshed !== undefined) {
		lines.push(`  shellRefreshed:  ${report.shellRefreshed}`);
	}
	return lines.join("\n");
}

const isMain =
	Boolean(process.argv[1]) &&
	(process.platform === "win32"
		? normalizeWinPath(resolve(process.argv[1])) === normalizeWinPath(__filename)
		: resolve(process.argv[1]) === __filename);

if (isMain) {
	try {
		const cliOptions = parseCliArgs(process.argv.slice(2));
		if (cliOptions.help) {
			console.log(formatUsage());
		} else if (process.platform !== "win32") {
			console.error(
				`[shortcut-sync] Windows .lnk desktop shortcut synchronization is only supported on Windows (current platform: ${process.platform}).`,
			);
			process.exitCode = 1;
		} else {
			const report = await syncDesktopShortcut(cliOptions);
			if (cliOptions.json) {
				console.log(JSON.stringify(report, null, 2));
			} else {
				console.log(formatHumanReport(report));
			}
		}
	} catch (error) {
		const msg = sanitizePathForDisplay(error instanceof Error ? error.message : String(error));
		console.error(`[shortcut-sync] ERROR: ${msg}`);
		process.exitCode = 1;
	}
}
