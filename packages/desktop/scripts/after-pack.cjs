"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEEP_PAKS = new Set(["zh-CN.pak", "en-US.pak"]);
const KEEP_PAKS_LOWER = new Set([...KEEP_PAKS].map((name) => name.toLowerCase()));
const KEEP_LPROJS = new Set(["zh_CN.lproj", "zh-Hans.lproj", "en.lproj", "Base.lproj"]);
const KEEP_LPROJS_LOWER = new Set([...KEEP_LPROJS].map((name) => name.toLowerCase()));

function isRealDirectory(dirPath) {
	try {
		return fs.lstatSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function prunePakLocales(localesDir) {
	if (!isRealDirectory(localesDir)) return 0;
	let removed = 0;
	for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const lower = entry.name.toLowerCase();
		if (!lower.endsWith(".pak")) continue;
		if (KEEP_PAKS_LOWER.has(lower)) continue;
		fs.rmSync(path.join(localesDir, entry.name), { recursive: true, force: true });
		removed += 1;
	}
	return removed;
}

function pruneMacLprojs(resourcesDir) {
	if (!isRealDirectory(resourcesDir)) return 0;
	let removed = 0;
	for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const lower = entry.name.toLowerCase();
		if (!lower.endsWith(".lproj")) continue;
		if (KEEP_LPROJS_LOWER.has(lower)) continue;
		fs.rmSync(path.join(resourcesDir, entry.name), { recursive: true, force: true });
		removed += 1;
	}
	return removed;
}

async function afterPack(context) {
	const appOutDir = context && context.appOutDir;
	if (!appOutDir || typeof appOutDir !== "string") return;

	prunePakLocales(path.join(appOutDir, "locales"));

	if (context.electronPlatformName === "darwin" && isRealDirectory(appOutDir)) {
		for (const entry of fs.readdirSync(appOutDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".app")) continue;
			const contentsDir = path.join(appOutDir, entry.name, "Contents");
			pruneMacLprojs(path.join(contentsDir, "Resources"));
			pruneMacLprojs(
				path.join(
					contentsDir,
					"Frameworks",
					"Electron Framework.framework",
					"Versions",
					"A",
					"Resources",
				),
			);
		}
	}
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.KEEP_PAKS = KEEP_PAKS;
module.exports.KEEP_LPROJS = KEEP_LPROJS;
