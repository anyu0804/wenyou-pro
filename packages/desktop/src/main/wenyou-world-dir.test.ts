import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorldDirectory, sanitizeWorldFolderName } from "./wenyou-world-dir";

const createdRoots: string[] = [];

afterEach(async () => {
	while (createdRoots.length > 0) {
		const dir = createdRoots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("wenyou-world-dir", () => {
	it("sanitizeWorldFolderName 保留中文、过滤路径穿越字符并规避 Windows 保留设备名", () => {
		expect(sanitizeWorldFolderName("文明不朽 · 第一局")).toBe("文明不朽-·-第一局");
		expect(sanitizeWorldFolderName("../etc/passwd")).toBe("etc-passwd");
		expect(sanitizeWorldFolderName("  ...  ")).toBe("wenyou-world");
		expect(sanitizeWorldFolderName("CON")).toBe("CON-world");
		expect(sanitizeWorldFolderName("nul")).toBe("nul-world");
	});

	it("createWorldDirectory 在指定父目录下新建空白目录，同名时自动递增后缀且绝不覆盖已有文件", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-world-dir-test-"));
		createdRoots.push(root);

		const first = await createWorldDirectory({ worldTitle: "顺唐文游", parentDir: root });
		expect(first.worldTitle).toBe("顺唐文游");
		expect(basename(first.cwd)).toBe("顺唐文游");
		expect(existsSync(first.cwd)).toBe(true);

		// 在首个目录写入标记文件，确认二次同名创建绝不覆写它
		await writeFile(join(first.cwd, "keep.txt"), "existing", "utf8");

		const second = await createWorldDirectory({ worldTitle: "顺唐文游", parentDir: root });
		expect(basename(second.cwd)).toBe("顺唐文游-2");
		expect(existsSync(second.cwd)).toBe(true);
		expect(existsSync(join(first.cwd, "keep.txt"))).toBe(true);

		const third = await createWorldDirectory({ worldTitle: "顺唐文游", parentDir: root });
		expect(basename(third.cwd)).toBe("顺唐文游-3");
	});

	it("世界名留空时自动生成带时间戳的默认世界名", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-world-dir-empty-"));
		createdRoots.push(root);

		const fixed = new Date(2026, 10, 26, 14, 5);
		const res = await createWorldDirectory({ parentDir: root, now: fixed });
		expect(res.worldTitle).toBe("新世界-20261126-1405");
		expect(basename(res.cwd)).toBe("新世界-20261126-1405");
		expect(existsSync(res.cwd)).toBe(true);
	});

	it("拒绝相对路径或不存在的父目录", async () => {
		await expect(createWorldDirectory({ parentDir: "relative/path" })).rejects.toThrow("绝对路径");
		await expect(
			createWorldDirectory({ parentDir: join(tmpdir(), "non-existent-wenyou-parent-xyz-999") }),
		).rejects.toThrow("不存在");
	});
});
