import { environmentEntityRef, sameEnvironment, WENYOU_SANDBOX_PROTOCOL } from "@percho/shared";

/** 剥离 environmentEntityKey 前缀，拿到真实目录路径（local 直接原样返回） */
export function unwrapCwdPath(cwd: string | null | undefined): string | null {
	if (!cwd) return null;
	try {
		return environmentEntityRef(cwd).id;
	} catch {
		return cwd;
	}
}

export function isRemoteCwd(cwd: string | null | undefined): boolean {
	if (!cwd) return false;
	try {
		return environmentEntityRef(cwd).environment.kind === "ssh";
	} catch {
		return false;
	}
}

export function normalizeDirForCompare(raw: string): string {
	const unwrapped = unwrapCwdPath(raw) ?? raw;
	const slash = unwrapped.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-zA-Z]:\//.test(slash) || /^[a-zA-Z]:$/.test(slash) ? slash.toLowerCase() : slash;
}

export function sameDirectoryPath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	try {
		const refA = environmentEntityRef(a);
		const refB = environmentEntityRef(b);
		if (!sameEnvironment(refA.environment, refB.environment)) return false;
	} catch {
		return false;
	}
	return normalizeDirForCompare(a) === normalizeDirForCompare(b);
}

/** 允许内置 `wenyou-sandbox://app...` 或有效的 `http://` / `https://` 地址（含局域网 IP 与主机名）接入沙盘桥接 */
export function sanitizePixiSandboxUrl(rawUrl: string | null | undefined): string | null {
	if (!rawUrl) return null;
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === `${WENYOU_SANDBOX_PROTOCOL}:`) {
			return parsed.hostname.toLowerCase() === "app" ? parsed.toString() : null;
		}
		if ((parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname)) {
			return parsed.toString();
		}
		return null;
	} catch {
		return null;
	}
}

export function formatShortTime(iso: string | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
