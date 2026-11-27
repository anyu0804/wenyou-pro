import { describe, expect, it, vi } from "vitest";
import {
	installRendererGlobalErrorForwarding,
	type RendererErrorForwardingTarget,
} from "./renderer-error-forwarding";

function createFakeWindowTarget() {
	const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	const target: RendererErrorForwardingTarget = {
		addEventListener: ((type: string, listener: EventListenerOrEventListenerObject | null) => {
			if (!listener) return;
			let bucket = listeners.get(type);
			if (!bucket) {
				bucket = new Set();
				listeners.set(type, bucket);
			}
			bucket.add(listener);
		}) as RendererErrorForwardingTarget["addEventListener"],
		removeEventListener: ((type: string, listener: EventListenerOrEventListenerObject | null) => {
			if (!listener) return;
			listeners.get(type)?.delete(listener);
		}) as RendererErrorForwardingTarget["removeEventListener"],
	};

	const emit = (type: "error" | "unhandledrejection", event: Record<string, unknown>) => {
		for (const listener of [...(listeners.get(type) ?? [])]) {
			if (typeof listener === "function") {
				listener(event as unknown as Event);
			} else {
				listener.handleEvent(event as unknown as Event);
			}
		}
	};

	return { target, emit, listeners };
}

describe("installRendererGlobalErrorForwarding", () => {
	it("转发 window error 事件为单字符串参数，包含标签、完整堆栈与源码位置", () => {
		const { target, emit } = createFakeWindowTarget();
		const logger = { error: vi.fn() };
		const dispose = installRendererGlobalErrorForwarding(target, logger);

		const boom = new Error("render crash");
		boom.stack = "Error: render crash\n    at Panel (renderer/Panel.tsx:42:13)";
		emit("error", {
			error: boom,
			message: "Uncaught Error: render crash",
			filename: "renderer/Panel.tsx",
			lineno: 42,
			colno: 13,
		});

		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error.mock.calls[0]).toHaveLength(1);
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("[renderer-uncaught-error] "));
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Error: render crash"));
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("at Panel (renderer/Panel.tsx:42:13)"));
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("(renderer/Panel.tsx:42:13)"));

		dispose();
	});

	it("无 Error 对象时回退 message 与位置；忽略空事件与 ResizeObserver 良性噪音", () => {
		const { target, emit } = createFakeWindowTarget();
		const logger = { error: vi.fn() };
		const dispose = installRendererGlobalErrorForwarding(target, logger);

		emit("error", { message: "ResizeObserver loop completed with undelivered notifications." });
		emit("error", { message: "ResizeObserver loop limit exceeded" });
		emit("error", { message: "" });
		expect(logger.error).not.toHaveBeenCalled();

		emit("error", {
			message: "Script error.",
			filename: "renderer/index.js",
			lineno: 9,
			colno: 4,
		});
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error.mock.calls[0]).toHaveLength(1);
		expect(logger.error).toHaveBeenCalledWith(
			"[renderer-uncaught-error] Script error. (renderer/index.js:9:4)",
		);

		dispose();
	});

	it("转发 unhandledrejection 事件为单字符串参数（Error 完整堆栈、非 Error 及不可序列化对象）", () => {
		const { target, emit } = createFakeWindowTarget();
		const logger = { error: vi.fn() };
		const dispose = installRendererGlobalErrorForwarding(target, logger);

		const ipcErr = new Error("IPC rejected");
		ipcErr.stack = "Error: IPC rejected\n    at callApi (renderer/api.ts:18:5)";
		const nullProto = Object.create(null);
		const hostile = {
			toJSON() {
				throw new Error("toJSON boom");
			},
			toString() {
				throw new Error("toString boom");
			},
		};

		emit("unhandledrejection", { reason: ipcErr });
		emit("unhandledrejection", { reason: "raw rejection text" });
		emit("unhandledrejection", { reason: { code: "E_TIMEOUT", detail: "5000ms" } });
		emit("unhandledrejection", { reason: nullProto });
		emit("unhandledrejection", { reason: hostile });

		expect(logger.error).toHaveBeenCalledTimes(5);
		for (const call of logger.error.mock.calls) {
			expect(call).toHaveLength(1);
		}
		expect(logger.error).toHaveBeenNthCalledWith(
			1,
			"[renderer-unhandled-rejection] Error: IPC rejected\n    at callApi (renderer/api.ts:18:5)",
		);
		expect(logger.error).toHaveBeenNthCalledWith(2, "[renderer-unhandled-rejection] raw rejection text");
		expect(logger.error).toHaveBeenNthCalledWith(
			3,
			'[renderer-unhandled-rejection] {"code":"E_TIMEOUT","detail":"5000ms"}',
		);
		expect(logger.error).toHaveBeenNthCalledWith(4, "[renderer-unhandled-rejection] [unserializable]");
		expect(logger.error).toHaveBeenNthCalledWith(5, "[renderer-unhandled-rejection] [unserializable]");

		dispose();
	});

	it("logger.error 内部重入触发二次 error 或抛错时不死循环不崩溃，且后续错误仍可正常转发", () => {
		const { target, emit } = createFakeWindowTarget();
		let calls = 0;
		const logger = {
			error: vi.fn(() => {
				calls += 1;
				if (calls === 1) {
					// 模拟 logger.error 内部同步再抛/触发 error 与 unhandledrejection
					emit("error", { error: new Error("reentrant error"), filename: "loop.ts", lineno: 1, colno: 1 });
					emit("unhandledrejection", { reason: "reentrant rejection" });
					throw new Error("logger crashed");
				}
			}),
		};
		const dispose = installRendererGlobalErrorForwarding(target, logger);

		expect(() =>
			emit("error", { error: new Error("first boom"), filename: "a.ts", lineno: 10, colno: 2 }),
		).not.toThrow();
		expect(logger.error).toHaveBeenCalledTimes(1);

		// finally 释放锁后，后续真实错误照常转发
		emit("unhandledrejection", { reason: "recovered rejection" });
		expect(logger.error).toHaveBeenCalledTimes(2);
		expect(logger.error.mock.calls[1]).toEqual(["[renderer-unhandled-rejection] recovered rejection"]);

		dispose();
	});

	it("重复安装幂等不双倍打印；卸载后干净移除监听并支持重新安装", () => {
		const { target, emit, listeners } = createFakeWindowTarget();
		const logger = { error: vi.fn() };

		const disposeFirst = installRendererGlobalErrorForwarding(target, logger);
		const disposeSecond = installRendererGlobalErrorForwarding(target, logger);
		expect(disposeSecond).toBe(disposeFirst);
		expect(listeners.get("error")?.size).toBe(1);
		expect(listeners.get("unhandledrejection")?.size).toBe(1);

		emit("error", { error: new Error("once"), filename: "a.ts", lineno: 1, colno: 1 });
		emit("unhandledrejection", { reason: "once-reject" });
		expect(logger.error).toHaveBeenCalledTimes(2);

		disposeFirst();
		disposeSecond();
		expect(listeners.get("error")?.size).toBe(0);
		expect(listeners.get("unhandledrejection")?.size).toBe(0);

		emit("error", { error: new Error("after-dispose"), filename: "a.ts", lineno: 2, colno: 1 });
		emit("unhandledrejection", { reason: "after-dispose-reject" });
		expect(logger.error).toHaveBeenCalledTimes(2);

		// 卸载后可重新挂载
		const disposeReinstalled = installRendererGlobalErrorForwarding(target, logger);
		emit("unhandledrejection", { reason: "reinstalled-reject" });
		expect(logger.error).toHaveBeenCalledTimes(3);
		disposeReinstalled();
	});
});
