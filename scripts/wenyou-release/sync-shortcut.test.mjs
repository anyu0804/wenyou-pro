import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	assertWindowsShortcutHost,
	DEFAULT_DESCRIPTION,
	DEFAULT_SHORTCUT_NAME,
	inspectShortcut,
	isAppOwnedShortcut,
	LEGACY_SHORTCUT_NAMES,
	normalizeWinPath,
	parseCliArgs,
	PS1_SCRIPT_PATH,
	resolveDesktopDir,
	sanitizePathForDisplay,
	syncDesktopShortcut,
	validateVersion,
} from "./sync-shortcut.mjs";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_SCRIPT_PATH = resolve(__dirname, "sync-shortcut.mjs");
const WIN32_COM_SKIP =
	process.platform !== "win32"
		? "Windows WScript.Shell .lnk integration test requires win32"
		: false;

const tempRoots = [];

async function makeTempSandbox(prefix = "wenyou-shortcut-test-") {
	const dir = await mkdtemp(join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

function createMinimalIcoBuffer(sizes = [32, 256], tagByte = 0x41) {
	const count = sizes.length;
	const headerSize = 6 + count * 16;
	const payloads = sizes.map((size) => {
		if (size === 256) {
			return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tagByte, 0x00, 0x00, 0x0d]);
		}
		return Buffer.from([0x28, 0x00, 0x00, 0x00, size & 0xff, tagByte, 0x00, 0x00]);
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

async function createShortcutViaPs1({
	shortcutPath,
	targetExe,
	workingDir,
	argumentsText = "",
	iconLocation,
	description = "Wenyou Pro Dev",
}) {
	const argsBase64 = argumentsText ? Buffer.from(argumentsText, "utf8").toString("base64") : "";
	const { stdout } = await execFileAsync(
		"pwsh",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			PS1_SCRIPT_PATH,
			"-Mode",
			"Write",
			"-UseEnv",
		],
		{
			encoding: "utf8",
			windowsHide: true,
			env: {
				...process.env,
				WENYOU_SHORTCUT_PATH: resolve(shortcutPath),
				WENYOU_TARGET_EXE: resolve(targetExe),
				WENYOU_WORKING_DIR: resolve(workingDir),
				WENYOU_ICON_LOCATION: iconLocation ?? `${resolve(targetExe)},0`,
				WENYOU_DESCRIPTION: description,
				WENYOU_ARGUMENTS: "",
				WENYOU_ARGUMENTS_B64: argsBase64,
			},
		},
	);
	const lines = stdout.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
	return JSON.parse(lines[lines.length - 1]);
}

after(async () => {
	for (const dir of tempRoots) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("wenyou-release shortcut sync", () => {
	it("exposes v0.2.4 brand defaults, legacy names, CLI flags, and keeps sync-shortcut.ps1 100% ASCII-only without BOM", async () => {
		assert.equal(DEFAULT_SHORTCUT_NAME, "司命 · 文游 Pro.lnk");
		assert.equal(DEFAULT_DESCRIPTION, "司命 · 文游 Pro");
		assert.deepEqual([...LEGACY_SHORTCUT_NAMES], ["Wenyou Pro.lnk", "Percho.lnk"]);

		const parsedDefaults = parseCliArgs([]);
		assert.equal(parsedDefaults.cleanupLegacy, true);
		assert.equal(parsedDefaults.refreshShell, true);
		const parsedDisabled = parseCliArgs(["--no-cleanup-legacy", "--no-refresh-shell"]);
		assert.equal(parsedDisabled.cleanupLegacy, false);
		assert.equal(parsedDisabled.refreshShell, false);

		const rawBytes = await readFile(PS1_SCRIPT_PATH);
		assert.ok(rawBytes.length > 0, "sync-shortcut.ps1 must not be empty");
		assert.ok(
			!(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf),
			"sync-shortcut.ps1 must not contain a UTF-8 BOM",
		);
		for (let i = 0; i < rawBytes.length; i += 1) {
			assert.ok(
				rawBytes[i] <= 0x7f,
				`Non-ASCII byte 0x${rawBytes[i].toString(16)} found at offset ${i} in sync-shortcut.ps1`,
			);
		}

		const psText = rawBytes.toString("ascii");
		assert.match(psText, /\[switch\]\$RefreshShell/);
		assert.match(psText, /SHChangeNotify\(0x08000000,\s*0x0000,\s*\[IntPtr\]::Zero,\s*\[IntPtr\]::Zero\)/);

		if (process.platform === "win32") {
			// Parse sync-shortcut.ps1 via real PowerShell AST parser on Windows to prove zero syntax errors.
			const { stdout: astCheckOut } = await execFileAsync(
				"pwsh",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:WENYOU_PS1, [ref]$tokens, [ref]$errors); Write-Output $errors.Count",
				],
				{
					encoding: "utf8",
					windowsHide: true,
					env: { ...process.env, WENYOU_PS1: PS1_SCRIPT_PATH },
				},
			);
			assert.equal(astCheckOut.trim(), "0", "sync-shortcut.ps1 must parse with 0 PowerShell syntax errors");
		}
	});

	it("sanitizes paths containing os.homedir() across case, slash, URI, punctuation, and POSIX variants", () => {
		const realHome = os.homedir();
		const realUserSegment = basename(realHome);

		const winBackslashPath = `${realHome}\\Desktop\\司命 · 文游 Pro.lnk`;
		const sanitizedBackslash = sanitizePathForDisplay(winBackslashPath);
		assert.equal(sanitizedBackslash, "~/Desktop/司命 · 文游 Pro.lnk");
		assert.ok(!sanitizedBackslash.includes(realUserSegment));

		const forwardLowerPath = `${realHome.replace(/\\/g, "/").toLowerCase()}/Desktop/Wenyou Pro.lnk`;
		const sanitizedForward = sanitizePathForDisplay(forwardLowerPath);
		assert.equal(sanitizedForward, "~/Desktop/Wenyou Pro.lnk");
		assert.ok(!sanitizedForward.toLowerCase().includes(realUserSegment.toLowerCase()));

		assert.equal(sanitizePathForDisplay(realHome), "~");
		assert.equal(sanitizePathForDisplay(`${realHome}\\`), "~");
		assert.equal(sanitizePathForDisplay(`${realHome.replace(/\\/g, "/")}/`), "~");

		const syntheticHome = "C:\\Users\\Alice";
		assert.equal(
			sanitizePathForDisplay("C:\\Users\\Alice\\Desktop\\司命 · 文游 Pro.lnk", {
				homeDir: syntheticHome,
			}),
			"~/Desktop/司命 · 文游 Pro.lnk",
		);
		assert.equal(
			sanitizePathForDisplay("c:/users/alice/App/wenyou-pro-0.2.4.ico,0", {
				homeDir: syntheticHome,
			}),
			"~/App/wenyou-pro-0.2.4.ico,0",
		);
		assert.equal(
			sanitizePathForDisplay("file:///C:/Users/Alice/Desktop/Wenyou Pro.lnk", {
				homeDir: syntheticHome,
			}),
			"file:///~/Desktop/Wenyou Pro.lnk",
		);
		assert.equal(
			sanitizePathForDisplay("路径：C:\\Users\\Alice。", {
				homeDir: syntheticHome,
			}),
			"路径：~。",
		);
		assert.equal(
			sanitizePathForDisplay("C:\\Users\\Alice2\\Desktop\\Wenyou Pro.lnk", {
				homeDir: syntheticHome,
			}),
			"C:\\Users\\Alice2\\Desktop\\Wenyou Pro.lnk",
		);
		assert.equal(
			sanitizePathForDisplay("C:\\Projects\\wenyou-fixture\\dist\\Wenyou Pro.exe", {
				homeDir: syntheticHome,
			}),
			"C:\\Projects\\wenyou-fixture\\dist\\Wenyou Pro.exe",
		);
		// POSIX home sanitization (macOS / Linux)
		assert.equal(
			sanitizePathForDisplay("/Users/fixture-mac/Desktop/Wenyou Pro", {
				homeDir: "/Users/fixture-mac",
			}),
			"~/Desktop/Wenyou Pro",
		);
		assert.equal(
			sanitizePathForDisplay("/home/fixture-linux", {
				homeDir: "/home/fixture-linux",
			}),
			"~",
		);
		assert.equal(
			sanitizePathForDisplay("file:///Users/fixture-mac/docs/a.txt", {
				homeDir: "/Users/fixture-mac",
			}),
			"file://~/docs/a.txt",
		);
	});

	it("validates semver versions strictly and classifies app-owned vs unrelated shortcuts accurately", () => {
		assert.equal(validateVersion("0.2.4"), "0.2.4");
		assert.equal(validateVersion("1.2.3-beta.1+build.4"), "1.2.3-beta.1+build.4");
		for (const bad of ["", "0.2", "v0.2.4", "abc", "../0.2.4", "0.2.4/evil"]) {
			assert.throws(() => validateVersion(bad), /Invalid version/i);
		}

		assert.equal(
			isAppOwnedShortcut({
				exists: true,
				targetPath: "C:\\Projects\\wenyou-fixture\\dist\\Wenyou Pro.exe",
				arguments: "",
				workingDirectory: "C:\\Projects\\wenyou-fixture\\dist",
				iconLocation: "",
			}),
			true,
		);
		assert.equal(
			isAppOwnedShortcut({
				exists: true,
				targetPath: "C:\\tools\\electron.exe",
				arguments: '"c:\\projects\\wenyou-fixture\\packages\\desktop"',
				workingDirectory: "C:\\tools",
				iconLocation: "",
			}),
			true,
		);
		assert.equal(
			isAppOwnedShortcut({
				exists: true,
				targetPath: "C:\\Windows\\System32\\notepad.exe",
				arguments: "notes.txt",
				workingDirectory: "C:\\Windows\\System32",
				iconLocation: "C:\\Windows\\System32\\notepad.exe,0",
			}),
			false,
		);
	});

	it("enforces Windows-only host guard on non-win32 while allowing mocked runners and --help cross-platform", async () => {
		assert.throws(() => assertWindowsShortcutHost("darwin"), /only supported on Windows/i);
		assert.throws(() => assertWindowsShortcutHost("linux"), /only supported on Windows/i);
		assert.doesNotThrow(() => assertWindowsShortcutHost("win32"));
		assert.doesNotThrow(() =>
			assertWindowsShortcutHost("darwin", { runPowerShell: async () => "" }),
		);

		const sandbox = await makeTempSandbox();
		const fakeExe = join(sandbox, "Wenyou Pro.exe");
		await writeFile(fakeExe, "mock-exe");

		await assert.rejects(
			() =>
				syncDesktopShortcut({
					platform: "darwin",
					targetExe: fakeExe,
					desktopDir: sandbox,
					noLocalCopy: true,
				}),
			/only supported on Windows/i,
		);

		const fakeDesktopPath = join(sandbox, "noisy-desktop");
		const resolvedNoisy = await resolveDesktopDir({
			runPowerShell: async () => `WARNING: profile banner\r\n\r\n${fakeDesktopPath}\r\n  \r\n`,
		});
		assert.equal(normalizeWinPath(resolvedNoisy), normalizeWinPath(fakeDesktopPath));

		const dryWithMock = await syncDesktopShortcut({
			platform: "linux",
			targetExe: fakeExe,
			desktopDir: sandbox,
			noLocalCopy: true,
			dryRun: true,
			runShortcutPowerShell: async () =>
				JSON.stringify({
					shortcutPath: join(sandbox, DEFAULT_SHORTCUT_NAME),
					exists: false,
					targetPath: "",
					arguments: "",
					workingDirectory: "",
					iconLocation: "",
					description: "",
				}),
		});
		assert.equal(dryWithMock.ok, true);
		assert.equal(dryWithMock.mode, "dry-run");
		assert.equal(dryWithMock.wouldUpdateDesktop, true);

		const { stdout: helpOut } = await execFileAsync(process.execPath, [CLI_SCRIPT_PATH, "--help"], {
			encoding: "utf8",
			windowsHide: true,
		});
		assert.match(helpOut, /Usage: node scripts\/wenyou-release\/sync-shortcut\.mjs/);
	});

	it(
		"creates 司命 · 文游 Pro.lnk with versioned wenyou-pro-0.2.4.ico, backs up & cleans legacy Wenyou Pro.lnk (desktop + .local), and skips unrelated shortcuts",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const unrelatedSandbox = await makeTempSandbox("other-app-test-");
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const tempBackup = join(sandbox, "backups");
			const tempLocalDir = join(tempRepo, ".local");
			const devElectronDir = join(sandbox, "node_modules", "electron", "dist");
			const packagedDir = join(
				tempRepo,
				"dist",
				"wenyou-pro-0.2.4-win-x64",
				"raw",
				"win-unpacked",
			);
			const resourcesDir = join(packagedDir, "resources");

			await Promise.all([
				mkdir(tempDesktop, { recursive: true }),
				mkdir(tempLocalDir, { recursive: true }),
				mkdir(devElectronDir, { recursive: true }),
				mkdir(resourcesDir, { recursive: true }),
				mkdir(join(tempRepo, "packages", "desktop"), { recursive: true }),
			]);

			await writeFile(join(tempRepo, "packages", "desktop", "package.json"), JSON.stringify({ version: "0.2.4" }));
			const fakeElectronExe = join(devElectronDir, "electron.exe");
			const fakeWenyouExe = join(packagedDir, "Wenyou Pro.exe");
			const resourcesIcoPath = join(resourcesDir, "wenyou-pro.ico");
			const resourcesIcoBytes = createMinimalIcoBuffer([16, 32, 256], 0x77);
			const unrelatedExe = join(unrelatedSandbox, "notepad.exe");

			await Promise.all([
				writeFile(fakeElectronExe, "MZ-mock-electron"),
				writeFile(fakeWenyouExe, "MZ-mock-wenyou-pro-0.2.4"),
				writeFile(resourcesIcoPath, resourcesIcoBytes),
				writeFile(unrelatedExe, "MZ-mock-unrelated"),
			]);

			const osHome = os.homedir();
			const osUser = basename(osHome);
			const legacyArgs = '"c:\\projects\\wenyou-fixture\\packages\\desktop"';
			const legacyDesktopPath = join(tempDesktop, "Wenyou Pro.lnk");
			const legacyLocalPath = join(tempLocalDir, "Wenyou Pro.lnk");
			const unrelatedPerchoPath = join(tempDesktop, "Percho.lnk");

			await createShortcutViaPs1({
				shortcutPath: legacyDesktopPath,
				targetExe: fakeElectronExe,
				workingDir: devElectronDir,
				argumentsText: legacyArgs,
				description: `Legacy dev from ${osHome}\\Desktop`,
			});
			await createShortcutViaPs1({
				shortcutPath: legacyLocalPath,
				targetExe: fakeElectronExe,
				workingDir: devElectronDir,
				argumentsText: legacyArgs,
			});
			await createShortcutViaPs1({
				shortcutPath: unrelatedPerchoPath,
				targetExe: unrelatedExe,
				workingDir: unrelatedSandbox,
				argumentsText: "",
				description: "Unrelated tool",
			});

			const legacyDesktopStat = await stat(legacyDesktopPath);
			const unrelatedBeforeBytes = await readFile(unrelatedPerchoPath);

			const dryReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeWenyouExe,
				desktopDir: tempDesktop,
				backupDir: tempBackup,
				dryRun: true,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			assert.equal(dryReport.ok, true);
			assert.equal(dryReport.mode, "dry-run");
			assert.equal(dryReport.shortcutName, DEFAULT_SHORTCUT_NAME);
			assert.equal(dryReport.wouldCleanupLegacy.length, 3);
			assert.equal(dryReport.wouldCleanupLegacy.filter((item) => item.appOwned).length, 2);
			await assert.rejects(() => stat(join(packagedDir, "wenyou-pro-0.2.4.ico")));
			await assert.rejects(() => stat(join(tempDesktop, DEFAULT_SHORTCUT_NAME)));

			const report = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeWenyouExe,
				desktopDir: tempDesktop,
				backupDir: tempBackup,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});

			assert.equal(report.ok, true);
			assert.equal(report.mode, "sync");
			assert.equal(report.shortcutName, "司命 · 文游 Pro.lnk");
			assert.equal(report.versionedIconCopied, true);
			assert.equal(report.shellRefreshed, false);

			const serializedReport = JSON.stringify(report);
			assert.ok(!serializedReport.toLowerCase().includes(osHome.toLowerCase()));
			assert.ok(!serializedReport.includes(osUser));

			const versionedIcoPath = join(packagedDir, "wenyou-pro-0.2.4.ico");
			const copiedIcoBytes = await readFile(versionedIcoPath);
			assert.ok(copiedIcoBytes.equals(resourcesIcoBytes));

			const newDesktopPath = join(tempDesktop, DEFAULT_SHORTCUT_NAME);
			const newLocalPath = join(tempLocalDir, DEFAULT_SHORTCUT_NAME);

			const desktopReadback = await inspectShortcut(newDesktopPath);
			assert.equal(desktopReadback.exists, true);
			assert.equal(normalizeWinPath(desktopReadback.targetPath), normalizeWinPath(fakeWenyouExe));
			assert.equal(desktopReadback.arguments, "");
			assert.equal(normalizeWinPath(desktopReadback.workingDirectory), normalizeWinPath(packagedDir));
			assert.equal(
				normalizeWinPath(desktopReadback.iconLocation),
				normalizeWinPath(`${versionedIcoPath},0`),
			);
			assert.equal(desktopReadback.description, "司命 · 文游 Pro");

			const localReadback = await inspectShortcut(newLocalPath);
			assert.equal(localReadback.exists, true);
			assert.equal(normalizeWinPath(localReadback.targetPath), normalizeWinPath(fakeWenyouExe));
			assert.equal(localReadback.arguments, "");
			assert.equal(
				normalizeWinPath(localReadback.iconLocation),
				normalizeWinPath(`${versionedIcoPath},0`),
			);
			assert.equal(localReadback.description, "司命 · 文游 Pro");

			await assert.rejects(() => stat(legacyDesktopPath));
			await assert.rejects(() => stat(legacyLocalPath));
			const localEntries = await readdir(tempLocalDir);
			assert.deepEqual(localEntries, [DEFAULT_SHORTCUT_NAME]);

			const backupEntries = await readdir(tempBackup);
			assert.equal(backupEntries.length, 1);
			assert.match(backupEntries[0], /^Wenyou Pro\.\d{8}-\d{6}-\d{3}\.legacy\.lnk\.bak$/);
			const legacyBackupPath = join(tempBackup, backupEntries[0]);
			assert.equal((await stat(legacyBackupPath)).size, legacyDesktopStat.size);
			const legacyBackupReadback = await inspectShortcut(legacyBackupPath);
			assert.equal(normalizeWinPath(legacyBackupReadback.targetPath), normalizeWinPath(fakeElectronExe));
			assert.equal(legacyBackupReadback.arguments, legacyArgs);

			assert.equal(report.legacyCleanup.enabled, true);
			assert.equal(report.legacyCleanup.deleteMode, "unlink");
			assert.equal(report.legacyCleanup.cleaned.length, 2);
			assert.equal(report.legacyCleanup.skipped.length, 1);
			assert.equal(report.legacyCleanup.skipped[0].shortcutName, "Percho.lnk");
			assert.equal(report.legacyCleanup.skipped[0].reason, "not-app-owned");
			assert.ok((await readFile(unrelatedPerchoPath)).equals(unrelatedBeforeBytes));

			const { stdout: cliOut } = await execFileAsync(
				process.execPath,
				[
					CLI_SCRIPT_PATH,
					"--version",
					"0.2.4",
					"--target-exe",
					fakeWenyouExe,
					"--desktop-dir",
					tempDesktop,
					"--backup-dir",
					tempBackup,
					"--local-copy",
					newLocalPath,
					"--verify-only",
					"--json",
				],
				{ encoding: "utf8", windowsHide: true },
			);
			const cliReport = JSON.parse(cliOut);
			assert.equal(cliReport.ok, true);
			assert.equal(cliReport.mode, "verify-only");
			assert.equal(cliReport.shortcutName, DEFAULT_SHORTCUT_NAME);
			assert.ok(!cliOut.includes(osUser), "CLI stdout must not expose OS username");
		},
	);

	it(
		"uses production default legacyDeleteMode='recycle' via SendToRecycleBin PowerShell call and honors cleanupLegacy=false",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const tempBackup = join(sandbox, "backups");
			const appDir = join(tempRepo, "app");

			await Promise.all([
				mkdir(tempDesktop, { recursive: true }),
				mkdir(appDir, { recursive: true }),
			]);

			const fakeExe = join(appDir, "Wenyou Pro.exe");
			await writeFile(fakeExe, "MZ-recycle-test");

			const legacyPath = join(tempDesktop, "Wenyou Pro.lnk");
			await createShortcutViaPs1({
				shortcutPath: legacyPath,
				targetExe: fakeExe,
				workingDir: appDir,
				argumentsText: "--old-dev",
			});

			const keptReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				backupDir: tempBackup,
				noLocalCopy: true,
				cleanupLegacy: false,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			assert.equal(keptReport.legacyCleanup.enabled, false);
			assert.equal(keptReport.legacyCleanup.cleaned.length, 0);
			assert.equal((await stat(legacyPath)).isFile(), true);

			const capturedRecycleCalls = [];
			const recycleReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				backupDir: tempBackup,
				noLocalCopy: true,
				refreshShell: false,
				runPowerShell: async (args, opts) => {
					capturedRecycleCalls.push({ args, target: opts?.env?.WENYOU_LEGACY_SHORTCUT_PATH });
					if (opts?.env?.WENYOU_LEGACY_SHORTCUT_PATH) {
						await rm(opts.env.WENYOU_LEGACY_SHORTCUT_PATH, { force: true });
					}
					return "";
				},
			});

			assert.equal(recycleReport.legacyCleanup.deleteMode, "recycle");
			assert.equal(recycleReport.legacyCleanup.cleaned.length, 1);
			assert.equal(capturedRecycleCalls.length, 1);
			const psCmd = capturedRecycleCalls[0].args.join(" ");
			assert.match(psCmd, /Microsoft\.VisualBasic/i);
			assert.match(psCmd, /DeleteFile\(/i);
			assert.match(psCmd, /SendToRecycleBin/);
			assert.equal(
				normalizeWinPath(capturedRecycleCalls[0].target),
				normalizeWinPath(legacyPath),
			);
		},
	);

	it(
		"resolves versioned icon fallback chain (resources/wenyou-pro.ico -> build/wenyou-pro.ico -> targetExe,0) and forwards -RefreshShell only on desktop sync",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const buildDir = join(tempRepo, "packages", "desktop", "build");
			const appDir = join(tempRepo, "dist", "wenyou-pro-0.2.4-win-x64", "raw", "win-unpacked");

			await Promise.all([
				mkdir(tempDesktop, { recursive: true }),
				mkdir(buildDir, { recursive: true }),
				mkdir(appDir, { recursive: true }),
			]);

			const fakeExe = join(appDir, "Wenyou Pro.exe");
			await writeFile(fakeExe, "MZ-icon-fallback");

			const fallbackReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				noLocalCopy: true,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			assert.equal(fallbackReport.versionedIconPath, null);
			assert.equal(
				normalizeWinPath((await inspectShortcut(join(tempDesktop, DEFAULT_SHORTCUT_NAME))).iconLocation),
				normalizeWinPath(`${fakeExe},0`),
			);

			const buildIcoBytes = createMinimalIcoBuffer([32, 256], 0x55);
			await writeFile(join(buildDir, "wenyou-pro.ico"), buildIcoBytes);

			const buildFallbackReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				noLocalCopy: true,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			const expectedVersionedIco = join(appDir, "wenyou-pro-0.2.4.ico");
			assert.equal(buildFallbackReport.versionedIconCopied, true);
			assert.ok((await readFile(expectedVersionedIco)).equals(buildIcoBytes));
			assert.equal(
				normalizeWinPath((await inspectShortcut(join(tempDesktop, DEFAULT_SHORTCUT_NAME))).iconLocation),
				normalizeWinPath(`${expectedVersionedIco},0`),
			);

			const spyLogPath = join(sandbox, "refresh-spy.log");
			const spyPs1Path = join(sandbox, "refresh-spy.ps1");
			const escapedRealPs1 = PS1_SCRIPT_PATH.replace(/'/g, "''");
			const escapedLogPath = spyLogPath.replace(/'/g, "''");
			await writeFile(
				spyPs1Path,
				`\uFEFF${[
					"param([string]$Mode, [switch]$UseEnv, [switch]$RefreshShell)",
					'if ($Mode -eq "Sync") {',
					`    Add-Content -LiteralPath '${escapedLogPath}' -Value ($env:WENYOU_SHORTCUT_PATH + "|" + [bool]$RefreshShell)`,
					`    $out = & '${escapedRealPs1}' -Mode Sync -UseEnv`,
					"    $obj = $out | ConvertFrom-Json",
					"    $obj | Add-Member -Force -NotePropertyName shellRefreshed -NotePropertyValue ([bool]$RefreshShell)",
					"    Write-Output ($obj | ConvertTo-Json -Depth 4 -Compress)",
					"    exit $LASTEXITCODE",
					"}",
					`& '${escapedRealPs1}' -Mode $Mode -UseEnv`,
					"exit $LASTEXITCODE",
				].join("\n")}`,
				"utf8",
			);

			const localCopyPath = join(sandbox, "local", DEFAULT_SHORTCUT_NAME);
			const refreshReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				localCopy: localCopyPath,
				force: true,
				refreshShell: true,
				legacyDeleteMode: "unlink",
				ps1ScriptPath: spyPs1Path,
			});
			assert.equal(refreshReport.shellRefreshed, true);
			const spyLines = (await readFile(spyLogPath, "utf8")).trim().split(/\r?\n/);
			assert.equal(spyLines.length, 2);
			assert.ok(spyLines[0].endsWith("|True"), "Desktop sync must pass -RefreshShell when refreshShell=true");
			assert.ok(spyLines[1].endsWith("|False"), "Local copy sync must omit -RefreshShell");

			const updatedIcoBytes = createMinimalIcoBuffer([32, 256], 0x99);
			await writeFile(join(buildDir, "wenyou-pro.ico"), updatedIcoBytes);
			const sameVersionUpdateReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				localCopy: localCopyPath,
				force: false,
				refreshShell: true,
				legacyDeleteMode: "unlink",
				ps1ScriptPath: spyPs1Path,
			});
			assert.equal(sameVersionUpdateReport.versionedIconCopied, true);
			assert.equal(sameVersionUpdateReport.desktopUpdated, true);
			assert.equal(sameVersionUpdateReport.shellRefreshed, true);
			assert.ok((await readFile(expectedVersionedIco)).equals(updatedIcoBytes));

			const staleLegacyPath = join(tempDesktop, "Wenyou Pro.lnk");
			await createShortcutViaPs1({
				shortcutPath: staleLegacyPath,
				targetExe: fakeExe,
				workingDir: appDir,
				argumentsText: "--stale-legacy",
			});
			const legacyRefreshReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				noLocalCopy: true,
				force: false,
				refreshShell: true,
				legacyDeleteMode: "unlink",
				ps1ScriptPath: spyPs1Path,
			});
			assert.equal(legacyRefreshReport.versionedIconCopied, false);
			assert.equal(legacyRefreshReport.desktopUpdated, false);
			assert.equal(legacyRefreshReport.legacyCleanup.cleaned.length, 1);
			assert.equal(legacyRefreshReport.shellRefreshed, true);
		},
	);

	it(
		"isolates per-item legacy cleanup errors without blocking .local sync or leaking OS username",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const tempBackup = join(sandbox, "backups");
			const tempLocalCopy = join(tempRepo, ".local", DEFAULT_SHORTCUT_NAME);
			const appDir = join(tempRepo, "app");

			await Promise.all([
				mkdir(tempDesktop, { recursive: true }),
				mkdir(appDir, { recursive: true }),
			]);

			const fakeExe = join(appDir, "Wenyou Pro.exe");
			await writeFile(fakeExe, "MZ-m3-isolation");

			const legacyWenyouPath = join(tempDesktop, "Wenyou Pro.lnk");
			await createShortcutViaPs1({
				shortcutPath: legacyWenyouPath,
				targetExe: fakeExe,
				workingDir: appDir,
				argumentsText: "--legacy-locked",
			});
			const corruptPerchoPath = join(tempDesktop, "Percho.lnk");
			await writeFile(corruptPerchoPath, "corrupt-shortcut-bytes", "utf8");

			const escapedRealPs1 = PS1_SCRIPT_PATH.replace(/'/g, "''");
			const escapedCorruptPath = corruptPerchoPath.replace(/'/g, "''");
			const inspectFailPs1 = join(sandbox, "inspect-fail.ps1");
			await writeFile(
				inspectFailPs1,
				`\uFEFF${[
					"param([string]$Mode, [switch]$UseEnv, [switch]$RefreshShell)",
					`if ($Mode -eq "Read" -and [string]::Equals($env:WENYOU_SHORTCUT_PATH, '${escapedCorruptPath}', [System.StringComparison]::OrdinalIgnoreCase)) {`,
					'    throw "Simulated corrupt legacy lnk read failure"',
					"}",
					`& '${escapedRealPs1}' -Mode $Mode -UseEnv`,
					"exit $LASTEXITCODE",
				].join("\n")}`,
				"utf8",
			);

			const osHome = os.homedir();
			const osUser = basename(osHome);
			const report = await syncDesktopShortcut({
				repoRoot: tempRepo,
				version: "0.2.4",
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				backupDir: tempBackup,
				localCopy: tempLocalCopy,
				refreshShell: false,
				legacyDeleteMode: "recycle",
				ps1ScriptPath: inspectFailPs1,
				recycleFile: async (targetPath) => {
					throw new Error(`Simulated locked recycle failure for ${targetPath}`);
				},
			});

			assert.equal(report.ok, true);
			assert.equal(report.verifiedDesktop.exists, true);
			assert.equal(report.verifiedLocalCopy.exists, true);
			assert.equal((await inspectShortcut(tempLocalCopy)).exists, true);

			assert.equal(report.legacyCleanup.cleaned.length, 0);
			assert.equal(report.legacyCleanup.errors.length, 2);
			const stages = report.legacyCleanup.errors.map((e) => `${e.shortcutName}:${e.stage}`).sort();
			assert.deepEqual(stages, ["Percho.lnk:inspect", "Wenyou Pro.lnk:delete"]);

			const deleteErr = report.legacyCleanup.errors.find((e) => e.shortcutName === "Wenyou Pro.lnk");
			assert.ok(deleteErr.backupPath, "Backup path should be recorded when delete fails after backup");

			const serialized = JSON.stringify(report);
			assert.ok(!serialized.toLowerCase().includes(osHome.toLowerCase()));
			assert.ok(!serialized.includes(osUser));
		},
	);

	it(
		"handles leading-hyphen parameter values such as description='-Mode' safely via env transport",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const appDir = join(sandbox, "app");

			await Promise.all([
				mkdir(tempRepo, { recursive: true }),
				mkdir(tempDesktop, { recursive: true }),
				mkdir(appDir, { recursive: true }),
			]);

			const fakeExe = join(appDir, "Wenyou Pro.exe");
			await writeFile(fakeExe, "MZ-hyphen-test");

			const report = await syncDesktopShortcut({
				repoRoot: tempRepo,
				targetExe: fakeExe,
				desktopDir: tempDesktop,
				noLocalCopy: true,
				description: "-Mode",
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			assert.equal(report.ok, true);
			assert.equal(report.verifiedDesktop.description, "-Mode");

			const onDisk = await inspectShortcut(join(tempDesktop, DEFAULT_SHORTCUT_NAME));
			assert.equal(onDisk.description, "-Mode");
			assert.equal(onDisk.arguments, "");
		},
	);

	it(
		"rolls back existing desktop shortcut, cleans dirty fresh shortcut, preserves legacy shortcut on failure, and annotates localCopy failures",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const tempBackup = join(sandbox, "backups");
			const tempLocalCopy = join(sandbox, "local", DEFAULT_SHORTCUT_NAME);
			const devDir = join(sandbox, "dev");
			const appDir = join(sandbox, "app");

			await Promise.all([
				mkdir(tempRepo, { recursive: true }),
				mkdir(tempDesktop, { recursive: true }),
				mkdir(devDir, { recursive: true }),
				mkdir(appDir, { recursive: true }),
			]);

			const fakeElectronExe = join(devDir, "electron.exe");
			const fakeWenyouExe = join(appDir, "Wenyou Pro.exe");
			await writeFile(fakeElectronExe, "MZ-legacy");
			await writeFile(fakeWenyouExe, "MZ-packaged");

			const legacyShortcutPath = join(tempDesktop, "Wenyou Pro.lnk");
			await createShortcutViaPs1({
				shortcutPath: legacyShortcutPath,
				targetExe: fakeElectronExe,
				workingDir: devDir,
				argumentsText: '"c:\\projects\\wenyou-fixture\\packages\\desktop"',
			});

			const badSyncPs1 = join(sandbox, "bad-sync.ps1");
			const escapedRealPs1 = PS1_SCRIPT_PATH.replace(/'/g, "''");
			await writeFile(
				badSyncPs1,
				`\uFEFF${[
					"param([string]$Mode, [switch]$UseEnv, [switch]$RefreshShell)",
					'if ($Mode -eq "Read") {',
					`    & '${escapedRealPs1}' -Mode Read -UseEnv`,
					"    exit $LASTEXITCODE",
					"}",
					'$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("--corrupted-arg"))',
					"$env:WENYOU_ARGUMENTS_B64 = $b64",
					`& '${escapedRealPs1}' -Mode Write -UseEnv`,
					"exit $LASTEXITCODE",
				].join("\n")}`,
				"utf8",
			);

			const desktopShortcutPath = join(tempDesktop, DEFAULT_SHORTCUT_NAME);
			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						targetExe: fakeWenyouExe,
						desktopDir: tempDesktop,
						backupDir: tempBackup,
						noLocalCopy: true,
						refreshShell: false,
						legacyDeleteMode: "unlink",
						ps1ScriptPath: badSyncPs1,
					}),
				/readback verification failed/i,
			);
			await assert.rejects(() => stat(desktopShortcutPath));
			assert.equal((await stat(legacyShortcutPath)).isFile(), true);

			const legacyArgs = '"c:\\projects\\wenyou-fixture\\packages\\desktop"';
			await createShortcutViaPs1({
				shortcutPath: desktopShortcutPath,
				targetExe: fakeElectronExe,
				workingDir: devDir,
				argumentsText: legacyArgs,
			});
			const originalBytes = await readFile(desktopShortcutPath);

			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						targetExe: fakeWenyouExe,
						desktopDir: tempDesktop,
						backupDir: tempBackup,
						noLocalCopy: true,
						refreshShell: false,
						legacyDeleteMode: "unlink",
						ps1ScriptPath: badSyncPs1,
					}),
				/readback verification failed/i,
			);

			const restoredBytes = await readFile(desktopShortcutPath);
			assert.ok(originalBytes.equals(restoredBytes));
			assert.equal((await readdir(tempBackup)).length, 1);

			const localFailPs1 = join(sandbox, "local-fail.ps1");
			const escapedLocalCopy = tempLocalCopy.replace(/'/g, "''");
			await writeFile(
				localFailPs1,
				`\uFEFF${[
					"param([string]$Mode, [switch]$UseEnv, [switch]$RefreshShell)",
					`if ($Mode -eq "Sync" -and [string]::Equals($env:WENYOU_SHORTCUT_PATH, '${escapedLocalCopy}', [System.StringComparison]::OrdinalIgnoreCase)) {`,
					'    throw "Simulated localCopy write failure"',
					"}",
					`& '${escapedRealPs1}' -Mode $Mode -UseEnv`,
					"exit $LASTEXITCODE",
				].join("\n")}`,
				"utf8",
			);

			const osUser = basename(os.homedir());
			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						targetExe: fakeWenyouExe,
						desktopDir: tempDesktop,
						backupDir: tempBackup,
						localCopy: tempLocalCopy,
						refreshShell: false,
						legacyDeleteMode: "unlink",
						ps1ScriptPath: localFailPs1,
					}),
				(err) => {
					assert.match(err.message, /Simulated localCopy write failure/i);
					assert.match(err.message, /desktop shortcut was already updated/i);
					assert.match(err.message, /desktop backup preserved at/i);
					assert.ok(!err.message.includes(osUser), "localCopy failure note must sanitize OS username");
					return true;
				},
			);
		},
	);

	it(
		"fails closed when targetExe does not exist and preserves existing .lnk untouched",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const tempBackup = join(sandbox, "backups");
			const tempLocalCopy = join(sandbox, "local", DEFAULT_SHORTCUT_NAME);
			const devDir = join(sandbox, "dev");

			await Promise.all([
				mkdir(tempRepo, { recursive: true }),
				mkdir(tempDesktop, { recursive: true }),
				mkdir(devDir, { recursive: true }),
			]);

			const fakeElectronExe = join(devDir, "electron.exe");
			await writeFile(fakeElectronExe, "MZ-existing");

			const desktopShortcutPath = join(tempDesktop, DEFAULT_SHORTCUT_NAME);
			const legacyArgs = '"c:\\projects\\wenyou-fixture\\packages\\desktop"';
			await createShortcutViaPs1({
				shortcutPath: desktopShortcutPath,
				targetExe: fakeElectronExe,
				workingDir: devDir,
				argumentsText: legacyArgs,
			});

			const beforeBytes = await readFile(desktopShortcutPath);
			const missingExe = join(sandbox, "dist", "missing", "Wenyou Pro.exe");

			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						targetExe: missingExe,
						desktopDir: tempDesktop,
						backupDir: tempBackup,
						localCopy: tempLocalCopy,
						refreshShell: false,
						legacyDeleteMode: "unlink",
					}),
				(err) => {
					assert.match(err.message, /does not exist/i);
					assert.ok(!err.message.includes(basename(os.homedir())));
					return true;
				},
			);

			assert.ok(beforeBytes.equals(await readFile(desktopShortcutPath)));
			await assert.rejects(() => stat(tempBackup));
			await assert.rejects(() => stat(tempLocalCopy));
		},
	);

	it(
		"blocks non-empty Arguments in ps1 Sync mode, resolves defaults from repoRoot, and verifies missing versioned icon fails --verify-only",
		{ skip: WIN32_COM_SKIP },
		async () => {
			const sandbox = await makeTempSandbox();
			const tempRepo = join(sandbox, "repo");
			const tempDesktop = join(sandbox, "desktop");
			const pkgDir = join(tempRepo, "packages", "desktop");
			const unpackedDir = join(
				tempRepo,
				"dist",
				"wenyou-pro-0.2.4-win-x64",
				"raw",
				"win-unpacked",
			);
			const resourcesDir = join(unpackedDir, "resources");

			await Promise.all([
				mkdir(tempDesktop, { recursive: true }),
				mkdir(pkgDir, { recursive: true }),
				mkdir(resourcesDir, { recursive: true }),
			]);

			await writeFile(join(pkgDir, "package.json"), JSON.stringify({ version: "0.2.4" }));
			const defaultExe = join(unpackedDir, "Wenyou Pro.exe");
			await writeFile(defaultExe, "MZ-default-0.2.4");
			await writeFile(join(resourcesDir, "wenyou-pro.ico"), createMinimalIcoBuffer([32, 256]));

			await assert.rejects(() =>
				execFileAsync(
					"pwsh",
					[
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						PS1_SCRIPT_PATH,
						"-Mode",
						"Sync",
						"-ShortcutPath",
						join(tempDesktop, "Wenyou Pro.lnk"),
						"-TargetExe",
						defaultExe,
						"-Arguments",
						"--dev",
					],
					{ encoding: "utf8", windowsHide: true },
				),
			);

			const noLocalReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				desktopDir: tempDesktop,
				noLocalCopy: true,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			assert.equal(noLocalReport.ok, true);
			assert.equal(noLocalReport.version, "0.2.4");
			assert.equal(noLocalReport.localCopy, null);
			await assert.rejects(() => stat(join(tempRepo, ".local", DEFAULT_SHORTCUT_NAME)));

			const fullReport = await syncDesktopShortcut({
				repoRoot: tempRepo,
				desktopDir: tempDesktop,
				refreshShell: false,
				legacyDeleteMode: "unlink",
			});
			assert.equal(fullReport.ok, true);
			assert.equal(fullReport.desktopUpdated, false);
			assert.equal(fullReport.backupCreated, false);

			const defaultLocalLnk = join(tempRepo, ".local", DEFAULT_SHORTCUT_NAME);
			const localInfo = await inspectShortcut(defaultLocalLnk);
			assert.equal(localInfo.exists, true);
			assert.equal(normalizeWinPath(localInfo.targetPath), normalizeWinPath(defaultExe));
			assert.equal(localInfo.arguments, "");

			const versionedIco = join(unpackedDir, "wenyou-pro-0.2.4.ico");
			await rm(versionedIco);
			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						desktopDir: tempDesktop,
						verifyOnly: true,
					}),
				/Versioned icon file is missing/i,
			);
			await writeFile(versionedIco, createMinimalIcoBuffer([32, 256]));
			await createShortcutViaPs1({
				shortcutPath: join(tempDesktop, DEFAULT_SHORTCUT_NAME),
				targetExe: defaultExe,
				workingDir: unpackedDir,
				argumentsText: "--stale-dev-flag",
				iconLocation: `${versionedIco},0`,
			});
			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						desktopDir: tempDesktop,
						verifyOnly: true,
					}),
				/arguments must be empty/i,
			);

			await assert.rejects(
				() =>
					syncDesktopShortcut({
						repoRoot: tempRepo,
						targetExe: unpackedDir,
						desktopDir: tempDesktop,
						noLocalCopy: true,
						refreshShell: false,
					}),
				/not a regular file/i,
			);
		},
	);
});
