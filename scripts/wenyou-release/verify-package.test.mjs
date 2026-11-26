import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatMacReleaseNotes } from "./build-installer.mjs";
import {
	extractLocalHtmlAssetRefs,
	loadAsarModule,
	parseVerifyArgs,
	resolveVerifyPlatform,
	sanitizePathForDisplay,
	scanUnmaskedLocalPaths,
	verifyMacAppBundle,
	verifyPortableZipExtract,
	verifyReadmeFile,
	verifySha256Sums,
	verifyUnpackedApp,
	verifyWenyouRelease,
} from "./verify-package.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_SCRIPT_PATH = resolve(SCRIPT_DIR, "verify-package.mjs");
const TEST_VERSION = "0.2.4";

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

function sha256Buffer(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

async function createTempDir(t, prefix = "wenyou-verify-test-") {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	return dir;
}

async function writeFileEnsuringDir(filePath, content) {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content);
}

async function buildAsarFromFiles(tempRoot, archivePath, filesMap) {
	const asar = loadAsarModule();
	const staging = await mkdtemp(join(tempRoot, "asar-src-"));
	try {
		for (const [relPath, content] of Object.entries(filesMap)) {
			const fullPath = join(staging, ...relPath.split("/"));
			await writeFileEnsuringDir(fullPath, content);
		}
		await mkdir(dirname(archivePath), { recursive: true });
		if (typeof asar.uncache === "function") asar.uncache(archivePath);
		await asar.createPackage(staging, archivePath);
		if (typeof asar.uncache === "function") asar.uncache(archivePath);
	} finally {
		await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

async function createZipFromDirectory(sourceDir, zipPath) {
	await rm(zipPath, { force: true });
	if (process.platform === "win32") {
		await execFileAsync(
			"pwsh",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:WENYOU_ZIP_SRC, $env:WENYOU_ZIP_DST, [System.IO.Compression.CompressionLevel]::Fastest, $false)",
			],
			{
				env: {
					...process.env,
					WENYOU_ZIP_SRC: resolve(sourceDir),
					WENYOU_ZIP_DST: resolve(zipPath),
				},
			},
		);
		return;
	}
	await execFileAsync("zip", ["-rq", resolve(zipPath), "."], { cwd: resolve(sourceDir) });
}

function defaultAsarFiles(version = TEST_VERSION, overrides = {}) {
	const pkg = {
		name: "@percho/desktop",
		version,
		releaseChannel: "stable",
		productName: "Wenyou Pro",
		disableAutoUpdate: true,
		main: "./out/main/index.js",
		...(overrides.packageJson ?? {}),
	};
	const rendererHtml =
		overrides.rendererHtml ??
		[
			"<!DOCTYPE html>",
			'<html lang="zh-CN">',
			"  <head>",
			'    <meta charset="UTF-8" />',
			'    <link rel="preload" as="image" href="data:image/png;base64,iVBORw0KGgo=" />',
			'    <link rel="preload" as="image" href="./assets/ring-light.png?v=1#hash" />',
			'    <link rel="preconnect" href="https://example.com" />',
			'    <link rel="preload" href="wenyou-asset://vault/preview.png" />',
			'    <!-- <script src="./assets/commented-missing.js"></script> -->',
			'    <script type="module" crossorigin src="./assets/index-main.js"></script>',
			'    <link rel="stylesheet" crossorigin href="./assets/index-main.css" />',
			"  </head>",
			'  <body><div id="root"></div></body>',
			"</html>",
		].join("\n");

	return {
		"package.json": JSON.stringify(pkg, null, 2),
		"out/main/index.js": "console.log('main');\n",
		"out/preload/index.cjs": "module.exports = {};\n",
		"out/renderer/index.html": rendererHtml,
		"out/renderer/assets/index-main.js": "export const ok = true;\n",
		"out/renderer/assets/index-main.css": "body { color: #fff; }\n",
		"out/renderer/assets/ring-light.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
		...(overrides.extraAsarFiles ?? {}),
	};
}

function defaultReadmeContent(version = TEST_VERSION) {
	return [
		`司命 · 文游 Pro（Wenyou Pro v${version} Windows x64）使用说明`,
		"制作与整理：安钰",
		`1. 安装版：Wenyou-Pro-Setup-${version}-x64.exe`,
		`2. 便携版：Wenyou-Pro-Portable-${version}-x64.zip`,
		"配置与日志路径：%USERPROFILE%\\.wenyou-pro\\、%APPDATA%\\Wenyou Pro\\logs\\、%LOCALAPPDATA%\\Wenyou Pro\\",
		"公共目录示例：C:\\Users\\Public\\Documents 与 C:\\Users\\Default\\AppData",
	].join("\r\n");
}

