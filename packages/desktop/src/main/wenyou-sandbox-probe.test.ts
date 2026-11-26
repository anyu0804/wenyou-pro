import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { extractHtmlTitle, parseSandboxProbeUrl, probeLocalSandbox } from "./wenyou-sandbox-probe";

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
	it("parseSandboxProbeUrl 放行内置 wenyou-sandbox://app 与任意有效 http:// / https://（含局域网），拒绝非法协议", () => {
		expect(parseSandboxProbeUrl("http://127.0.0.1:5173")?.hostname).toBe("127.0.0.1");
		expect(parseSandboxProbeUrl("http://localhost:5174/")?.hostname).toBe("localhost");
		expect(parseSandboxProbeUrl("http://[::1]:5173")).not.toBeNull();
		expect(parseSandboxProbeUrl("http://192.168.1.2:5173")?.hostname).toBe("192.168.1.2");
		expect(parseSandboxProbeUrl("https://192.168.1.2:8443/map")?.protocol).toBe("https:");
		expect(parseSandboxProbeUrl("https://sandbox.example.local:5173")?.hostname).toBe("sandbox.example.local");
		expect(parseSandboxProbeUrl("wenyou-sandbox://app/index.html")?.protocol).toBe("wenyou-sandbox:");

		expect(parseSandboxProbeUrl("wenyou-sandbox://evil/index.html")).toBeNull();
		expect(parseSandboxProbeUrl("file:///etc/passwd")).toBeNull();
		expect(parseSandboxProbeUrl("ftp://192.168.1.2:21")).toBeNull();
		expect(parseSandboxProbeUrl("javascript:alert(1)")).toBeNull();
		expect(parseSandboxProbeUrl("not-a-url")).toBeNull();
	});

	it("extractHtmlTitle 提取并折叠标题空白，缺失时返回 undefined", () => {
		expect(extractHtmlTitle("<html><head><title>  Wenyou  Pixi\n v0.9.1 </title></head></html>")).toBe(
			"Wenyou Pixi v0.9.1",
		);
		expect(extractHtmlTitle("<html><body>no title</body></html>")).toBeUndefined();
	});

	it("probeLocalSandbox 成功探测 HTTP 服务并提取标题与状态码", async () => {
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

	it("probeLocalSandbox 对内置 wenyou-sandbox://app 零网络开销直接返回可达", async () => {
		const result = await probeLocalSandbox("wenyou-sandbox://app/index.html");
		expect(result.reachable).toBe(true);
		expect(result.statusCode).toBe(200);
		expect(result.latencyMs).toBe(0);
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

	it("probeLocalSandbox 拒绝非 http(s)/wenyou-sandbox 协议且零网络耗时", async () => {
		const result = await probeLocalSandbox("file:///etc/passwd");
		expect(result.reachable).toBe(false);
		expect(result.latencyMs).toBe(0);
		expect(result.error).toContain("http://");
	});

	it("probeLocalSandbox 在底层 requestFn 同步抛错时稳定返回不可达结果而非 reject", async () => {
		const throwingRequest = (() => {
			throw new Error("ERR_INVALID_SYNC_OPTIONS");
		}) as unknown as Parameters<typeof probeLocalSandbox>[2];

		const result = await probeLocalSandbox("http://192.168.1.25:4173/", 500, throwingRequest);
		expect(result.reachable).toBe(false);
		expect(result.url).toBe("http://192.168.1.25:4173/");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(result.error).toBe("ERR_INVALID_SYNC_OPTIONS");
	});
});
