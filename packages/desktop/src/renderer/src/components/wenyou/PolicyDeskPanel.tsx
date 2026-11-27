import { Fragment, type ReactNode, useMemo, useState } from "react";
import { getPi } from "../../api";
import { pushExtensionToast } from "../../stores/toasts";
import { fillWenyouPrompt, useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { formatShortTime, isRemoteCwd, unwrapCwdPath } from "./wenyou-helpers";

export type PolicyPreviewBlock =
	| { kind: "subheading"; text: string; key: string }
	| { kind: "list-item"; text: string; bullet?: boolean; key: string }
	| { kind: "paragraph"; text: string; key: string };

/** 识别条陈/列表项起始行：`一、`、`（一）`、`1、`、`1.`、`- `、以及 `**条目标题**：内容` / `条目：内容` */
const UNORDERED_ITEM_RE = /^[-*+•·]\s+(.+)$/;
const ORDERED_ITEM_RE = /^(?:\d{1,3}(?:\.\s+|\s*[、)）]\s*)|[一二三四五六七八九十百]+[、.．]\s*|[（(][一二三四五六七八九十百\d]+[)）]\s*)/;
const COLON_ITEM_RE = /^(?:\*\*[^*\n]{1,24}\*\*|[^：:，。！？；,.!?;]{1,20})[：:]\s*\S/;
const HORIZONTAL_RULE_RE = /^(?:---+|\*\*\*+|___+)$/;

function stripControlChars(input: string): string {
	let out = "";
	for (let i = 0; i < input.length; i += 1) {
		const code = input.charCodeAt(i);
		out += code < 32 ? "-" : input[i];
	}
	return out;
}

/** 清洗另存为 `.docx` 的默认文件名：去除 `/`/`:` 等非法字符、尾随点空格与保留名 */
export function sanitizePolicyFileName(rawName: string, fallback = "国策文书.docx"): string {
	const withoutExt = rawName.trim().replace(/\.docx$/i, "");
	const cleaned = stripControlChars(withoutExt)
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/\s*-\s*/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[\s.-]+|[\s.-]+$/g, "")
		.slice(0, 100)
		.replace(/[\s.]+$/g, "");
	if (!cleaned) return fallback;
	const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `${cleaned}-doc` : cleaned;
	return `${safeStem}.docx`;
}

