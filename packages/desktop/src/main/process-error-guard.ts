/**
 * 主进程单实例锁与全局异常守卫：
 * 1. 单实例锁（acquireSingleInstanceGuard）：防止外部自动化或重复启动拉起第二个同 userData 实例，
 *    避免抢占 ui-state.json / SQLite 会话目录库，并在二次拉起时唤醒既有主窗口。
 * 2. 全局异常与原生弹窗守卫（installMainProcessErrorGuard）：拦截 dialog.showErrorBox 并接管
 *    uncaughtException / unhandledRejection，按错误签名做 60s 时间窗去重限流，彻底阻止主进程
 *    原生阻塞报错弹窗风暴。
 */

export interface ErrorGuardLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

export interface ErrorBoxDialogLike {
	showErrorBox(title: string, content: string): void;
}

export interface ProcessErrorEmitterLike {
	on(event: "uncaughtException", listener: (error: Error, origin?: string) => void): unknown;
	on(event: "unhandledRejection", listener: (reason: unknown, promise?: Promise<unknown>) => void): unknown;
	off?(event: "uncaughtException", listener: (error: Error, origin?: string) => void): unknown;
	off?(event: "unhandledRejection", listener: (reason: unknown, promise?: Promise<unknown>) => void): unknown;
	removeListener?(event: "uncaughtException", listener: (error: Error, origin?: string) => void): unknown;
	removeListener?(
		event: "unhandledRejection",
		listener: (reason: unknown, promise?: Promise<unknown>) => void,
	): unknown;
}

export type ErrorGuardEventKind = "uncaughtException" | "unhandledRejection" | "errorBox";

export interface ErrorGuardSummary {
	kind: ErrorGuardEventKind;
	signature: string;
	suppressed: number;
	total: number;
	windowMs: number;
}

export interface MainProcessErrorGuardDeps {
	dialog?: ErrorBoxDialogLike;
	process?: ProcessErrorEmitterLike;
	log: ErrorGuardLogger;
	/** 相同错误签名去重时间窗（默认 60s） */
	windowMs?: number;
	/** 签名表上限（FIFO 淘汰，默认 256） */
	maxSignatures?: number;
	/** 可注入时钟，方便单测 */
	now?: () => number;
	/** 是否开启周期汇总定时器（默认 true；unref 不阻止进程退出） */
	autoFlush?: boolean;
}

export interface MainProcessErrorGuardHandle {
	flush(options?: { force?: boolean }): ErrorGuardSummary[];
	dispose(): void;
}

export interface SingleInstanceWindowLike {
	isDestroyed(): boolean;
	isMinimized(): boolean;
	restore(): void;
	show(): void;
	focus(): void;
}

export interface SingleInstanceAppLike {
	requestSingleInstanceLock(): boolean;
	on(event: "second-instance", listener: () => void): unknown;
	exit(exitCode?: number): void;
}

export interface SingleInstanceGuardDeps {
	app: SingleInstanceAppLike;
	getWindows: () => readonly SingleInstanceWindowLike[];
	log: ErrorGuardLogger;
	/** 未获锁退出前回调（如 markQuitting），防止 close 拦截干扰退出 */
	onBeforeExit?: () => void;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_SIGNATURES = 256;
const MAX_FIELD_LEN = 200;

interface DedupEntry {
	kind: ErrorGuardEventKind;
	signature: string;
	windowStartAt: number;
	suppressed: number;
	total: number;
}

/** 按进程实例维度幂等注册，防止重复挂载监听或二次包装 dialog.showErrorBox */
const installedGuards = new WeakMap<ProcessErrorEmitterLike, MainProcessErrorGuardHandle>();

function extractTopStackFrame(stack: string | undefined): string {
	if (!stack) return "";
	const lines = stack.split(/\r?\n/);
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		if (trimmed.startsWith("at ")) return trimmed.slice(0, MAX_FIELD_LEN);
	}
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		if (trimmed.length > 0) return trimmed.slice(0, MAX_FIELD_LEN);
	}
	return "";
}

function safeSerialize(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// 循环引用或 BigInt 等回退 String()
	}
	try {
		return String(value);
	} catch {
		return "[unserializable]";
	}
}

