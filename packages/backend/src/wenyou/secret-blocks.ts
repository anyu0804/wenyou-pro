import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseViewerScope, type ViewerScope, type VisibilityLevel } from "@percho/shared";

export interface SecretBlockStripResult {
	readonly visibleBody: string;
	readonly strippedBodies: readonly string[];
	readonly strippedBlockCount: number;
}

export interface ParsedFrontmatterDoc {
	readonly data: Record<string, unknown>;
	readonly body: string;
}

export function normalizeVaultPath(relPath: string): string {
	const slashNormalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const segments = slashNormalized.split("/");
	const resolved: string[] = [];
	for (const seg of segments) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
				resolved.pop();
			} else {
				resolved.push("..");
			}
		} else {
			resolved.push(seg);
		}
	}
	return resolved.join("/");
}

export function isPrivateVaultPath(relPath: string): boolean {
	const normalized = normalizeVaultPath(relPath).toLowerCase();
	return normalized === "private" || normalized.startsWith("private/") || normalized === ".wenyou" || normalized.startsWith(".wenyou/");
}

export function canViewerSee(
	visibility: VisibilityLevel,
	visibleToFactions: readonly string[] | undefined,
	viewer: ViewerScope,
): boolean {
	if (viewer.kind === "gm") return true;
	if (visibility === "public") return true;
	if (visibility === "gm") return false;
	if (viewer.kind === "faction") {
		return Array.isArray(visibleToFactions) && visibleToFactions.includes(viewer.factionId);
	}
	return false;
}

export function assertPathInsideWorkspace(cwd: string, relOrAbsPath: string): string {
	const root = resolve(cwd);
	const target = isAbsolute(relOrAbsPath) ? resolve(relOrAbsPath) : resolve(root, relOrAbsPath);
	const rel = relative(root, target);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`路径越界：${relOrAbsPath} 不在工作区目录内`);
	}
	return target;
}

export async function resolveRealPathInsideWorkspace(cwd: string, relPath: string): Promise<string> {
	const candidate = assertPathInsideWorkspace(cwd, relPath);
	const [realRoot, realTarget] = await Promise.all([realpath(resolve(cwd)), realpath(candidate)]);
	const rel = relative(realRoot, realTarget);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`符号链接路径越界：${relPath}`);
	}
	return realTarget;
}

const SECRET_OPEN_RE = /^[ \t]*:::secret(?:\[([^\]]*)\])?[ \t]*$/;
const SECRET_CLOSE_RE = /^[ \t]*:::[ \t]*$/;
const CODE_FENCE_RE = /^[ \t]*(```+|~~~+)/;

function parseAllowedScopes(specRaw: string | undefined): ViewerScope[] | null {
	if (specRaw === undefined) return null;
	const parts = specRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parts.length === 0) return null;
	const scopes: ViewerScope[] = [];
	try {
		for (const part of parts) {
			scopes.push(parseViewerScope(part));
		}
		return scopes;
	} catch {
		return null;
	}
}

function isViewerAuthorizedForSecret(
	allowedScopes: readonly ViewerScope[] | null,
	viewer: ViewerScope,
): boolean {
	if (viewer.kind === "gm") return true;
	if (allowedScopes === null) return false;
	for (const scope of allowedScopes) {
		if (scope.kind === "public") return true;
		if (scope.kind === "faction" && viewer.kind === "faction" && scope.factionId === viewer.factionId) {
			return true;
		}
	}
	return false;
}

/**
 * 块级受限暗线剥离器（Fail-Closed）：
 * 语法 `:::secret[gm]` 或 `:::secret[faction:north-zhou]` ... `:::`
 */
export function stripRestrictedMarkdownBlocks(
	markdownBody: string,
	viewer: ViewerScope,
): SecretBlockStripResult {
	const normalized = markdownBody.replace(/\r\n/g, "\n");
	if (!normalized.includes(":::secret")) {
		return { visibleBody: normalized, strippedBodies: [], strippedBlockCount: 0 };
	}
	const lines = normalized.split("\n");
	const visibleLines: string[] = [];
	const strippedBodies: string[] = [];

	let activeCodeFence: string | null = null;
	let inSecret = false;
	let secretAuthorized = false;
	let secretBuffer: string[] = [];

	for (const line of lines) {
		const fenceMatch = line.match(CODE_FENCE_RE);
		if (fenceMatch && fenceMatch[1]) {
			const marker = fenceMatch[1];
			if (activeCodeFence === null) {
				activeCodeFence = marker[0]!.repeat(marker.length);
			} else if (line.trimStart().startsWith(activeCodeFence)) {
				activeCodeFence = null;
			}
			if (inSecret) secretBuffer.push(line);
			else visibleLines.push(line);
			continue;
		}
		if (activeCodeFence !== null) {
			if (inSecret) secretBuffer.push(line);
			else visibleLines.push(line);
			continue;
		}
		if (!inSecret) {
			const openMatch = line.match(SECRET_OPEN_RE);
			if (openMatch) {
				inSecret = true;
				secretAuthorized = isViewerAuthorizedForSecret(parseAllowedScopes(openMatch[1]), viewer);
				secretBuffer = [];
				continue;
			}
			visibleLines.push(line);
			continue;
		}
		if (SECRET_CLOSE_RE.test(line)) {
			if (secretAuthorized) visibleLines.push(...secretBuffer);
			else strippedBodies.push(secretBuffer.join("\n"));
			inSecret = false;
			secretAuthorized = false;
			secretBuffer = [];
			continue;
		}
		secretBuffer.push(line);
	}

	if (inSecret) {
		if (viewer.kind === "gm") visibleLines.push(...secretBuffer);
		else strippedBodies.push(secretBuffer.join("\n"));
	}

	return {
		visibleBody: visibleLines.join("\n"),
		strippedBodies,
		strippedBlockCount: strippedBodies.length,
	};
}

function parseScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null" || trimmed === "~") return null;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(",")
			.map((p) => parseScalar(p))
			.filter((v) => v !== "");
	}
	return trimmed;
}

export function parseMarkdownWithFrontmatter(source: string): ParsedFrontmatterDoc {
	const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { data: {}, body: normalized };
	}
	const endIdx = normalized.indexOf("\n---\n", 4);
	const trailingIdx = endIdx === -1 && normalized.endsWith("\n---") ? normalized.length - 4 : endIdx;
	if (trailingIdx === -1) return { data: {}, body: normalized };

	const header = normalized.slice(4, trailingIdx);
	const body = normalized.slice(trailingIdx + 5).replace(/^\n/, "");
	const data: Record<string, unknown> = {};
	let listKey: string | null = null;

	for (const line of header.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("- ") && listKey) {
			const arr = data[listKey];
			if (Array.isArray(arr)) arr.push(parseScalar(trimmed.slice(2)));
			continue;
		}
		listKey = null;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		const rest = line.slice(colon + 1).trim();
		if (!rest) {
			data[key] = [];
			listKey = key;
		} else {
			data[key] = parseScalar(rest);
		}
	}
	return { data, body };
}
