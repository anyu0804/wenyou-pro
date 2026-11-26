import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPrivateVaultPath, normalizeVaultPath, resolveRealPathInsideWorkspace } from "@percho/backend";
import { WENYOU_ASSET_PROTOCOL, WENYOU_SANDBOX_PROTOCOL } from "@percho/shared";
import { app, net, protocol } from "electron";

export const WENYOU_ASSET_MIME_MAP: Readonly<Record<string, string>> = {
	".svg": "image/svg+xml; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

export const WENYOU_SANDBOX_MIME_MAP: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
};

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

/** 随包内置 Pixi 动态沙盘构建产物目录：dev 态读 packages/desktop/resources/pixi-sandbox，packaged 态读 resources/pixi-sandbox */
export function wenyouSandboxDir(): string {
	return app.isPackaged
		? join(process.resourcesPath, "pixi-sandbox")
		: join(__dirname, "../../resources/pixi-sandbox");
}

export type WenyouFileFetcher = (fileUrl: string) => Promise<Response>;

export type WenyouAssetRequest = Pick<Request, "url" | "method"> & {
	headers?: Pick<Headers, "get">;
};

/**
 * 拦截把战役内部私有目录（`<campaign>/private`、`<campaign>/.wenyou` 及其子目录）直接作为 `cwd` 传入的绕过尝试。
 */
export function isPrivateWorkspaceRoot(realRoot: string): boolean {
	const base = basename(realRoot).toLowerCase();
	if (base === "private" || base === ".wenyou") return true;

	let prev = realRoot;
	let cursor = dirname(realRoot);
	while (cursor && cursor !== prev) {
		if (existsSync(join(cursor, "manifest.json")) || existsSync(join(cursor, ".wenyou"))) {
			const rel = normalizeVaultPath(relative(cursor, realRoot));
			if (rel && isPrivateVaultPath(rel)) return true;
		}
		prev = cursor;
		cursor = dirname(cursor);
	}
	return false;
}

