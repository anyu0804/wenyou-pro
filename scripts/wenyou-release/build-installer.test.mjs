import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildElectronBuilderArgs,
	buildElectronBuilderConfigOverride,
	buildWenyouInstaller,
	checkPrerequisites,
	collectReleaseArtifacts,
	formatLinuxArtifactArch,
	formatLinuxReleaseNotes,
	formatMacReleaseNotes,
	formatReleaseNotes,
	formatSha256Sums,
	getRequiredPrerequisites,
	moveFileSafely,
	POSIX_NTQQ_VFS_FILTER,
	parseBuildArgs,
	REQUIRED_MAC_PREREQUISITES,
	REQUIRED_PREREQUISITES,
	readDefaultVersion,
	resolveDefaultPlatform,
	resolveNpmCommand,
	resolveReleasePaths,
	resolveTargetArchitectures,
	sanitizeTextForLog,
	validatePngIconBuffer,
} from "./build-installer.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createMinimalIcoBuffer(sizes = [32, 256]) {
	const count = sizes.length;
	const headerSize = 6 + count * 16;
	const payloads = sizes.map((size) => {
		if (size === 256) {
			return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
		}
		return Buffer.from([0x28, 0x00, 0x00, 0x00, size & 0xff, 0x00, 0x00, 0x00]);
	});
	const totalPayloadBytes = payloads.reduce((sum, p) => sum + p.length, 0);
	const out = Buffer.alloc(headerSize + totalPayloadBytes);
	out.writeUInt16LE(0, 0);
	out.writeUInt16LE(1, 2);
	out.writeUInt16LE(count, 4);

	let dataOffset = headerSize;
	for (let i = 0; i < count; i += 1) {
		const size = sizes[i];
		const entryOffset = 6 + i * 16;
		const dimByte = size === 256 ? 0x00 : size;
		out[entryOffset] = dimByte;
		out[entryOffset + 1] = dimByte;
		out[entryOffset + 2] = 0;
		out[entryOffset + 3] = 0;
		out.writeUInt16LE(1, entryOffset + 4);
		out.writeUInt16LE(32, entryOffset + 6);
		out.writeUInt32LE(payloads[i].length, entryOffset + 8);
		out.writeUInt32LE(dataOffset, entryOffset + 12);
		payloads[i].copy(out, dataOffset);
		dataOffset += payloads[i].length;
	}
	return out;
}

function createMinimalPngHeaderBuffer(width = 1024, height = 1024) {
	const buf = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, 4, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	buf[24] = 8; // bit depth
	buf[25] = 6; // RGBA
	return buf;
}

async function createTempFixtureRepo(version = "0.2.4", platform = "win") {
	const tempRoot = await mkdtemp(join(os.tmpdir(), "wenyou-build-installer-"));
	await mkdir(join(tempRoot, "packages/desktop"), { recursive: true });
	await writeFile(
		join(tempRoot, "packages/desktop/package.json"),
		`${JSON.stringify({ name: "@percho/desktop", version }, null, 2)}\n`,
		"utf8",
	);
	const required = getRequiredPrerequisites(platform);
	for (const relPath of required) {
		const absPath = join(tempRoot, relPath);
		await mkdir(dirname(absPath), { recursive: true });
		if (relPath === "packages/desktop/build/wenyou-pro.ico") {
			await writeFile(absPath, createMinimalIcoBuffer([32, 256]));
		} else if (relPath === "packages/desktop/build/icon.png") {
			await writeFile(absPath, createMinimalPngHeaderBuffer(1024, 1024));
		} else {
			await writeFile(absPath, `fixture:${relPath}\n`, "utf8");
		}
	}
	return tempRoot;
}

describe("parseBuildArgs and platform/arch resolution", () => {
	test("parses default and explicit flags including --platform and --arch", () => {
		assert.deepEqual(parseBuildArgs([]), {
			version: undefined,
			platform: undefined,
			arch: undefined,
			skipBuild: false,
			dryRun: false,
			help: false,
		});
		assert.deepEqual(parseBuildArgs(["--version", "0.2.4", "--skip-build", "--dry-run"]), {
			version: "0.2.4",
			platform: undefined,
			arch: undefined,
			skipBuild: true,
			dryRun: true,
			help: false,
		});
		assert.deepEqual(parseBuildArgs(["--version=1.2.3", "--platform", "mac", "--arch", "arm64"]), {
			version: "1.2.3",
			platform: "mac",
			arch: "arm64",
			skipBuild: false,
			dryRun: false,
			help: false,
		});
		assert.equal(resolveDefaultPlatform("darwin"), "mac");
		assert.equal(resolveDefaultPlatform("win32"), "win");
		assert.equal(resolveDefaultPlatform("linux"), "linux");
		assert.deepEqual(resolveTargetArchitectures("mac"), ["arm64", "x64"]);
		assert.deepEqual(resolveTargetArchitectures("mac", "all"), ["arm64", "x64"]);
		assert.deepEqual(resolveTargetArchitectures("mac", "arm64"), ["arm64"]);
		assert.deepEqual(resolveTargetArchitectures("win"), ["x64"]);
		assert.deepEqual(resolveTargetArchitectures("linux"), ["x64"]);
		assert.equal(formatLinuxArtifactArch("x64"), "x86_64");
		assert.equal(formatLinuxArtifactArch("arm64"), "arm64");
	});

	test("rejects malformed versions, invalid platforms/archs, and unknown flags", () => {
		assert.throws(() => parseBuildArgs(["--version", "v0.2.4"]), /Invalid release version/);
		assert.throws(() => parseBuildArgs(["--version", "0.2"]), /Invalid release version/);
		assert.throws(() => parseBuildArgs(["--version", "../0.2.4"]), /Invalid release version/);
		assert.throws(() => parseBuildArgs(["--platform", "solaris"]), /Invalid target platform/);
		assert.throws(() => parseBuildArgs(["--platform", "win", "--arch", "arm64"]), /Invalid Windows arch/);
		assert.throws(() => parseBuildArgs(["--arch", "ia32"]), /Invalid target arch/);
		assert.throws(() => parseBuildArgs(["--unknown-flag"]));
	});
});