/** 构建错误签名：name + message + 首帧调用栈 */
export function buildErrorSignature(error: unknown): string {
	if (error instanceof Error) {
		const name = (error.name || "Error").slice(0, MAX_FIELD_LEN);
		const message = (error.message || "").slice(0, MAX_FIELD_LEN);
		const topFrame = extractTopStackFrame(error.stack);
		return `${name}|${message}|${topFrame}`;
	}
	if (error && typeof error === "object") {
		const record = error as { name?: unknown; message?: unknown; stack?: unknown };
		if (typeof record.name === "string" || typeof record.message === "string") {
			const name = (typeof record.name === "string" && record.name ? record.name : "ErrorLike").slice(
				0,
				MAX_FIELD_LEN,
			);
			const message = (typeof record.message === "string" ? record.message : "").slice(0, MAX_FIELD_LEN);
			const topFrame = typeof record.stack === "string" ? extractTopStackFrame(record.stack) : "";
			return `${name}|${message}|${topFrame}`;
		}
	}
	const typeName = error === null ? "Null" : typeof error;
	const message = safeSerialize(error).slice(0, MAX_FIELD_LEN);
	return `${typeName}|${message}|`;
}

function formatErrorPayload(error: unknown, origin?: string): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name || "Error",
			message: error.message,
			stack: error.stack,
			...(origin ? { origin } : {}),
		};
	}
	return {
		reason: safeSerialize(error),
		...(origin ? { origin } : {}),
	};
}

function patchDialogShowErrorBox(
	dialog: ErrorBoxDialogLike,
	replacement: (title: string, content: string) => void,
	log: ErrorGuardLogger,
): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(dialog, "showErrorBox");
	const original = dialog.showErrorBox;
	let patched = false;
	try {
		dialog.showErrorBox = replacement;
		patched = true;
	} catch {
		try {
			Object.defineProperty(dialog, "showErrorBox", {
				value: replacement,
				configurable: true,
				writable: true,
			});
			patched = true;
		} catch (error) {
			log.warn("failed to patch dialog.showErrorBox", error);
		}
	}
	return () => {
		if (!patched) return;
		try {
			if (descriptor) {
				Object.defineProperty(dialog, "showErrorBox", descriptor);
			} else {
				dialog.showErrorBox = original;
			}
		} catch {
			// 恢复失败不影响退出
		}
	};
}

function removeProcessListener(
	proc: ProcessErrorEmitterLike,
	event: "uncaughtException",
	listener: (error: Error, origin?: string) => void,
): void;
function removeProcessListener(
	proc: ProcessErrorEmitterLike,
	event: "unhandledRejection",
	listener: (reason: unknown, promise?: Promise<unknown>) => void,
): void;
function removeProcessListener(
	proc: ProcessErrorEmitterLike,
	event: "uncaughtException" | "unhandledRejection",
	listener:
		| ((error: Error, origin?: string) => void)
		| ((reason: unknown, promise?: Promise<unknown>) => void),
): void {
	if (event === "uncaughtException") {
		const fn = listener as (error: Error, origin?: string) => void;
		if (proc.off) proc.off(event, fn);
		else proc.removeListener?.(event, fn);
	} else {
		const fn = listener as (reason: unknown, promise?: Promise<unknown>) => void;
		if (proc.off) proc.off(event, fn);
		else proc.removeListener?.(event, fn);
	}
}

/**
 * 安装主进程全局异常守卫（幂等）：
 * - 拦截 dialog.showErrorBox，阻止 Electron 弹出阻塞式原生报错弹窗；
 * - 注册 process uncaughtException / unhandledRejection 处理器并按签名做时间窗去重汇总。
 */
