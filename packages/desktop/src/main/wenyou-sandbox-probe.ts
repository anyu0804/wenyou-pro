import { request as httpRequest } from "node:http";
import type { SandboxProbeResult } from "@percho/shared";

const DEFAULT_TIMEOUT_MS = 800;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5000;
const MAX_PROBE_BYTES = 16 * 1024;

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 仅放行本机回环 http:// 地址，避免探测请求触碰外部网络或系统代理 */
export function parseLoopbackProbeUrl(rawUrl: string): URL | null {
	try {
		const parsed = new URL(rawUrl.trim());
		if (parsed.protocol !== "http:") return null;
		if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
		return parsed;
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
 * 使用 Node 原生 http.request（agent: false，直连回环、绕过系统代理/VPN）探测本机 Pixi 沙盘服务存活状态。
 */
export function probeLocalSandbox(rawUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SandboxProbeResult> {
	const trimmed = rawUrl.trim();
	const parsed = parseLoopbackProbeUrl(trimmed);
	if (!parsed) {
		return Promise.resolve({
			url: trimmed,
			reachable: false,
			latencyMs: 0,
			error: "仅允许探测本机回环 http:// 地址（127.0.0.1 / localhost）",
		});
	}

	const clampedTimeout = Number.isFinite(timeoutMs)
		? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)))
		: DEFAULT_TIMEOUT_MS;
	const startedAt = performance.now();
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	const port = parsed.port ? Number(parsed.port) : 80;
	const path = `${parsed.pathname || "/"}${parsed.search}`;

	return new Promise<SandboxProbeResult>((resolve) => {
		let settled = false;
		const finish = (result: SandboxProbeResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const req = httpRequest(
			{
				protocol: "http:",
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
	});
}
