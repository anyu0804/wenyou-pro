import { useMemo, useState } from "react";
import { getPi } from "../../api";
import { pushExtensionToast } from "../../stores/toasts";
import { fillWenyouPrompt, useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { formatShortTime, isRemoteCwd, unwrapCwdPath } from "./wenyou-helpers";

/** 拆分自然段用于公文纸面预览 */
function parsePolicyParagraphs(content: string): { heading?: string; paragraphs: string[] } {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	let heading: string | undefined;
	const paragraphs: string[] = [];
	let buffer: string[] = [];

	const flush = () => {
		if (buffer.length > 0) {
			paragraphs.push(buffer.join(" ").trim());
			buffer = [];
		}
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			flush();
			continue;
		}
		if (!heading && /^#\s+(.+)$/.test(line)) {
			heading = line.replace(/^#\s+/, "").trim();
			continue;
		}
		if (/^#{2,6}\s+/.test(line)) {
			flush();
			paragraphs.push(line.replace(/^#{2,6}\s+/, "").trim());
			continue;
		}
		buffer.push(line);
	}
	flush();
	return { heading, paragraphs };
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
		return { chars: cleanChars, paras: parsed.paragraphs.length };
	}, [currentPolicy, parsed]);

	const handleExportDocx = async () => {
		if (!rawCwd || !currentPolicy?.docxPath) return;
		if (remote) {
			pushExtensionToast("warning", "远端项目的 .docx 文件请在服务器上直接获取", "Wenyou Pro");
			return;
		}
		setExporting(true);
		try {
			const defaultName = `${currentPolicy.serialNo}-${currentPolicy.title}.docx`;
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
									{parsed.heading || currentPolicy.title}
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
								{parsed.paragraphs.map((para, idx) => (
									<p key={idx} className="indent-[2em] break-words">
										{para}
									</p>
								))}
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