async function populateSharedExtraResources(resourcesDir, options = {}) {
	const sandboxHtml =
		options.sandboxHtml ??
		[
			"<!DOCTYPE html>",
			"<html>",
			"  <head>",
			'    <script type="module" crossorigin src="./assets/index-sandbox.js"></script>',
			'    <link rel="modulepreload" crossorigin href="./assets/pixi-core.js">',
			'    <link rel="stylesheet" href="./assets/sandbox.css">',
			"  </head>",
			'  <body><div id="app"></div></body>',
			"</html>",
		].join("\n");

	await writeFileEnsuringDir(join(resourcesDir, "pixi-sandbox/index.html"), sandboxHtml);
	await writeFileEnsuringDir(
		join(resourcesDir, "pixi-sandbox/assets/index-sandbox.js"),
		"console.log('sandbox');\n",
	);
	await writeFileEnsuringDir(
		join(resourcesDir, "pixi-sandbox/assets/pixi-core.js"),
		"export const pixi = 1;\n",
	);
	await writeFileEnsuringDir(
		join(resourcesDir, "pixi-sandbox/assets/sandbox.css"),
		"canvas { display: block; }\n",
	);

	await writeFileEnsuringDir(
		join(resourcesDir, "wenyou-skills/wenyou-handwritten-policy/SKILL.md"),
		"# policy skill\n",
	);
	await writeFileEnsuringDir(
		join(resourcesDir, "wenyou-skills/wenyou-situation-memory/SKILL.md"),
		"# memory skill\n",
	);
	await writeFileEnsuringDir(
		join(resourcesDir, "pi-package/dist/core/export-html/template.html"),
		"<html></html>\n",
	);
	await writeFileEnsuringDir(
		join(resourcesDir, "pi-package/dist/core/export-html/vendor/marked-cjk-friendly.min.js"),
		"window.marked = {};\n",
	);
	await writeFileEnsuringDir(join(resourcesDir, "ui-plugins/SPEC.md"), "# ui plugins\n");
}

async function createCompleteReleaseFixture(baseDir, options = {}) {
	const version = options.version ?? TEST_VERSION;
	const releaseDir = join(baseDir, `wenyou-pro-${version}-win-x64`);
	const unpackedDir = join(releaseDir, "raw", "win-unpacked");
	const resourcesDir = join(unpackedDir, "resources");

	await writeFileEnsuringDir(join(unpackedDir, "Wenyou Pro.exe"), Buffer.from("MZ-FAKE-PE-EXE"));

	const asarFiles = defaultAsarFiles(version, options.asarOverrides);
	await buildAsarFromFiles(baseDir, join(resourcesDir, "app.asar"), asarFiles);
	await populateSharedExtraResources(resourcesDir, options);

	const ntqqFiles = {
		"wenyou_read.py": "print('read')\n",
		"wenyou_vfs_sync.py": "print('sync')\n",
		"ntqq_vfs.py": "print('vfs')\n",
		"wenyou_ntqq_bridge.py": "print('bridge')\n",
		"qq_dump_db.exe": Buffer.from("MZ-DUMP"),
		"python/python.exe": Buffer.from("MZ-PYTHON"),
	};
	for (const [relPath, content] of Object.entries(ntqqFiles)) {
		await writeFileEnsuringDir(join(resourcesDir, "ntqq-vfs", relPath), content);
	}
	await writeFileEnsuringDir(
		join(resourcesDir, "update-diagnostics/collect.ps1"),
		"Write-Output 'ok'\n",
	);
	await writeFileEnsuringDir(
		join(resourcesDir, "wenyou-pro.ico"),
		options.icoBuffer ?? createMinimalIcoBuffer([32, 256]),
	);

	const setupName = `Wenyou-Pro-Setup-${version}-x64.exe`;
	const portableName = `Wenyou-Pro-Portable-${version}-x64.zip`;
	const setupPath = join(releaseDir, setupName);
	const portablePath = join(releaseDir, portableName);

	await writeFileEnsuringDir(setupPath, Buffer.from(`MZ-NSIS-INSTALLER-PAYLOAD-${version}`));
	await createZipFromDirectory(unpackedDir, portablePath);

	const setupHash = sha256Buffer(await readFile(setupPath));
	const portableHash = sha256Buffer(await readFile(portablePath));
	await writeFileEnsuringDir(
		join(releaseDir, "SHA256SUMS.txt"),
		`${setupHash}  ${setupName}\n${portableHash}  ${portableName}\n`,
	);

	const readmeBody = options.readmeText ?? defaultReadmeContent(version);
	const bom = Buffer.from([0xef, 0xbb, 0xbf]);
	await writeFileEnsuringDir(
		join(releaseDir, "使用说明.txt"),
		Buffer.concat([bom, Buffer.from(readmeBody, "utf8")]),
	);

	return {
		version,
		releaseDir,
		unpackedDir,
		resourcesDir,
		setupPath,
		portablePath,
		setupName,
		portableName,
		readmePath: join(releaseDir, "使用说明.txt"),
		sha256Path: join(releaseDir, "SHA256SUMS.txt"),
	};
}

