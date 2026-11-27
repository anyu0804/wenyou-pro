import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * 判定 git 调用失败是否为「系统未安装 git 可执行文件」：
 * `execFile("git", ..., { cwd })` 在 git 缺失与 cwd 不存在时都可能报 ENOENT，
 * 因此必须同时校验 cwd 是真实存在的目录，避免误吞不存在工作目录的错误。
 */
export function isGitBinaryMissing(error: unknown, cwd: string): boolean {
	if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return false;
	try {
		return statSync(cwd).isDirectory();
	} catch {
		return false;
	}
}

/** Cwd determines the repository; inherited shell/extension overrides cannot redirect UI actions. */
async function git(cwd: string, args: string[], timeout = 5000): Promise<string> {
	const env = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_NAMESPACE",
	])
		delete env[key];
	try {
		return (
			await exec("git", args, { cwd, env, timeout, maxBuffer: 1024 * 1024, windowsHide: true })
		).stdout.trim();
	} catch (error) {
		const failure = error as Error & { stderr?: string; code?: string | number };
		throw Object.assign(new Error(failure.stderr?.trim() || failure.message), { code: failure.code });
	}
}

export async function getGitBranch(cwd: string): Promise<string | null> {
	try {
		try {
			return await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		} catch (error) {
			if ((error as { code?: number }).code !== 1) throw error;
			return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || null;
		}
	} catch (error) {
		if (isGitBinaryMissing(error, cwd)) return null;
		if (error instanceof Error && /not a git repository/i.test(error.message)) return null;
		throw error;
	}
}
export async function listGitBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
	try {
		const names = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
		return { current: await getGitBranch(cwd), branches: names.split("\n").filter(Boolean) };
	} catch (error) {
		if (isGitBinaryMissing(error, cwd)) return { current: null, branches: [] };
		if (error instanceof Error && /not a git repository/i.test(error.message))
			return { current: null, branches: [] };
		throw error;
	}
}
export async function checkoutBranch(cwd: string, branch: string): Promise<string> {
	if (
		typeof branch !== "string" ||
		!branch ||
		branch === "HEAD" ||
		branch.startsWith("-") ||
		branch.length > 4096 ||
		branch.includes("\0")
	)
		throw new Error("Invalid local branch name");
	try {
		await git(cwd, ["check-ref-format", `refs/heads/${branch}`]);
		await git(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]);
		// Never guess, reset, clean, or remove locks; Git reports conflicting work directly.
		await git(cwd, ["checkout", "--no-guess", branch, "--"], 15000);
		return (await getGitBranch(cwd)) ?? branch;
	} catch (error) {
		if (isGitBinaryMissing(error, cwd)) throw new Error("当前系统未安装 Git，无法切换分支");
		throw error;
	}
}
