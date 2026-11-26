import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** 默认存放空白文游世界的本地根目录（位于用户目录 ~/.wenyou-pro/worlds，跨平台且不硬编码用户名） */
export function defaultWorldsRootDir(): string {
	return join(homedir(), ".wenyou-pro", "worlds");
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function defaultWorldTitle(now: Date): string {
	const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
	return `新世界-${stamp}`;
}

/** 将世界名净化为跨平台安全目录名，保留中文字符并阻断路径穿越与 Windows 保留名 */
export function sanitizeWorldFolderName(rawTitle: string): string {
	const cleaned = rawTitle
		.trim()
		.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[.\-\s]+|[.\-\s]+$/g, "")
		.slice(0, 64);
	if (!cleaned || cleaned === "." || cleaned === "..") return "wenyou-world";
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
		return `${cleaned}-world`;
	}
	return cleaned;
}

export interface CreateWorldDirOptions {
	worldTitle?: string;
	parentDir?: string;
	now?: Date;
}

export interface CreateWorldDirResult {
	cwd: string;
	worldTitle: string;
}

/**
 * 创建全新的空白文游世界目录（绝不覆盖已有目录：同名时自动追加 -2 / -3 后缀）。
 */
export async function createWorldDirectory(options?: CreateWorldDirOptions): Promise<CreateWorldDirResult> {
	const now = options?.now ?? new Date();
	const rawParent = options?.parentDir?.trim();
	let baseDir: string;

	if (rawParent) {
		if (!isAbsolute(rawParent)) {
			throw new Error("世界存放父目录必须是绝对路径");
		}
		baseDir = resolve(rawParent);
		const info = await stat(baseDir).catch(() => null);
		if (!info || !info.isDirectory()) {
			throw new Error("所选世界存放位置不存在或不是文件夹");
		}
	} else {
		baseDir = defaultWorldsRootDir();
		await mkdir(baseDir, { recursive: true });
	}

	const worldTitle = options?.worldTitle?.trim() || defaultWorldTitle(now);
	const baseFolder = sanitizeWorldFolderName(worldTitle);

	let candidate = join(baseDir, baseFolder);
	let suffix = 2;
	while (existsSync(candidate)) {
		candidate = join(baseDir, `${baseFolder}-${suffix}`);
		suffix += 1;
		if (suffix > 999) {
			throw new Error("同名世界目录过多，请换一个世界名称或存放目录");
		}
	}

	await mkdir(candidate, { recursive: true });
	return { cwd: candidate, worldTitle };
}
