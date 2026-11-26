import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { extractHtmlTitle, parseLoopbackProbeUrl, probeLocalSandbox } from "./wenyou-sandbox-probe";

const activeServers: Server[] = [];

async function startTempServer(handler: RequestListener): Promise<{ url: string; server: Server }> {
	const server = createServer(handler);
	activeServers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const addr = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${addr.port}`, server };
}

afterEach(async () => {
	while (activeServers.length > 0) {
		const srv = activeServers.pop();
		if (srv?.listening) {
			await new Promise<void>((resolve) => srv.close(() => resolve()));
		}
	}
});

describe("wenyou-sandbox-probe", () => {
	it("parseLoopbackProbeUrl 仅放行本机回环 http:// 地址，拒绝外网与非 http 协议", () => {
		expect(parseLoopbackProbeUrl("http://127.0.0.1:5173")?.hostname).toBe("127.0.0.1");
		expect(parseLoopbackProbeUrl("http://localhost:5174/")?.hostname).toBe("localhost");
		expect(parseLoopbackProbeUrl("http://[::1]:5173")).not.toBeNull();

		expect(parseLoopbackProbeUrl("https://127.0.0.1:5173")).toBeNull();
		expect(parseLoopbackProbeUrl("http://example.com:5173")).toBeNull();
		expect(parseLoopbackProbeUrl("http://192.168.1.2:5173")).toBeNull();
		expect(parseLoopbackProbeUrl("file:///etc/passwd")).toBeNull();
		expect(parseLoopbackProbeUrl("not-a-url")).toBeNull();
	});

	it("extractHtmlTitle 提取并折叠标题空白，缺失时返回 undefined", () => {
		expect(extractHtmlTitle("<html><head><title>  Wenyou  Pixi\n v0.9.1 </title></head></html>")).toBe(
			"Wenyou Pixi v0.9.1",
		);
		expect(extractHtmlTitle("<html><body>no title</body></html>")).toBeUndefined();
	});

	it("probeLocalSandbox 成功探测本地回环 HTTP 服务并提取标题与状态码", async () => {
		const { url } = await startTempServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<!doctype html><html><head><title>Wenyou Pixi Sandbox v0.9.1</title></head><body>ok</body></html>");
		});

		const result = await probeLocalSandbox(url, 800);
		expect(result.reachable).toBe(true);
		expect(result.statusCode).toBe(200);
		expect(result.title).toBe("Wenyou Pixi Sandbox v0.9.1");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("probeLocalSandbox 对 5xx 响应标记为不可用并回传状态码", async () => {
		const { url } = await startTempServer((_req, res) => {
			res.writeHead(503, { "Content-Type": "text/plain" });
			res.end("unavailable");
		});

		const result = await probeLocalSandbox(url, 800);
		expect(result.reachable).toBe(false);
		expect(result.statusCode).toBe(503);
		expect(result.error).toBe("HTTP 503");
	});

	it("probeLocalSandbox 在端口未监听或超时时快速返回不可达而非抛错", async () => {
		// 先占一个端口再立刻关闭，确保端口当前未监听
		const { url, server } = await startTempServer((_req, res) => res.end("ok"));
		await new Promise<void>((resolve) => server.close(() => resolve()));

		const closedResult = await probeLocalSandbox(url, 500);
		expect(closedResult.reachable).toBe(false);
		expect(closedResult.error).toBeTruthy();

		const { url: slowUrl } = await startTempServer((_req, res) => {
			const timer = setTimeout(() => {
				if (!res.destroyed) {
					res.writeHead(200);
					res.end("late");
				}
			}, 600);
			res.on("close", () => clearTimeout(timer));
		});

		const timeoutResult = await probeLocalSandbox(slowUrl, 120);
		expect(timeoutResult.reachable).toBe(false);
		expect(timeoutResult.error).toBe("连接超时");
	});

	it("probeLocalSandbox 拒绝非回环地址且零网络耗时", async () => {
		const result = await probeLocalSandbox("https://example.com");
		expect(result.reachable).toBe(false);
		expect(result.latencyMs).toBe(0);
		expect(result.error).toContain("回环");
	});
});
