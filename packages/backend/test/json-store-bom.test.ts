import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	renameSync: vi.fn<typeof import("node:fs").renameSync>(),
	actualRenameSync: undefined as typeof import("node:fs").renameSync | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	io.actualRenameSync = original.renameSync;
	return { ...original, renameSync: io.renameSync };
});

import { JsonStore, JsonStoreCorruptedError } from "../src/json-store";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const actualRenameSync = io.actualRenameSync;
if (!platformDescriptor || !actualRenameSync) throw new Error("Missing native test prerequisites");

let dir: string;
let filePath: string;

function writeUtf8WithBom(targetPath: string, content: string): void {
	writeFileSync(targetPath, Buffer.concat([UTF8_BOM, Buffer.from(content, "utf8")]));
}

function createStore(defaultValue?: () => Record<string, unknown>) {
	return new JsonStore<Record<string, unknown>>({
		path: filePath,
		defaultValue: defaultValue ?? (() => ({ theme: "system", fallback: true })),
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "json-store-bom-"));
	filePath = join(dir, "ui-state.json");
	io.renameSync.mockReset().mockImplementation(actualRenameSync);
});

afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	rmSync(dir, { recursive: true, force: true });
});

describe("JsonStore UTF-8 BOM tolerance (PowerShell Set-Content -Encoding UTF8)", () => {
	it("带 \\uFEFF UTF-8 BOM 的合法 JSON 在 read / readStrict / readSync / update / updateSync 下均正常读写", async () => {
		const initial = { theme: "dark", sidebarWidth: 320 };
		writeUtf8WithBom(filePath, JSON.stringify(initial, null, 2));

		// 确认落盘原始字节确实带有 PowerShell 风格的 EF BB BF UTF-8 BOM
		const rawBytes = readFileSync(filePath);
		expect(rawBytes.subarray(0, 3)).toEqual(UTF8_BOM);

		const store = createStore();
		await expect(store.read()).resolves.toEqual(initial);
		await expect(store.readStrict()).resolves.toEqual(initial);
		expect(store.readSync()).toEqual(initial);

		// async update 正常读取 BOM 文件并落盘自愈为无 BOM UTF-8
		const updated = await store.update((draft) => {
			draft.sidebarWidth = 360;
		});
		expect(updated).toEqual({ theme: "dark", sidebarWidth: 360 });
		expect(readFileSync(filePath).subarray(0, 3)).not.toEqual(UTF8_BOM);

		// 再次写入带 BOM 的内容，验证 updateSync 也能无异常读写并自愈
		writeUtf8WithBom(filePath, JSON.stringify({ theme: "light", count: 1 }));
		const syncUpdated = store.updateSync((draft) => {
			draft.count = 2;
		});
		expect(syncUpdated).toEqual({ theme: "light", count: 2 });
		expect(store.readSync()).toEqual({ theme: "light", count: 2 });
		expect(readFileSync(filePath).subarray(0, 3)).not.toEqual(UTF8_BOM);
	});

	it("自定义 JSONC parse 钩子同样对 UTF-8 BOM 免疫", async () => {
		writeUtf8WithBom(filePath, '{\n  // PowerShell 编辑后带 BOM 的 JSONC\n  "theme": "dark"\n}\n');
		const store = new JsonStore<Record<string, unknown>>({
			path: filePath,
			defaultValue: () => ({ theme: "system" }),
			parse: (raw) => JSON.parse(raw.replace(/\/\/[^\n"]*(?=\n)/g, "")) as Record<string, unknown>,
		});
		await expect(store.readStrict()).resolves.toEqual({ theme: "dark" });
		await expect(
			store.update((draft) => {
				draft.updated = true;
			}),
		).resolves.toEqual({ theme: "dark", updated: true });
	});

	it("负向对照：真正损坏的非法 JSON（无 BOM 与带 BOM）仍严格按契约抛 JsonStoreCorruptedError 且不覆盖原文件", async () => {
		const store = createStore();

		// 1. 无 BOM 的损坏 JSON
		writeFileSync(filePath, "{ invalid json", "utf8");
		await expect(store.read()).resolves.toEqual({ theme: "system", fallback: true });
		expect(store.readSync()).toEqual({ theme: "system", fallback: true });
		await expect(store.readStrict()).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		await expect(
			store.update((draft) => {
				draft.touched = true;
			}),
		).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		expect(() =>
			store.updateSync((draft) => {
				draft.touched = true;
			}),
		).toThrow(JsonStoreCorruptedError);
		expect(readFileSync(filePath, "utf8")).toBe("{ invalid json");

		// 2. 带 UTF-8 BOM 但正文损坏的 JSON
		writeUtf8WithBom(filePath, "{ invalid bom json");
		const before = readFileSync(filePath);
		await expect(store.read()).resolves.toEqual({ theme: "system", fallback: true });
		expect(store.readSync()).toEqual({ theme: "system", fallback: true });
		await expect(store.readStrict()).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		await expect(
			store.update((draft) => {
				draft.touched = true;
			}),
		).rejects.toBeInstanceOf(JsonStoreCorruptedError);
		expect(() =>
			store.updateSync((draft) => {
				draft.touched = true;
			}),
		).toThrow(JsonStoreCorruptedError);
		expect(readFileSync(filePath)).toEqual(before);
	});
});

describe("JsonStore sync rename retry on Windows transient locks", () => {
	it.each(["EPERM", "EACCES", "EBUSY"])("Windows 下 updateSync 遇到瞬时 %s 时退避重试成功", (code) => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const store = createStore();
		store.writeSync({ count: 1 });

		const transient = Object.assign(new Error("transient sharing violation"), { code });
		io.renameSync
			.mockReset()
			.mockImplementationOnce(() => {
				throw transient;
			})
			.mockImplementationOnce(() => {
				throw transient;
			})
			.mockImplementation((src, dest) => actualRenameSync(src, dest));

		const result = store.updateSync((draft) => {
			draft.count = 2;
		});
		expect(result).toEqual({ count: 2 });
		expect(io.renameSync).toHaveBeenCalledTimes(3);
		expect(store.readSync()).toEqual({ count: 2 });
		expect(readdirSync(dir)).toEqual(["ui-state.json"]);
	});

	it("Windows 下持续锁冲突重试 3 次（共 4 次）后上抛并清理 tmp 且保留原文件", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const store = createStore();
		store.writeSync({ count: 1 });

		const persistent = Object.assign(new Error("persistent lock"), { code: "EPERM" });
		io.renameSync.mockReset().mockImplementation(() => {
			throw persistent;
		});

		expect(() => store.writeSync({ count: 2 })).toThrow(persistent);
		expect(io.renameSync).toHaveBeenCalledTimes(4);
		expect(store.readSync()).toEqual({ count: 1 });
		expect(readdirSync(dir)).toEqual(["ui-state.json"]);
	});

	it("非 Windows 平台或非共享锁错误（EIO）不重试", () => {
		const store = createStore();
		store.writeSync({ count: 1 });

		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const ioErr = Object.assign(new Error("io failure"), { code: "EIO" });
		io.renameSync.mockReset().mockImplementation(() => {
			throw ioErr;
		});
		expect(() => store.writeSync({ count: 2 })).toThrow(ioErr);
		expect(io.renameSync).toHaveBeenCalledTimes(1);

		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		const permErr = Object.assign(new Error("perm failure"), { code: "EPERM" });
		io.renameSync.mockReset().mockImplementation(() => {
			throw permErr;
		});
		expect(() => store.writeSync({ count: 2 })).toThrow(permErr);
		expect(io.renameSync).toHaveBeenCalledTimes(1);
	});
});
