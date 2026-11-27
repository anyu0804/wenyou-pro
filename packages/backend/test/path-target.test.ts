import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePathTarget } from "../src/path-target";
import { PiBackend } from "../src/pi-backend";

describe("Windows 路径工具细节回归（Bug #21）", () => {
	it("resolvePathTarget 支持 ~\\ 反斜杠家目录展开", () => {
		expect(resolvePathTarget("~\\docs\\plan.md", null)).toBe(normalize(join(homedir(), "docs\\plan.md")));
		expect(resolvePathTarget("~/docs/plan.md", null)).toBe(normalize(join(homedir(), "docs/plan.md")));
	});

	it("resolvePathTarget 处理 file:///D:/ 含裸 % 的回退路径时不产出非法 \\D:\\...", () => {
		const rawPercent = resolvePathTarget("file:///D:/reports/100%done.txt", null);
		expect(rawPercent).not.toMatch(/^[\\/]D:/i);
		expect(rawPercent.replace(/\\/g, "/")).toBe("D:/reports/100%done.txt");

		const encodedPercent = resolvePathTarget("file:///D:/reports/100%25done.txt", null);
		expect(encodedPercent).not.toMatch(/^[\\/]D:/i);
		expect(encodedPercent.replace(/\\/g, "/")).toBe("D:/reports/100%done.txt");
	});

	it("extensionDisplayName 同时兼容 POSIX / 与 Windows \\ 分隔符", () => {
		const fn = (PiBackend.prototype as unknown as { extensionDisplayName: (p: string) => string })
			.extensionDisplayName;
		expect(fn("C:\\Users\\demo\\extensions\\my-ext\\index.ts")).toBe("my-ext");
		expect(fn("C:\\Users\\demo\\extensions\\single.js")).toBe("single.js");
		expect(fn("/home/demo/extensions/my-ext/index.ts")).toBe("my-ext");
		expect(fn("<inline:wenyou>")).toBe("<inline:wenyou>");
	});
});
