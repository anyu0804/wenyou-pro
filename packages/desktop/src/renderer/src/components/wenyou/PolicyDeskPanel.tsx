import { formatViewerScope, type PolicyLintCode, type PolicyLintReport } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { pushExtensionToast } from "../../stores/toasts";
import { fillWenyouPrompt, useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { formatShortTime, isRemoteCwd, unwrapCwdPath } from "./wenyou-helpers";

const LINT_CODE_LABELS: Record<PolicyLintCode, string> = {
	FORBIDDEN_MARKDOWN_TABLE: "禁用表格",
	NESTED_LIST_VIOLATION: "禁用嵌套列表",
	CLICHE_PHRASE: "AI 套话腔",
	CROSS_FACTION_LEAK: "跨阵营透题",
	TIMELINE_ANACHRONISM: "时间线穿帮",
};

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

function LintIssuesList({ report }: { report: PolicyLintReport }) {
	if (report.issues.length === 0) {
		return (
			<div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-ui-12 text-emerald-700 dark:text-emerald-300">
				静态门禁全部通过：零 Markdown 表格、零嵌套列表、零 AI 套话，未检出跨阵营透题或时间线穿帮。
			</div>
		);
	}
	return (
		<div className="divide-y divide-border rounded-xl border border-border bg-surface">
			{report.issues.map((issue, idx) => (
				<div key={`${issue.code}-${idx}`} className="px-3.5 py-2.5">
					<div className="flex flex-wrap items-center gap-1.5">
						<span
							className={`rounded-full border px-2 py-0.5 text-ui-10 font-medium ${
								issue.severity === "error"
									? "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300"
									: "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300"
							}`}
						>
							{issue.severity === "error" ? "阻断" : "提示"} · {LINT_CODE_LABELS[issue.code] ?? issue.code}
						</span>
						<span className="text-ui-12 font-medium text-ink">{issue.message}</span>
					</div>
					{issue.excerpt && (
						<p className="mt-1 truncate font-mono text-ui-11 text-ink-dim">摘录：{issue.excerpt}</p>
					)}
				</div>
			))}
		</div>
	);
}

/** Tab 2 — 国策书案 (.docx) 面板 */
export function PolicyDeskPanel() {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const viewerScope = useWenyouCanvasStore((s) => s.viewerScope);
	const selectedPolicyId = useWenyouCanvasStore((s) => s.selectedPolicyId);
	const setSelectedPolicyId = useWenyouCanvasStore((s) => s.setSelectedPolicyId);
	const refreshOverview = useWenyouCanvasStore((s) => s.refreshOverview);

	const [mode, setMode] = useState<"preview" | "linter">("preview");
	const [exporting, setExporting] = useState(false);
	const [showLintDetail, setShowLintDetail] = useState(false);

	// 零成本静态门禁体检台本地草稿状态
	const [draftTitle, setDraftTitle] = useState("");
	const [draftActor, setDraftActor] = useState("");
	const [draftTurn, setDraftTurn] = useState("");
	const [draftText, setDraftText] = useState("");
	const [linting, setLinting] = useState(false);
	const [writingDocx, setWritingDocx] = useState(false);
	const [liveLintReport, setLiveLintReport] = useState<PolicyLintReport | null>(null);
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;
	const lintRequestSeqRef = useRef(0);
	const writeRequestSeqRef = useRef(0);

	const policies = overview?.policies ?? [];
	const currentPolicy =
		policies.find((p) => p.id === selectedPolicyId) ?? policies[0] ?? null;

	const rawCwd = unwrapCwdPath(cwd);
	const remote = isRemoteCwd(cwd);

	// 切换世界时重置本地体检台草稿与请求序号
	useEffect(() => {
		lintRequestSeqRef.current += 1;
		writeRequestSeqRef.current += 1;
		setDraftTitle("");
		setDraftActor("");
		setDraftTurn("");
		setDraftText("");
		setLiveLintReport(null);
		setLinting(false);
		setWritingDocx(false);
		setShowLintDetail(false);
	}, [cwd]);

	// 切换国策时收起旧体检展开态
	useEffect(() => {
		setShowLintDetail(false);
	}, [currentPolicy?.id]);

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

	const loadPolicyIntoLinter = () => {
		if (currentPolicy) {
			setDraftTitle(currentPolicy.title);
			setDraftActor(currentPolicy.actor ?? "");
			setDraftTurn(currentPolicy.turnLabel ?? overview?.currentEra ?? "");
			setDraftText(currentPolicy.content);
			setLiveLintReport(currentPolicy.lintReport);
		}
		setMode("linter");
	};

	const handleRunLiveLint = async () => {
		const targetCwd = cwd;
		if (!targetCwd || !draftText.trim()) return;
		const seq = ++lintRequestSeqRef.current;
		setLinting(true);
		try {
			const report = await getExecutionApi(targetCwd).wenyouLintPolicy({
				cwd: targetCwd,
				text: draftText,
				viewer: formatViewerScope(viewerScope),
			});
			if (seq !== lintRequestSeqRef.current || cwdRef.current !== targetCwd) return;
			setLiveLintReport(report);
		} catch (error) {
			if (seq !== lintRequestSeqRef.current || cwdRef.current !== targetCwd) return;
			pushExtensionToast(
				"error",
				`静态体检失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			if (seq === lintRequestSeqRef.current) {
				setLinting(false);
			}
		}
	};

	const handleGenerateDocxFromDraft = async (force = false) => {
		const targetCwd = cwd;
		if (!targetCwd || !draftTitle.trim() || !draftText.trim()) {
			pushExtensionToast("warning", "请先填写国策标题与正文内容", "Wenyou Pro");
			return;
		}
		const seq = ++writeRequestSeqRef.current;
		setWritingDocx(true);
		try {
			const res = await getExecutionApi(targetCwd).wenyouWritePolicyDocx({
				cwd: targetCwd,
				title: draftTitle.trim(),
				content: draftText,
				viewer: formatViewerScope(viewerScope),
				...(draftActor.trim() ? { actor: draftActor.trim() } : {}),
				...(draftTurn.trim() ? { turnLabel: draftTurn.trim() } : {}),
				...(force ? { force: true } : {}),
			});
			if (seq !== writeRequestSeqRef.current || cwdRef.current !== targetCwd) return;
			setLiveLintReport(res.lintReport);
			if (!res.ok || !res.artifact) {
				pushExtensionToast(
					"warning",
					res.error ?? "门禁未通过，可修订正文或点「忽略告警强制生成 .docx」",
					"Wenyou Pro",
				);
				return;
			}
			pushExtensionToast(
				"info",
				force && !res.lintReport.passed
					? `已忽略门禁告警并生成 Word 文档：${res.artifact.docxPath}`
					: `已生成规范国策 Word 文档：${res.artifact.docxPath}`,
				"Wenyou Pro",
			);
			setSelectedPolicyId(res.artifact.id);
			setMode("preview");
			await refreshOverview(targetCwd, { silent: true });
		} catch (error) {
			if (seq !== writeRequestSeqRef.current || cwdRef.current !== targetCwd) return;
			pushExtensionToast(
				"error",
				`生成国策文档失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			if (seq === writeRequestSeqRef.current) {
				setWritingDocx(false);
			}
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶工具条 */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-1 rounded-lg bg-hover p-0.5">
					<button
						type="button"
						onClick={() => setMode("preview")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							mode === "preview"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						纸面预览{policies.length > 0 ? ` (${policies.length})` : ""}
					</button>
					<button
						type="button"
						onClick={() => setMode("linter")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							mode === "linter"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						实时门禁体检台
					</button>
				</div>

				<div className="flex flex-wrap items-center gap-1.5">
					{mode === "preview" && currentPolicy && (
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
								title={currentPolicy.docxPath ? "导出规范宋体 Word (.docx) 文件" : "该国策尚无 .docx 文件"}
							>
								{exporting ? "导出中…" : "另存为 Word (.docx)"}
							</button>
						</>
					)}
					{mode === "linter" && (
						<button
							type="button"
							disabled={linting || !draftText.trim()}
							onClick={() => void handleRunLiveLint()}
							className="rounded-lg border border-border px-2.5 py-1 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-45"
						>
							{linting ? "体检中…" : "零成本静态体检"}
						</button>
					)}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{mode === "preview" ? (
					currentPolicy && parsed ? (
						<div className="space-y-4">
							{/* 国策列表选择 + 元信息与门禁状态 */}
							<div className="flex flex-wrap items-center justify-between gap-2">
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
								<button
									type="button"
									onClick={loadPolicyIntoLinter}
									className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
								>
									在体检台编辑
								</button>
							</div>

							{/* 字数/段数与门禁体检徽章 */}
							<div className="flex flex-wrap items-center justify-between gap-2 text-ui-12">
								<div className="flex flex-wrap items-center gap-3 text-ink-dim">
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
								<button
									type="button"
									onClick={() => setShowLintDetail((v) => !v)}
									className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-ui-11 font-medium transition-colors ${
										currentPolicy.lintReport.passed
											? "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
											: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300"
									}`}
								>
									<span>
										{currentPolicy.lintReport.passed
											? "门禁通过 · 零表格/零套话"
											: `门禁告警 · ${currentPolicy.lintReport.issues.length} 项`}
									</span>
								</button>
							</div>

							{showLintDetail && <LintIssuesList report={currentPolicy.lintReport} />}

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
								可让司命依据最新局势书与国力实册起草并自动过门禁生成宋体规范 Word（.docx），也可直接切到「实时门禁体检台」手工校验草稿。
							</p>
							<div className="mt-1 flex items-center gap-2">
								<button
									type="button"
									onClick={() => setMode("linter")}
									className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
								>
									打开静态门禁体检台
								</button>
								<button
									type="button"
									onClick={() =>
										fillWenyouPrompt(
											"请读取最新局势书与 01-设定与国力实册/，为我起草本轮国策并通过 wenyou_write_policy_docx 生成规范 Word (.docx) 文档（严禁表格、嵌套清单与空泛套话）。",
										)
									}
									className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90"
								>
									让司命起草本轮国策
								</button>
							</div>
						</div>
					)
				) : (
					/* 实时静态门禁体检台 */
					<div className="space-y-3.5">
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
							<input
								type="text"
								value={draftTitle}
								onChange={(e) => setDraftTitle(e.target.value)}
								placeholder="国策标题（如：河西屯田与军马整备策）"
								className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink outline-none focus:border-accent sm:col-span-3"
							/>
							<input
								type="text"
								value={draftActor}
								onChange={(e) => setDraftActor(e.target.value)}
								placeholder="阵营/施政主体（可选）"
								className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
							/>
							<input
								type="text"
								value={draftTurn}
								onChange={(e) => setDraftTurn(e.target.value)}
								placeholder="回合/纪年（如：第 4 轮）"
								className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink outline-none focus:border-accent sm:col-span-2"
							/>
						</div>

						<textarea
							rows={12}
							value={draftText}
							onChange={(e) => setDraftText(e.target.value)}
							placeholder="在此输入或粘贴国策正文（建议采用 1. / 2. / 3. 编号自然段叙事，勿使用 Markdown 表格、多层嵌套清单或 AI 套话）…"
							className="w-full resize-y rounded-xl border border-border bg-surface p-3.5 text-ui-13 leading-relaxed text-ink outline-none focus:border-accent"
						/>

						<div className="flex flex-wrap items-center justify-between gap-2">
							<span className="text-ui-11 text-ink-faint">
								当前正文字数：{draftText.replace(/\s+/g, "").length} 字 · 静态体检零 Token 消耗
							</span>
							<div className="flex items-center gap-2">
								<button
									type="button"
									disabled={linting || !draftText.trim()}
									onClick={() => void handleRunLiveLint()}
									className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-45"
								>
									{linting ? "体检中…" : "运行静态门禁体检"}
								</button>
								<button
									type="button"
									disabled={writingDocx || !draftTitle.trim() || !draftText.trim()}
									onClick={() => void handleGenerateDocxFromDraft(false)}
									className="rounded-lg bg-accent px-3 py-1.5 text-ui-12 font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-45"
								>
									{writingDocx ? "生成中…" : "定稿并生成 .docx"}
								</button>
								{liveLintReport && !liveLintReport.passed && (
									<button
										type="button"
										disabled={writingDocx || !draftTitle.trim() || !draftText.trim()}
										onClick={() => void handleGenerateDocxFromDraft(true)}
										className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-ui-12 font-medium text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-45 dark:text-amber-300"
									>
										忽略告警强制生成 .docx
									</button>
								)}
							</div>
						</div>

						{liveLintReport && <LintIssuesList report={liveLintReport} />}
					</div>
				)}
			</div>
		</div>
	);
}
