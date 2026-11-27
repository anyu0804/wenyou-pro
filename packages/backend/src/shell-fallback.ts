import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";

/**
 * Windows 无 Git Bash 自动回退辅助：
 * 普通 Windows 玩家电脑通常未安装 Git for Windows，SDK 默认工具集 ["read", "bash", "edit", "write"]
 * 调起 bash 会抛 "No bash shell found. Options: 1. Install Git for Windows"。
 * 本模块以零子进程开销（纯 fs.accessSync）探测是否存在可用 bash.exe，不可用时自动切换为 SDK
 * 内置的 Windows 原生 "powershell" 工具。
 */

function pathAccessible(candidate: string): boolean {
	try {
		accessSync(candidate, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, targetKey: string): string | undefined {
	if (env[targetKey] !== undefined) return env[targetKey];
	const lower = targetKey.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === lower && value !== undefined) return value;
	}
	return undefined;
}

/**
 * 检测当前环境是否具备可用的 Windows bash 可执行文件：
 * - 非 Windows 平台直接返回 true；
 * - 若显式指定 customShellPath，校验该路径是否可访问；
 * - 否则依次检查 %ProgramFiles%\Git\bin\bash.exe、%ProgramFiles(x86)%\Git\bin\bash.exe 与 PATH 目录下的 bash.exe。
 */
export function hasUsableWindowsBash(
	customShellPath?: string | null,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return true;

	const custom = customShellPath?.trim();
	if (custom) return pathAccessible(custom);

	const programDirs = [
		getEnvCaseInsensitive(env, "ProgramFiles"),
		getEnvCaseInsensitive(env, "ProgramFiles(x86)"),
	];
	for (const dir of programDirs) {
		const trimmed = dir?.trim();
		if (!trimmed) continue;
		if (pathAccessible(win32.join(trimmed, "Git", "bin", "bash.exe"))) return true;
	}

	const pathValue = getEnvCaseInsensitive(env, "PATH") ?? "";
	for (const rawEntry of pathValue.split(";")) {
		const entry = rawEntry.trim().replace(/^"+|"+$/g, "");
		if (!entry) continue;
		if (pathAccessible(win32.join(entry, "bash.exe"))) return true;
	}
	return false;
}

function replaceBashWithPowerShell(tools: readonly string[]): string[] {
	const mapped: string[] = [];
	const seen = new Set<string>();
	for (const name of tools) {
		const next = name === "bash" ? "powershell" : name;
		if (!seen.has(next)) {
			seen.add(next);
			mapped.push(next);
		}
	}
	return mapped;
}

/**
 * 为主会话解析 createAgentSession 的 tools 参数：
 * - 若宿主显式指定 tools，原样返回；
 * - Windows 下无可用 bash 时：
 *   - 若用户通过 settings.json 显式配置了 defaultTools 且其中包含 "bash"（如 `["+grep"]` 被 SDK 展开后仍含 bash），
 *     将 "bash" 替换为 "powershell"（去重保序）；若用户配置不含 "bash"，尊重用户选择返回 undefined；
 *   - 若用户未配置 defaultTools，返回 ["-bash", "+powershell"] 使用系统原生 PowerShell。
 */
export function resolveSessionTools(options: {
	explicitTools?: string[];
	defaultTools?: string[];
	shellPath?: string | null;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): string[] | undefined {
	if (options.explicitTools !== undefined) return options.explicitTools;
	const platform = options.platform ?? process.platform;
	if (platform !== "win32" || hasUsableWindowsBash(options.shellPath, options.env, platform)) {
		return undefined;
	}
	if (options.defaultTools !== undefined) {
		if (!options.defaultTools.includes("bash")) return undefined;
		return replaceBashWithPowerShell(options.defaultTools);
	}
	return ["-bash", "+powershell"];
}

/**
 * 为子代理工具列表应用 Windows 无 bash 回退：将 "bash" 替换为 "powershell"（去重保序）。
 */
export function resolveSubagentTools(
	tools: readonly string[],
	options?: {
		shellPath?: string | null;
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
	},
): string[] {
	const platform = options?.platform ?? process.platform;
	if (platform !== "win32" || hasUsableWindowsBash(options?.shellPath, options?.env, platform)) {
		return [...tools];
	}
	return replaceBashWithPowerShell(tools);
}
