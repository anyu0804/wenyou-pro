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
			// 循环引用或恶意 toJSON 时回落 String()
		}
	}
	try {
		return String(reason);
	} catch {
		return "[unserializable]";
	}
}

/**
 * 安装渲染进程全局未捕获错误与未捕获 Promise rejection 转发器：
 * 将完整堆栈拼成单条模板字符串经 `console.error` 输出，避免 Chromium `DidAddMessageToConsole`
 * 在多参数无占位符调用时丢弃后续参数，确保主进程 `console-message` 守卫完整落盘。
 * 同一 target 重复调用保持幂等；返回幂等卸载函数。
 */
export function installRendererGlobalErrorForwarding(
	target: RendererErrorForwardingTarget = window,
	logger: RendererErrorLogger = console,
): () => void {
	const existing = installedDisposers.get(target);
	if (existing) return existing;

	let forwarding = false;

	const onError = (event: ErrorEvent) => {
		if (forwarding) return;
		forwarding = true;
		try {
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
			logger.error(`[renderer-uncaught-error] ${summary}`);
		} catch {
			// 防止 logger.error 自身抛错或异常事件 getter 触发二次未捕获异常循环
		} finally {
			forwarding = false;
		}
	};

	const onUnhandledRejection = (event: PromiseRejectionEvent) => {
		if (forwarding) return;
		forwarding = true;
		try {
			const summary = formatUnknownReason(event.reason);
			logger.error(`[renderer-unhandled-rejection] ${summary}`);
		} catch {
			// 防止 logger.error 自身抛错引发二次未捕获异常循环
		} finally {
			forwarding = false;
		}
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
