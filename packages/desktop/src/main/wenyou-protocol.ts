import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isPrivateVaultPath, normalizeVaultPath, resolveRealPathInsideWorkspace } from "@percho/backend";
import { WENYOU_ASSET_PROTOCOL } from "@percho/shared";
import { app, net, protocol } from "electron";

const ALLOWED_ASSET_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/** 随包文游技能目录：dev 态读 packages/desktop/resources/wenyou-skills，packaged 态读 resources/wenyou-skills */
export function wenyouSkillsDir(): string {
	return app.isPackaged
		? join(process.resourcesPath, "wenyou-skills")
		: join(__dirname, "../../resources/wenyou-skills");
}

/** 随包本机 NTQQ 只读 VFS 资源目录：dev 态读 packages/desktop/resources/ntqq-vfs，packaged 态读 resources/ntqq-vfs */
export function wenyouNtqqAssetsDir(): string {
	return app.isPackaged
		? join(process.resourcesPath, "ntqq-vfs")
		: join(__dirname, "../../resources/ntqq-vfs");
}

/**
 * 注册受工作区 realpath 白名单保护的 `wenyou-asset://` 协议：
 * URL 形态：`wenyou-asset://vault?cwd=<encoded>&path=<encoded>`
 * - 强校验 realpath 必须严格落在 realpath(cwd) 内，防 `..` 与符号链接穿越
 * - 禁止访问 private/ 与 .wenyou/ 内部文件
 * - 仅放行静态地图/图集扩展名，零拷贝流式返回高清大图
 */
export function registerWenyouAssetProtocolHandler(): void {
	protocol.handle(WENYOU_ASSET_PROTOCOL, async (request) => {
		try {
			const url = new URL(request.url);
			const cwd = url.searchParams.get("cwd")?.trim();
			const rawPath = url.searchParams.get("path")?.trim();
			if (!cwd || !rawPath) {
				return new Response("missing cwd or path", { status: 400 });
			}
			const normalized = normalizeVaultPath(rawPath);
			if (!normalized || normalized.split("/").includes("..") || isPrivateVaultPath(normalized)) {
				return new Response("forbidden asset path", { status: 403 });
			}
			const ext = extname(normalized).toLowerCase();
			if (!ALLOWED_ASSET_EXTS.has(ext)) {
				return new Response("unsupported asset extension", { status: 400 });
			}
			const realTarget = await resolveRealPathInsideWorkspace(cwd, normalized);
			return net.fetch(pathToFileURL(realTarget).toString());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === "ENOENT") return new Response("asset not found", { status: 404 });
			return new Response(error instanceof Error ? error.message : "asset access denied", { status: 403 });
		}
	});
}
