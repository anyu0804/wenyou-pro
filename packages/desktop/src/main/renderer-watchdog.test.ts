import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initLogging } from "../../../backend/src/log";

const electronFixture = vi.hoisted(() => {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const appEvents = {
		on(event: string, fn: (...args: unknown[]) => void) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(fn);
		},
		off(event: string, fn: (...args: unknown[]) => void) {
			listeners.get(event)?.delete(fn);
		},
		emit(event: string, ...args: unknown[]) {
			for (const fn of listeners.get(event) ?? []) fn(...args);
		},
		removeAllListeners() {
			listeners.clear();
		},
	};
	return {
		appEvents,
		windows: [] as Array<{ isDestroyed: () => boolean; webContents: FakeWebContents }>,
		allWebContents: [] as FakeWebContents[],
		getAppMetrics: vi.fn(() => [{ type: "Tab", memory: { workingSetSize: 65536 } }]),
		quit: vi.fn(),
		showMessageBox: vi.fn(async () => ({ response: 0 })),
	};
});

interface FakeWebContents extends EventEmitter {
	isDestroyed: () => boolean;
	reload: ReturnType<typeof vi.fn>;
}

function createFakeWebContents(destroyed = false): FakeWebContents {
	const emitter = new EventEmitter() as FakeWebContents;
	emitter.isDestroyed = () => destroyed;
	emitter.reload = vi.fn();
	return emitter;
}

vi.mock("@percho/backend", async () => {
	const logMod = await import("../../../backend/src/log");
	return { createLogger: logMod.createLogger, initLogging: logMod.initLogging };
});

vi.mock("electron", () => ({
	app: Object.assign(electronFixture.appEvents, {
		getAppMetrics: electronFixture.getAppMetrics,
		quit: electronFixture.quit,
	}),
	BrowserWindow: {
		getAllWindows: () => electronFixture.windows,
		fromWebContents: () => null,
	},
	webContents: {
		getAllWebContents: () => electronFixture.allWebContents,
	},
	dialog: {
		showMessageBox: electronFixture.showMessageBox,
	},
}));

import { attachRendererWatchdog, type RendererWatchdogHandle } from "./renderer-watchdog";

let logDir: string;
let handle: RendererWatchdogHandle | undefined;

function readMainLog(): string {
	const logFiles = readdirSync(logDir).filter((name) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(name));
	return logFiles.map((name) => readFileSync(join(logDir, name), "utf8")).join("\n");
}

beforeEach(() => {
	logDir = mkdtempSync(join(tmpdir(), "renderer-watchdog-test-"));
	initLogging(logDir, "info");
	electronFixture.windows = [];
	electronFixture.allWebContents = [];
	electronFixture.appEvents.removeAllListeners();
	electronFixture.getAppMetrics.mockClear();
	electronFixture.quit.mockClear();
	electronFixture.showMessageBox.mockClear();
});

afterEach(() => {
	handle?.dispose();
	handle = undefined;
	rmSync(logDir, { recursive: true, force: true });
});

describe("attachRendererWatchdog", () => {
	it("同时补绑已存在的 BrowserWindow 与新建 webContents，并去重防重复绑定，真实将 error 落盘到 main-*.log", () => {
		const existingContents = createFakeWebContents();
		// 同时出现在 allWebContents 与 BrowserWindow.getAllWindows() 中，验证 WeakSet 防止双绑
		electronFixture.allWebContents = [existingContents];
		electronFixture.windows = [{ isDestroyed: () => false, webContents: existingContents }];

		handle = attachRendererWatchdog(() => undefined);

		existingContents.emit("console-message", {
			level: "error",
			message: "ReferenceError: existingWindowCrash",
			lineNumber: 42,
			sourceId: "app://renderer/workbench.js",
		});

		const newContents = createFakeWebContents();
		electronFixture.appEvents.emit("web-contents-created", {}, newContents);
		newContents.emit("console-message", {
			level: "error",
			message: "TypeError: newWindowCrash",
			lineNumber: 99,
			sourceId: "app://renderer/startup.js",
		});
		newContents.emit("console-message", {
			level: "warning",
			message: "Unhandled promise rejection failed in loader",
			lineNumber: 12,
			sourceId: "app://renderer/loader.js",
		});
		newContents.emit("console-message", {
			level: "info",
			message: "harmless info noise",
			lineNumber: 1,
			sourceId: "app://renderer/info.js",
		});

		const content = readMainLog();
		const existingMatches = content.match(/ReferenceError: existingWindowCrash/g) ?? [];
		expect(existingMatches).toHaveLength(1);
		expect(content).toContain("TypeError: newWindowCrash");
		expect(content).toContain("Unhandled promise rejection failed in loader");
		expect(content).not.toContain("harmless info noise");
	});

	it("backend 未就绪时 render-process-gone 崩溃快照安全回退空速率表不抛空指针，就绪后自动读取最新速率", () => {
		const contents = createFakeWebContents();
		electronFixture.windows = [{ isDestroyed: () => false, webContents: contents }];

		let currentBackend:
			| { getEventRates: () => Map<string, { window60s: number[]; lastEventAt: number }> }
			| undefined;

		handle = attachRendererWatchdog(() => currentBackend);

		// 1. backend 尚未初始化完成时发生崩溃 → 不抛错，自动 reload，sessions 为空数组
		expect(() => contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 })).not.toThrow();
		expect(contents.reload).toHaveBeenCalledTimes(1);
		const logBeforeBackend = readMainLog();
		expect(logBeforeBackend).toContain("incident snapshot");
		expect(logBeforeBackend).toContain('"sessions":[]');

		// 2. backend 初始化完成后再次崩溃 → 惰性 getter 自动拿到实时事件速率
		currentBackend = {
			getEventRates: () => new Map([["sess-abcd1234", { window60s: [4, 6], lastEventAt: Date.now() }]]),
		};
		expect(() => contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 })).not.toThrow();
		expect(contents.reload).toHaveBeenCalledTimes(2);
		const logAfterBackend = readMainLog();
		expect(logAfterBackend).toContain('"id":"sess-abc"');
		expect(logAfterBackend).toContain('"rate1m":10');
	});
});
