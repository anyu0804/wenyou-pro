import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
	it("裁剪 locales/ 下所有非 zh-CN.pak / en-US.pak 文件并保留其他非 .pak 文件", async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "wenyou-after-pack-win-"));
		tempDirs.push(appOutDir);
		const localesDir = join(appOutDir, "locales");
		await mkdir(localesDir, { recursive: true });
		for (const file of ["zh-CN.pak", "en-US.pak", "fr.pak", "de.pak", "ja.pak", "ko.pak", "README.txt"]) {
			await writeFile(join(localesDir, file), "fixture", "utf8");
		}

		await afterPack({ appOutDir, electronPlatformName: "win32" });

		const remaining = (await readdir(localesDir)).sort();
		expect(remaining).toEqual(["README.txt", "en-US.pak", "zh-CN.pak"]);
	});

	it("macOS 下裁剪 .app 与 Electron Framework 中多余的 .lproj 目录", async () => {
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
		for (const base of [appResources, fwResources]) {
			for (const lproj of ["zh_CN.lproj", "zh-Hans.lproj", "en.lproj", "Base.lproj", "fr.lproj", "ja.lproj"]) {
				await mkdir(join(base, lproj), { recursive: true });
			}
		}

		await afterPack({ appOutDir, electronPlatformName: "darwin" });

		expect((await readdir(appResources)).sort()).toEqual(["Base.lproj", "en.lproj", "zh-Hans.lproj", "zh_CN.lproj"]);
		expect((await readdir(fwResources)).sort()).toEqual(["Base.lproj", "en.lproj", "zh-Hans.lproj", "zh_CN.lproj"]);
	});

	it("locales/ 目录不存在时静默通过不抛错", async () => {
		const appOutDir = await mkdtemp(join(tmpdir(), "wenyou-after-pack-empty-"));
		tempDirs.push(appOutDir);
		await expect(afterPack({ appOutDir, electronPlatformName: "linux" })).resolves.toBeUndefined();
	});
});
