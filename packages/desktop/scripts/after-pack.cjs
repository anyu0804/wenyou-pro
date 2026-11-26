"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEEP_PAKS = new Set(["zh-CN.pak", "en-US.pak"]);
const KEEP_LPROJS = new Set(["zh_CN.lproj", "zh-Hans.lproj", "en.lproj", "Base.lproj"]);

function prunePakLocales(localesDir) {
	if (!fs.existsSync(localesDir)) return 0;
	let removed = 0;
	for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".pak")) continue;
		if (KEEP_PAKS.has(entry.name)) continue;
		fs.rmSync(path.join(localesDir, entry.name), { force: true });
		removed += 1;
	}
	return removed;
}

function pruneMacLprojs(resourcesDir) {
	if (!fs.existsSync(resourcesDir)) return 0;
	let removed = 0;
	for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
		if (KEEP_LPROJS.has(entry.name)) continue;
		fs.rmSync(path.join(resourcesDir, entry.name), { recursive: true, force: true });
		removed += 1;
	}
	return removed;
}

async function afterPack(context) {
	const appOutDir = context && context.appOutDir;
	if (!appOutDir || typeof appOutDir !== "string") return;

	prunePakLocales(path.join(appOutDir, "locales"));

	if (context.electronPlatformName === "darwin" && fs.existsSync(appOutDir)) {
		for (const entry of fs.readdirSync(appOutDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
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
