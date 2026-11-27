#!/usr/bin/env node
/**
 * Release artifact staging collector & non-empty completeness gate for Wenyou Pro.
 * Author: 安钰
 *
 * Recursively discovers macOS and Windows release artifacts from downloaded GitHub Actions
 * staging directories (supporting both flat layouts and nested `wenyou-pro-<ver>-*` folders),
 * copies them into a flat upload directory, and fails closed if any required asset is missing
 * or empty so an empty (0-asset) GitHub Release can never be created silently.
 */

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MODULE_PATH = fileURLToPath(import.meta.url);

function normalizeSlashes(value) {
	return String(value).replaceAll("\\", "/");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizePathForDisplay(inputPath, home = homedir()) {
	const text = typeof inputPath === "string" ? inputPath : String(inputPath ?? "");
	if (!home) return text;
	const homePosix = normalizeSlashes(home).replace(/\/+$/, "");
	if (!homePosix) return text;

	const variants = [];
	const winDriveMatch = /^([A-Za-z]):\/(.+)$/.exec(homePosix);
	if (winDriveMatch) {
		const drive = winDriveMatch[1];
		const restPattern = winDriveMatch[2]
			.split("/")
			.filter(Boolean)
			.map(escapeRegExp)
			.join("[\\\\/]+");
		variants.push(`${escapeRegExp(drive)}:[\\\\/]+${restPattern}`);
		variants.push(`/+(?:(?:mnt|cygdrive)/+)?${escapeRegExp(drive)}[\\\\/]+${restPattern}`);
	} else {
		const segments = homePosix.split("/").filter(Boolean).map(escapeRegExp);
		if (segments.length > 0) {
			variants.push(`[\\\\/]+${segments.join("[\\\\/]+")}`);
		}
	}

	if (variants.length === 0) return text;
	const pattern = new RegExp(
		`(^|[^A-Za-z0-9_])(?:${variants.join("|")})(?=$|[\\\\/\\s"'\\])},;.:：，。！？（）()\\[\\]{}<>|])`,
		"gi",
	);
	return text.replace(pattern, "$1~");
}

export async function collectFilesRecursively(rootDir) {
	const resolvedRoot = resolve(rootDir);
	let rootStat;
	try {
		rootStat = await stat(resolvedRoot);
	} catch {
		throw new Error(`Staging directory does not exist: ${sanitizePathForDisplay(resolvedRoot)}`);
	}
	if (!rootStat.isDirectory()) {
		throw new Error(`Staging path is not a directory: ${sanitizePathForDisplay(resolvedRoot)}`);
	}

	const discovered = [];
	const walk = async (currentDir) => {
		const entries = await readdir(currentDir, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				const info = await stat(fullPath);
				discovered.push({
					absPath: fullPath,
					relPath: normalizeSlashes(relative(resolvedRoot, fullPath)),
					baseName: entry.name,
					size: info.size,
				});
			}
		}
	};

	await walk(resolvedRoot);
	discovered.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return discovered;
}

async function directoryExists(dirPath) {
	try {
		return (await stat(dirPath)).isDirectory();
	} catch {
		return false;
	}
}

async function copyStagedFile(entry, destDir, destName, seenDestinations) {
	if (entry.size <= 0) {
		throw new Error(
			`Release staging hard gate failed: empty artifact (0 bytes) at "${entry.relPath}"`,
		);
	}
	const key = destName.toLowerCase();
	if (seenDestinations.has(key)) {
		throw new Error(
			`Release staging hard gate failed: duplicate artifact filename "${destName}" (from "${entry.relPath}" and "${seenDestinations.get(key)}")`,
		);
	}
	seenDestinations.set(key, entry.relPath);
	const destPath = join(destDir, destName);
	await copyFile(entry.absPath, destPath);
	const copiedStat = await stat(destPath);
	if (!copiedStat.isFile() || copiedStat.size <= 0) {
		throw new Error(
			`Release staging hard gate failed: staged file "${destName}" is missing or empty after copy`,
		);
	}
	return destName;
}

/**
 * Stages macOS (required) and Windows (optional or required via `requireWindows`) release artifacts
 * from flat or arbitrarily nested staging directories into `outDir`, enforcing non-empty completeness.
 */
