import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	isBinaryFilePath,
	isTestFilePath,
	parseScanArgs,
	scanRepositoryPaths,
	scanTextForPathLeaks,
} from "./scan-repo-paths.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT_PATH = resolve(SCRIPT_DIR, "scan-repo-paths.mjs");

async function createTempDir(t, prefix = "wenyou-scan-paths-test-") {
	const dir = await mkdtemp(join(os.tmpdir(), prefix));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("scan-repo-paths classification and argument parsing", () => {
	test("classifies binary extensions and test file paths accurately", () => {
		assert.equal(isBinaryFilePath("packages/desktop/build/wenyou-pro.png"), true);
		assert.equal(isBinaryFilePath("packages/desktop/build/wenyou-pro.ico"), true);
		assert.equal(isBinaryFilePath("packages/desktop/resources/ntqq-vfs/qq_dump_db.exe"), true);
		assert.equal(isBinaryFilePath("scripts/wenyou-release/build-installer.mjs"), false);

		assert.equal(isTestFilePath("scripts/wenyou-release/sync-shortcut.test.mjs"), true);
		assert.equal(isTestFilePath("packages/backend/test/wenyou-ntqq-sync.test.ts"), true);
		assert.equal(isTestFilePath("packages/desktop/src/main/app-identity.ts"), false);
		assert.equal(isTestFilePath("README.md"), false);
	});

	test("parses CLI arguments and rejects unknown flags", () => {
		assert.deepEqual(parseScanArgs([]), { rootDir: undefined, help: false });
		assert.deepEqual(parseScanArgs(["--root", "tmp/repo"]), { rootDir: "tmp/repo", help: false });
		assert.deepEqual(parseScanArgs(["-h"]), { rootDir: undefined, help: true });
		assert.throws(() => parseScanArgs(["--unknown"]));
	});
});

describe("scanTextForPathLeaks positive and negative gates", () => {
	test("blocks unmasked user paths in production code including fictional usernames, while allowing sanitized placeholders", () => {
		const safeProd = [
			"Home config: ~/.wenyou-pro/config.json",
			"macOS support: ~/Library/Application Support/Wenyou Pro/",
			"Env vars: $HOME/.wenyou-pro and %USERPROFILE%\\.wenyou-pro and %APPDATA%\\Wenyou Pro",
			"System dirs: C:\\Users\\Public\\Documents, C:\\Users\\Default\\AppData, C:\\Users\\Default User\\Desktop, C:\\Users\\All Users\\Shared",
			"Placeholders: C:\\Users\\<user>\\Desktop, /Users/<user>/Documents, /home/${USER}/work, C:\\Users\\%USERNAME%\\.wenyou",
			'Upstream UI input: placeholder="/home/user/project"',
			"URL: https://example.com/Users/public/docs",
		].join("\n");
		assert.deepEqual(scanTextForPathLeaks(safeProd, { filePath: "packages/desktop/src/main/index.ts" }), []);

		// Narrow placeholder exemption must NOT exempt a second path on the same line
		const mixedPlaceholderLine =
			'placeholder="/home/user/project" data-fallback="' + ["", "home", "user", "real"].join("/") + '"';
		const mixedFindings = scanTextForPathLeaks(mixedPlaceholderLine, {
			filePath: "packages/desktop/src/renderer/Demo.tsx",
		});
		assert.equal(mixedFindings.length, 1);
		assert.equal(mixedFindings[0].kind, "posix-home-path");
		assert.equal(mixedFindings[0].match, "/home/<REDACTED>");

		const unsafeProdSamples = [
			{
				line: `const p = '${["C:", "Users", "RealPerson", "Desktop"].join("\\\\")}';`,
				secret: "RealPerson",
				kind: "windows-users-path",
			},
			{
				line: `const p = '${["C:", "Users", "Alice", "Desktop"].join("/")}';`,
				secret: "Alice",
				kind: "windows-users-path",
			},
			{
				line: `const p = '${["", "c", "Users", "Alice", "Documents"].join("/")}';`,
				secret: "Alice",
				kind: "msys-users-path",
			},
			{
				line: `const p = '${["", "Users", "alice", "Library"].join("/")}';`,
				secret: "alice",
				kind: "posix-home-path",
			},
			{
				line: `const p = 'file://${["", "Users", "alice", "app.txt"].join("/")}';`,
				secret: "alice",
				kind: "posix-home-path",
			},
			{
				line: `const p = '${["", "home", "dev", "workspace"].join("/")}';`,
				secret: "dev",
				kind: "posix-home-path",
			},
			{
				line: `const p = '${["", "", "host", "Users", "SecretUser", "share"].join("\\\\")}';`,
				secret: "SecretUser",
				kind: "unc-users-path",
			},
			{
				line: `文档路径：${["C:", "Users", "真实姓名", "Desktop", "wenyou"].join("\\")}`,
				secret: "真实姓名",
				kind: "windows-users-path",
			},
		];

		for (const sample of unsafeProdSamples) {
			const findings = scanTextForPathLeaks(sample.line, { filePath: "docs/guide.md" });
			assert.equal(findings.length, 1, `Expected leak in production file for: ${sample.line}`);
			assert.equal(findings[0].kind, sample.kind);
			assert.match(findings[0].match, /<REDACTED>/);
			assert.equal(
				findings[0].match.includes(sample.secret),
				false,
				"Finding match must redact captured username",
			);
		}
	});

	test("allows explicit fictional fixture usernames ONLY in test files, while still blocking unlisted names", () => {
		const testFixture = [
			'const macHome = "/Users/fixture-mac";',
			'const linuxHome = "/home/fixture-linux";',
			'const winHome = "C:\\\\Users\\\\AliceTest\\\\Desktop";',
			'const upstream = "/Users/ericw/.pi/agent";',
		].join("\n");
		assert.deepEqual(
			scanTextForPathLeaks(testFixture, { filePath: "packages/backend/test/sample.test.ts" }),
			[],
		);

		const leakedInTest = `const realPath = "${["C:", "Users", "UnlistedRealName", "Desktop"].join("\\\\")}";`;
		const findings = scanTextForPathLeaks(leakedInTest, {
			filePath: "packages/backend/test/sample.test.ts",
		});
		assert.equal(findings.length, 1);
		assert.equal(findings[0].kind, "windows-users-path");
		assert.equal(findings[0].match.includes("UnlistedRealName"), false);
	});

	test("blocks hardcoded local workspace drive paths (including %20 URL-encoded spaces) in BOTH production and test files", () => {
		const workspaceA = ["wenyou", "pro"].join(" ");
		const workspaceAEncoded = ["wenyou", "pro"].join("%20");
		const workspaceB = ["deepseek", "harness"].join(" ");
		const workspaceBEncoded = ["deepseek", "harness"].join("%20");
		const badLines = [
			`const a = "D:\\\\${workspaceA}\\\\dist\\\\Wenyou Pro.exe";`,
			`const b = "d:/${workspaceA}/packages/desktop";`,
			`const c = "/d/${workspaceA}/scripts";`,
			`const d = "D:\\\\${workspaceB}\\\\notes.md";`,
			`const e = "/mnt/d/${workspaceB}/shared.md";`,
			`const f = "file:///d:/${workspaceAEncoded}/packages/desktop";`,
			`const g = "file:///d/${workspaceBEncoded}/todo.md";`,
		];

		for (const targetFile of ["packages/desktop/src/main/index.ts", "scripts/wenyou-release/demo.test.mjs"]) {
			for (const line of badLines) {
				const findings = scanTextForPathLeaks(line, { filePath: targetFile });
				assert.equal(
					findings.length,
					1,
					`Expected workspace path gate to reject in ${targetFile}: ${line}`,
				);
				assert.equal(findings[0].kind, "hardcoded-local-workspace");
				assert.match(findings[0].match, /<REDACTED-WORKSPACE>/);
			}
		}

		// Cross-machine safe fixture paths must pass
		const safeLines = [
			'const a = "C:\\\\Projects\\\\wenyou-fixture\\\\dist\\\\Wenyou Pro.exe";',
			'const b = "c:/projects/wenyou-fixture/packages/desktop";',
		].join("\n");
		assert.deepEqual(
			scanTextForPathLeaks(safeLines, { filePath: "scripts/wenyou-release/demo.test.mjs" }),
			[],
		);
	});
});

describe("scanRepositoryPaths filesystem and CLI integration", () => {
	test("scans custom file lists, skips binary files, and reports redacted line numbers on violations", async (t) => {
		const tempRoot = await createTempDir(t);
		await mkdir(join(tempRoot, "src"), { recursive: true });
		await mkdir(join(tempRoot, "assets"), { recursive: true });

		await writeFile(join(tempRoot, "src/clean.ts"), "export const dir = '~/.wenyou-pro';\n", "utf8");
		await writeFile(join(tempRoot, "assets/icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
		await writeFile(join(tempRoot, "assets/unknown.custom"), Buffer.from([0x01, 0x00, 0x02]));

		const cleanReport = await scanRepositoryPaths({
			rootDir: tempRoot,
			files: ["src/clean.ts", "assets/icon.png", "assets/unknown.custom"],
		});
		assert.equal(cleanReport.ok, true);
		assert.equal(cleanReport.scannedFiles, 1);
		assert.equal(cleanReport.skippedBinaryFiles, 2);
		assert.equal(cleanReport.violationCount, 0);

		await writeFile(
			join(tempRoot, "src/dirty.ts"),
			`const ok = 1;\nconst leak = '${["", "Users", "LeakedUser", "secret"].join("/")}';\n`,
			"utf8",
		);
		const dirtyReport = await scanRepositoryPaths({
			rootDir: tempRoot,
			files: ["src/clean.ts", "src/dirty.ts"],
		});
		assert.equal(dirtyReport.ok, false);
		assert.equal(dirtyReport.violationCount, 1);
		assert.equal(dirtyReport.violations[0].file, "src/dirty.ts");
		assert.equal(dirtyReport.violations[0].line, 2);
		assert.equal(dirtyReport.violations[0].kind, "posix-home-path");
		assert.equal(dirtyReport.violations[0].match, "/Users/<REDACTED>");
	});

	test("CLI exits non-zero with redacted violation output when scanning a dirty git repo", async (t) => {
		const tempRoot = await createTempDir(t);
		await execFileAsync("git", ["init", "-q"], { cwd: tempRoot });
		await writeFile(
			join(tempRoot, "README.md"),
			`Install path: ${["C:", "Users", "LeakVictim", "App"].join("\\")}\n`,
			"utf8",
		);

		await assert.rejects(
			() => execFileAsync(process.execPath, [SCAN_SCRIPT_PATH, "--root", tempRoot], { encoding: "utf8" }),
			(err) => {
				assert.equal(err.code, 1);
				const parsed = JSON.parse(err.stdout);
				assert.equal(parsed.ok, false);
				assert.equal(parsed.violationCount, 1);
				assert.match(err.stderr, /README\.md:1/);
				assert.equal(err.stdout.includes("LeakVictim"), false);
				assert.equal(err.stderr.includes("LeakVictim"), false);
				return true;
			},
		);
	});
});