async function createCompleteMacReleaseFixture(baseDir, options = {}) {
	const version = options.version ?? TEST_VERSION;
	const archs = options.archs ?? ["arm64", "x64"];
	const releaseDir = join(baseDir, `wenyou-pro-${version}-mac`);
	const rawDir = join(releaseDir, "raw");
	const appBundles = {};
	const shaLines = [];

	for (const arch of archs) {
		const folderName = arch === "arm64" ? "mac-arm64" : "mac";
		const appBundleDir = join(rawDir, folderName, "Wenyou Pro.app");
		const resourcesDir = join(appBundleDir, "Contents", "Resources");

		await writeFileEnsuringDir(
			join(appBundleDir, "Contents", "MacOS", "Wenyou Pro"),
			Buffer.from("MACHO-FAKE-BIN"),
		);
		await writeFileEnsuringDir(
			join(appBundleDir, "Contents", "Info.plist"),
			'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>\n',
		);

		const asarFiles = defaultAsarFiles(version, options.asarOverrides);
		await buildAsarFromFiles(baseDir, join(resourcesDir, "app.asar"), asarFiles);
		await populateSharedExtraResources(resourcesDir, options);

		// Unpacked arch-matched @esbuild native binary
		await writeFileEnsuringDir(
			join(resourcesDir, "app.asar.unpacked", "node_modules", "@esbuild", `darwin-${arch}`, "bin", "esbuild"),
			Buffer.from(`MACHO-ESBUILD-${arch}`),
		);

		for (const pyName of ["wenyou_read.py", "wenyou_vfs_sync.py", "ntqq_vfs.py", "wenyou_ntqq_bridge.py"]) {
			await writeFileEnsuringDir(join(resourcesDir, "ntqq-vfs", pyName), `print('${pyName}')\n`);
		}

		appBundles[arch] = { appBundleDir, resourcesDir };

		const dmgName = `Wenyou-Pro-${version}-mac-${arch}.dmg`;
		const zipName = `Wenyou-Pro-${version}-mac-${arch}.zip`;
		const dmgBytes = Buffer.from(`FAKE-DMG-${version}-${arch}`);
		const zipBytes = Buffer.from(`FAKE-ZIP-${version}-${arch}`);
		await writeFileEnsuringDir(join(releaseDir, dmgName), dmgBytes);
		await writeFileEnsuringDir(join(releaseDir, zipName), zipBytes);
		shaLines.push(`${sha256Buffer(dmgBytes)}  ${dmgName}\n`);
		shaLines.push(`${sha256Buffer(zipBytes)}  ${zipName}\n`);
	}

	await writeFileEnsuringDir(join(releaseDir, "SHA256SUMS.txt"), shaLines.join(""));

	const readmeContent = options.readmeContent ?? formatMacReleaseNotes(version, archs);
	await writeFileEnsuringDir(join(releaseDir, "使用说明.txt"), readmeContent);

	return {
		version,
		archs,
		releaseDir,
		rawDir,
		appBundles,
		readmePath: join(releaseDir, "使用说明.txt"),
		sha256Path: join(releaseDir, "SHA256SUMS.txt"),
	};
}

test("full Wenyou release verification passes including Portable.zip extract-check, appIcon, and temp cleanup", async (t) => {
	const baseDir = await createTempDir(t);
	const extractTempParent = join(baseDir, "extract-tmp");
	const fixture = await createCompleteReleaseFixture(baseDir);

	const report = await verifyWenyouRelease({
		version: fixture.version,
		releaseDir: fixture.releaseDir,
		extractCheck: true,
		tempDir: extractTempParent,
	});

	assert.equal(report.ok, true);
	assert.equal(report.platform, "win");
	assert.equal(report.version, TEST_VERSION);
	assert.equal(report.readme.bomVerified, true);
	assert.equal(report.unpacked.metadata.disableAutoUpdate, true);
	assert.equal(report.unpacked.metadata.releaseChannel, "stable");
	assert.equal(report.unpacked.metadata.productName, "Wenyou Pro");
	assert.ok(report.unpacked.renderer.checkedAssets.includes("out/renderer/assets/index-main.js"));
	assert.ok(report.unpacked.renderer.checkedAssets.includes("out/renderer/assets/index-main.css"));
	assert.ok(report.unpacked.renderer.checkedAssets.includes("out/renderer/assets/ring-light.png"));
	assert.ok(
		report.unpacked.extraResources.pixiSandbox.checkedAssets.includes("assets/index-sandbox.js"),
	);
	assert.ok(
		report.unpacked.extraResources.pixiSandbox.checkedAssets.includes("assets/pixi-core.js"),
	);
	assert.equal(report.unpacked.extraResources.appIcon.file, "wenyou-pro.ico");
	assert.equal(report.unpacked.extraResources.appIcon.has256, true);
	assert.ok(report.unpacked.extraResources.appIcon.sizes.includes("256x256"));
	assert.equal(report.portableExtract.extractedChecked, true);

	const leftover = await readdir(extractTempParent);
	assert.deepEqual(leftover, []);
});

