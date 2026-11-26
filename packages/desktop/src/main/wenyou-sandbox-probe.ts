import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type SandboxProbeResult, WENYOU_SANDBOX_PROTOCOL } from "@percho/shared";

const DEFAULT_TIMEOUT_MS = 800;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5000;
const MAX_PROBE_BYTES = 16 * 1024;

/** 放行内置 `wenyou-sandbox://app` 或有效的 `http://` / `https://` 地址（含局域网 IP 与主机名） */
export function parseSandboxProbeUrl(rawUrl: string): URL | null {
	try {
		const parsed = new URL(rawUrl.trim());
		if (parsed.protocol === `${WENYOU_SANDBOX_PROTOCOL}:`) {
			return parsed.hostname.toLowerCase() === "app" ? parsed : null;
		}
		if ((parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname)) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

/** 从响应首段 HTML 提取 <title> 文本摘要 */
export function extractHtmlTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!match?.[1]) return undefined;
	const cleaned = match[1].replace(/\s+/g, " ").trim();
	return cleaned ? cleaned.slice(0, 80) : undefined;
}

/**
 * 探测 Pixi 沙盘地址存活状态：内置 `wenyou-sandbox://app` 直接返回可达；`http://` 与 `https://`（含局域网）使用 Node 原生直连探测。
 */
export function probeLocalSandbox(
	rawUrl: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	requestOverride?: typeof httpRequest,
): Promise<SandboxProbeResult> {
	const trimmed = rawUrl.trim();
	const parsed = parseSandboxProbeUrl(trimmed);
	if (!parsed) {
		return Promise.resolve({
			url: trimmed,
			reachable: false,
			latencyMs: 0,
			error: "仅允许探测有效的 http:// / https:// 或 wenyou-sandbox://app 地址",
		});
	}

	if (parsed.protocol === `${WENYOU_SANDBOX_PROTOCOL}:`) {
		return Promise.resolve({
			url: parsed.toString(),
			reachable: true,
			statusCode: 200,
			latencyMs: 0,
			title: "内置沙盘",
		});
	}

	const clampedTimeout = Number.isFinite(timeoutMs)
		? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)))
		: DEFAULT_TIMEOUT_MS;
	const startedAt = performance.now();
	const isHttps = parsed.protocol === "https:";
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
	const path = `${parsed.pathname || "/"}${parsed.search}`;
	const requestFn = requestOverride ?? (isHttps ? httpsRequest : httpRequest);

	return new Promise<SandboxProbeResult>((resolve) => {
		let settled = false;
		const finish = (result: SandboxProbeResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		try {
			const req = requestFn(
				{
					protocol: parsed.protocol,
					hostname: host,
					port,
					path,
					method: "GET",
					agent: false,
					timeout: clampedTimeout,
					headers: {
						Accept: "text/html, */*",
						Connection: "close",
					},
				},
				(res) => {
					const statusCode = res.statusCode ?? 0;
					const reachable = statusCode >= 200 && statusCode < 400;
					let collected = "";
					let bytesRead = 0;

					const finalizeResponse = () => {
						const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
						const title = extractHtmlTitle(collected);
						finish({
							url: parsed.toString(),
							reachable,
							statusCode,
							latencyMs,
							...(title ? { title } : {}),
							...(!reachable ? { error: `HTTP ${statusCode}` } : {}),
						});
					};

					res.on("data", (chunk: Buffer | string) => {
						const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
						const remaining = MAX_PROBE_BYTES - bytesRead;
						if (remaining > 0) {
							collected += buf.subarray(0, remaining).toString("utf8");
							bytesRead += Math.min(buf.length, remaining);
						}
						if (bytesRead >= MAX_PROBE_BYTES || /<\/title>/i.test(collected)) {
							res.destroy();
							finalizeResponse();
						}
					});

					res.on("end", finalizeResponse);
					res.on("close", finalizeResponse);
					res.on("error", () => finalizeResponse());
				},
			);

			req.on("timeout", () => {
				const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
				req.destroy();
				finish({
					url: parsed.toString(),
					reachable: false,
					latencyMs,
					error: "连接超时",
				});
			});

			req.on("error", (error: NodeJS.ErrnoException) => {
				const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
				finish({
					url: parsed.toString(),
					reachable: false,
					latencyMs,
					error: error.code || error.message || "连接失败",
				});
			});

			req.end();
		} catch (error) {
			const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
			const err = error as NodeJS.ErrnoException;
			finish({
				url: parsed.toString(),
				reachable: false,
				latencyMs,
				error: err?.code || err?.message || "连接失败",
			});
		}
	});
}
