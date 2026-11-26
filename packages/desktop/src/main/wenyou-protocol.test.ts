import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWenyouAssetUrl } from "@percho/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { isPackaged: false },
	net: { fetch: vi.fn() },
	protocol: { handle: vi.fn() },
}));

import {
	createWorkspaceAllowlistChecker,
	handleWenyouAssetRequest,
	handleWenyouSandboxRequest,
} from "./wenyou-protocol";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "wenyou-protocol-test-"));
	tempDirs.push(dir);
	await mkdir(join(dir, "05-沙盘与图集"), { recursive: true });
	await mkdir(join(dir, "private"), { recursive: true });
	await mkdir(join(dir, ".wenyou"), { recursive: true });
	return dir;
}

const localFileFetcher = async (fileUrl: string): Promise<Response> => {
	const data = await readFile(fileURLToPath(fileUrl));
	// 故意模拟 Windows 注册表返回错误 MIME，验证协议层是否强制覆写
	return new Response(new Uint8Array(data), {
		status: 200,
		headers: { "Content-Type": "text/plain" },
	});
};

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("wenyou-protocol (wenyou-asset://)", () => {
	it("为 .svg/.png/.webp 显式覆写标准 MIME 与安全响应头并支持带 v 版本参数的 URL", async () => {
		const cwd = await makeTempWorkspace();
		const svgBody = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
		const pngBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const webpBody = Buffer.from("RIFF\x00\x00\x00\x00WEBP");

		await writeFile(join(cwd, "05-沙盘与图集", "campaign.svg"), svgBody, "utf8");
		await writeFile(join(cwd, "05-沙盘与图集", "front.png"), pngBody);
		await writeFile(join(cwd, "05-沙盘与图集", "theater.webp"), webpBody);

		const svgRes = await handleWenyouAssetRequest(
			{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/campaign.svg", 1700000001), method: "GET" },
			localFileFetcher,
		);
		expect(svgRes.status).toBe(200);
		expect(svgRes.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
		expect(svgRes.headers.get("access-control-allow-origin")).toBe("wenyou-sandbox://app");
		expect(svgRes.headers.get("vary")).toBe("Origin");
		expect(svgRes.headers.get("x-content-type-options")).toBe("nosniff");
		expect(svgRes.headers.get("cache-control")).toBe("no-cache");
		expect(await svgRes.text()).toBe(svgBody);

		const pngRes = await handleWenyouAssetRequest(
			{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/front.png", 1700000002), method: "HEAD" },
			localFileFetcher,
		);
		expect(pngRes.status).toBe(200);
		expect(pngRes.headers.get("content-type")).toBe("image/png");
		expect(pngRes.headers.get("access-control-allow-origin")).toBe("wenyou-sandbox://app");
		expect(pngRes.headers.get("vary")).toBe("Origin");
		expect(pngRes.headers.get("content-length")).toBe(String(pngBody.length));
		expect(await pngRes.text()).toBe("");

		const webpRes = await handleWenyouAssetRequest(
			{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/theater.webp"), method: "GET" },
			localFileFetcher,
		);
		expect(webpRes.status).toBe(200);
		expect(webpRes.headers.get("content-type")).toBe("image/webp");
	});

	it("仅放行 GET / HEAD，拒绝 POST/DELETE", async () => {
		const cwd = await makeTempWorkspace();
		const res = await handleWenyouAssetRequest(
			{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/a.png"), method: "POST" },
			localFileFetcher,
		);
		expect(res.status).toBe(405);
	});

	it("拦截路径穿越、private/.wenyou 目录、非图片后缀、目录伪装与不存在文件", async () => {
		const cwd = await makeTempWorkspace();
		await writeFile(join(cwd, "private", "secret.png"), Buffer.from("secret"));
		await writeFile(join(cwd, ".wenyou", "internal.png"), Buffer.from("internal"));
		await writeFile(join(cwd, "05-沙盘与图集", "notes.json"), "{}");
		await mkdir(join(cwd, "05-沙盘与图集", "dir-as-image.png"), { recursive: true });

		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, "../outside.png"), method: "GET" },
					localFileFetcher,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, "private/secret.png"), method: "GET" },
					localFileFetcher,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, ".wenyou/internal.png"), method: "GET" },
					localFileFetcher,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/notes.json"), method: "GET" },
					localFileFetcher,
				)
			).status,
		).toBe(400);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/dir-as-image.png"), method: "GET" },
					localFileFetcher,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/missing.png"), method: "GET" },
					localFileFetcher,
				)
			).status,
		).toBe(404);
	});

	it("阻断工作区内指向 private/ 或工作区外的符号链接绕过", async () => {
		const cwd = await makeTempWorkspace();
		const outsideDir = await mkdtemp(join(tmpdir(), "wenyou-protocol-outside-"));
		tempDirs.push(outsideDir);

		const privateImg = join(cwd, "private", "gm-secret.png");
		const outsideImg = join(outsideDir, "outside.png");
		await writeFile(privateImg, Buffer.from("gm-only"));
		await writeFile(outsideImg, Buffer.from("outside"));

		const linkToPrivate = join(cwd, "05-沙盘与图集", "leak-private.png");
		const linkToOutside = join(cwd, "05-沙盘与图集", "leak-outside.png");
		let symlinkCreated = false;
		try {
			await symlink(privateImg, linkToPrivate, "file");
			await symlink(outsideImg, linkToOutside, "file");
			symlinkCreated = true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "EPERM" && code !== "EACCES") throw error;
		}

		if (symlinkCreated) {
			expect(
				(
					await handleWenyouAssetRequest(
						{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/leak-private.png"), method: "GET" },
						localFileFetcher,
					)
				).status,
			).toBe(403);
			expect(
				(
					await handleWenyouAssetRequest(
						{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/leak-outside.png"), method: "GET" },
						localFileFetcher,
					)
				).status,
			).toBe(403);
		} else {
			// Windows 非提权环境下用目录联结（junction）验证同类 realpath 越界拦截
			const junctionToPrivate = join(cwd, "05-沙盘与图集", "priv-junction");
			await symlink(join(cwd, "private"), junctionToPrivate, "junction");
			expect(
				(
					await handleWenyouAssetRequest(
						{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/priv-junction/gm-secret.png"), method: "GET" },
						localFileFetcher,
					)
				).status,
			).toBe(403);
		}
	});

	it("校验协议与主机名、拦截以 private/.wenyou 为 cwd 的绕过、校验工作区白名单并精确回显 CORS Origin", async () => {
		const cwd = await makeTempWorkspace();
		const worldsParent = await mkdtemp(join(tmpdir(), "wenyou-worlds-parent-"));
		tempDirs.push(worldsParent);
		const worldCampaign = join(worldsParent, "shuntang");
		await mkdir(join(worldCampaign, "05-沙盘与图集"), { recursive: true });
		await mkdir(join(worldCampaign, "private", "nested"), { recursive: true });
		await mkdir(join(worldCampaign, ".wenyou"), { recursive: true });
		await writeFile(join(worldCampaign, "manifest.json"), '{"worldId":"w1"}', "utf8");
		await writeFile(join(worldCampaign, "05-沙盘与图集", "map.png"), Buffer.from("png-data"));
		await writeFile(join(worldCampaign, "private", "secret.png"), Buffer.from("secret"));
		await writeFile(join(worldCampaign, "private", "nested", "deep.png"), Buffer.from("deep"));
		await writeFile(join(worldCampaign, ".wenyou", "internal.png"), Buffer.from("internal"));
		await writeFile(join(cwd, "05-沙盘与图集", "ok.png"), Buffer.from("ok-png"));

		// 非法协议与非法 host 拦截
		expect(
			(
				await handleWenyouAssetRequest(
					{
						url: `http://vault?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("05-沙盘与图集/ok.png")}`,
						method: "GET",
					},
					localFileFetcher,
				)
			).status,
		).toBe(400);
		expect(
			(
				await handleWenyouAssetRequest(
					{
						url: `wenyou-asset://evil?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent("05-沙盘与图集/ok.png")}`,
						method: "GET",
					},
					localFileFetcher,
				)
			).status,
		).toBe(403);

		// 将 private / .wenyou / private/nested 直接作为 cwd 传入时一律 403
		for (const [badCwd, rel] of [
			[join(worldCampaign, "private"), "secret.png"],
			[join(worldCampaign, ".wenyou"), "internal.png"],
			[join(worldCampaign, "private", "nested"), "deep.png"],
		] as const) {
			const res = await handleWenyouAssetRequest(
				{ url: buildWenyouAssetUrl(badCwd, rel), method: "GET" },
				localFileFetcher,
			);
			expect(res.status).toBe(403);
			expect(await res.text()).toContain("forbidden asset workspace");
		}

		// 工作区白名单：放行 exactRoots 与 parentRoots 子战役目录，拒绝未登记外部目录及 parentRoots 本身
		const unrelated = await mkdtemp(join(tmpdir(), "wenyou-unrelated-"));
		tempDirs.push(unrelated);
		await writeFile(join(unrelated, "leak.png"), Buffer.from("leak"));
		await writeFile(join(worldsParent, "parent-root.png"), Buffer.from("root"));

		const isAllowedWorkspace = createWorkspaceAllowlistChecker(() => ({
			exactRoots: [cwd],
			parentRoots: [worldsParent],
		}));

		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/ok.png"), method: "GET" },
					localFileFetcher,
					{ isAllowedWorkspace },
				)
			).status,
		).toBe(200);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(worldCampaign, "05-沙盘与图集/map.png"), method: "GET" },
					localFileFetcher,
					{ isAllowedWorkspace },
				)
			).status,
		).toBe(200);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(unrelated, "leak.png"), method: "GET" },
					localFileFetcher,
					{ isAllowedWorkspace },
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouAssetRequest(
					{ url: buildWenyouAssetUrl(worldsParent, "parent-root.png"), method: "GET" },
					localFileFetcher,
					{ isAllowedWorkspace },
				)
			).status,
		).toBe(403);

		// CORS Origin 精确回显校验
		for (const allowedOrigin of [
			"wenyou-sandbox://app",
			"app://wenyou",
			"http://127.0.0.1:5173",
			"http://localhost:5174",
			"http://[::1]:5173",
		]) {
			const res = await handleWenyouAssetRequest(
				{
					url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/ok.png"),
					method: "HEAD",
					headers: new Headers({ Origin: allowedOrigin }),
				},
				localFileFetcher,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
			expect(res.headers.get("vary")).toBe("Origin");
		}

		// 非法外部 Origin 不回显 ACAO（防任意网页读取本地图集）
		const evilRes = await handleWenyouAssetRequest(
			{
				url: buildWenyouAssetUrl(cwd, "05-沙盘与图集/ok.png"),
				method: "HEAD",
				headers: new Headers({ Origin: "https://evil.example" }),
			},
			localFileFetcher,
		);
		expect(evilRes.status).toBe(200);
		expect(evilRes.headers.get("access-control-allow-origin")).toBeNull();
		expect(evilRes.headers.get("vary")).toBe("Origin");
	});
});

