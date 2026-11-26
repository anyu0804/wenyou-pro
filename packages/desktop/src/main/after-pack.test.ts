import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPack: (context: { appOutDir: string; electronPlatformName?: string }) => Promise<void> = require(
	resolve(__dirname, "../../scripts/after-pack.cjs"),
);

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("after-pack.cjs locale pruning", () => {
	it("裁剪 locales/ 下所有非 zh-CN.pak / en-US.pak 文件（含大写后缀与符号链接）并保留其他非 .pak 文件", async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "wenyou-after-pack-win-"));
		tempDirs.push(appOutDir);
		const localesDir = join(appOutDir, "locales");
		const externalTarget = join(appOutDir, "keep-target.bin");
		await mkdir(localesDir, { recursive: true });
		await writeFile(externalTarget, "keep-me", "utf8");
		for (const file of ["zh-CN.pak", "en-US.pak", "fr.pak", "DE.PAK", "ja.pak", "ko.pak", "README.txt"]) {
			await writeFile(join(localesDir, file), "fixture", "utf8");
		}
		try {
			await symlink(externalTarget, join(localesDir, "es.pak"));
		} catch {
			// Windows 无符号链接权限时跳过 symlink 构造，其余断言照常验证
		}

		await afterPack({ appOutDir, electronPlatformName: "win32" });

		const remaining = (await readdir(localesDir)).sort();
		expect(remaining).toEqual(["README.txt", "en-US.pak", "zh-CN.pak"]);
		await expect(access(externalTarget)).resolves.toBeUndefined();
	});

	it("macOS 下裁剪 .app 与 Electron Framework 中多余的 .lproj 目录（含大写后缀与符号链接）", async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "wenyou-after-pack-mac-"));
		tempDirs.push(appOutDir);
		const appResources = join(appOutDir, "Wenyou Pro.app", "Contents", "Resources");
		const fwResources = join(
			appOutDir,
			"Wenyou Pro.app",
			"Contents",
			"Frameworks",
			"Electron Framework.framework",
			"Versions",
			"A",
			"Resources",
		);
		const externalDir = join(appOutDir, "external-locale-dir");
		await mkdir(externalDir, { recursive: true });
		for (const base of [appResources, fwResources]) {
			for (const lproj of [
				"zh_CN.lproj",
				"zh-Hans.lproj",
				"en.lproj",
				"Base.lproj",
				"fr.lproj",
				"JA.LPROJ",
			]) {
				await mkdir(join(base, lproj), { recursive: true });
			}
		}
		try {
			await symlink(externalDir, join(appResources, "de.lproj"), "junction");
		} catch {
			// 忽略受限环境下的 symlink 创建失败
		}

		await afterPack({ appOutDir, electronPlatformName: "darwin" });

		expect((await readdir(appResources)).sort()).toEqual(["Base.lproj", "en.lproj", "zh-Hans.lproj", "zh_CN.lproj"]);
		expect((await readdir(fwResources)).sort()).toEqual(["Base.lproj", "en.lproj", "zh-Hans.lproj", "zh_CN.lproj"]);
		await expect(access(externalDir)).resolves.toBeUndefined();
	});

	it("locales/ 不存在或不是目录（普通文件）时静默通过不抛 ENOTDIR", async () => {
		const emptyOutDir = await mkdtemp(join(tmpdir(), "wenyou-after-pack-empty-"));
		tempDirs.push(emptyOutDir);
		await expect(afterPack({ appOutDir: emptyOutDir, electronPlatformName: "linux" })).resolves.toBeUndefined();

		const fileLocalesOutDir = await mkdtemp(join(tmpdir(), "wenyou-after-pack-file-"));
		tempDirs.push(fileLocalesOutDir);
		await writeFile(join(fileLocalesOutDir, "locales"), "not a directory", "utf8");
		await expect(afterPack({ appOutDir: fileLocalesOutDir, electronPlatformName: "win32" })).resolves.toBeUndefined();
	});
});
