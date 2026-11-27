import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseStageArgs, stageReleaseAssets } from "./stage-release-assets.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const STAGE_SCRIPT_PATH = resolve(SCRIPT_DIR, "stage-release-assets.mjs");

async function createTempDir(t, prefix = "wenyou-stage-assets-test-") {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
	return dir;
}

async function writeFixtureFile(filePath, content) {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, content);
}

describe("stage-release-assets: Bug #1 nested directory collection & anti-empty release gate", () => {
	test("collects artifacts from nested actions/upload-artifact@v4 subdirectories (wenyou-pro-<ver>-mac & -win-x64)", async (t) => {
		const base = await createTempDir(t);
		const macDir = join(base, "release-staging/mac");
		const winDir = join(base, "release-staging/win");
		const outDir = join(base, "release-upload");

		// Reproduce exact actions/upload-artifact@v4 nested structure that broke flat globs
		const macNested = join(macDir, "wenyou-pro-0.2.6-mac");
		await writeFixtureFile(join(macNested, "Wenyou-Pro-0.2.6-mac-arm64.dmg"), "DMG-ARM64");
		await writeFixtureFile(join(macNested, "Wenyou-Pro-0.2.6-mac-arm64.zip"), "ZIP-ARM64");
		await writeFixtureFile(join(macNested, "Wenyou-Pro-0.2.6-mac-x64.dmg"), "DMG-X64");
		await writeFixtureFile(join(macNested, "Wenyou-Pro-0.2.6-mac-x64.zip"), "ZIP-X64");
		await writeFixtureFile(join(macNested, "SHA256SUMS.txt"), "mac-sha256\n");
		await writeFixtureFile(join(macNested, "使用说明.txt"), "\uFEFFmac-notes\n");

		const winNested = join(winDir, "wenyou-pro-0.2.6-win-x64");
		await writeFixtureFile(join(winNested, "Wenyou-Pro-Setup-0.2.6-x64.exe"), "EXE-SETUP");
		await writeFixtureFile(join(winNested, "Wenyou-Pro-Portable-0.2.6-x64.zip"), "ZIP-PORTABLE");
		await writeFixtureFile(join(winNested, "SHA256SUMS.txt"), "win-sha256\n");
		await writeFixtureFile(join(winNested, "使用说明.txt"), "\uFEFFwin-notes\n");

		const result = await stageReleaseAssets({
			macDir,
			winDir,
			outDir,
			requireWindows: true,
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.mac.dmg, [
			"Wenyou-Pro-0.2.6-mac-arm64.dmg",
			"Wenyou-Pro-0.2.6-mac-x64.dmg",
		]);
		assert.deepEqual(result.mac.zip, [
			"Wenyou-Pro-0.2.6-mac-arm64.zip",
			"Wenyou-Pro-0.2.6-mac-x64.zip",
		]);
		assert.equal(result.mac.sha256, "SHA256SUMS-macOS.txt");
		assert.equal(result.mac.readme, "使用说明-macOS.txt");
		assert.deepEqual(result.win.exe, ["Wenyou-Pro-Setup-0.2.6-x64.exe"]);
		assert.deepEqual(result.win.zip, ["Wenyou-Pro-Portable-0.2.6-x64.zip"]);
		assert.equal(result.win.sha256, "SHA256SUMS-Windows-x64.txt");
		assert.equal(result.win.readme, "使用说明-Windows-x64.txt");

		const uploaded = (await readdir(outDir)).sort();
		assert.equal(uploaded.length, 10);
		assert.equal(await readFile(join(outDir, "SHA256SUMS-macOS.txt"), "utf8"), "mac-sha256\n");
		assert.equal(
			await readFile(join(outDir, "SHA256SUMS-Windows-x64.txt"), "utf8"),
			"win-sha256\n",
		);
	});

	test("supports flat layouts, deep arbitrary nesting, and macOS-only release mode", async (t) => {
		const base = await createTempDir(t);
		const macFlat = join(base, "flat-mac");
		const outFlat = join(base, "out-flat");

		await writeFixtureFile(join(macFlat, "Wenyou-Pro-0.2.6-mac-arm64.dmg"), "DMG");
		await writeFixtureFile(join(macFlat, "deep/sub/Wenyou-Pro-0.2.6-mac-arm64.zip"), "ZIP");
		await writeFixtureFile(join(macFlat, "SHA256SUMS.txt"), "sha\n");
		await writeFixtureFile(join(macFlat, "nested/使用说明.txt"), "\uFEFFnotes\n");

		const result = await stageReleaseAssets({
			macDir: macFlat,
			outDir: outFlat,
			requireWindows: false,
		});

		assert.equal(result.ok, true);
		assert.equal(result.win, null);
		assert.deepEqual(result.stagedFiles, [
			"SHA256SUMS-macOS.txt",
			"Wenyou-Pro-0.2.6-mac-arm64.dmg",
			"Wenyou-Pro-0.2.6-mac-arm64.zip",
			"使用说明-macOS.txt",
		]);
	});

	test("fails closed when staging is empty, missing required macOS/Windows assets, or has 0-byte files", async (t) => {
		const base = await createTempDir(t);
		const emptyMac = join(base, "empty-mac");
		const outDir = join(base, "out");
		await mkdir(emptyMac, { recursive: true });

		// 1. Empty mac staging must fail (prevents 0-attachment GitHub Release)
		await assert.rejects(
			() => stageReleaseAssets({ macDir: emptyMac, outDir, requireWindows: false }),
			/macOS \.dmg.*macOS \.zip.*SHA256SUMS-macOS\.txt.*使用说明-macOS\.txt/,
		);

		// 2. Complete mac staging but 0-byte .dmg must fail
		const zeroMac = join(base, "zero-mac");
		await writeFixtureFile(join(zeroMac, "wenyou-pro-0.2.6-mac/app.dmg"), "");
		await writeFixtureFile(join(zeroMac, "wenyou-pro-0.2.6-mac/app.zip"), "ZIP");
		await writeFixtureFile(join(zeroMac, "wenyou-pro-0.2.6-mac/SHA256SUMS.txt"), "sha");
		await writeFixtureFile(join(zeroMac, "wenyou-pro-0.2.6-mac/使用说明.txt"), "notes");
		await assert.rejects(
			() => stageReleaseAssets({ macDir: zeroMac, outDir, requireWindows: false }),
			/empty artifact \(0 bytes\)/i,
		);

		// 3. Complete mac staging + requireWindows=true but Windows missing .zip (mac .zip must NOT mask missing Windows .zip!)
		const goodMac = join(base, "good-mac");
		await writeFixtureFile(join(goodMac, "wenyou-pro-0.2.6-mac/mac.dmg"), "DMG");
		await writeFixtureFile(join(goodMac, "wenyou-pro-0.2.6-mac/mac.zip"), "ZIP");
		await writeFixtureFile(join(goodMac, "wenyou-pro-0.2.6-mac/SHA256SUMS.txt"), "sha");
		await writeFixtureFile(join(goodMac, "wenyou-pro-0.2.6-mac/使用说明.txt"), "notes");

		const incompleteWin = join(base, "incomplete-win");
		await writeFixtureFile(join(incompleteWin, "wenyou-pro-0.2.6-win-x64/setup.exe"), "EXE");
		await writeFixtureFile(join(incompleteWin, "wenyou-pro-0.2.6-win-x64/SHA256SUMS.txt"), "sha");
		await writeFixtureFile(join(incompleteWin, "wenyou-pro-0.2.6-win-x64/使用说明.txt"), "notes");

		await assert.rejects(
			() =>
				stageReleaseAssets({
					macDir: goodMac,
					winDir: incompleteWin,
					outDir,
					requireWindows: true,
				}),
			/Windows x64 \.zip archive/,
		);

		// 4. CLI exits with code 1 on incomplete staging
		await assert.rejects(
			() =>
				execFileAsync(process.execPath, [
					STAGE_SCRIPT_PATH,
					"--mac-dir",
					goodMac,
					"--win-dir",
					incompleteWin,
					"--out-dir",
					outDir,
					"--require-windows",
				]),
			(error) => {
				assert.equal(error.code, 1);
				assert.match(error.stderr, /Release staging hard gate failed/i);
				return true;
			},
		);
	});

	test("CLI argument parsing and wenyou-release.yml integration contract", async () => {
		assert.deepEqual(
			parseStageArgs([
				"--mac-dir",
				"release-staging/mac",
				"--win-dir",
				"release-staging/win",
				"--out-dir",
				"release-upload",
				"--require-windows",
			]),
			{
				macDir: "release-staging/mac",
				winDir: "release-staging/win",
				outDir: "release-upload",
				requireWindows: true,
				help: false,
			},
		);

		const workflowText = await readFile(
			resolve(REPO_ROOT, ".github/workflows/wenyou-release.yml"),
			"utf8",
		);
		assert.match(workflowText, /stage-release-assets\.mjs/);
		assert.match(workflowText, /--require-windows/);
		assert.match(workflowText, /UPLOAD_FILES=\(release-upload\/\*\)/);
		assert.match(workflowText, /\$\{#UPLOAD_FILES\[@\]\}["']?\s*-eq\s*0/);
	});
});
