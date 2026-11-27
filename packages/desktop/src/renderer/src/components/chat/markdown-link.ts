/** Markdown 链接不能按 app 页面 URL 解析：相对文件路径必须交给会话 cwd。 */
export type MarkdownLink =
	| { kind: "external"; url: string }
	| { kind: "file"; target: string }
	| { kind: "anchor" }
	| { kind: "unsupported" };

/** Windows 盘符绝对路径（如 `D:/...`、`C:\...`） */
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
/** Windows UNC 网络共享路径（如 `\\server\share\doc.md`） */
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\/]+[\\/][^\\/]+/;
/** 合法 URI scheme 至少 2 个字符，避免把单字母 Windows 盘符误判成协议 */
const URI_SCHEME_RE = /^[a-z][a-z\d+.-]+:/i;

/** 判断本地文件目标是否已具备绝对锚点（不依赖会话 cwd 即可解析） */
export function isAbsoluteMarkdownFileTarget(target: string): boolean {
	const trimmed = target.trim();
	return (
		/^file:\/\//i.test(trimmed) ||
		WINDOWS_DRIVE_PATH_RE.test(trimmed) ||
		WINDOWS_UNC_PATH_RE.test(trimmed) ||
		(trimmed.startsWith("/") && !trimmed.startsWith("//")) ||
		trimmed === "~" ||
		trimmed.startsWith("~/") ||
		trimmed.startsWith("~\\")
	);
}

export function classifyMarkdownLink(href: string): MarkdownLink {
	const target = href.trim();
	if (!target) return { kind: "unsupported" };
	if (target.startsWith("#")) return { kind: "anchor" };
	if (/^https?:\/\//i.test(target)) return { kind: "external", url: target };
	if (WINDOWS_DRIVE_PATH_RE.test(target) || WINDOWS_UNC_PATH_RE.test(target)) {
		return { kind: "file", target };
	}
	// 不能把协议相对 URL / 其它协议送进 shell.openPath（更不能在 app 内导航）。
	if (target.startsWith("//") || (URI_SCHEME_RE.test(target) && !/^file:\/\//i.test(target))) {
		return { kind: "unsupported" };
	}
	return { kind: "file", target };
}
