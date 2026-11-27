export type RendererErrorForwardingTarget = Pick<Window, "addEventListener" | "removeEventListener">;
export type RendererErrorLogger = Pick<Console, "error">;

const installedDisposers = new WeakMap<RendererErrorForwardingTarget, () => void>();

const BENIGN_ERROR_PATTERNS = [/^ResizeObserver loop\b/i];

function formatLocation(filename?: string, lineno?: number, colno?: number): string {
	if (filename) {
		if (lineno && colno) return `${filename}:${lineno}:${colno}`;
		if (lineno) return `${filename}:${lineno}`;
		return filename;
	}
	if (lineno) {
		return colno ? `<anonymous>:${lineno}:${colno}` : `<anonymous>:${lineno}`;
	}
	return "";
}

function formatUnknownReason(reason: unknown): string {
	if (reason instanceof Error) {
		return reason.stack || reason.message || reason.name;
	}
	if (typeof reason === "object" && reason !== null) {
		try {
			const json = JSON.stringify(reason);
			if (json && json !== "{}") return json;
		} catch {
			// 循环引用时回落 String()
		}
	}
	return String(reason);
}

/**
 * 安装渲染进程全局未捕获错误与未捕获 Promise rejection 转发器：
 * 将完整堆栈经 `console.error` 输出，确保主进程 `console-message` 守卫将其稳定落盘到日志文件。
 * 同一 target 重复调用保持幂等；返回幂等卸载函数。
 */
export function installRendererGlobalErrorForwarding(
	target: RendererErrorForwardingTarget = window,
	logger: RendererErrorLogger = console,
): () => void {
	const existing = installedDisposers.get(target);
	if (existing) return existing;

	const onError = (event: ErrorEvent) => {
		const err = event.error;
		const rawMessage = event.message?.trim() || (err instanceof Error ? err.message : "");
		if (rawMessage && BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(rawMessage))) {
			return;
		}

		const detail =
			err instanceof Error
				? err.stack || err.message || err.name
				: err !== undefined && err !== null
					? formatUnknownReason(err)
					: event.message?.trim() || "";
		const location = formatLocation(event.filename, event.lineno, event.colno);
		if (!detail && !location) return;

		const summary = location ? `${detail || "Uncaught error"} (${location})` : detail;
		logger.error("[renderer-uncaught-error]", summary);
	};

	const onUnhandledRejection = (event: PromiseRejectionEvent) => {
		const summary = formatUnknownReason(event.reason);
		logger.error("[renderer-unhandled-rejection]", summary);
	};

	target.addEventListener("error", onError);
	target.addEventListener("unhandledrejection", onUnhandledRejection);

	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		target.removeEventListener("error", onError);
		target.removeEventListener("unhandledrejection", onUnhandledRejection);
		if (installedDisposers.get(target) === dispose) {
			installedDisposers.delete(target);
		}
	};

	installedDisposers.set(target, dispose);
	return dispose;
}