export function isAllowedCorsOrigin(origin: string): boolean {
	if (origin === "file://" || origin.startsWith("file://")) {
		return true;
	}
	try {
		const parsed = new URL(origin);
		if (parsed.protocol === `${WENYOU_SANDBOX_PROTOCOL}:`) {
			return parsed.hostname.toLowerCase() === "app";
		}
		if (parsed.protocol === "app:" || parsed.protocol === "file:") {
			return true;
		}
		if ((parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname)) {
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

function resolveCorsOriginHeader(request: WenyouAssetRequest): string | null {
	const rawOrigin = request.headers?.get?.("Origin") ?? request.headers?.get?.("origin");
	if (rawOrigin === null || rawOrigin === undefined || rawOrigin.trim() === "") {
		return `${WENYOU_SANDBOX_PROTOCOL}://app`;
	}
	const trimmed = rawOrigin.trim();
	return isAllowedCorsOrigin(trimmed) ? trimmed : null;
}

/**
 * 处理单次 `wenyou-asset://vault?cwd=<encoded>&path=<encoded>` 请求（纯逻辑可单测）：
 * 1. 仅放行 GET / HEAD，严格校验 `wenyou-asset:` 协议与 `vault` 主机；
 * 2. 路径归一与 pre-check 拒绝 `..` 及 `private/` / `.wenyou/`；
 * 3. 拦截 `cwd` 直接指向私有目录/内部目录的绕过尝试；
 * 4. `realpath` 解析后复检目标落在工作区内、真实相对路径不命中 `private/` / `.wenyou/`、扩展名合法且为常规文件；
 * 5. 透传文件流并显式覆写 MIME、精确 CORS Origin + `Vary: Origin`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-cache`。
 */
export async function handleWenyouAssetRequest(
	request: WenyouAssetRequest,
	fetchFile: WenyouFileFetcher = (fileUrl) => net.fetch(fileUrl),
): Promise<Response> {
	const method = (request.method || "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return new Response("method not allowed", { status: 405 });
	}
	try {
		const url = new URL(request.url);
		if (url.protocol !== `${WENYOU_ASSET_PROTOCOL}:`) {
			return new Response("invalid asset protocol", { status: 400 });
		}
		if (url.hostname.toLowerCase() !== "vault") {
			return new Response("invalid asset host", { status: 403 });
		}
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
		const mime = WENYOU_ASSET_MIME_MAP[ext];
		if (!mime) {
			return new Response("unsupported asset extension", { status: 400 });
		}

		const realRoot = await realpath(resolve(cwd));
		if (isPrivateWorkspaceRoot(realRoot)) {
			return new Response("forbidden asset workspace", { status: 403 });
		}

		const realTarget = await resolveRealPathInsideWorkspace(cwd, normalized);
		const realRel = normalizeVaultPath(relative(realRoot, realTarget));
		if (!realRel || realRel.split("/").includes("..") || isPrivateVaultPath(realRel)) {
			return new Response("forbidden asset path", { status: 403 });
		}
		const realMime = WENYOU_ASSET_MIME_MAP[extname(realTarget).toLowerCase()];
		if (!realMime) {
			return new Response("unsupported asset extension", { status: 403 });
		}
		const info = await stat(realTarget);
		if (!info.isFile()) {
			return new Response("asset is not a file", { status: 403 });
		}

		const corsOrigin = resolveCorsOriginHeader(request);
		const headers = new Headers({
			"Content-Type": realMime,
			"Vary": "Origin",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-cache",
			"Content-Length": String(info.size),
		});
		if (corsOrigin) {
			headers.set("Access-Control-Allow-Origin", corsOrigin);
		}

		if (method === "HEAD") {
			return new Response(null, { status: 200, headers });
		}

		const upstream = await fetchFile(pathToFileURL(realTarget).toString());
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return new Response("asset not found", { status: 404 });
		return new Response(error instanceof Error ? error.message : "asset access denied", { status: 403 });
	}
}

function hasRawTraversalSegment(rawUrl: string): boolean {
	const schemeEnd = rawUrl.indexOf("://");
	if (schemeEnd === -1) return false;
	const afterScheme = rawUrl.slice(schemeEnd + 3);
	const slashIdx = afterScheme.indexOf("/");
	if (slashIdx === -1) return false;
	let rawPath = afterScheme.slice(slashIdx);
	const queryIdx = rawPath.search(/[?#]/);
	if (queryIdx !== -1) rawPath = rawPath.slice(0, queryIdx);
	if (rawPath.includes("\\") || /%5c/i.test(rawPath) || /%00/.test(rawPath)) return true;
	return rawPath.split("/").some((seg) => {
		const lower = seg.toLowerCase();
		return lower === ".." || lower === "%2e%2e" || lower === "%2e." || lower === ".%2e";
	});
}

/**
 * 处理单次 `wenyou-sandbox://app/<pathname>` 请求（纯逻辑可单测）：
 * 1. 仅放行 GET / HEAD，主机限定 `app`；
 * 2. 拦截原始与解码后的 `..`、反斜杠与空字节，默认 `/` 重写为 `index.html`；
 * 3. 经 `realpath(rootDir)` 与 `realpath(candidate)` 二次校验严防符号链接越界，校验 `stat.isFile()`；
 * 4. 显式映射静态资源 MIME（含 `.js`/`.mjs` -> `text/javascript; charset=utf-8`）并附 `X-Content-Type-Options: nosniff`。
 */
export async function handleWenyouSandboxRequest(
	request: Pick<Request, "url" | "method">,
	rootDir: string = wenyouSandboxDir(),
	fetchFile: WenyouFileFetcher = (fileUrl) => net.fetch(fileUrl),
): Promise<Response> {
	const method = (request.method || "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		return new Response("method not allowed", { status: 405 });
	}
	if (hasRawTraversalSegment(request.url)) {
		return new Response("forbidden sandbox path", { status: 403 });
	}
	try {
		const url = new URL(request.url);
		if (url.protocol !== `${WENYOU_SANDBOX_PROTOCOL}:`) {
			return new Response("invalid sandbox protocol", { status: 400 });
		}
		if (url.hostname && url.hostname.toLowerCase() !== "app") {
			return new Response("unknown sandbox host", { status: 404 });
		}
		let decodedPathname: string;
		try {
			decodedPathname = decodeURIComponent(url.pathname || "/");
		} catch {
			return new Response("invalid pathname encoding", { status: 400 });
		}
		if (decodedPathname.includes("\0") || decodedPathname.includes("\\")) {
			return new Response("forbidden sandbox path", { status: 403 });
		}
		const trimmed = decodedPathname.replace(/^\/+/, "");
		const relCandidate = !trimmed || trimmed.endsWith("/") ? `${trimmed}index.html` : trimmed;
		const segments = relCandidate.split("/").filter(Boolean);
		if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
			return new Response("forbidden sandbox path", { status: 403 });
		}

		const realRoot = await realpath(resolve(rootDir));
		const candidate = resolve(realRoot, segments.join("/"));
		const preRel = relative(realRoot, candidate);
		if (!preRel || preRel === ".." || preRel.startsWith("..") || isAbsolute(preRel)) {
			return new Response("forbidden sandbox path", { status: 403 });
		}

		const realTarget = await realpath(candidate);
		const realRel = relative(realRoot, realTarget).replace(/\\/g, "/");
		if (!realRel || realRel === ".." || realRel.startsWith("../") || isAbsolute(realRel)) {
			return new Response("forbidden sandbox path", { status: 403 });
		}

		const info = await stat(realTarget);
		if (!info.isFile()) {
			return new Response("sandbox asset is not a file", { status: 403 });
		}

		const ext = extname(realTarget).toLowerCase();
		const mime = WENYOU_SANDBOX_MIME_MAP[ext] ?? "application/octet-stream";
		const headers = new Headers({
			"Content-Type": mime,
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-cache",
			"Content-Length": String(info.size),
		});

		if (method === "HEAD") {
			return new Response(null, { status: 200, headers });
		}

		const upstream = await fetchFile(pathToFileURL(realTarget).toString());
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return new Response("sandbox asset not found", { status: 404 });
		return new Response(error instanceof Error ? error.message : "sandbox access denied", { status: 403 });
	}
}

/** 注册受工作区 realpath 与私有目录隔离保护的 `wenyou-asset://` 协议 */
export function registerWenyouAssetProtocolHandler(): void {
	protocol.handle(WENYOU_ASSET_PROTOCOL, (request) => handleWenyouAssetRequest(request));
}

/** 注册内置 Pixi 沙盘静态资源 `wenyou-sandbox://` 协议 */
export function registerWenyouSandboxProtocolHandler(): void {
	protocol.handle(WENYOU_SANDBOX_PROTOCOL, (request) => handleWenyouSandboxRequest(request));
}