describe("buildElectronBuilderConfigOverride and buildElectronBuilderArgs", () => {
	test("builds standalone override config with relative extends and version overrides for win, mac, and linux", () => {
		const winOverride = buildElectronBuilderConfigOverride("0.9.4");
		assert.deepEqual(winOverride, {
			extends: "electron-builder.wenyou.yml",
			directories: {
				output: "../../dist/wenyou-pro-0.9.4-win-x64/raw",
			},
			extraMetadata: {
				version: "0.9.4",
			},
		});

		const winArgs = buildElectronBuilderArgs("/tmp/override.json");
		assert.deepEqual(winArgs, [
			"--config",
			"/tmp/override.json",
			"--win",
			"nsis",
			"zip",
			"--x64",
			"--publish",
			"never",
		]);

		const macOverride = buildElectronBuilderConfigOverride("0.9.4", { platform: "mac", arch: "all" });
		assert.deepEqual(macOverride, {
			extends: "electron-builder.wenyou.yml",
			directories: {
				output: "../../dist/wenyou-pro-0.9.4-mac/raw",
			},
			extraMetadata: {
				version: "0.9.4",
			},
		});

		const macAllArgs = buildElectronBuilderArgs("/tmp/override.json", { platform: "mac", arch: "all" });
		assert.deepEqual(macAllArgs, [
			"--config",
			"/tmp/override.json",
			"--mac",
			"dmg",
			"zip",
			"--arm64",
			"--x64",
			"--publish",
			"never",
		]);

		const macArmArgs = buildElectronBuilderArgs("/tmp/override.json", { platform: "mac", arch: "arm64" });
		assert.deepEqual(macArmArgs, [
			"--config",
			"/tmp/override.json",
			"--mac",
			"dmg",
			"zip",
			"--arm64",
			"--publish",
			"never",
		]);

		const linuxPaths = resolveReleasePaths("/tmp/repo", "0.2.4", { platform: "linux", arch: "x64" });
		assert.deepEqual(linuxPaths.expectedArtifacts, ["Wenyou-Pro-0.2.4-linux-x86_64.AppImage"]);
	});
});

