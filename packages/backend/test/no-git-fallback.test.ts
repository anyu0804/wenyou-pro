import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch, getGitBranch, isGitBinaryMissing, listGitBranches } from "../src/git";
import { applyToolAnnotationsRule } from "../src/permissions/annotations";
import { DEFAULT_PERMISSION_CONFIG } from "../src/permissions/config";
import { evaluateRules } from "../src/permissions/pattern";
import { hasUsableWindowsBash, resolveSessionTools, resolveSubagentTools } from "../src/shell-fallback";
import { resolveChannelProject } from "../src/tools/channels/project";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "no-git-fallback-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("Git-free graceful fallback (PATH empty)", () => {
	it("PATH 为空时 resolveChannelProject 对真实目录优雅降级而不抛 spawn git ENOENT", async () => {
		const workspace = join(root, "campaign");
		const nested = join(workspace, "sub");
		const outside = join(root, "other");
		mkdirSync(nested, { recursive: true });
		mkdirSync(outside, { recursive: true });

		vi.stubEnv("PATH", "");

		expect(await resolveChannelProject(workspace)).toBe(await realpath(workspace));
		expect(await resolveChannelProject(nested, workspace)).toBe(await realpath(workspace));
		await expect(resolveChannelProject(outside, workspace)).rejects.toThrow(
			"Channel project root does not contain cwd",
		);
		// 不存在的目录仍然按契约抛错（realpath 失败）
		await expect(resolveChannelProject(join(root, "missing"))).rejects.toThrow();
	});

	it("PATH 为空时 git.ts 各查询优雅降级，checkoutBranch 给中文友好错误，不存在目录继续报错", async () => {
		const workspace = join(root, "campaign");
		const missing = join(root, "does-not-exist");
		mkdirSync(workspace, { recursive: true });

		vi.stubEnv("PATH", "");

		expect(await getGitBranch(workspace)).toBeNull();
		expect(await listGitBranches(workspace)).toEqual({ current: null, branches: [] });
		await expect(checkoutBranch(workspace, "main")).rejects.toThrow("当前系统未安装 Git，无法切换分支");

		// 负向对照：目录本身不存在时 isGitBinaryMissing 为 false，绝不误吞错误
		expect(isGitBinaryMissing(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), workspace)).toBe(
			true,
		);
		expect(isGitBinaryMissing(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), missing)).toBe(
			false,
		);
		await expect(getGitBranch(missing)).rejects.toThrow();
		await expect(listGitBranches(missing)).rejects.toThrow();
		await expect(checkoutBranch(missing, "main")).rejects.not.toThrow("当前系统未安装 Git，无法切换分支");
	});
});

describe("Windows bash fallback to built-in powershell tool", () => {
	it("Windows 缺失 Git Bash 且 PATH 无 bash.exe 时返回 false 并自动回退 [-bash, +powershell]", () => {
		const emptyPf = join(root, "ProgramFiles");
		const emptyPf86 = join(root, "ProgramFilesX86");
		mkdirSync(emptyPf, { recursive: true });
		mkdirSync(emptyPf86, { recursive: true });
		const emptyEnv: NodeJS.ProcessEnv = {
			ProgramFiles: emptyPf,
			"ProgramFiles(x86)": emptyPf86,
			PATH: "",
		};

		expect(hasUsableWindowsBash(undefined, emptyEnv, "win32")).toBe(false);
		expect(resolveSessionTools({ env: emptyEnv, platform: "win32" })).toEqual(["-bash", "+powershell"]);
		expect(
			resolveSubagentTools(["read", "bash", "edit", "write"], { env: emptyEnv, platform: "win32" }),
		).toEqual(["read", "powershell", "edit", "write"]);
		// 只读子代理不含 bash，不应被凭空注入 powershell
		expect(resolveSubagentTools(["read", "grep", "find"], { env: emptyEnv, platform: "win32" })).toEqual([
			"read",
			"grep",
			"find",
		]);
		// 已有 powershell 时替换 bash 不产生重复项
		expect(
			resolveSubagentTools(["read", "bash", "powershell"], { env: emptyEnv, platform: "win32" }),
		).toEqual(["read", "powershell"]);

		// 显式宿主 tools 或用户 settings defaultTools 优先保留，不被回退覆盖
		expect(resolveSessionTools({ explicitTools: ["read"], env: emptyEnv, platform: "win32" })).toEqual([
			"read",
		]);
		expect(
			resolveSessionTools({ defaultTools: ["read", "edit"], env: emptyEnv, platform: "win32" }),
		).toBeUndefined();
	});

	it("检测到 Git Bash / PATH 中的 bash.exe / 有效 customShellPath 或非 Windows 时保持默认 bash", () => {
		const pf = join(root, "PF");
		const gitBashDir = join(pf, "Git", "bin");
		mkdirSync(gitBashDir, { recursive: true });
		const gitBash = join(gitBashDir, "bash.exe");
		writeFileSync(gitBash, "stub");

		const envWithGitBash: NodeJS.ProcessEnv = { ProgramFiles: pf, PATH: "" };
		expect(hasUsableWindowsBash(undefined, envWithGitBash, "win32")).toBe(true);
		expect(resolveSessionTools({ env: envWithGitBash, platform: "win32" })).toBeUndefined();
		expect(resolveSubagentTools(["read", "bash"], { env: envWithGitBash, platform: "win32" })).toEqual([
			"read",
			"bash",
		]);

		// PATH 中存在（含引号包裹路径）也可识别
		const customBin = join(root, "msys-bin");
		mkdirSync(customBin, { recursive: true });
		writeFileSync(join(customBin, "bash.exe"), "stub");
		const envWithPathBash: NodeJS.ProcessEnv = {
			ProgramFiles: join(root, "none"),
			PATH: `;"${customBin}";`,
		};
		expect(hasUsableWindowsBash(undefined, envWithPathBash, "win32")).toBe(true);

		// 显式 customShellPath 存在 → true；不存在 → false（即使 ProgramFiles 有 bash）
		const customShell = join(root, "custom-bash.exe");
		writeFileSync(customShell, "stub");
		expect(hasUsableWindowsBash(customShell, { PATH: "" }, "win32")).toBe(true);
		expect(hasUsableWindowsBash(join(root, "missing-bash.exe"), envWithGitBash, "win32")).toBe(false);

		// 非 Windows 平台始终返回 true
		expect(hasUsableWindowsBash(undefined, { PATH: "" }, "darwin")).toBe(true);
		expect(hasUsableWindowsBash(undefined, { PATH: "" }, "linux")).toBe(true);
	});

	it("默认权限规则对内置 powershell 工具放行，不会每次命令都弹权限审批框", () => {
		const ruleAction = evaluateRules(DEFAULT_PERMISSION_CONFIG.rules, "powershell", "Get-Location");
		expect(ruleAction).toBe("allow");
		const annotatedAction = applyToolAnnotationsRule(
			DEFAULT_PERMISSION_CONFIG.rules,
			"powershell",
			ruleAction,
			() => undefined,
		);
		expect(annotatedAction).toBe("allow");
	});
});
