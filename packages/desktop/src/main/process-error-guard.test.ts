import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	acquireSingleInstanceGuard,
	buildErrorSignature,
	type ErrorGuardLogger,
	installMainProcessErrorGuard,
	type SingleInstanceWindowLike,
} from "./process-error-guard";

function createFakeLogger(): ErrorGuardLogger & {
	info: ReturnType<typeof vi.fn>;
	warn: ReturnType<typeof vi.fn>;
	error: ReturnType<typeof vi.fn>;
} {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

function createFakeWindow(options?: {
	destroyed?: boolean;
	minimized?: boolean;
	throwOnShow?: boolean;
}): SingleInstanceWindowLike & {
	restore: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
} {
	let minimized = options?.minimized ?? false;
	const restore = vi.fn(() => {
		minimized = false;
	});
	const show = vi.fn(() => {
		if (options?.throwOnShow) throw new Error("window transitioning");
	});
	const focus = vi.fn();
	return {
		isDestroyed: () => options?.destroyed ?? false,
		isMinimized: () => minimized,
		restore,
		show,
		focus,
	};
}

describe("acquireSingleInstanceGuard", () => {
	it("第二实例 requestSingleInstanceLock 返回 false 时立即短路退出且不执行后续初始化", () => {
		const events = new EventEmitter();
		const log = createFakeLogger();
		const markQuitting = vi.fn();
		const exit = vi.fn();
		const continueInit = vi.fn();
		const on = vi.fn((event: "second-instance", listener: () => void) => events.on(event, listener));

		const locked = acquireSingleInstanceGuard({
			app: {
				requestSingleInstanceLock: () => false,
				on,
				exit,
			},
			getWindows: () => [],
			log,
			onBeforeExit: markQuitting,
		});

		if (locked) continueInit();

		expect(locked).toBe(false);
		expect(continueInit).not.toHaveBeenCalled();
		expect(on).not.toHaveBeenCalled();
		expect(markQuitting).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(markQuitting.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0] ?? 0);
		expect(log.info).toHaveBeenCalledOnce();
	});

	it("主实例收到 second-instance 时恢复最小化窗口并 show + focus", () => {
		const events = new EventEmitter();
		const log = createFakeLogger();
		const exit = vi.fn();
		const destroyedWin = createFakeWindow({ destroyed: true, minimized: true });
		const mainWin = createFakeWindow({ minimized: true });

		const locked = acquireSingleInstanceGuard({
			app: {
				requestSingleInstanceLock: () => true,
				on: (event, listener) => events.on(event, listener),
				exit,
			},
			getWindows: () => [destroyedWin, mainWin],
			log,
		});

		expect(locked).toBe(true);
		expect(exit).not.toHaveBeenCalled();

		events.emit("second-instance");

		expect(destroyedWin.restore).not.toHaveBeenCalled();
		expect(destroyedWin.show).not.toHaveBeenCalled();
		expect(mainWin.restore).toHaveBeenCalledOnce();
		expect(mainWin.show).toHaveBeenCalledOnce();
		expect(mainWin.focus).toHaveBeenCalledOnce();
		expect(mainWin.restore.mock.invocationCallOrder[0]).toBeLessThan(
			mainWin.show.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mainWin.show.mock.invocationCallOrder[0]).toBeLessThan(
			mainWin.focus.mock.invocationCallOrder[0] ?? 0,
		);

		// 再次触发时窗口已非最小化：不再重复 restore，仅 show + focus
		events.emit("second-instance");
		expect(mainWin.restore).toHaveBeenCalledOnce();
		expect(mainWin.show).toHaveBeenCalledTimes(2);
		expect(mainWin.focus).toHaveBeenCalledTimes(2);
	});

	it("second-instance 唤醒异常或无可用窗口时优雅降级不抛出", () => {
		const events = new EventEmitter();
		const log = createFakeLogger();
		const faultyWin = createFakeWindow({ throwOnShow: true });
		let windows: SingleInstanceWindowLike[] = [];

		acquireSingleInstanceGuard({
			app: {
				requestSingleInstanceLock: () => true,
				on: (event, listener) => events.on(event, listener),
				exit: vi.fn(),
			},
			getWindows: () => windows,
			log,
		});

		expect(() => events.emit("second-instance")).not.toThrow();
		expect(log.warn).not.toHaveBeenCalled();

		windows = [faultyWin];
		expect(() => events.emit("second-instance")).not.toThrow();
		expect(log.warn).toHaveBeenCalledOnce();
	});
});

