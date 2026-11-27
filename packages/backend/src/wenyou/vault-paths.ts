import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") return parsed;
		} catch {
			// 兼容历史手写含未转义引号或非 JSON 转义的双引号标量
		}
		return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
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
