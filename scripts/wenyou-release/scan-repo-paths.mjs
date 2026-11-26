#!/usr/bin/env node
/**
 * Repository-wide anti-doxxing and hardcoded local path gate for Wenyou Pro.
 * Author: 安钰
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(MODULE_PATH), "../..");

export const BINARY_EXTENSIONS = new Set([
	".png",
	".ico",
	".icns",
	".exe",
	".dll",
	".pyd",
	".pyc",
	".pyo",
	".cat",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".mp3",
	".wav",
	".ogg",
	".mp4",
	".webm",
	".gif",
	".jpg",
	".jpeg",
	".webp",
	".bmp",
	".zip",
	".tar",
	".gz",
	".7z",
	".dmg",
	".asar",
	".node",
	".pdf",
	".docx",
	".xlsx",
	".pptx",
	".sqlite",
	".db",
	".bin",
	".dat",
]);

export const ALLOWED_SYSTEM_USER_SEGMENTS = new Set([
	"public",
	"default",
	"default user",
	"all users",
]);

/**
 * Fictional usernames explicitly permitted ONLY inside automated test fixtures
 * (to stay compatible with upstream Percho unit tests and Wenyou release test suites).
 * Production code, scripts, workflows, and documentation must NEVER use hardcoded user paths.
 */
export const ALLOWED_TEST_FIXTURE_USER_SEGMENTS = new Set([
	"a",
	"alice",
	"alice2",
	"alice.bak",
	"alicetest",
	"alicetest2",
	"b",
	"dev",
	"developer",
	"ericw",
	"fixture",
	"fixture-linux",
	"fixture-mac",
	"fixture-user",
	"lingcool",
	"me",
	"one",
	"person",
	"runner",
	"secret",
	"somerealuser",
	"test",
	"u",
	"user",
	"x",
	"测试用户",
	"用户",
]);

const TEST_FILE_PATTERN =
	/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

