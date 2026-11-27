import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "@percho/shared";
import { collectBashCandidates, splitShellSegments } from "../../permissions/bash-chain";
import { patternMatchesToolCall } from "../../permissions/pattern";

export const READ_ONLY_GIT_COMMANDS = [
	"status",
	"diff",
	"log",
	"show",
	"blame",
	"rev-parse",
	"ls-files",
	"shortlog",
	"grep",
] as const;

export const PROTECTED_STATE_FILENAMES = [
	"permissions.json",
	"auth.json",
	"model-prefs.json",
	"workspaces.json",
] as const;

export interface SubagentPolicy {
	agentDir: string;
	deny: readonly string[];
	permissionMode?: PermissionMode;
}

// 与权限模式键相同：工具名，或「工具名: 通配文本」。通配只支持 * / ?，其余为字面。
export function isDenyPattern(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]+(?:: [^\r\n]+)?$/.test(value);
}

export function subagentPermissionMode(parent: PermissionMode, declared?: PermissionMode): PermissionMode {
	return parent === "default" ? "default" : (declared ?? "fullAccess");
}

function isGitBinaryToken(rawToken: string, unescapedToken: string): boolean {
	const matches = (value: string): boolean => {
		const stripped = value.replace(/["']/g, "");
		const last = stripped.split(/[\\/]/).pop() ?? "";
		return last.toLowerCase().replace(/\.exe$/, "") === "git";
	};
	return matches(unescapedToken) || matches(rawToken);
}

function normalizePathText(value: string): string {
	return value.replace(/\\/g, "/").toLowerCase();
}

function matchesDenyPattern(pattern: string, tool: string, text: string | null): boolean {
	if (patternMatchesToolCall(pattern, tool, text)) return true;
	if (tool === "powershell") {
		if (pattern === "bash") return true;
		if (pattern.startsWith("bash: ")) {
			return patternMatchesToolCall(`powershell: ${pattern.slice("bash: ".length)}`, "powershell", text);
		}
	}
	return false;
}

/** 候选已包含命令链、shell -c 载荷和命令替换；这里只解析程序与紧随的子命令。 */
export function forbiddenGitCommand(command: string): string | undefined {
	for (const candidate of collectBashCandidates(command).flatMap(splitShellSegments)) {
		const rawTokens = candidate.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? [];
		const tokens = rawTokens.map((token) => token.replace(/\\(.)/g, "$1").replace(/["']/g, ""));
		let start = 0;
		while (start < tokens.length && /^[\w]+=/u.test(tokens[start] ?? "")) start++;
		const cmdToken = tokens[start] ?? "";
		const rawCmdToken = rawTokens[start] ?? "";
		if (
			!isGitBinaryToken(rawCmdToken, cmdToken) &&
			basename(cmdToken)
				.toLowerCase()
				.replace(/\.exe$/, "") !== "git"
		)
			continue;
		const rest = tokens.slice(start + 1);
		if (rest.some((token) => /^-[cC]|^--(?:git-dir|work-tree)(?:=|$)/i.test(token))) return candidate;
		const subcommand = rest[0];
		if (!READ_ONLY_GIT_COMMANDS.some((name) => name === subcommand)) return candidate;
	}
	return undefined;
}

/** 工具调用边界；SDK 自身持久化不经过这里。bash / powershell 的目录保护刻意只做文本匹配。 */
export function subagentBoundaryViolation(
	policy: SubagentPolicy,
	tool: string,
	text: string | null,
	cwd: string,
): string | undefined {
	const deny = policy.deny.find((pattern) => matchesDenyPattern(pattern, tool, text));
	if (deny) return `deny: ${deny}`;
	if ((tool === "bash" || tool === "powershell") && text) {
		const git = forbiddenGitCommand(text);
		if (git) return `git: ${git}`;
		const normalizedText = normalizePathText(text);
		const normalizedAgentDir = normalizePathText(policy.agentDir).replace(/\/+$/, "");
		if (
			(normalizedAgentDir.length > 0 && normalizedText.includes(normalizedAgentDir)) ||
			PROTECTED_STATE_FILENAMES.some((name) => normalizedText.includes(name.toLowerCase()))
		)
			return "Percho state is read-only (bash text match)";
	}
	if ((tool === "edit" || tool === "write") && text) {
		// SDK 工具支持 @、~、file URL 与 Unicode 空格；在同样的字面路径上判定，避免前缀被包装绕过。
		let normalized = text.replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
		if (normalized === "~") normalized = homedir();
		else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\")))
			normalized = join(homedir(), normalized.slice(2));
		if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
		const path = resolve(cwd, normalized);
		const root = resolve(policy.agentDir);
		if (path === root || path.startsWith(root + sep)) return "Percho state is read-only";
	}
	return undefined;
}