test("CLI invocation succeeds with --version, --release-dir and --extract-check without polluting repo .local", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);

	const { stdout } = await execFileAsync(
		process.execPath,
		[
			VERIFY_SCRIPT_PATH,
			"--version",
			fixture.version,
			"--release-dir",
			fixture.releaseDir,
			"--repo-root",
			baseDir,
			"--extract-check",
		],
		{ env: process.env },
	);

	const parsed = JSON.parse(stdout);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.version, TEST_VERSION);
	assert.equal(parsed.portableExtract.extractedChecked, true);

	const leftover = await readdir(join(baseDir, ".local", "tmp"));
	assert.deepEqual(leftover, []);
});

test("macOS release verification passes for dual-arch (mac-arm64 + mac), checks @esbuild arch binary, and runs codesign/hdiutil on darwin", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteMacReleaseFixture(baseDir, { archs: ["arm64", "x64"] });

	assert.equal(resolveVerifyPlatform({ releaseDir: fixture.releaseDir, hostPlatform: "win32" }), "mac");

	const nonDarwinReport = await verifyWenyouRelease({
		version: fixture.version,
		releaseDir: fixture.releaseDir,
		hostPlatform: "linux",
	});
	assert.equal(nonDarwinReport.ok, true);
	assert.equal(nonDarwinReport.platform, "mac");
	assert.deepEqual(nonDarwinReport.archs, ["arm64", "x64"]);
	assert.equal(nonDarwinReport.appBundles.arm64.extraResources.ntqqVfs.windowsViolations, 0);
	assert.equal(nonDarwinReport.appBundles.x64.extraResources.ntqqVfs.windowsViolations, 0);
	assert.equal(nonDarwinReport.appBundles.arm64.esbuildBinary.arch, "arm64");
	assert.equal(nonDarwinReport.appBundles.x64.esbuildBinary.arch, "x64");
	assert.equal(nonDarwinReport.nativeVerification.executed, false);

	const nativeCalls = [];
	const darwinReport = await verifyWenyouRelease({
		version: fixture.version,
		platform: "mac",
		arch: "all",
		releaseDir: fixture.releaseDir,
		hostPlatform: "darwin",
		execFileFn: async (cmd, args) => {
			nativeCalls.push({ cmd, args });
			return { stdout: "", stderr: "" };
		},
	});
	assert.equal(darwinReport.ok, true);
	assert.equal(darwinReport.nativeVerification.executed, true);
	assert.deepEqual(darwinReport.nativeVerification.codesignVerified, ["arm64", "x64"]);
	assert.deepEqual(darwinReport.nativeVerification.hdiutilVerified, [
		`Wenyou-Pro-${TEST_VERSION}-mac-arm64.dmg`,
		`Wenyou-Pro-${TEST_VERSION}-mac-x64.dmg`,
	]);
	assert.equal(nativeCalls.length, 4);
	assert.equal(nativeCalls[0].cmd, "codesign");
	assert.deepEqual(nativeCalls[0].args.slice(0, 3), ["--verify", "--deep", "--strict"]);
	assert.ok(nativeCalls[0].args[3].includes("mac-arm64"));
	assert.equal(nativeCalls[1].cmd, "codesign");
	assert.ok(nativeCalls[1].args[3].includes(join("raw", "mac", "Wenyou Pro.app")));
	assert.equal(nativeCalls[2].cmd, "hdiutil");
	assert.equal(nativeCalls[2].args[0], "verify");

	await assert.rejects(
		() =>
			verifyWenyouRelease({
				version: fixture.version,
				platform: "mac",
				arch: "all",
				releaseDir: fixture.releaseDir,
				hostPlatform: "darwin",
				execFileFn: async (cmd) => {
					if (cmd === "codesign") throw new Error("invalid signature");
					return { stdout: "", stderr: "" };
				},
			}),
		/codesign verification failed/i,
	);
});