export async function stageReleaseAssets({
	macDir,
	winDir,
	outDir,
	requireWindows = false,
} = {}) {
	if (!macDir) throw new Error("stageReleaseAssets requires macDir");
	if (!outDir) throw new Error("stageReleaseAssets requires outDir");

	const resolvedMacDir = resolve(macDir);
	const resolvedWinDir = winDir ? resolve(winDir) : null;
	const resolvedOutDir = resolve(outDir);

	await rm(resolvedOutDir, { recursive: true, force: true });
	await mkdir(resolvedOutDir, { recursive: true });

	const seenDestinations = new Map();
	const macFiles = await collectFilesRecursively(resolvedMacDir);

	const macDmg = [];
	const macZip = [];
	let macSha256 = null;
	let macReadme = null;

	for (const file of macFiles) {
		const lower = file.baseName.toLowerCase();
		if (lower.endsWith(".dmg")) {
			macDmg.push(await copyStagedFile(file, resolvedOutDir, file.baseName, seenDestinations));
		} else if (lower.endsWith(".zip")) {
			macZip.push(await copyStagedFile(file, resolvedOutDir, file.baseName, seenDestinations));
		} else if (file.baseName === "SHA256SUMS.txt") {
			macSha256 = await copyStagedFile(
				file,
				resolvedOutDir,
				"SHA256SUMS-macOS.txt",
				seenDestinations,
			);
		} else if (file.baseName === "使用说明.txt") {
			macReadme = await copyStagedFile(
				file,
				resolvedOutDir,
				"使用说明-macOS.txt",
				seenDestinations,
			);
		}
	}

	const shouldCollectWindows =
		Boolean(requireWindows) || (resolvedWinDir !== null && (await directoryExists(resolvedWinDir)));

	let winSummary = null;
	let winFiles = [];
	if (shouldCollectWindows) {
		if (!resolvedWinDir) {
			throw new Error(
				"Release staging hard gate failed: --require-windows was specified without --win-dir",
			);
		}
		winFiles = await collectFilesRecursively(resolvedWinDir);
		const winExe = [];
		const winZip = [];
		let winSha256 = null;
		let winReadme = null;

		for (const file of winFiles) {
			const lower = file.baseName.toLowerCase();
			if (lower.endsWith(".exe")) {
				winExe.push(await copyStagedFile(file, resolvedOutDir, file.baseName, seenDestinations));
			} else if (lower.endsWith(".zip")) {
				winZip.push(await copyStagedFile(file, resolvedOutDir, file.baseName, seenDestinations));
			} else if (file.baseName === "SHA256SUMS.txt") {
				winSha256 = await copyStagedFile(
					file,
					resolvedOutDir,
					"SHA256SUMS-Windows-x64.txt",
					seenDestinations,
				);
			} else if (file.baseName === "使用说明.txt") {
				winReadme = await copyStagedFile(
					file,
					resolvedOutDir,
					"使用说明-Windows-x64.txt",
					seenDestinations,
				);
			}
		}

		winSummary = {
			exe: winExe,
			zip: winZip,
			sha256: winSha256,
			readme: winReadme,
		};
	}

	const missing = [];
	if (macDmg.length === 0) missing.push("macOS .dmg installer");
	if (macZip.length === 0) missing.push("macOS .zip archive");
	if (!macSha256) missing.push("SHA256SUMS-macOS.txt");
	if (!macReadme) missing.push("使用说明-macOS.txt");

	if (requireWindows || shouldCollectWindows) {
		if (!winSummary || winSummary.exe.length === 0) missing.push("Windows x64 .exe installer");
		if (!winSummary || winSummary.zip.length === 0) missing.push("Windows x64 .zip archive");
		if (!winSummary?.sha256) missing.push("SHA256SUMS-Windows-x64.txt");
		if (!winSummary?.readme) missing.push("使用说明-Windows-x64.txt");
	}

	const stagedFiles = (await readdir(resolvedOutDir)).sort();
	if (stagedFiles.length === 0) {
		missing.push("non-empty release-upload directory");
	}

	if (missing.length > 0) {
		const macList = macFiles.map((f) => f.relPath).join(", ") || "(none)";
		const winList = shouldCollectWindows
			? `; win staging files=[${winFiles.map((f) => f.relPath).join(", ") || "(none)"}]`
			: "";
		throw new Error(
			`Release staging hard gate failed: missing required non-empty artifact(s): ${missing.join(", ")}. Discovered mac staging files=[${macList}]${winList}`,
		);
	}

	return {
		ok: true,
		requireWindows: Boolean(requireWindows),
		outDir: sanitizePathForDisplay(resolvedOutDir),
		mac: {
			dmg: macDmg,
			zip: macZip,
			sha256: macSha256,
			readme: macReadme,
		},
		win: winSummary,
		stagedFiles,
	};
}

export function parseStageArgs(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			"mac-dir": { type: "string" },
			"win-dir": { type: "string" },
			"out-dir": { type: "string" },
			"require-windows": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
		strict: true,
	});
	if (positionals.length > 0) {
		throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
	}
	return {
		macDir: values["mac-dir"],
		winDir: values["win-dir"],
		outDir: values["out-dir"],
		requireWindows: Boolean(values["require-windows"]),
		help: Boolean(values.help),
	};
}

function printUsage() {
	console.log(
		[
			"Usage: node scripts/wenyou-release/stage-release-assets.mjs [options]",
			"",
			"Options:",
			"  --mac-dir <dir>       Downloaded macOS artifact staging directory (required)",
			"  --win-dir <dir>       Downloaded Windows x64 artifact staging directory (optional)",
			"  --out-dir <dir>       Flat release upload directory to populate (required)",
			"  --require-windows     Enforce non-empty Windows x64 .exe/.zip/SHA256SUMS/使用说明",
			"  -h, --help            Show this help message",
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
	const args = parseStageArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}
	const summary = await stageReleaseAssets({
		macDir: args.macDir,
		winDir: args.winDir,
		outDir: args.outDir,
		requireWindows: args.requireWindows,
	});
	console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[stage-release-assets] FAILED: ${sanitizePathForDisplay(message)}`);
		process.exitCode = 1;
	});
}