describe("wenyou-protocol (wenyou-sandbox://)", () => {
	async function makeTempSandboxRoot(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "wenyou-sandbox-proto-"));
		tempDirs.push(dir);
		await mkdir(join(dir, "assets"), { recursive: true });
		await writeFile(join(dir, "index.html"), "<!doctype html><html><body>sandbox</body></html>", "utf8");
		await writeFile(join(dir, "assets", "main.js"), "console.log('ok');", "utf8");
		await writeFile(join(dir, "assets", "worker.mjs"), "export const x = 1;", "utf8");
		await writeFile(join(dir, "assets", "style.css"), "body{margin:0}", "utf8");
		await writeFile(join(dir, "assets", "font.woff2"), Buffer.from("wOF2"));
		await writeFile(join(dir, "assets", "main.js.map"), '{"version":3}', "utf8");
		return dir;
	}

	it("将根路径重写为 index.html 并为 JS/MJS/CSS/WOFF2/MAP 等显式设置 MIME 与 nosniff", async () => {
		const root = await makeTempSandboxRoot();

		const rootRes = await handleWenyouSandboxRequest(
			{ url: "wenyou-sandbox://app/", method: "GET" },
			root,
			localFileFetcher,
		);
		expect(rootRes.status).toBe(200);
		expect(rootRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(rootRes.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await rootRes.text()).toContain("sandbox");

		const jsRes = await handleWenyouSandboxRequest(
			{ url: "wenyou-sandbox://app/assets/main.js", method: "GET" },
			root,
			localFileFetcher,
		);
		expect(jsRes.status).toBe(200);
		expect(jsRes.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

		const mjsRes = await handleWenyouSandboxRequest(
			{ url: "wenyou-sandbox://app/assets/worker.mjs", method: "HEAD" },
			root,
			localFileFetcher,
		);
		expect(mjsRes.status).toBe(200);
		expect(mjsRes.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await mjsRes.text()).toBe("");

		const cssRes = await handleWenyouSandboxRequest(
			{ url: "wenyou-sandbox://app/assets/style.css", method: "GET" },
			root,
			localFileFetcher,
		);
		expect(cssRes.headers.get("content-type")).toBe("text/css; charset=utf-8");

		const fontRes = await handleWenyouSandboxRequest(
			{ url: "wenyou-sandbox://app/assets/font.woff2", method: "GET" },
			root,
			localFileFetcher,
		);
		expect(fontRes.headers.get("content-type")).toBe("font/woff2");

		const mapRes = await handleWenyouSandboxRequest(
			{ url: "wenyou-sandbox://app/assets/main.js.map", method: "GET" },
			root,
			localFileFetcher,
		);
		expect(mapRes.headers.get("content-type")).toBe("application/json; charset=utf-8");
	});

	it("仅放行 GET/HEAD，拦截非法主机、路径穿越、越界符号链接与缺失文件", async () => {
		const root = await makeTempSandboxRoot();
		const outside = await mkdtemp(join(tmpdir(), "wenyou-sandbox-outside-"));
		tempDirs.push(outside);
		await writeFile(join(outside, "secret.txt"), "top-secret", "utf8");

		expect(
			(await handleWenyouSandboxRequest({ url: "wenyou-sandbox://app/index.html", method: "POST" }, root, localFileFetcher))
				.status,
		).toBe(405);
		expect(
			(await handleWenyouSandboxRequest({ url: "wenyou-sandbox://evil/index.html", method: "GET" }, root, localFileFetcher))
				.status,
		).toBe(404);
		expect(
			(
				await handleWenyouSandboxRequest(
					{ url: "wenyou-sandbox://app/../secret.txt", method: "GET" },
					root,
					localFileFetcher,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouSandboxRequest(
					{ url: "wenyou-sandbox://app/assets/%2e%2e/%2e%2e/secret.txt", method: "GET" },
					root,
					localFileFetcher,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleWenyouSandboxRequest(
					{ url: "wenyou-sandbox://app/assets/missing.js", method: "GET" },
					root,
					localFileFetcher,
				)
			).status,
		).toBe(404);

		// 验证符号链接或目录联结越界拦截
		const linkPath = join(root, "assets", "escape.txt");
		let fileLinkCreated = false;
		try {
			await symlink(join(outside, "secret.txt"), linkPath, "file");
			fileLinkCreated = true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "EPERM" && code !== "EACCES") throw error;
		}
		if (fileLinkCreated) {
			expect(
				(
					await handleWenyouSandboxRequest(
						{ url: "wenyou-sandbox://app/assets/escape.txt", method: "GET" },
						root,
						localFileFetcher,
					)
				).status,
			).toBe(403);
		} else {
			const junctionPath = join(root, "assets", "escape-dir");
			await symlink(outside, junctionPath, "junction");
			expect(
				(
					await handleWenyouSandboxRequest(
						{ url: "wenyou-sandbox://app/assets/escape-dir/secret.txt", method: "GET" },
						root,
						localFileFetcher,
					)
				).status,
			).toBe(403);
		}
	});
});
