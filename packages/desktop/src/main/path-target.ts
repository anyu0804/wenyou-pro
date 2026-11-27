import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { cleanPathText, resolvePathTarget as resolveBackendPathTarget } from "@percho/backend";

export { cleanPathText };

function decodePercentSafe(text: string): string {
	if (!text.includes("%")) return text;
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** 解析成绝对路径（在 backend 规则基础上同步兼容 Windows `~\` 家目录展开与空串 cwd）。 */
export function resolvePathTarget(raw: string, cwd: string | null): string {
	const cleaned = cleanPathText(raw);
	if (!cleaned) throw new Error(`Empty path: ${JSON.stringify(raw)}`);
	if (cleaned.startsWith("~\\")) {
		const rest = decodePercentSafe(cleaned.slice(2)).replace(/\\/g, "/");
		return normalize(rest ? join(homedir(), rest) : homedir());
	}
	const effectiveCwd = cwd?.trim() ? cwd : null;
	return resolveBackendPathTarget(raw, effectiveCwd);
}

/** 解析 + 存在性检查；不存在抛错（handler 把错误消息透到 toast detail）。 */
export function resolveExistingPath(raw: string, cwd: string | null): string {
	const resolved = resolvePathTarget(raw, cwd);
	if (!existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
	return resolved;
}