test("macOS negative gates block Windows .exe/.dll/.pyd/.ico/update-diagnostics leakage, wrong-arch esbuild, and bad Mac README", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteMacReleaseFixture(baseDir, { archs: ["x64"] });
	const { appBundleDir, resourcesDir } = fixture.appBundles.x64;

	// 1. Missing x64 esbuild binary (e.g., only arm64 binary present on cross-compiled x64 bundle) -> must reject
	const x64Esbuild = join(
		resourcesDir,
		"app.asar.unpacked",
		"node_modules",
		"@esbuild",
		"darwin-x64",
		"bin",
		"esbuild",
	);
	await rm(x64Esbuild);
	await writeFileEnsuringDir(
		join(resourcesDir, "app.asar.unpacked", "node_modules", "@esbuild", "darwin-arm64", "bin", "esbuild"),
		Buffer.from("MACHO-ESBUILD-ARM64-ONLY"),
	);
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/@esbuild\/darwin-x64\/bin\/esbuild/i,
	);
	await writeFileEnsuringDir(x64Esbuild, Buffer.from("MACHO-ESBUILD-X64"));

	// 2. Contaminate ntqq-vfs with qq_dump_db.exe -> must reject
	const leakedExe = join(resourcesDir, "ntqq-vfs", "qq_dump_db.exe");
	await writeFileEnsuringDir(leakedExe, Buffer.from("MZ-LEAK"));
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/Forbidden Windows binaries.*qq_dump_db\.exe/i,
	);
	await rm(leakedExe);

	// 3. Contaminate ntqq-vfs with a .dll -> must reject
	const leakedDll = join(resourcesDir, "ntqq-vfs", "python313.dll");
	await writeFileEnsuringDir(leakedDll, Buffer.from("MZ-DLL"));
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/Forbidden Windows binaries.*python313\.dll/i,
	);
	await rm(leakedDll);

	// 4. Contaminate ntqq-vfs with a .pyd -> must reject
	const leakedPyd = join(resourcesDir, "ntqq-vfs", "_sqlite3.pyd");
	await writeFileEnsuringDir(leakedPyd, Buffer.from("MZ-PYD"));
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/Forbidden Windows binaries.*_sqlite3\.pyd/i,
	);
	await rm(leakedPyd);

	// 5. Contaminate ntqq-vfs with __pycache__/.pyc -> must reject
	const pycacheFile = join(resourcesDir, "ntqq-vfs", "__pycache__", "ntqq_vfs.cpython-313.pyc");
	await writeFileEnsuringDir(pycacheFile, Buffer.from([0x01, 0x02]));
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/Python cache.*__pycache__/i,
	);
	await rm(join(resourcesDir, "ntqq-vfs", "__pycache__"), { recursive: true, force: true });

	// 6. Contaminate Resources with Windows-only update-diagnostics or wenyou-pro.ico -> must reject
	await writeFileEnsuringDir(join(resourcesDir, "update-diagnostics", "collect.ps1"), "ok\n");
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/Forbidden Windows-only resource.*update-diagnostics/i,
	);
	await rm(join(resourcesDir, "update-diagnostics"), { recursive: true, force: true });

	await writeFileEnsuringDir(join(resourcesDir, "wenyou-pro.ico"), createMinimalIcoBuffer([32, 256]));
	await assert.rejects(
		() => verifyMacAppBundle(appBundleDir, fixture.version, { arch: "x64" }),
		/Forbidden Windows-only resource.*wenyou-pro\.ico/i,
	);
	await rm(join(resourcesDir, "wenyou-pro.ico"));

	// 7. Mac README containing %USERPROFILE% or unmasked /Users/<name> must be blocked
	const badMacReadmeWinVar = `${formatMacReleaseNotes(fixture.version, ["x64"])}\n%USERPROFILE%\\.wenyou-pro\n`;
	await writeFile(fixture.readmePath, badMacReadmeWinVar, "utf8");
	await assert.rejects(
		() => verifyReadmeFile(fixture.readmePath, fixture.version, { platform: "mac", arch: "x64" }),
		/%USERPROFILE%/i,
	);

	const badMacReadmeLocalPath = `${formatMacReleaseNotes(fixture.version, ["x64"])}\n/Users/AliceTest/Library\n`;
	await writeFile(fixture.readmePath, badMacReadmeLocalPath, "utf8");
	await assert.rejects(
		() => verifyReadmeFile(fixture.readmePath, fixture.version, { platform: "mac", arch: "x64" }),
		/path sanitization gate/i,
	);
});