describe("installMainProcessErrorGuard", () => {
	it("拦截 dialog.showErrorBox 并在高频弹窗风暴下零原生调用、60s 窗口去重汇总", () => {
		let currentTime = 1_000;
		const proc = new EventEmitter();
		const log = createFakeLogger();
		const nativeShowErrorBox = vi.fn();
		const fakeDialog = { showErrorBox: nativeShowErrorBox };

		const guard = installMainProcessErrorGuard({
			process: proc,
			dialog: fakeDialog,
			log,
			windowMs: 60_000,
			now: () => currentTime,
			autoFlush: false,
		});

		for (let i = 0; i < 25; i++) {
			fakeDialog.showErrorBox(
				"A JavaScript error occurred in the main process",
				"Error: EPERM: operation not permitted, rename ui-state.json",
			);
			currentTime += 100;
		}

		// 不同标题/内容的报错属于不同签名，应立即可见（避免盲吞新错误）
		fakeDialog.showErrorBox("Different title", "Different content");

		expect(nativeShowErrorBox).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledTimes(2);
		expect(log.error).toHaveBeenNthCalledWith(1, "suppressed native error box", {
			title: "A JavaScript error occurred in the main process",
			content: "Error: EPERM: operation not permitted, rename ui-state.json",
		});
		expect(log.error).toHaveBeenNthCalledWith(2, "suppressed native error box", {
			title: "Different title",
			content: "Different content",
		});

		// 满 60s 窗口后 flush 输出重复汇总
		currentTime = 62_000;
		const summaries = guard.flush();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			kind: "errorBox",
			suppressed: 24,
			total: 25,
			windowMs: 60_000,
		});
		expect(log.error).toHaveBeenCalledTimes(3);
		expect(log.error).toHaveBeenLastCalledWith("main process error repeated", summaries[0]);

		guard.dispose();
		expect(fakeDialog.showErrorBox).toBe(nativeShowErrorBox);
	});

	it("拦截 uncaughtException 与 unhandledRejection，按 name+message+首帧栈去重限流", () => {
		let currentTime = 10_000;
		const proc = new EventEmitter();
		const log = createFakeLogger();
		const nativeShowErrorBox = vi.fn();
		const fakeDialog = { showErrorBox: nativeShowErrorBox };

		const guard = installMainProcessErrorGuard({
			process: proc,
			dialog: fakeDialog,
			log,
			windowMs: 60_000,
			now: () => currentTime,
			autoFlush: false,
		});

		const makeStormError = (frame: string) => {
			const err = new TypeError("Object has been destroyed");
			err.stack = `TypeError: Object has been destroyed\n    at ${frame}\n    at caller (app.js:10:2)`;
			return err;
		};

		// 同签名 uncaughtException 连续轰炸 30 次
		for (let i = 0; i < 30; i++) {
			proc.emit("uncaughtException", makeStormError("sendToRenderer (send.ts:25:18)"), "uncaughtException");
			currentTime += 50;
		}
		// 首帧调用栈不同 → 视为不同签名，立即输出完整日志
		proc.emit(
			"uncaughtException",
			makeStormError("applyChromeTheme (window.ts:113:12)"),
			"uncaughtException",
		);

		// 同签名 unhandledRejection 连续轰炸 15 次
		for (let i = 0; i < 15; i++) {
			proc.emit("unhandledRejection", new Error("配置文件损坏：ui-state.json"), Promise.resolve());
			currentTime += 50;
		}
		// 非 Error rejection 也能安全记录与去重
		for (let i = 0; i < 5; i++) {
			proc.emit("unhandledRejection", "plain rejection", Promise.resolve());
		}

		expect(nativeShowErrorBox).not.toHaveBeenCalled();
		// 4 个唯一签名在窗口内仅各打 1 条全量日志
		expect(log.error).toHaveBeenCalledTimes(4);
		expect(log.error.mock.calls[0]?.[0]).toBe("uncaughtException");
		expect(log.error.mock.calls[1]?.[0]).toBe("uncaughtException");
		expect(log.error.mock.calls[2]?.[0]).toBe("unhandledRejection");
		expect(log.error.mock.calls[3]?.[0]).toBe("unhandledRejection");

		// 跨 60s 窗口后再次收到第一个签名：先汇总旧窗口被抑次数，再打新窗口首条完整日志
		currentTime = 75_000;
		proc.emit("uncaughtException", makeStormError("sendToRenderer (send.ts:25:18)"), "uncaughtException");
		expect(log.error).toHaveBeenCalledTimes(6);
		expect(log.error.mock.calls[4]?.[0]).toBe("main process error repeated");
		expect(log.error.mock.calls[4]?.[1]).toMatchObject({
			kind: "uncaughtException",
			suppressed: 29,
			total: 30,
		});
		expect(log.error.mock.calls[5]?.[0]).toBe("uncaughtException");

		// flush 输出其余两类 rejection 的汇总
		const rest = guard.flush();
		expect(rest).toHaveLength(2);
		expect(rest.map((s) => ({ kind: s.kind, suppressed: s.suppressed, total: s.total }))).toEqual([
			{ kind: "unhandledRejection", suppressed: 14, total: 15 },
			{ kind: "unhandledRejection", suppressed: 4, total: 5 },
		]);

		guard.dispose();
	});

	it("重复安装幂等不叠挂监听，dispose 后干净卸载并可重新安装", () => {
		const proc = new EventEmitter();
		const log = createFakeLogger();
		const nativeShowErrorBox = vi.fn();
		const fakeDialog = { showErrorBox: nativeShowErrorBox };

		const first = installMainProcessErrorGuard({
			process: proc,
			dialog: fakeDialog,
			log,
			autoFlush: false,
		});
		const second = installMainProcessErrorGuard({
			process: proc,
			dialog: fakeDialog,
			log,
			autoFlush: false,
		});

		expect(second).toBe(first);
		expect(proc.listenerCount("uncaughtException")).toBe(1);
		expect(proc.listenerCount("unhandledRejection")).toBe(1);

		first.dispose();
		expect(proc.listenerCount("uncaughtException")).toBe(0);
		expect(proc.listenerCount("unhandledRejection")).toBe(0);
		expect(fakeDialog.showErrorBox).toBe(nativeShowErrorBox);

		// buildErrorSignature 验证：按 name + message + 首帧栈拼接
		const err = new RangeError("out of range");
		err.stack = "RangeError: out of range\n    at foo (bar.ts:1:1)\n    at baz (qux.ts:2:2)";
		expect(buildErrorSignature(err)).toBe("RangeError|out of range|at foo (bar.ts:1:1)");
	});

	it("dialog 对象被冻结不可写时记录 warn 而不崩溃启动", () => {
		const proc = new EventEmitter();
		const log = createFakeLogger();
		const frozenDialog = Object.freeze({ showErrorBox: vi.fn() });

		const guard = installMainProcessErrorGuard({
			process: proc,
			dialog: frozenDialog,
			log,
			autoFlush: false,
		});

		expect(log.warn).toHaveBeenCalledOnce();
		expect(proc.listenerCount("uncaughtException")).toBe(1);
		expect(() => guard.dispose()).not.toThrow();
	});
});