/** 拆分自然段与条陈/列表项用于公文纸面预览，避免无空行条陈粘成一行 */
export function parsePolicyParagraphs(content: string): {
	heading?: string;
	paragraphs: string[];
	blocks: PolicyPreviewBlock[];
} {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	let heading: string | undefined;
	const blocks: PolicyPreviewBlock[] = [];
	let buffer: { kind: "paragraph" | "list-item"; bullet?: boolean; lines: string[]; lineNo: number } | null =
		null;

	const flush = () => {
		if (!buffer || buffer.lines.length === 0) {
			buffer = null;
			return;
		}
		const text = buffer.lines.join(" ").trim();
		if (text) {
			const key = `${buffer.kind}-${buffer.lineNo}`;
			blocks.push(
				buffer.kind === "list-item"
					? { kind: "list-item", text, key, ...(buffer.bullet ? { bullet: true } : {}) }
					: { kind: "paragraph", text, key },
			);
		}
		buffer = null;
	};

	for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
		const rawLine = lines[lineNo] ?? "";
		const line = rawLine.trim();
		if (!line) {
			flush();
			continue;
		}
		if (HORIZONTAL_RULE_RE.test(line)) {
			flush();
			continue;
		}
		if (!heading && /^#\s+(.+)$/.test(line)) {
			heading = line.replace(/^#\s+/, "").trim();
			continue;
		}
		if (/^#{2,6}\s+/.test(line)) {
			flush();
			blocks.push({ kind: "subheading", text: line.replace(/^#{2,6}\s+/, "").trim(), key: `sub-${lineNo}` });
			continue;
		}
		const normalizedLine = line.replace(/^>\s*/, "").trim();
		if (!normalizedLine) {
			flush();
			continue;
		}
		const unordered = normalizedLine.match(UNORDERED_ITEM_RE);
		if (unordered?.[1]) {
			flush();
			buffer = { kind: "list-item", bullet: true, lines: [unordered[1].trim()], lineNo };
			continue;
		}
		if (ORDERED_ITEM_RE.test(normalizedLine) || COLON_ITEM_RE.test(normalizedLine)) {
			flush();
			buffer = { kind: "list-item", lines: [normalizedLine], lineNo };
			continue;
		}
		if (!buffer) {
			buffer = { kind: "paragraph", lines: [normalizedLine], lineNo };
		} else {
			buffer.lines.push(normalizedLine);
		}
	}
	flush();
	return { heading, blocks, paragraphs: blocks.map((b) => b.text) };
}

/** 轻量行内富文本解析：将 `***加粗斜体***` / `**加粗**` / `*斜体*` / `` `行内代码` `` 转为真实节点 */
const INLINE_RICH_RE = /(\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|\*(?!\s)[^*\n]+?(?<!\s)\*|`[^`\n]+?`)/g;

export function renderPolicyInlineRichText(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let cursor = 0;
	let key = 0;
	for (const match of text.matchAll(INLINE_RICH_RE)) {
		const index = match.index ?? -1;
		const token = match[0];
		if (index < 0 || !token) continue;
		if (index > cursor) {
			nodes.push(<Fragment key={key++}>{text.slice(cursor, index)}</Fragment>);
		}
		if (token.startsWith("***") && token.endsWith("***") && token.length > 6) {
			nodes.push(
				<strong key={key++} className="font-semibold text-ink">
					<em className="italic">{token.slice(3, -3)}</em>
				</strong>,
			);
		} else if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
			nodes.push(
				<strong key={key++} className="font-semibold text-ink">
					{token.slice(2, -2)}
				</strong>,
			);
		} else if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
			nodes.push(
				<em key={key++} className="italic">
					{token.slice(1, -1)}
				</em>,
			);
		} else if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
			nodes.push(
				<code key={key++} className="rounded bg-hover px-1 py-0.5 font-mono text-ui-12">
					{token.slice(1, -1)}
				</code>,
			);
		} else {
			nodes.push(<Fragment key={key++}>{token}</Fragment>);
		}
		cursor = index + token.length;
	}
	if (cursor < text.length) {
		nodes.push(<Fragment key={key++}>{text.slice(cursor)}</Fragment>);
	}
	return nodes.length > 0 ? nodes : [text];
}

const DRAFT_POLICY_PROMPT =
	"请读取最新局势书与 01-设定与国力实册/，为我起草本轮国策并通过 wenyou_write_policy_docx 生成宋体排版 Word (.docx) 文档，采用自然段叙述。";

/** Tab 2 — 国策书案 (.docx) 只读纸面预览面板 */
export function PolicyDeskPanel() {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const selectedPolicyId = useWenyouCanvasStore((s) => s.selectedPolicyId);
	const setSelectedPolicyId = useWenyouCanvasStore((s) => s.setSelectedPolicyId);

	const [exporting, setExporting] = useState(false);

	const policies = overview?.policies ?? [];
	const currentPolicy =
		policies.find((p) => p.id === selectedPolicyId) ?? policies[0] ?? null;

	const rawCwd = unwrapCwdPath(cwd);
	const remote = isRemoteCwd(cwd);

	const parsed = useMemo(
		() => (currentPolicy ? parsePolicyParagraphs(currentPolicy.content) : null),
		[currentPolicy],
	);

	const stats = useMemo(() => {
		if (!currentPolicy || !parsed) return { chars: 0, paras: 0 };
		const cleanChars = currentPolicy.content.replace(/\s+/g, "").length;
		return { chars: cleanChars, paras: parsed.blocks.length };
	}, [currentPolicy, parsed]);

	const handleExportDocx = async () => {
		if (!rawCwd || !currentPolicy?.docxPath) return;
		if (remote) {
			pushExtensionToast("warning", "远端项目的 .docx 文件请在服务器上直接获取", "Wenyou Pro");
			return;
		}
		setExporting(true);
		try {
			const defaultName = sanitizePolicyFileName(`${currentPolicy.serialNo}-${currentPolicy.title}`);
			const savedPath = await getPi().wenyouExportDocxDialog({
				cwd: rawCwd,
				relPath: currentPolicy.docxPath,
				defaultName,
			});
			if (savedPath) {
				pushExtensionToast("info", `已另存为 Word 文档：${savedPath}`, "Wenyou Pro");
			}
		} catch (error) {
			pushExtensionToast(
				"error",
				`导出 Word 文档失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			setExporting(false);
		}
	};

	const handleRevealFile = async () => {
		if (!rawCwd || !currentPolicy) return;
		if (remote) {
			pushExtensionToast("warning", "远端文件不支持在本地文件管理器定位", "Wenyou Pro");
			return;
		}
		try {
			await getPi().wenyouRevealFile({
				cwd: rawCwd,
				relPath: currentPolicy.docxPath ?? currentPolicy.markdownPath,
			});
		} catch (error) {
			pushExtensionToast(
				"error",
				`打开目录失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		}
	};

	const handleDraftPrompt = () => {
		fillWenyouPrompt(DRAFT_POLICY_PROMPT);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶工具条 */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<span className="text-ui-12 font-medium text-ink">
					国策书案{policies.length > 0 ? ` (${policies.length})` : ""}
				</span>

				<div className="flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						onClick={handleDraftPrompt}
						className="rounded-lg border border-border px-2.5 py-1 text-ui-12 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
					>
						让司命起草国策
					</button>
					{currentPolicy && (
						<>
							<button
								type="button"
								onClick={() => void handleRevealFile()}
								className="rounded-lg border border-border px-2.5 py-1 text-ui-12 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
							>
								打开所在目录
							</button>
							<button
								type="button"
								disabled={exporting || !currentPolicy.docxPath}
								onClick={() => void handleExportDocx()}
								className="rounded-lg bg-accent px-3 py-1 text-ui-12 font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-45"
								title={currentPolicy.docxPath ? "导出宋体排版 Word (.docx) 文件" : "该国策尚无 .docx 文件"}
							>
								{exporting ? "导出中…" : "另存为 Word (.docx)"}
							</button>
						</>
					)}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{currentPolicy && parsed ? (
					<div className="space-y-4">
						{/* 国策列表选择 */}
						<div className="flex flex-wrap items-center gap-2">
							<select
								aria-label="选择国策文书"
								value={currentPolicy.id}
								onChange={(e) => setSelectedPolicyId(e.target.value)}
								className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
							>
								{policies.map((p) => (
									<option key={p.id} value={p.id}>
										[{p.serialNo}] {p.title}
										{p.turnLabel ? ` · ${p.turnLabel}` : ""}
									</option>
								))}
							</select>
						</div>

						{/* 字数/段数与 .docx 状态 */}
						<div className="flex flex-wrap items-center gap-3 text-ui-12 text-ink-dim">
							<span>
								正文 <strong className="font-mono text-ink">{stats.chars}</strong> 字
							</span>
							<span>
								自然段 <strong className="font-mono text-ink">{stats.paras}</strong> 段
							</span>
							{currentPolicy.docxPath && (
								<span className="font-mono text-ui-11 text-ok">.docx 已就绪</span>
							)}
						</div>

						{/* 模拟公文纸面排版预览（单层容器，浅深双主题舒适阅读） */}
						<article className="select-text rounded-xl border border-border bg-surface px-7 py-7 shadow-soft">
							<header className="border-b border-border pb-4 text-center">
								<h2
									className="text-ui-18 font-semibold tracking-wide text-ink"
									style={{ fontFamily: '"Songti SC", "SimSun", "Noto Serif SC", Georgia, serif' }}
								>
									{renderPolicyInlineRichText(parsed.heading || currentPolicy.title)}
								</h2>
								<p className="mt-2 text-ui-11 text-ink-dim">
									{[
										`编号 ${currentPolicy.serialNo}`,
										currentPolicy.actor,
										currentPolicy.turnLabel,
										formatShortTime(currentPolicy.createdAt),
									]
										.filter(Boolean)
										.join(" · ")}
								</p>
							</header>
							<div
								className="mt-5 space-y-3.5 text-ui-14 leading-[1.9] text-ink"
								style={{ fontFamily: '"Songti SC", "SimSun", "Noto Serif SC", Georgia, serif' }}
							>
								{parsed.blocks.map((block) => {
									if (block.kind === "subheading") {
										return (
											<h3 key={block.key} className="pt-1 text-ui-15 font-semibold text-ink break-words">
												{renderPolicyInlineRichText(block.text)}
											</h3>
										);
									}
									if (block.kind === "list-item" && block.bullet) {
										return (
											<p key={block.key} className="pl-[1.5em] -indent-[0.9em] break-words">
												<span className="mr-1.5 text-ink-dim">•</span>
												{renderPolicyInlineRichText(block.text)}
											</p>
										);
									}
									return (
										<p key={block.key} className="indent-[2em] break-words">
											{renderPolicyInlineRichText(block.text)}
										</p>
									);
								})}
							</div>
						</article>
					</div>
				) : (
					<div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
						<p className="text-ui-14 font-medium text-ink">03-国策与文书/ 尚无国策文档</p>
						<p className="max-w-sm text-ui-12 leading-relaxed text-ink-dim">
							可让司命依据最新局势书与 01-设定与国力实册/ 起草本轮国策，并直接生成宋体排版 Word（.docx）存档于书案。
						</p>
						<div className="mt-1 flex items-center gap-2">
							<button
								type="button"
								onClick={handleDraftPrompt}
								className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90"
							>
								让司命起草本轮国策
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