// Narrow allowlist for upstream Percho UI input placeholder example (placeholder="/home/user/project").
const UPSTREAM_UI_PLACEHOLDER_PREFIX_PATTERN = /\bplaceholder\s*=\s*["']$/;

function normalizeSlashes(value) {
	return String(value).replaceAll("\\", "/");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isTestFilePath(relPath) {
	return TEST_FILE_PATTERN.test(normalizeSlashes(relPath));
}

export function isBinaryFilePath(filePath) {
	return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function sanitizeTextForDisplay(input, homeDir = os.homedir()) {
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
		patterns.push(new RegExp(`(^|[^A-Za-z0-9_])[\\\\/]+${joined}${boundaryAfter}`, "g"));
	}

	let sanitized = text;
	for (const pattern of patterns) {
		sanitized = sanitized.replace(pattern, "$1~");
	}
	return sanitized;
}

function isAllowedUserSegment(segment, tailAfterSegment, { isTestFile }) {
	const cleaned = segment.trim().replace(/\.+$/, "");
	if (!cleaned) return true;
	const lower = cleaned.toLowerCase();

	if (ALLOWED_SYSTEM_USER_SEGMENTS.has(lower)) return true;

	const combined = `${lower}${tailAfterSegment}`.toLowerCase();
	if (/^(?:default user|all users)(?:$|[\\/\s"'<>|;:,，。！？（）()[\]{}])/.test(combined)) {
		return true;
	}

	// Allow environment variables and angle-bracket placeholders in all files.
	if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(cleaned)) return true;
	if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(cleaned)) return true;
	if (/^<[^<>\\/\r\n]+>$/.test(cleaned)) return true;

	if (isTestFile && ALLOWED_TEST_FIXTURE_USER_SEGMENTS.has(lower)) {
		return true;
	}

	return false;
}

const USER_PATH_PATTERNS = [
	{
		kind: "windows-users-path",
		regex:
			/(?:^|[^\w])([A-Za-z]:[\\/]+Users[\\/]+(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/gi,
	},
	{
		kind: "msys-users-path",
		regex:
			/(?:^|file:\/\/|[^\w:/.-])(\/(?:(?:mnt|cygdrive)\/)?[A-Za-z]\/Users\/(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/gi,
	},
	{
		kind: "posix-home-path",
		regex:
			/(?:^|file:\/\/|[^\w:/.-])(\/(?:Users|home)\/(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/g,
	},
	{
		kind: "unc-users-path",
		regex:
			/(?:^|[^\w\\])(\\{2,}[A-Za-z0-9._-]+\\+Users\\+(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\\/\r\n"'`|;:,，。！？（）()[\]{}\s]+))/gi,
	},
];

const WORKSPACE_PATH_PATTERNS = [
	{
		kind: "hardcoded-local-workspace",
		regex:
			/(?:^|[^\w])([A-Za-z]:[\\/]+(?:wenyou(?:[ ]|%20)+pro|deepseek(?:[ ]|%20)+harness))(?=$|[\\/\s"'`|;:,，。！？（）()[\]{}])/gi,
	},
	{
		kind: "hardcoded-local-workspace",
		regex:
			/(?:^|file:\/\/|[^\w:/.-])(\/(?:(?:mnt|cygdrive)\/)?[A-Za-z]\/(?:wenyou(?:[ ]|%20)+pro|deepseek(?:[ ]|%20)+harness))(?=$|[\\/\s"'`|;:,，。！？（）()[\]{}])/gi,
	},
];

/**
 * Scan text content for unmasked local user paths or hardcoded local workspace drive paths.
 */
export function scanTextForPathLeaks(text, options = {}) {
	const filePath = options.filePath ? normalizeSlashes(options.filePath) : "";
	const isTestFile =
		typeof options.isTestFile === "boolean" ? options.isTestFile : isTestFilePath(filePath);
	const findings = [];
	const lines = String(text).split(/\r?\n/);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const lineText = lines[lineIndex];

		for (const { kind, regex } of USER_PATH_PATTERNS) {
			regex.lastIndex = 0;
			let match;
			while ((match = regex.exec(lineText)) !== null) {
				const fullMatch = match[1];
				const userSegment = match[2];
				const fullMatchStart = match.index + (match[0].length - fullMatch.length);
				const matchEndIndex = match.index + match[0].length;
				const tail = lineText.slice(matchEndIndex, matchEndIndex + 16);

				if (isAllowedUserSegment(userSegment, tail, { isTestFile })) {
					continue;
				}
				if (
					!isTestFile &&
					kind === "posix-home-path" &&
					userSegment === "user" &&
					UPSTREAM_UI_PLACEHOLDER_PREFIX_PATTERN.test(lineText.slice(0, fullMatchStart))
				) {
					continue;
				}

				const redactedMatch = `${fullMatch.slice(0, fullMatch.length - userSegment.length)}<REDACTED>`;
				findings.push({
					file: filePath,
					line: lineIndex + 1,
					kind,
					match: sanitizeTextForDisplay(redactedMatch),
				});
			}
		}

		for (const { kind, regex } of WORKSPACE_PATH_PATTERNS) {
			regex.lastIndex = 0;
			let match;
			while ((match = regex.exec(lineText)) !== null) {
				const fullMatch = match[1];
				const drivePrefixMatch = /^([A-Za-z]:[\\/]+|\/(?:(?:mnt|cygdrive)\/)?[A-Za-z]\/)/i.exec(
					fullMatch,
				);
				const redactedMatch = drivePrefixMatch
					? `${drivePrefixMatch[1]}<REDACTED-WORKSPACE>`
					: "<REDACTED-WORKSPACE>";
				findings.push({
					file: filePath,
					line: lineIndex + 1,
					kind,
					match: redactedMatch,
				});
			}
		}
	}

	return findings;
}

export function listGitWorkspaceFiles(rootDir) {
	const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: rootDir,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return raw
		.split("\0")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map(normalizeSlashes);
}

function bufferLooksBinary(buf) {
	const sampleLen = Math.min(buf.length, 8192);
	for (let i = 0; i < sampleLen; i += 1) {
		if (buf[i] === 0) return true;
	}
	return false;
}

/**
 * Scan repository files (via git ls-files or an explicit relative file list) for path leaks.
 */
export async function scanRepositoryPaths(options = {}) {
	const rootDir = resolve(options.rootDir ?? DEFAULT_REPO_ROOT);
	const files = Array.isArray(options.files)
		? options.files.map(normalizeSlashes)
		: listGitWorkspaceFiles(rootDir);

	let scannedFiles = 0;
	let skippedBinaryFiles = 0;
	let skippedMissingFiles = 0;
	const violations = [];

	for (const relPath of files) {
		if (isBinaryFilePath(relPath)) {
			skippedBinaryFiles += 1;
			continue;
		}
		const absPath = resolve(rootDir, relPath);
		let info;
		try {
			info = await stat(absPath);
		} catch {
			skippedMissingFiles += 1;
			continue;
		}
		if (!info.isFile()) {
			skippedMissingFiles += 1;
			continue;
		}

		const buf = await readFile(absPath);
		if (bufferLooksBinary(buf)) {
			skippedBinaryFiles += 1;
			continue;
		}

		scannedFiles += 1;
		const text = buf.toString("utf8");
		const displayPath = normalizeSlashes(relative(rootDir, absPath) || relPath);
		const fileFindings = scanTextForPathLeaks(text, { filePath: displayPath });
		if (fileFindings.length > 0) {
			violations.push(...fileFindings);
		}
	}

	return {
		ok: violations.length === 0,
		totalListedFiles: files.length,
		scannedFiles,
		skippedBinaryFiles,
		skippedMissingFiles,
		violationCount: violations.length,
		violations,
	};
}

export function parseScanArgs(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			root: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
		strict: true,
	});
	if (positionals.length > 0) {
		throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
	}
	return {
		rootDir: values.root,
		help: Boolean(values.help),
	};
}

function printUsage() {
	console.log(
		[
			"Usage: node scripts/wenyou-release/scan-repo-paths.mjs [--root <dir>]",
			"",
			"Scans all git-tracked and untracked non-ignored text files for unmasked local",
			"user directory paths and hardcoded local workspace drive paths.",
			"",
			"Options:",
			"  --root <dir>   Override repository root directory",
			"  -h, --help     Show this help message",
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
	const args = parseScanArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}
	const report = await scanRepositoryPaths({
		rootDir: args.rootDir ?? DEFAULT_REPO_ROOT,
	});
	console.log(JSON.stringify(report, null, 2));
	if (!report.ok) {
		for (const item of report.violations) {
			console.error(`[check:paths] ${item.file}:${item.line} (${item.kind}): ${item.match}`);
		}
		process.exitCode = 1;
	}
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[check:paths] ERROR: ${sanitizeTextForDisplay(message)}`);
		process.exitCode = 1;
	});
}