test("Negative #1: tampered installer bytes, dirty entries, or path escape fail SHA-256 verification", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);

	const originalBytes = await readFile(fixture.setupPath);
	const tampered = Buffer.from(originalBytes);
	tampered[tampered.length - 1] ^= 0xff;
	await writeFile(fixture.setupPath, tampered);

	await assert.rejects(
		() => verifySha256Sums(fixture.releaseDir, fixture.version),
		/SHA-256 mismatch/i,
	);
	await writeFile(fixture.setupPath, originalBytes);

	const validSums = await readFile(fixture.sha256Path, "utf8");
	await writeFile(fixture.sha256Path, `${validSums}${"a".repeat(64)}  extra-dirty.bin\n`);
	await assert.rejects(
		() => verifySha256Sums(fixture.releaseDir, fixture.version),
		/Unexpected dirty entry/i,
	);

	await writeFile(fixture.sha256Path, `${validSums}${"b".repeat(64)}  ../escape.exe\n`);
	await assert.rejects(
		() => verifySha256Sums(fixture.releaseDir, fixture.version),
		/Path traversal|unsafe filename/i,
	);
});

test("Negative #2: 使用说明.txt missing UTF-8 BOM or required version/filenames fails", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);

	await writeFile(fixture.readmePath, defaultReadmeContent(fixture.version), "utf8");
	await assert.rejects(
		() => verifyReadmeFile(fixture.readmePath, fixture.version),
		/UTF-8 BOM/i,
	);

	const missingPortable = [
		`Wenyou Pro v${fixture.version} 使用说明`,
		`安装版：${fixture.setupName}`,
	].join("\r\n");
	await writeFile(
		fixture.readmePath,
		Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(missingPortable, "utf8")]),
	);
	await assert.rejects(
		() => verifyReadmeFile(fixture.readmePath, fixture.version),
		/missing required text/i,
	);
});

test("Negative #3: 使用说明.txt containing unmasked local user paths is blocked while env/system paths pass", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);

	const badPaths = [
		{ line: "日志目录位于 C:\\Users\\AliceTest\\Desktop\\wenyou-logs", leakedUser: "AliceTest" },
		{ line: "Git Bash 路径：/c/Users/AliceTest/Documents/world", leakedUser: "AliceTest" },
		{ line: "中文用户名泄漏：C:\\Users\\测试用户\\AppData\\Roaming\\Wenyou Pro", leakedUser: "测试用户" },
		{ line: "正斜杠路径：C:/Users/SomeRealUser/Desktop/save", leakedUser: "SomeRealUser" },
		{ line: "UNC 路径：\\\\fileserver\\Users\\AliceTest\\share", leakedUser: "AliceTest" },
	];

	const localUser = userInfo().username;
	if (localUser) {
		badPaths.push({
			line: `MSYS 本机路径：/c/Users/${localUser}/Desktop/log.txt`,
			leakedUser: localUser,
		});
	}

	for (const { line: leakLine, leakedUser } of badPaths) {
		const content = `${defaultReadmeContent(fixture.version)}\r\n${leakLine}\r\n`;
		await writeFile(
			fixture.readmePath,
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]),
		);
		await assert.rejects(
			() => verifyReadmeFile(fixture.readmePath, fixture.version),
			(err) => {
				assert.match(err.message, /path sanitization gate|unmasked local user path/i);
				assert.match(err.message, /<REDACTED>/);
				assert.equal(
					err.message.includes(leakedUser),
					false,
					"Error message must redact captured username rather than echoing it back",
				);
				return true;
			},
			`Expected path sanitization gate to reject: ${leakLine}`,
		);
	}

	const safeText = [
		"配置：%USERPROFILE%\\.wenyou-pro\\",
		"日志：%APPDATA%\\Wenyou Pro\\logs\\",
		"缓存：%LOCALAPPDATA%\\Wenyou Pro\\Cache",
		"公共：C:\\Users\\Public\\Documents",
		"默认：C:\\Users\\Default\\AppData 与 C:\\Users\\Default User\\Desktop",
		"环境变量：C:\\Users\\%USERNAME%\\.wenyou-pro",
		"链接：https://github.com/Jaxton07/percho/users/example",
	].join("\n");
	assert.deepEqual(scanUnmaskedLocalPaths(safeText), []);
});

