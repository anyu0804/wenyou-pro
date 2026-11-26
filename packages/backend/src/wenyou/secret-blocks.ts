import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
	if (!normalized) return false;
	return normalized.split("/").some((seg) => seg === "private" || seg === ".wenyou");
}

export function isRawChatPath(relPath: string): boolean {
	const normalized = normalizeVaultPath(relPath);
	return normalized === "00-群聊收集" || normalized.startsWith("00-群聊收集/");
}

/**
 * 规范化文档可见性（Fail-Closed）：
 * - `undefined` / `null` / 空字符串返回 `defaultWhenUndefined`（正史词条默认 `"public"`，国策/简报应显式传 `"gm"`）；
 * - `"gm"` / `"public"` / `"faction"`（大小写无关）原样归一化返回；
 * - 任何非空未知值一律 Fail-Closed 返回 `"gm"`，防止拼写错误意外公开机密。
 */
export function parseVisibility(
	value: unknown,
	defaultWhenUndefined: VisibilityLevel = "public",
): VisibilityLevel {
	if (value === undefined || value === null || value === "") return defaultWhenUndefined;
	if (typeof value === "string") {
		const norm = value.trim().toLowerCase();
		if (norm === "") return defaultWhenUndefined;
		if (norm === "gm" || norm === "public" || norm === "faction") return norm;
	}
	return "gm";
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

/**
 * 校验待写入路径的已存在最近祖先目录（以及目标自身若已存在）经 realpath 解析后均位于工作区内，
 * 返回解析后的真实相对路径（POSIX 斜杠分隔）与目标绝对路径，防符号链接目录逃逸。
 */
export async function assertRealTargetInsideWorkspace(
	cwd: string,
	relOrAbsPath: string,
): Promise<{ absPath: string; realRelPath: string }> {
	const root = resolve(cwd);
	const absPath = assertPathInsideWorkspace(root, relOrAbsPath);
	const realRoot = await realpath(root);

	let probe = absPath;
	const trailingSegments: string[] = [];
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) break;
		trailingSegments.unshift(relative(parent, probe));
		probe = parent;
	}
	const realAnchor = await realpath(probe);
	const relAnchor = relative(realRoot, realAnchor);
	if (relAnchor === ".." || relAnchor.startsWith(`..${sep}`) || isAbsolute(relAnchor)) {
		throw new Error(`符号链接路径越界：${relOrAbsPath}`);
	}
	const combined = trailingSegments.length > 0 ? resolve(realAnchor, ...trailingSegments) : realAnchor;
	const realRel = relative(realRoot, combined);
	if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
		throw new Error(`符号链接路径越界：${relOrAbsPath}`);
	}
	return { absPath, realRelPath: normalizeVaultPath(realRel) };
}

const SECRET_OPEN_RE = /^[ \t]*:::secret(?:\[([^\]]*)\])?[ \t]*$/;
const SECRET_CLOSE_RE = /^[ \t]*:::[ \t]*$/;
/** CommonMark 反引号围栏开启：info string 中禁止出现反引号，避免把行内 ```inline``` 误判为多行围栏 */
const BACKTICK_FENCE_OPEN_RE = /^[ \t]*(`{3,})([^`]*)$/;
/** CommonMark 波浪号围栏开启 */
const TILDE_FENCE_OPEN_RE = /^[ \t]*(~{3,})(.*)$/;
/** CommonMark 闭合围栏：仅允许同字符且长度 >= 开启长度，后接可选空白 */
const CODE_FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

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
	const normalized = markdownBody.replace(/\r\n?/g, "\n");
	if (!normalized.includes(":::secret")) {
		return { visibleBody: normalized, strippedBodies: [], strippedBlockCount: 0 };
	}
	const lines = normalized.split("\n");
	const visibleLines: string[] = [];
	const strippedBodies: string[] = [];

	let activeFenceChar: "`" | "~" | null = null;
	let activeFenceLen = 0;
	let inSecret = false;
	let secretAuthorized = false;
	let secretBuffer: string[] = [];

	for (const line of lines) {
		if (activeFenceChar !== null) {
			const closeMatch = line.match(CODE_FENCE_CLOSE_RE);
			if (
				closeMatch?.[1] &&
				closeMatch[1][0] === activeFenceChar &&
				closeMatch[1].length >= activeFenceLen
			) {
				activeFenceChar = null;
				activeFenceLen = 0;
			}
			if (inSecret) secretBuffer.push(line);
			else visibleLines.push(line);
			continue;
		}

		const btOpen = line.match(BACKTICK_FENCE_OPEN_RE);
		if (btOpen?.[1]) {
			activeFenceChar = "`";
			activeFenceLen = btOpen[1].length;
			if (inSecret) secretBuffer.push(line);
			else visibleLines.push(line);
			continue;
		}
		const tildeOpen = line.match(TILDE_FENCE_OPEN_RE);
		if (tildeOpen?.[1]) {
			activeFenceChar = "~";
			activeFenceLen = tildeOpen[1].length;
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

function stripInlineYamlComment(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		let escaped = false;
		for (let i = 1; i < trimmed.length; i += 1) {
			const ch = trimmed[i]!;
			if (quote === '"' && escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				const tail = trimmed.slice(i + 1);
				if (tail === "" || /^[ \t]+#/.test(tail) || /^[ \t]+$/.test(tail)) {
					return trimmed.slice(0, i + 1);
				}
				break;
			}
		}
		return trimmed;
	}
	if (trimmed.startsWith("[")) {
		let inQuote: '"' | "'" | null = null;
		let escaped = false;
		for (let i = 1; i < trimmed.length; i += 1) {
			const ch = trimmed[i]!;
			if (inQuote) {
				if (inQuote === '"' && escaped) {
					escaped = false;
					continue;
				}
				if (inQuote === '"' && ch === "\\") {
					escaped = true;
					continue;
				}
				if (ch === inQuote) inQuote = null;
				continue;
			}
			if (ch === '"' || ch === "'") {
				inQuote = ch;
			} else if (ch === "]") {
				const tail = trimmed.slice(i + 1);
				if (tail === "" || /^[ \t]+#/.test(tail) || /^[ \t]+$/.test(tail)) {
					return trimmed.slice(0, i + 1);
				}
				break;
			}
		}
	}
	return trimmed.replace(/(?:^|[ \t]+)#.*$/, "").trim();
}

function parseScalar(raw: string): unknown {
	const trimmed = stripInlineYamlComment(raw);
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null" || trimmed === "~") return null;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
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
	const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const openMatch = normalized.match(/^---[ \t]*\n/);
	if (!openMatch) {
		return { data: {}, body: normalized };
	}
	const afterOpen = normalized.slice(openMatch[0].length);
	const closeMatch = afterOpen.match(/(?:^|\n)---[ \t]*(?:\n|$)/);
	if (!closeMatch || closeMatch.index === undefined) {
		return { data: {}, body: normalized };
	}

	const header = afterOpen.slice(0, closeMatch.index);
	const body = afterOpen.slice(closeMatch.index + closeMatch[0].length).replace(/^\n/, "");
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
		const rest = stripInlineYamlComment(line.slice(colon + 1));
		if (!rest) {
			data[key] = [];
			listKey = key;
		} else {
			data[key] = parseScalar(rest);
		}
	}
	return { data, body };
}