export function installMainProcessErrorGuard(deps: MainProcessErrorGuardDeps): MainProcessErrorGuardHandle {
	const proc: ProcessErrorEmitterLike = deps.process ?? process;
	const existing = installedGuards.get(proc);
	if (existing) return existing;

	const windowMs = Math.max(1, deps.windowMs ?? DEFAULT_WINDOW_MS);
	const maxSignatures = Math.max(1, deps.maxSignatures ?? DEFAULT_MAX_SIGNATURES);
	const now = deps.now ?? (() => Date.now());
	const { log } = deps;

	const entries = new Map<string, DedupEntry>();
	let disposed = false;

	const emitSummary = (entry: DedupEntry): ErrorGuardSummary => {
		const summary: ErrorGuardSummary = {
			kind: entry.kind,
			signature: entry.signature,
			suppressed: entry.suppressed,
			total: entry.total,
			windowMs,
		};
		log.error("main process error repeated", summary);
		return summary;
	};

	const observe = (kind: ErrorGuardEventKind, signature: string, emitFirst: () => void): void => {
		try {
			const ts = now();
			const key = `${kind}:${signature}`;
			const entry = entries.get(key);
			if (!entry) {
				if (entries.size >= maxSignatures) {
					const oldestKey = entries.keys().next().value;
					if (oldestKey !== undefined) {
						const oldest = entries.get(oldestKey);
						if (oldest && oldest.suppressed > 0) emitSummary(oldest);
						entries.delete(oldestKey);
					}
				}
				entries.set(key, { kind, signature, windowStartAt: ts, suppressed: 0, total: 1 });
				emitFirst();
				return;
			}
			if (ts - entry.windowStartAt >= windowMs) {
				if (entry.suppressed > 0) emitSummary(entry);
				entry.windowStartAt = ts;
				entry.suppressed = 0;
				entry.total += 1;
				emitFirst();
				return;
			}
			entry.suppressed += 1;
			entry.total += 1;
		} catch {
			// 全局错误守卫自身绝不二次抛出
		}
	};

	const flush = (options?: { force?: boolean }): ErrorGuardSummary[] => {
		const summaries: ErrorGuardSummary[] = [];
		try {
			const ts = now();
			const force = options?.force === true;
			for (const [key, entry] of entries) {
				const expired = ts - entry.windowStartAt >= windowMs;
				if (!force && !expired) continue;
				if (entry.suppressed > 0) {
					summaries.push(emitSummary(entry));
					entry.suppressed = 0;
					entry.windowStartAt = ts;
				} else if (expired) {
					entries.delete(key);
				}
			}
		} catch {
			// flush 失败不影响主流程
		}
		return summaries;
	};

	const onUncaughtException = (error: Error, origin?: string): void => {
		const signature = buildErrorSignature(error);
		observe("uncaughtException", signature, () => {
			log.error("uncaughtException", formatErrorPayload(error, origin));
		});
	};

	const onUnhandledRejection = (reason: unknown): void => {
		const signature = buildErrorSignature(reason);
		observe("unhandledRejection", signature, () => {
			log.error("unhandledRejection", formatErrorPayload(reason));
		});
	};

	proc.on("uncaughtException", onUncaughtException);
	proc.on("unhandledRejection", onUnhandledRejection);

	const restoreDialog = deps.dialog
		? patchDialogShowErrorBox(
				deps.dialog,
				(title: string, content: string) => {
					const signature = `${String(title).slice(0, MAX_FIELD_LEN)}|${String(content).slice(0, MAX_FIELD_LEN)}`;
					observe("errorBox", signature, () => {
						log.error("suppressed native error box", { title, content });
					});
				},
				log,
			)
		: undefined;

	let timer: ReturnType<typeof setInterval> | undefined;
	if (deps.autoFlush !== false) {
		timer = setInterval(() => {
			flush();
		}, windowMs);
		timer.unref?.();
	}

	const handle: MainProcessErrorGuardHandle = {
		flush,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			removeProcessListener(proc, "uncaughtException", onUncaughtException);
			removeProcessListener(proc, "unhandledRejection", onUnhandledRejection);
			restoreDialog?.();
			entries.clear();
			installedGuards.delete(proc);
		},
	};

	installedGuards.set(proc, handle);
	return handle;
}

/**
 * 申请单实例锁：
 * - 返回 false：已有同 userData 实例在运行，记录简洁日志并立即退出，调用方须跳过后续初始化；
 * - 返回 true：持锁成功并绑定 second-instance 唤醒既有主窗口。
 */
export function acquireSingleInstanceGuard(deps: SingleInstanceGuardDeps): boolean {
	const { app, getWindows, log, onBeforeExit } = deps;
	if (!app.requestSingleInstanceLock()) {
		log.info("another instance is already running, exiting duplicate instance");
		onBeforeExit?.();
		app.exit(0);
		return false;
	}

	app.on("second-instance", () => {
		const win = getWindows().find((candidate) => !candidate.isDestroyed());
		if (!win) return;
		try {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		} catch (error) {
			log.warn("failed to focus existing window on second-instance", error);
		}
	});
	return true;
}