test("Negative #4: broken static asset closure in app.asar or pixi-sandbox and bundled test deps are blocked", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);

	const brokenRendererHtml = [
		"<!DOCTYPE html>",
		"<html><head>",
		'<script type="module" src="./assets/index-main.js"></script>',
		'<script type="module" src="./assets/missing-chunk.js"></script>',
		'<link rel="stylesheet" href="./assets/index-main.css" />',
		"</head><body></body></html>",
	].join("\n");
	await buildAsarFromFiles(
		baseDir,
		join(fixture.resourcesDir, "app.asar"),
		defaultAsarFiles(fixture.version, { rendererHtml: brokenRendererHtml }),
	);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/missing-chunk\.js/i,
	);

	await buildAsarFromFiles(
		baseDir,
		join(fixture.resourcesDir, "app.asar"),
		defaultAsarFiles(fixture.version, {
			extraAsarFiles: { "node_modules/happy-dom/index.js": "module.exports = {};\n" },
		}),
	);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/happy-dom/i,
	);

	await buildAsarFromFiles(
		baseDir,
		join(fixture.resourcesDir, "app.asar"),
		defaultAsarFiles(fixture.version, {
			packageJson: { disableAutoUpdate: false },
		}),
	);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/disableAutoUpdate/i,
	);

	const rootRelativeRendererHtml = [
		"<!DOCTYPE html>",
		"<html><head>",
		'<script type="module" src="/assets/index-main.js"></script>',
		'<link rel="stylesheet" href="./assets/index-main.css" />',
		"</head><body></body></html>",
	].join("\n");
	await buildAsarFromFiles(
		baseDir,
		join(fixture.resourcesDir, "app.asar"),
		defaultAsarFiles(fixture.version, { rendererHtml: rootRelativeRendererHtml }),
	);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/Root-relative asset path/i,
	);

	await buildAsarFromFiles(
		baseDir,
		join(fixture.resourcesDir, "app.asar"),
		defaultAsarFiles(fixture.version),
	);
	await writeFile(
		join(fixture.resourcesDir, "pixi-sandbox/index.html"),
		'<!DOCTYPE html><html><head><script type="module" src="/assets/index-sandbox.js"></script></head><body></body></html>',
	);
	await verifyUnpackedApp(fixture.unpackedDir, fixture.version);

	await writeFile(
		join(fixture.resourcesDir, "pixi-sandbox/index.html"),
		'<!DOCTYPE html><html><head><script type="module" src="./assets/missing-sandbox-chunk.js"></script></head><body></body></html>',
	);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/missing-sandbox-chunk\.js/i,
	);
});

test("Negative #5: ntqq-vfs missing python.exe or polluted with __pycache__/.pyc/.pyo is blocked", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);
	const pythonExePath = join(fixture.resourcesDir, "ntqq-vfs/python/python.exe");

	await rm(pythonExePath);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/python\/python\.exe/i,
	);
	await writeFileEnsuringDir(pythonExePath, Buffer.from("MZ-PYTHON"));

	const pycacheFile = join(fixture.resourcesDir, "ntqq-vfs/__pycache__/foo.pyc");
	await writeFileEnsuringDir(pycacheFile, Buffer.from([0x00, 0x01, 0x02]));
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/__pycache__|Python cache/i,
	);
	await rm(join(fixture.resourcesDir, "ntqq-vfs/__pycache__"), { recursive: true, force: true });

	const nestedPyo = join(fixture.resourcesDir, "ntqq-vfs/python/lib/stale.pyo");
	await writeFileEnsuringDir(nestedPyo, Buffer.from([0x00, 0x02]));
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/stale\.pyo|Python cache/i,
	);
});

test("Negative #6: Portable.zip extract-check catches zip-only defects and cleans temp dir on failure", async (t) => {
	const baseDir = await createTempDir(t);
	const extractTempParent = join(baseDir, "extract-fail-tmp");
	const fixture = await createCompleteReleaseFixture(baseDir);

	const pycacheFile = join(fixture.resourcesDir, "ntqq-vfs/__pycache__/zip-only.pyc");
	await writeFileEnsuringDir(pycacheFile, Buffer.from([0xde, 0xad]));
	await createZipFromDirectory(fixture.unpackedDir, fixture.portablePath);
	await rm(join(fixture.resourcesDir, "ntqq-vfs/__pycache__"), { recursive: true, force: true });

	await assert.rejects(
		() =>
			verifyPortableZipExtract(fixture.portablePath, fixture.version, {
				tempDir: extractTempParent,
			}),
		/__pycache__|Python cache/i,
	);

	const leftover = await readdir(extractTempParent);
	assert.deepEqual(leftover, []);
});

