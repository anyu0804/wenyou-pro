import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Resolve the worktree root without inheriting Git's repository overrides. */
export async function resolveChannelProject(cwd: string, boundRoot?: string): Promise<string> {
	const current = await realpath(cwd);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
	env.LC_ALL = "C";
	let topLevel: string | undefined;
	try {
		const result = await exec("git", ["rev-parse", "--show-toplevel"], {
			cwd: current,
			env,
			shell: false,
			timeout: 5000,
			windowsHide: true,
		});
		topLevel = result.stdout.trim();
	} catch (error) {
		// Only Git's explicit non-repository response or missing git executable permits a fallback.
		// `realpath(cwd)` above has already verified that `cwd` itself exists.
		const failure = error as { code?: unknown; stderr?: unknown };
		const isMissingGitBinary = failure.code === "ENOENT";
		const isNotGitRepository =
			failure.code === 128 &&
			typeof failure.stderr === "string" &&
			(/^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?\s*$/i.test(
				failure.stderr,
			) ||
				/^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\s*$/i.test(
					failure.stderr,
				));
		if (!isMissingGitBinary && !isNotGitRepository) throw error;
	}
	if (topLevel) return realpath(topLevel);
	if (!boundRoot) return current;
	const bound = await realpath(boundRoot);
	const rel = relative(bound, current);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error("Channel project root does not contain cwd");
	}
	return bound;
}