describe("checkPrerequisites", () => {
	test("includes complete ntqq-vfs, update-diagnostics, and 256px ico prerequisites on Windows", async () => {
		assert.ok(REQUIRED_PREREQUISITES.includes("packages/desktop/resources/ntqq-vfs/ntqq_vfs.py"));
		assert.ok(REQUIRED_PREREQUISITES.includes("packages/desktop/resources/ntqq-vfs/wenyou_ntqq_bridge.py"));
		assert.ok(REQUIRED_PREREQUISITES.includes("packages/desktop/resources/update-diagnostics/collect.ps1"));

		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			const result = await checkPrerequisites(tempRoot);
			assert.equal(result.ok, true);
			assert.equal(result.checked.length, REQUIRED_PREREQUISITES.length);
			assert.equal(result.icon.has256, true);
			assert.ok(result.icon.sizes.includes("256x256"));
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("rejects legacy 32px-only or malformed wenyou-pro.ico lacking a 256x256 frame on Windows", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			const icoPath = join(tempRoot, "packages/desktop/build/wenyou-pro.ico");

			await writeFile(icoPath, createMinimalIcoBuffer([16, 32]));
			await assert.rejects(() => checkPrerequisites(tempRoot), /missing a 256x256 frame/i);

			await writeFile(icoPath, "not-an-ico-file-at-all-1234567890", "utf8");
			await assert.rejects(() => checkPrerequisites(tempRoot), /Invalid ICO header/i);

			const truncated = Buffer.alloc(24);
			truncated.writeUInt16LE(0, 0);
			truncated.writeUInt16LE(1, 2);
			truncated.writeUInt16LE(4, 4);
			await writeFile(icoPath, truncated);
			await assert.rejects(() => checkPrerequisites(tempRoot), /Truncated ICO directory/i);

			const garbage256 = Buffer.alloc(6 + 16 + 16);
			garbage256.writeUInt16LE(0, 0);
			garbage256.writeUInt16LE(1, 2);
			garbage256.writeUInt16LE(1, 4);
			garbage256[6] = 0x00;
			garbage256[7] = 0x00;
			garbage256.writeUInt32LE(16, 6 + 8);
			garbage256.writeUInt32LE(22, 6 + 12);
			Buffer.from("NOT-PNG-OR-DIB!!").copy(garbage256, 22);
			await writeFile(icoPath, garbage256);
			await assert.rejects(() => checkPrerequisites(tempRoot), /Invalid 256x256 ICO frame payload/i);

			const dib256 = Buffer.alloc(6 + 16 + 40);
			dib256.writeUInt16LE(0, 0);
			dib256.writeUInt16LE(1, 2);
			dib256.writeUInt16LE(1, 4);
			dib256[6] = 0x00;
			dib256[7] = 0x00;
			dib256.writeUInt32LE(40, 6 + 8);
			dib256.writeUInt32LE(22, 6 + 12);
			dib256.writeUInt32LE(40, 22);
			await writeFile(icoPath, dib256);
			const dibResult = await checkPrerequisites(tempRoot);
			assert.equal(dibResult.icon.has256, true);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("macOS/Linux prerequisite check validates >=512px build/icon.png and 4 .py scripts without Windows binaries", async () => {
		assert.ok(REQUIRED_MAC_PREREQUISITES.includes("packages/desktop/build/icon.png"));
		assert.equal(
			REQUIRED_MAC_PREREQUISITES.includes("packages/desktop/resources/ntqq-vfs/python/python.exe"),
			false,
		);
		assert.equal(
			REQUIRED_MAC_PREREQUISITES.includes("packages/desktop/resources/ntqq-vfs/qq_dump_db.exe"),
			false,
		);
		assert.equal(
			REQUIRED_MAC_PREREQUISITES.includes("packages/desktop/resources/update-diagnostics/collect.ps1"),
			false,
		);

		const tempRoot = await createTempFixtureRepo("0.2.4", "mac");
		try {
			const result = await checkPrerequisites(tempRoot, { platform: "mac" });
			assert.equal(result.ok, true);
			assert.equal(result.platform, "mac");
			assert.equal(result.checked.length, REQUIRED_MAC_PREREQUISITES.length);
			assert.equal(result.icon.width, 1024);
			assert.equal(result.icon.height, 1024);

			const iconPath = join(tempRoot, "packages/desktop/build/icon.png");
			// Reject under-sized 256x256 PNG
			await writeFile(iconPath, createMinimalPngHeaderBuffer(256, 256));
			await assert.rejects(
				() => checkPrerequisites(tempRoot, { platform: "mac" }),
				/below minimum 512x512/i,
			);

			// Reject non-PNG bytes
			await writeFile(iconPath, Buffer.from("not-a-png-header-at-all-1234567890"));
			await assert.rejects(
				() => checkPrerequisites(tempRoot, { platform: "linux" }),
				/Invalid PNG signature/i,
			);

			// Direct validator check
			assert.throws(() => validatePngIconBuffer(Buffer.from("tiny")), /at least 24 bytes/i);

			await rm(iconPath);
			await assert.rejects(
				() => checkPrerequisites(tempRoot, { platform: "mac" }),
				/packages\/desktop\/build\/icon\.png/,
			);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("throws naming missing relative path when a required Windows file is absent", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			const missingRel = "packages/desktop/resources/ntqq-vfs/python/python.exe";
			await rm(join(tempRoot, missingRel));
			await assert.rejects(
				() => checkPrerequisites(tempRoot),
				(error) => {
					assert.match(error.message, /missing:/);
					assert.ok(error.message.includes(missingRel));
					return true;
				},
			);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("throws naming empty relative path when a required file is 0 bytes", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			const emptyRel = "packages/desktop/build/wenyou-pro.ico";
			await writeFile(join(tempRoot, emptyRel), "", "utf8");
			await assert.rejects(
				() => checkPrerequisites(tempRoot),
				(error) => {
					assert.match(error.message, /empty:/);
					assert.ok(error.message.includes(emptyRel));
					return true;
				},
			);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("sanitizeTextForLog and resolveNpmCommand", () => {
	test("sanitizes Windows, MSYS, mixed-slash, double-slash, and punctuated home paths without false positives", () => {
		const fakeHome = "C:\\Users\\AliceTest";
		assert.equal(sanitizeTextForLog("C:\\Users\\AliceTest\\Desktop", fakeHome), "~\\Desktop");
		assert.equal(sanitizeTextForLog("/c/Users/AliceTest/Desktop", fakeHome), "~/Desktop");
		assert.equal(sanitizeTextForLog("C:\\Users/AliceTest\\AppData", fakeHome), "~\\AppData");
		assert.equal(sanitizeTextForLog("C:\\\\Users\\\\AliceTest\\\\Temp", fakeHome), "~\\\\Temp");
		assert.equal(sanitizeTextForLog("file:///C:/Users/AliceTest/a.txt", fakeHome), "file:///~/a.txt");
		assert.equal(
			sanitizeTextForLog("Target not found: C:\\Users\\AliceTest.", fakeHome),
			"Target not found: ~.",
		);
		assert.equal(sanitizeTextForLog("Error at C:\\Users\\AliceTest:123", fakeHome), "Error at ~:123");
		assert.equal(sanitizeTextForLog("路径：C:\\Users\\AliceTest，失败", fakeHome), "路径：~，失败");
		assert.equal(
			sanitizeTextForLog("C:\\Users\\AliceTest2\\Desktop", fakeHome),
			"C:\\Users\\AliceTest2\\Desktop",
		);
	});

	test("resolveNpmCommand only reuses npm_execpath for npm CLI scripts and rejects pnpm/yarn", () => {
		const npmArgs = ["run", "build", "-w", "packages/desktop"];
		const fakeNode = "C:\\Program Files\\nodejs\\node.exe";
		const bundled = join(dirname(fakeNode), "node_modules", "npm", "bin", "npm-cli.js");

		const fromNpm = resolveNpmCommand(npmArgs, {
			env: { npm_execpath: "C:\\tools\\npm\\bin\\npm-cli.js" },
			execPath: fakeNode,
			existsFn: (p) => p === "C:\\tools\\npm\\bin\\npm-cli.js",
			platform: "win32",
		});
		assert.deepEqual(fromNpm, {
			command: fakeNode,
			args: ["C:\\tools\\npm\\bin\\npm-cli.js", ...npmArgs],
			shell: false,
		});

		const fromPnpm = resolveNpmCommand(npmArgs, {
			env: { npm_execpath: "C:\\tools\\pnpm\\pnpm.cjs" },
			execPath: fakeNode,
			existsFn: (p) => p === "C:\\tools\\pnpm\\pnpm.cjs" || p === bundled,
			platform: "win32",
		});
		assert.deepEqual(fromPnpm, {
			command: fakeNode,
			args: [bundled, ...npmArgs],
			shell: false,
		});

		const fromYarnNoBundled = resolveNpmCommand(npmArgs, {
			env: { npm_execpath: "C:\\tools\\yarn\\yarn.js" },
			execPath: fakeNode,
			existsFn: (p) => p === "C:\\tools\\yarn\\yarn.js",
			platform: "win32",
		});
		assert.deepEqual(fromYarnNoBundled, {
			command: "npm.cmd",
			args: npmArgs,
			shell: true,
		});

		const fromPosixNpm = resolveNpmCommand(npmArgs, {
			env: { npm_execpath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js" },
			execPath: "/opt/node/bin/node",
			existsFn: (p) => p === "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
			platform: "linux",
		});
		assert.deepEqual(fromPosixNpm, {
			command: "/opt/node/bin/node",
			args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js", ...npmArgs],
			shell: false,
		});

		const fromPosixYarnNoBundled = resolveNpmCommand(npmArgs, {
			env: { npm_execpath: "/opt/yarn/bin/yarn.js" },
			execPath: "/opt/node/bin/node",
			existsFn: (p) => p === "/opt/yarn/bin/yarn.js",
			platform: "linux",
		});
		assert.deepEqual(fromPosixYarnNoBundled, {
			command: "npm",
			args: npmArgs,
			shell: false,
		});
	});
});

describe("formatReleaseNotes, formatMacReleaseNotes, formatLinuxReleaseNotes, and formatSha256Sums", () => {
	test("generates UTF-8 BOM + CRLF Windows notes with v0.2.5 brand, repo URL, MIT attribution, and sanitized paths", () => {
		const notes = formatReleaseNotes("0.2.5");
		const buf = Buffer.from(notes, "utf8");

		assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

		const body = notes.slice(1);
		assert.ok(body.includes("\r\n"), "notes must use CRLF line endings");
		assert.equal(body.replace(/\r\n/g, "").includes("\n"), false, "notes must not contain bare LF");
		assert.equal(body.replace(/\r\n/g, "").includes("\r"), false, "notes must not contain bare CR");
		assert.ok(body.endsWith("\r\n"), "notes must end with CRLF");

		assert.ok(body.includes("司命 · 文游 Pro"));
		assert.ok(body.includes("Wenyou Pro v0.2.5"));
		assert.ok(body.includes("Wenyou-Pro-Setup-0.2.5-x64.exe"));
		assert.ok(body.includes("Wenyou-Pro-Portable-0.2.5-x64.zip"));
		assert.ok(body.includes("制作与整理：安钰"));
		assert.ok(body.includes("https://github.com/anyu0804/wenyou-pro"));
		assert.ok(body.includes("https://github.com/Jaxton07/percho"));
		assert.ok(body.includes("7 层"));
		assert.ok(body.includes("256x256"));
		assert.ok(body.includes("跨世界动态沙盘物理隔离"));
		assert.ok(body.includes("FMG .map"));
		assert.ok(body.includes("正史提案门禁"));
		assert.ok(body.includes("maxViewer"));
		assert.ok(body.includes("Python 3.13"));
		assert.ok(body.includes("40030=0"));
		assert.ok(body.includes("20,000"));
		assert.ok(body.includes("%USERPROFILE%\\.wenyou-pro\\"));

		assert.doesNotMatch(body, /[A-Za-z]:\\Users\\(?!Public|Default)/i);
		assert.doesNotMatch(body, /\/[a-z]\/Users\//i);
		const currentUsername = os.userInfo().username;
		if (currentUsername && currentUsername.length >= 2) {
			assert.equal(body.toLowerCase().includes(currentUsername.toLowerCase()), false);
		}
		const homeDir = os.homedir();
		if (homeDir) {
			assert.equal(body.toLowerCase().includes(homeDir.toLowerCase()), false);
		}
	});

	test("generates UTF-8 BOM macOS and Linux notes with repo URL, MIT attribution, sanitized paths, and AppImage x86_64 naming", () => {
		const notes = formatMacReleaseNotes("0.2.5", ["arm64", "x64"]);
		const buf = Buffer.from(notes, "utf8");
		assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

		const body = notes.slice(1);
		assert.ok(body.includes("司命 · 文游 Pro"));
		assert.ok(body.includes("Wenyou Pro v0.2.5 macOS"));
		assert.ok(body.includes("制作与整理：安钰"));
		assert.ok(body.includes("https://github.com/anyu0804/wenyou-pro"));
		assert.ok(body.includes("https://github.com/Jaxton07/percho"));
		assert.ok(body.includes("Wenyou-Pro-0.2.5-mac-arm64.dmg"));
		assert.ok(body.includes("Wenyou-Pro-0.2.5-mac-arm64.zip"));
		assert.ok(body.includes("Wenyou-Pro-0.2.5-mac-x64.dmg"));
		assert.ok(body.includes("Wenyou-Pro-0.2.5-mac-x64.zip"));
		assert.ok(body.includes('xattr -cr "/Applications/Wenyou Pro.app"'));
		assert.ok(body.includes("隐私与安全性"));
		assert.ok(body.includes("00-群聊收集/"));
		assert.ok(body.includes("key_map.json"));
		assert.ok(body.includes("~/.wenyou-pro/"));
		assert.ok(body.includes("~/Library/Application Support/Wenyou Pro/"));

		assert.equal(body.includes("%USERPROFILE%"), false);
		assert.doesNotMatch(body, /[A-Za-z]:\\Users\\/i);
		assert.doesNotMatch(body, /\/Users\/[^/\s]+/);
		const currentUsername = os.userInfo().username;
		if (currentUsername && currentUsername.length >= 2) {
			assert.equal(body.toLowerCase().includes(currentUsername.toLowerCase()), false);
		}

		const armOnly = formatMacReleaseNotes("1.5.0", ["arm64"]);
		assert.ok(armOnly.includes("Wenyou-Pro-1.5.0-mac-arm64.dmg"));
		assert.equal(armOnly.includes("Wenyou-Pro-1.5.0-mac-x64.dmg"), false);

		const linuxNotes = formatLinuxReleaseNotes("0.2.5", ["x64"]);
		assert.ok(linuxNotes.includes("https://github.com/anyu0804/wenyou-pro"));
		assert.ok(linuxNotes.includes("https://github.com/Jaxton07/percho"));
		assert.ok(linuxNotes.includes("Wenyou-Pro-0.2.5-linux-x86_64.AppImage"));
		assert.equal(linuxNotes.includes("Wenyou-Pro-0.2.5-linux-x64.AppImage"), false);
	});

	test("substitutes arbitrary version cleanly without stale version strings", () => {
		const notes = formatReleaseNotes("1.4.0");
		assert.ok(notes.includes("司命 · 文游 Pro"));
		assert.ok(notes.includes("Wenyou Pro v1.4.0"));
		assert.ok(notes.includes("Wenyou-Pro-Setup-1.4.0-x64.exe"));
		assert.ok(notes.includes("Wenyou-Pro-Portable-1.4.0-x64.zip"));
		assert.equal(notes.includes("0.2.2"), false);
		assert.equal(notes.includes("0.2.3"), false);
		assert.equal(notes.includes("0.2.4"), false);
		assert.equal(notes.includes("0.2.5"), false);
	});

	test("formats SHA256SUMS.txt with two-space separator and validates inputs", () => {
		const digestA = "a".repeat(64);
		const digestB = "0123456789abcdef".repeat(4);
		const formatted = formatSha256Sums([
			{ name: "Wenyou-Pro-Setup-0.2.4-x64.exe", sha256: digestA.toUpperCase() },
			{ name: "Wenyou-Pro-Portable-0.2.4-x64.zip", sha256: digestB },
		]);
		assert.equal(
			formatted,
			`${digestA}  Wenyou-Pro-Setup-0.2.4-x64.exe\n${digestB}  Wenyou-Pro-Portable-0.2.4-x64.zip\n`,
		);
		assert.throws(() => formatSha256Sums([]), /non-empty/);
		assert.throws(
			() => formatSha256Sums([{ name: "../escape.exe", sha256: digestA }]),
			/Invalid artifact filename/,
		);
		assert.throws(() => formatSha256Sums([{ name: "ok.exe", sha256: "not-a-sha256" }]), /Invalid SHA-256/);
	});
});

describe("moveFileSafely and collectReleaseArtifacts", () => {
	test("moveFileSafely preserves file when source and destination differ only by case on Windows", async () => {
		const tempDir = await mkdtemp(join(os.tmpdir(), "wenyou-move-same-"));
		try {
			const filePath = join(tempDir, "SampleFile.bin");
			const payload = Buffer.from("must-not-be-deleted");
			await writeFile(filePath, payload);
			const altCasePath = process.platform === "win32" ? join(tempDir, "samplefile.bin") : filePath;
			await moveFileSafely(filePath, altCasePath);
			assert.deepEqual(await readFile(filePath), payload);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("moves raw Windows artifacts safely, preserves win-unpacked, and writes exact SHA256SUMS.txt and BOM+CRLF notes", async () => {
		const tempDir = await mkdtemp(join(os.tmpdir(), "wenyou-collect-artifacts-"));
		try {
			const version = "0.2.4";
			const releaseDir = join(tempDir, `dist/wenyou-pro-${version}-win-x64`);
			const rawDir = join(releaseDir, "raw");
			const unpackedDir = join(rawDir, "win-unpacked");
			await mkdir(unpackedDir, { recursive: true });

			const setupName = `Wenyou-Pro-Setup-${version}-x64.exe`;
			const portableName = `Wenyou-Pro-Portable-${version}-x64.zip`;
			const setupPayload = Buffer.from("fake-nsis-installer-payload-v0.2.4");
			const portablePayload = Buffer.from("fake-portable-zip-payload-v0.2.4");

			await writeFile(join(releaseDir, setupName), Buffer.from("stale-exe"));
			await writeFile(join(releaseDir, portableName), Buffer.from("stale-zip"));

			await writeFile(join(rawDir, setupName), setupPayload);
			await writeFile(join(rawDir, portableName), portablePayload);
			await writeFile(join(unpackedDir, "Wenyou Pro.exe"), Buffer.from("unpacked-exe"));

			const result = await collectReleaseArtifacts({ releaseDir, rawDir, version });

			assert.deepEqual(await readFile(join(releaseDir, setupName)), setupPayload);
			assert.deepEqual(await readFile(join(releaseDir, portableName)), portablePayload);

			await assert.rejects(() => stat(join(rawDir, setupName)));
			await assert.rejects(() => stat(join(rawDir, portableName)));
			assert.equal((await stat(join(unpackedDir, "Wenyou Pro.exe"))).isFile(), true);

			const expectedSetupHash = createHash("sha256").update(setupPayload).digest("hex");
			const expectedPortableHash = createHash("sha256").update(portablePayload).digest("hex");
			const shaBuf = await readFile(result.sha256Path);
			assert.notDeepEqual([...shaBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
			assert.equal(
				shaBuf.toString("utf8"),
				`${expectedSetupHash}  ${setupName}\n${expectedPortableHash}  ${portableName}\n`,
			);

			const notesBuf = await readFile(result.notesPath);
			assert.deepEqual([...notesBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
			const notesBody = notesBuf.subarray(3).toString("utf8");
			assert.ok(notesBody.includes("司命 · 文游 Pro"));
			assert.ok(notesBody.includes(`Wenyou Pro v${version}`));
			assert.equal(notesBody.replace(/\r\n/g, "").includes("\n"), false);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("collects macOS arm64 + x64 dmg/zip and Linux x86_64 AppImage artifacts", async () => {
		const tempDir = await mkdtemp(join(os.tmpdir(), "wenyou-collect-mac-linux-"));
		try {
			const version = "0.2.4";
			const paths = resolveReleasePaths(tempDir, version, { platform: "mac", arch: "all" });
			await mkdir(join(paths.rawDir, "mac-arm64", "Wenyou Pro.app"), { recursive: true });
			await mkdir(join(paths.rawDir, "mac", "Wenyou Pro.app"), { recursive: true });

			const payloads = new Map();
			for (const name of paths.expectedArtifacts) {
				const buf = Buffer.from(`fake-mac-payload-${name}`);
				payloads.set(name, buf);
				await writeFile(join(paths.rawDir, name), buf);
			}

			const result = await collectReleaseArtifacts({
				releaseDir: paths.releaseDir,
				rawDir: paths.rawDir,
				version,
				platform: "mac",
				arch: "all",
			});

			assert.equal(result.platform, "mac");
			assert.deepEqual(result.archs, ["arm64", "x64"]);
			assert.equal(result.artifacts.length, 4);

			const expectedShaLines = [];
			for (const name of paths.expectedArtifacts) {
				const buf = payloads.get(name);
				assert.deepEqual(await readFile(join(paths.releaseDir, name)), buf);
				await assert.rejects(() => stat(join(paths.rawDir, name)));
				expectedShaLines.push(`${createHash("sha256").update(buf).digest("hex")}  ${name}\n`);
			}
			assert.equal(await readFile(result.sha256Path, "utf8"), expectedShaLines.join(""));

			// Linux AppImage must expect x86_64 for x64
			const linuxPaths = resolveReleasePaths(tempDir, version, { platform: "linux", arch: "x64" });
			await mkdir(linuxPaths.rawDir, { recursive: true });
			const appImageName = `Wenyou-Pro-${version}-linux-x86_64.AppImage`;
			const appImageBuf = Buffer.from("fake-appimage-x86_64");
			await writeFile(join(linuxPaths.rawDir, appImageName), appImageBuf);
			const linuxResult = await collectReleaseArtifacts({
				releaseDir: linuxPaths.releaseDir,
				rawDir: linuxPaths.rawDir,
				version,
				platform: "linux",
				arch: "x64",
			});
			assert.equal(linuxResult.artifacts.length, 1);
			assert.equal(linuxResult.artifacts[0].name, appImageName);
			assert.deepEqual(await readFile(join(linuxPaths.releaseDir, appImageName)), appImageBuf);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("throws when a built artifact is missing from raw directory", async () => {
		const tempDir = await mkdtemp(join(os.tmpdir(), "wenyou-collect-missing-"));
		try {
			const releaseDir = join(tempDir, "dist/wenyou-pro-0.2.4-win-x64");
			const rawDir = join(releaseDir, "raw");
			await mkdir(rawDir, { recursive: true });
			await writeFile(join(rawDir, "Wenyou-Pro-Setup-0.2.4-x64.exe"), Buffer.from("only-exe"));

			await assert.rejects(
				() => collectReleaseArtifacts({ releaseDir, rawDir, version: "0.2.4" }),
				/Wenyou-Pro-Portable-0\.2\.4-x64\.zip/,
			);
			await assert.rejects(() => stat(join(releaseDir, "SHA256SUMS.txt")));
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildWenyouInstaller orchestration and repository alignment", () => {
	test("supports dry-run on Windows and macOS without spawning external commands or creating dist", async () => {
		const winRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			let invoked = false;
			const plan = await buildWenyouInstaller({
				repoRoot: winRoot,
				hostPlatform: "win32",
				dryRun: true,
				runFn: async () => {
					invoked = true;
				},
			});
			assert.equal(invoked, false);
			assert.equal(plan.dryRun, true);
			assert.equal(plan.platform, "win");
			assert.equal(plan.version, "0.2.4");
			assert.equal(plan.builderConfigOverride.extends, "electron-builder.wenyou.yml");
			assert.deepEqual(plan.outputs, [
				"Wenyou-Pro-Setup-0.2.4-x64.exe",
				"Wenyou-Pro-Portable-0.2.4-x64.zip",
				"SHA256SUMS.txt",
				"使用说明.txt",
			]);
			await assert.rejects(() => stat(join(winRoot, "dist")));
		} finally {
			await rm(winRoot, { recursive: true, force: true });
		}

		const macRoot = await createTempFixtureRepo("0.2.4", "mac");
		try {
			let invoked = false;
			const macPlan = await buildWenyouInstaller({
				repoRoot: macRoot,
				hostPlatform: "darwin",
				dryRun: true,
				runFn: async () => {
					invoked = true;
				},
			});
			assert.equal(invoked, false);
			assert.equal(macPlan.platform, "mac");
			assert.deepEqual(macPlan.archs, ["arm64", "x64"]);
			assert.deepEqual(macPlan.outputs, [
				"Wenyou-Pro-0.2.4-mac-arm64.dmg",
				"Wenyou-Pro-0.2.4-mac-arm64.zip",
				"Wenyou-Pro-0.2.4-mac-x64.dmg",
				"Wenyou-Pro-0.2.4-mac-x64.zip",
				"SHA256SUMS.txt",
				"使用说明.txt",
			]);
		} finally {
			await rm(macRoot, { recursive: true, force: true });
		}
	});

	test("orchestrates Windows build, repo-local temp override config, artifact archiving, and cleans up temp config", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			const calls = [];
			let capturedOverrideConfig = null;
			let capturedConfigPath = null;

			const result = await buildWenyouInstaller({
				repoRoot: tempRoot,
				platform: "win",
				version: "0.2.5",
				skipBuild: false,
				dryRun: false,
				resolveBuilderCli: () => "/fake/electron-builder/cli.js",
				runFn: async (command, args, options) => {
					calls.push({ command, args, cwd: options.cwd });
					if (args[0] === "/fake/electron-builder/cli.js") {
						const configIdx = args.indexOf("--config");
						assert.notEqual(configIdx, -1);
						capturedConfigPath = args[configIdx + 1];
						const expectedLocalTmp = resolve(tempRoot, ".local", "tmp");
						assert.ok(
							dirname(capturedConfigPath).startsWith(expectedLocalTmp),
							"override config dir must prefer <repoRoot>/.local/tmp",
						);
						capturedOverrideConfig = JSON.parse(await readFile(capturedConfigPath, "utf8"));
						const rawOut = resolve(options.cwd, capturedOverrideConfig.directories.output);
						await mkdir(join(rawOut, "win-unpacked"), { recursive: true });
						await writeFile(join(rawOut, "Wenyou-Pro-Setup-0.2.5-x64.exe"), Buffer.from("setup-025"));
						await writeFile(join(rawOut, "Wenyou-Pro-Portable-0.2.5-x64.zip"), Buffer.from("zip-025"));
					}
				},
			});

			assert.equal(calls.length, 2);
			assert.equal(calls[0].cwd, tempRoot);
			assert.ok(calls[0].args.includes("build"));
			assert.ok(calls[0].args.includes("packages/desktop"));
			assert.equal(calls[1].cwd, resolve(tempRoot, "packages/desktop"));
			assert.deepEqual(capturedOverrideConfig, {
				extends: "electron-builder.wenyou.yml",
				directories: { output: "../../dist/wenyou-pro-0.2.5-win-x64/raw" },
				extraMetadata: { version: "0.2.5" },
			});
			await assert.rejects(() => stat(dirname(capturedConfigPath)));

			assert.equal(result.version, "0.2.5");
			assert.equal(result.artifacts.length, 2);
			assert.equal((await stat(result.sha256Path)).isFile(), true);
			assert.equal((await stat(result.notesPath)).isFile(), true);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("orchestrates macOS build for single arch and cleans up temp override config", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "mac");
		try {
			const calls = [];
			let capturedOverrideConfig = null;

			const result = await buildWenyouInstaller({
				repoRoot: tempRoot,
				platform: "mac",
				arch: "arm64",
				skipBuild: true,
				dryRun: false,
				resolveBuilderCli: () => "/fake/electron-builder/cli.js",
				runFn: async (command, args, options) => {
					calls.push({ command, args, cwd: options.cwd });
					const configPath = args[args.indexOf("--config") + 1];
					capturedOverrideConfig = JSON.parse(await readFile(configPath, "utf8"));
					const rawOut = resolve(options.cwd, capturedOverrideConfig.directories.output);
					await mkdir(join(rawOut, "mac-arm64", "Wenyou Pro.app"), { recursive: true });
					await writeFile(join(rawOut, "Wenyou-Pro-0.2.4-mac-arm64.dmg"), Buffer.from("dmg-arm64"));
					await writeFile(join(rawOut, "Wenyou-Pro-0.2.4-mac-arm64.zip"), Buffer.from("zip-arm64"));
				},
			});

			assert.equal(calls.length, 1);
			assert.ok(calls[0].args.includes("--mac"));
			assert.ok(calls[0].args.includes("--arm64"));
			assert.equal(calls[0].args.includes("--x64"), false);
			assert.deepEqual(capturedOverrideConfig, {
				extends: "electron-builder.wenyou.yml",
				directories: { output: "../../dist/wenyou-pro-0.2.4-mac/raw" },
				extraMetadata: { version: "0.2.4" },
			});
			assert.equal(result.platform, "mac");
			assert.deepEqual(result.archs, ["arm64"]);
			assert.equal(result.artifacts.length, 2);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("cleans up temp override config directory in finally even when electron-builder throws", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			let capturedConfigDir = null;
			await assert.rejects(
				() =>
					buildWenyouInstaller({
						repoRoot: tempRoot,
						platform: "win",
						skipBuild: true,
						dryRun: false,
						resolveBuilderCli: () => "/fake/electron-builder/cli.js",
						runFn: async (_command, args) => {
							const configPath = args[args.indexOf("--config") + 1];
							capturedConfigDir = dirname(configPath);
							assert.equal((await stat(configPath)).isFile(), true);
							throw new Error("simulated electron-builder failure");
						},
					}),
				/simulated electron-builder failure/,
			);
			assert.ok(capturedConfigDir, "temp config dir should have been created before failure");
			await assert.rejects(() => stat(capturedConfigDir));
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("skip-build omits npm run build and directly invokes electron-builder", async () => {
		const tempRoot = await createTempFixtureRepo("0.2.4", "win");
		try {
			const calls = [];
			await buildWenyouInstaller({
				repoRoot: tempRoot,
				platform: "win",
				skipBuild: true,
				dryRun: false,
				resolveBuilderCli: () => "/fake/electron-builder/cli.js",
				runFn: async (command, args, options) => {
					calls.push({ command, args, cwd: options.cwd });
					const configPath = args[args.indexOf("--config") + 1];
					const override = JSON.parse(await readFile(configPath, "utf8"));
					const rawOut = resolve(options.cwd, override.directories.output);
					await mkdir(rawOut, { recursive: true });
					await writeFile(join(rawOut, "Wenyou-Pro-Setup-0.2.4-x64.exe"), Buffer.from("setup"));
					await writeFile(join(rawOut, "Wenyou-Pro-Portable-0.2.4-x64.zip"), Buffer.from("zip"));
				},
			});
			assert.equal(calls.length, 1);
			assert.equal(calls[0].args[0], "/fake/electron-builder/cli.js");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("workspace package manifests, npm scripts, and electron-builder.wenyou.yml are aligned with desktop version and POSIX filter isolation", async () => {
		const desktopPkg = JSON.parse(await readFile(join(REPO_ROOT, "packages/desktop/package.json"), "utf8"));
		const expectedVersion = desktopPkg.version;
		const defaultVersion = await readDefaultVersion(REPO_ROOT);
		assert.equal(defaultVersion, expectedVersion);

		const rootPkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
		const lockfile = JSON.parse(await readFile(join(REPO_ROOT, "package-lock.json"), "utf8"));
		const backendPkg = JSON.parse(await readFile(join(REPO_ROOT, "packages/backend/package.json"), "utf8"));
		const sharedPkg = JSON.parse(await readFile(join(REPO_ROOT, "packages/shared/package.json"), "utf8"));
		const builderYml = await readFile(
			join(REPO_ROOT, "packages/desktop/electron-builder.wenyou.yml"),
			"utf8",
		);

		assert.equal(rootPkg.name, "percho");
		assert.equal(rootPkg.version, expectedVersion);
		assert.equal(backendPkg.version, expectedVersion);
		assert.equal(sharedPkg.version, expectedVersion);
		assert.equal(lockfile.version, expectedVersion);
		assert.equal(lockfile.packages[""].version, expectedVersion);
		assert.equal(lockfile.packages["packages/shared"].version, expectedVersion);
		assert.equal(lockfile.packages["packages/backend"].version, expectedVersion);
		assert.equal(lockfile.packages["packages/desktop"].version, expectedVersion);
		assert.equal(rootPkg.repository?.url, "git+https://github.com/anyu0804/wenyou-pro.git");
		assert.equal(rootPkg.bugs, "https://github.com/anyu0804/wenyou-pro/issues");
		assert.equal(rootPkg.author, "安钰 (Based on Percho by Jaxton07)");
		assert.equal(desktopPkg.author, "安钰 (Based on Percho MIT)");
		assert.deepEqual(rootPkg.workspaces, ["packages/shared", "packages/backend", "packages/desktop"]);

		assert.equal(rootPkg.scripts["icons:wenyou"], "node scripts/wenyou-release/generate-wenyou-icons.mjs");
		assert.equal(rootPkg.scripts["package:wenyou"], "node scripts/wenyou-release/build-installer.mjs");
		assert.equal(
			rootPkg.scripts["package:wenyou:mac"],
			"node scripts/wenyou-release/build-installer.mjs --platform mac",
		);
		assert.equal(rootPkg.scripts["package:wenyou:verify"], "node scripts/wenyou-release/verify-package.mjs");
		assert.equal(
			rootPkg.scripts["package:wenyou:verify:mac"],
			"node scripts/wenyou-release/verify-package.mjs --platform mac",
		);
		assert.equal(rootPkg.scripts["check:paths"], "node scripts/wenyou-release/scan-repo-paths.mjs");
		assert.equal(
			rootPkg.scripts["repo:guard"],
			"node scripts/wenyou-release/configure-github-repo.mjs --verify",
		);
		assert.equal(rootPkg.scripts["shortcut:sync"], "node scripts/wenyou-release/sync-shortcut.mjs");

		assert.equal(desktopPkg.scripts["build:sandbox"], "npm --prefix ../pixi-sandbox run build:desktop");
		const escapedVersion = expectedVersion.replace(/\./g, "\\.");
		assert.match(builderYml, new RegExp(`^\\s*version:\\s*${escapedVersion}\\s*$`, "m"));
		assert.match(
			builderYml,
			new RegExp(`^\\s*output:\\s*\\.\\.\\/\\.\\.\\/dist\\/wenyou-pro-${escapedVersion}-win-x64\\/raw\\s*$`, "m"),
		);
		assert.match(builderYml, /nsis:[\s\S]*?^\s*shortcutName:\s*"司命 · 文游 Pro"\s*$/m);
		assert.ok(builderYml.includes('from: "resources/pixi-sandbox"'));
		assert.ok(builderYml.includes('"!**/__pycache__/**"'));

		// Verify win.extraResources carries build/wenyou-pro.ico and update-diagnostics, NOT top-level extraResources
		const [beforeWin, fromWin] = builderYml.split(/^win:\s*$/m);
		assert.equal(
			beforeWin.includes("resources/update-diagnostics"),
			false,
			"resources/update-diagnostics must be scoped under win:",
		);
		assert.equal(
			beforeWin.includes("resources/ntqq-vfs"),
			false,
			"resources/ntqq-vfs must be scoped per-platform under win:/mac:/linux:",
		);
		assert.equal(
			beforeWin.includes("build/wenyou-pro.ico"),
			false,
			"build/wenyou-pro.ico must be scoped under win: so macOS/Linux bundles contain no .ico",
		);
		const winSection = fromWin.split(/^nsis:\s*$/m)[0];
		assert.match(
			winSection,
			/extraResources:[\s\S]*?from:\s*"build\/wenyou-pro\.ico"[\r\n]+\s*to:\s*"wenyou-pro\.ico"/m,
		);

		// Verify mac and linux sections use build/icon.png and match POSIX_NTQQ_VFS_FILTER verbatim
		const macSection = builderYml.split(/^mac:\s*$/m)[1].split(/^linux:\s*$/m)[0];
		const linuxSection = builderYml.split(/^linux:\s*$/m)[1].split(/^publish:\s*$/m)[0];
		assert.match(macSection, /^\s*icon:\s*build\/icon\.png\s*$/m);
		assert.match(macSection, /^\s*identity:\s*"-"\s*$/m);
		assert.match(macSection, /^\s*hardenedRuntime:\s*false\s*$/m);
		assert.match(macSection, /^\s*artifactName:\s*Wenyou-Pro-\$\{version\}-mac-\$\{arch\}\.\$\{ext\}\s*$/m);
		assert.match(linuxSection, /^\s*icon:\s*build\/icon\.png\s*$/m);

		const macFilterMatch = /filter:\s*(\[[^\]]+\])/.exec(macSection);
		const linuxFilterMatch = /filter:\s*(\[[^\]]+\])/.exec(linuxSection);
		assert.ok(macFilterMatch, "mac.extraResources must define ntqq-vfs filter");
		assert.ok(linuxFilterMatch, "linux.extraResources must define ntqq-vfs filter");
		assert.deepEqual(JSON.parse(macFilterMatch[1]), [...POSIX_NTQQ_VFS_FILTER]);
		assert.deepEqual(JSON.parse(linuxFilterMatch[1]), [...POSIX_NTQQ_VFS_FILTER]);
	});
});