test("Negative #7: missing, 32px-only legacy, or corrupt resources/wenyou-pro.ico is blocked on Windows", async (t) => {
	const baseDir = await createTempDir(t);
	const fixture = await createCompleteReleaseFixture(baseDir);
	const icoPath = join(fixture.resourcesDir, "wenyou-pro.ico");

	await rm(icoPath);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/resources\/wenyou-pro\.ico/i,
	);

	await writeFile(icoPath, createMinimalIcoBuffer([16, 32]));
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/missing a 256x256 frame/i,
	);

	await writeFile(icoPath, Buffer.from("not-a-valid-windows-ico-header-data"));
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/Invalid ICO header/i,
	);

	const garbage256 = Buffer.alloc(6 + 16 + 16);
	garbage256.writeUInt16LE(0, 0);
	garbage256.writeUInt16LE(1, 2);
	garbage256.writeUInt16LE(1, 4);
	garbage256[6] = 0x00;
	garbage256[7] = 0x00;
	garbage256.writeUInt32LE(16, 6 + 8);
	garbage256.writeUInt32LE(22, 6 + 12);
	Buffer.from("GARBAGE-PAYLOAD!").copy(garbage256, 22);
	await writeFile(icoPath, garbage256);
	await assert.rejects(
		() => verifyUnpackedApp(fixture.unpackedDir, fixture.version),
		/Invalid 256x256 ICO frame payload/i,
	);
});

test("parseVerifyArgs, extractLocalHtmlAssetRefs, and sanitizePathForDisplay handle edge cases", () => {
	assert.deepEqual(
		parseVerifyArgs(["--version", "0.2.4", "--release-dir=dist/out", "--extract-check"]),
		{
			version: "0.2.4",
			platform: undefined,
			arch: undefined,
			releaseDir: "dist/out",
			repoRoot: undefined,
			extractCheck: true,
			help: false,
		},
	);
	assert.deepEqual(
		parseVerifyArgs(["--platform", "mac", "--arch=arm64", "--version=0.2.4"]),
		{
			version: "0.2.4",
			platform: "mac",
			arch: "arm64",
			releaseDir: undefined,
			repoRoot: undefined,
			extractCheck: false,
			help: false,
		},
	);
	assert.throws(() => parseVerifyArgs(["--version"]), /Missing value/);
	assert.throws(() => parseVerifyArgs(["--platform", "linux"]), /Invalid verify platform/);
	assert.throws(() => parseVerifyArgs(["--platform", "win", "--arch", "arm64"]), /Invalid Windows verify arch/);
	assert.throws(() => parseVerifyArgs(["--unknown-flag"]), /Unknown CLI argument/);

	const html = [
		'<script data-src="./ignored.js" src="./assets/app.js?v=123#top"></script>',
		'<script>const tpl = "<link href=\'./not-a-real-link.css\'>";</script >',
		'<style>/* <link href="./fake-in-style.css"> */ body { background: url("./bg.png"); }</style >',
		'<link rel="stylesheet" title="see href=\'./fake-in-attr.css\'" href="./assets/real.css">',
		'<link rel="stylesheet"href="./assets/no-space-before-href.css">',
		"<link rel=stylesheet href=./assets/unquoted.css/>",
		"<link rel='stylesheet' href='./assets/app.css'>",
		'<link rel="icon" href="data:image/svg+xml;base64,abc">',
		'<script src="https://cdn.example.com/lib.js"></script>',
		'<link href="wenyou-sandbox://app/assets/x.js">',
		'<!-- <script src="./assets/commented.js"></script> -->',
	].join("\n");
	const refs = extractLocalHtmlAssetRefs(html);
	assert.deepEqual(
		refs.map((r) => r.path),
		[
			"./assets/app.js",
			"./assets/real.css",
			"./assets/no-space-before-href.css",
			"./assets/unquoted.css",
			"./assets/app.css",
		],
	);

	const home = homedir();
	const currentUser = userInfo().username;
	const homePosix = home.replaceAll("\\", "/");
	const sampleCases = [
		join(home, "Documents", "demo.txt"),
		`Target not found: ${home}.`,
		`${home}:123`,
		`路径：${home}，请检查`,
	];
	const winDrive = /^([A-Za-z]):\/(.+)$/.exec(homePosix);
	if (winDrive) {
		const [, drive, rest] = winDrive;
		const restBack = rest.replaceAll("/", "\\");
		sampleCases.push(
			`/${drive.toLowerCase()}/${rest}/Desktop`,
			`${drive}:\\${rest}\\Desktop`,
			`${drive}:/${restBack}/Desktop`,
			`${drive}:\\\\${restBack.replaceAll("\\", "\\\\")}\\\\Desktop`,
			`file:///${drive}:/${rest}/index.html`,
		);
	}
	for (const rawSample of sampleCases) {
		const sanitized = sanitizePathForDisplay(rawSample);
		assert.equal(sanitized.includes("~"), true, `Expected "~" in sanitized: ${sanitized}`);
		if (currentUser) {
			assert.equal(
				sanitized.includes(currentUser),
				false,
				`Expected username redacted in sanitized output for sample`,
			);
		}
	}
});
