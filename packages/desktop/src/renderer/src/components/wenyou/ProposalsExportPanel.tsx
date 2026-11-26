import type { ProposalStatus } from "@percho/shared";
import { useMemo, useState } from "react";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { pushExtensionToast } from "../../stores/toasts";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import {
	computeSimpleLineDiff,
	extractAvailableFactions,
	formatShortTime,
	renderOfflineChronicleHtml,
} from "./wenyou-helpers";

const PROPOSAL_STATUS_META: Record<ProposalStatus, { label: string; className: string }> = {
	pending: {
		label: "待审",
		className: "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
	},
	approved: {
		label: "已合入正史",
		className: "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
	},
	rejected: {
		label: "已驳回",
		className: "border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-300",
	},
};

/** Tab 4 — 正史提案审批与群友离线包泄密预检/发包面板 */
export function ProposalsExportPanel() {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const viewerScope = useWenyouCanvasStore((s) => s.viewerScope);
	const selectedProposalId = useWenyouCanvasStore((s) => s.selectedProposalId);
	const setSelectedProposalId = useWenyouCanvasStore((s) => s.setSelectedProposalId);
	const decideProposal = useWenyouCanvasStore((s) => s.decideProposal);
	const openSourceContext = useWenyouCanvasStore((s) => s.openSourceContext);
	const preflightTargetViewer = useWenyouCanvasStore((s) => s.preflightTargetViewer);
	const setPreflightTargetViewer = useWenyouCanvasStore((s) => s.setPreflightTargetViewer);
	const preflightResult = useWenyouCanvasStore((s) => s.preflightResult);
	const preflightLoading = useWenyouCanvasStore((s) => s.preflightLoading);
	const runExportPreflight = useWenyouCanvasStore((s) => s.runExportPreflight);

	const [section, setSection] = useState<"proposals" | "export" | "canon">("proposals");
	const [statusFilter, setStatusFilter] = useState<"all" | ProposalStatus>("all");
	const [diffViewMode, setDiffViewMode] = useState<"diff" | "full">("diff");
	const [decidingId, setDecidingId] = useState<string | null>(null);
	const [exportingFormat, setExportingFormat] = useState<"html" | "json" | null>(null);

	// 正史档案速览状态
	const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
	const [previewDocContent, setPreviewDocContent] = useState<{
		content: string;
		strippedSecretBlocks: number;
	} | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);

	const proposals = overview?.proposals ?? [];
	const pendingCount = proposals.filter((p) => p.status === "pending").length;
	const filteredProposals = useMemo(
		() => (statusFilter === "all" ? proposals : proposals.filter((p) => p.status === statusFilter)),
		[proposals, statusFilter],
	);
	const selectedProposal =
		filteredProposals.find((p) => p.proposalId === selectedProposalId) ??
		filteredProposals[0] ??
		null;

	const diffLines = useMemo(
		() =>
			selectedProposal
				? computeSimpleLineDiff(selectedProposal.beforeContent, selectedProposal.afterContent)
				: [],
		[selectedProposal],
	);

	const factions = useMemo(() => extractAvailableFactions(overview), [overview]);
	const canonDocs = overview?.canonDocs ?? [];

	const handleDecide = async (decision: "approved" | "rejected") => {
		if (!selectedProposal || decidingId) return;
		setDecidingId(selectedProposal.proposalId);
		try {
			await decideProposal(selectedProposal.proposalId, decision);
		} finally {
			setDecidingId(null);
		}
	};

	const handleExportBundle = async (format: "html" | "json") => {
		const report = preflightResult ?? (await runExportPreflight(preflightTargetViewer));
		if (!report) return;
		setExportingFormat(format);
		try {
			const worldSlug = overview?.worldId || "wenyou-chronicle";
			const scopeSlug = preflightTargetViewer.replace(/[^a-zA-Z0-9_-]+/g, "-");
			const defaultName = `${worldSlug}-${scopeSlug}.${format}`;
			const content = format === "html" ? renderOfflineChronicleHtml(report) : report.bundleJson;
			const saved = await getPi().wenyouExportBundleDialog({
				defaultName,
				content,
				format,
			});
			if (saved) {
				pushExtensionToast(
					"info",
					`已安全导出${format === "html" ? "离线 HTML 图史包" : " JSON 归档包"}：${saved}`,
					"Wenyou Pro",
				);
			}
		} catch (error) {
			pushExtensionToast(
				"error",
				`导出离线包失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			setExportingFormat(null);
		}
	};

	const handleOpenCanonDoc = async (relPath: string) => {
		if (!cwd) return;
		setPreviewDocPath(relPath);
		setPreviewLoading(true);
		try {
			const viewer =
				viewerScope.kind === "faction" ? `faction:${viewerScope.factionId}` : viewerScope.kind;
			const res = await getExecutionApi(cwd).wenyouReadCanonDoc({ cwd, relPath, viewer });
			setPreviewDocContent({
				content: res.content,
				strippedSecretBlocks: res.strippedSecretBlocks,
			});
		} catch (error) {
			setPreviewDocContent(null);
			pushExtensionToast(
				"error",
				`读取档案失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			setPreviewLoading(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 子导航切换 */}
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-1 rounded-lg bg-hover p-0.5">
					<button
						type="button"
						onClick={() => setSection("proposals")}
						className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							section === "proposals"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						<span>正史提案审批</span>
						{pendingCount > 0 && (
							<span className="rounded-full bg-amber-500/20 px-1.5 font-mono text-ui-10 font-semibold text-amber-700 dark:text-amber-300">
								{pendingCount}
							</span>
						)}
					</button>
					<button
						type="button"
						onClick={() => setSection("export")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							section === "export"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						泄密预检与发包
					</button>
					<button
						type="button"
						onClick={() => setSection("canon")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							section === "canon"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						可见档案 ({canonDocs.length})
					</button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{section === "proposals" && (
					<div className="space-y-4">
						{/* 状态筛选胶囊 */}
						<div className="flex flex-wrap items-center gap-1.5">
							{(
								[
									{ id: "all", label: `全部 (${proposals.length})` },
									{ id: "pending", label: `待审 (${pendingCount})` },
									{ id: "approved", label: "已合入" },
									{ id: "rejected", label: "已驳回" },
								] as const
							).map((item) => (
								<button
									key={item.id}
									type="button"
									onClick={() => setStatusFilter(item.id)}
									className={`rounded-full border px-2.5 py-0.5 text-ui-11 transition-colors ${
										statusFilter === item.id
											? "border-accent bg-accent/12 font-medium text-accent"
											: "border-border text-ink-dim hover:bg-hover hover:text-ink"
									}`}
								>
									{item.label}
								</button>
							))}
						</div>

						{filteredProposals.length === 0 ? (
							<div className="py-12 text-center">
								<p className="text-ui-13 font-medium text-ink">暂无符合条件的正史变更提案</p>
								<p className="mt-1 text-ui-12 text-ink-dim">
									Agent 调用 <code className="font-mono">wenyou_propose_canon</code> 提交对{" "}
									<code className="font-mono">01-设定与国力实册/</code> 或{" "}
									<code className="font-mono">04-编年史与条约/</code> 的改动后，会在此等待人工落锤审批。
								</p>
							</div>
						) : (
							<>
								{/* 提案选择列表 */}
								<div className="divide-y divide-border rounded-xl border border-border bg-surface">
									{filteredProposals.map((p) => {
										const isSelected = p.proposalId === selectedProposal?.proposalId;
										const meta = PROPOSAL_STATUS_META[p.status];
										return (
											<button
												key={p.proposalId}
												type="button"
												onClick={() => setSelectedProposalId(p.proposalId)}
												className={`flex w-full items-start justify-between gap-2 px-3.5 py-2.5 text-left transition-colors ${
													isSelected ? "bg-accent/8" : "hover:bg-hover/70"
												}`}
											>
												<div className="min-w-0">
													<p className="truncate text-ui-13 font-medium text-ink">{p.summary}</p>
													<p className="mt-0.5 truncate font-mono text-ui-11 text-ink-dim">
														{p.operation === "create" ? "新建" : "修订"} · {p.targetPath}
													</p>
												</div>
												<span
													className={`shrink-0 rounded-full border px-2 py-0.5 text-ui-10 font-medium ${meta.className}`}
												>
													{meta.label}
												</span>
											</button>
										);
									})}
								</div>

								{/* 选中提案详情与前后对照 Diff */}
								{selectedProposal && (
									<div className="space-y-3 border-t border-border pt-4">
										<div className="flex flex-wrap items-start justify-between gap-2">
											<div className="min-w-0">
												<h3 className="text-ui-14 font-semibold text-ink">
													{selectedProposal.summary}
												</h3>
												<p className="mt-0.5 font-mono text-ui-11 text-ink-dim">
													{selectedProposal.targetPath} · {formatShortTime(selectedProposal.createdAt)}
												</p>
											</div>
											<div className="flex items-center gap-1 rounded-lg bg-hover p-0.5">
												<button
													type="button"
													onClick={() => setDiffViewMode("diff")}
													className={`rounded-md px-2 py-0.5 text-ui-11 ${
														diffViewMode === "diff"
															? "bg-canvas font-medium text-ink shadow-soft"
															: "text-ink-dim hover:text-ink"
													}`}
												>
													变更对照
												</button>
												<button
													type="button"
													onClick={() => setDiffViewMode("full")}
													className={`rounded-md px-2 py-0.5 text-ui-11 ${
														diffViewMode === "full"
															? "bg-canvas font-medium text-ink shadow-soft"
															: "text-ink-dim hover:text-ink"
													}`}
												>
													修改后全文
												</button>
											</div>
										</div>

										{selectedProposal.warnings.length > 0 && (
											<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-12 text-amber-700 dark:text-amber-300">
												{selectedProposal.warnings.map((w, i) => (
													<p key={i}>⚠ {w}</p>
												))}
											</div>
										)}

										{selectedProposal.sourceRefs.length > 0 && (
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="text-ui-11 text-ink-dim">关联证据：</span>
												{selectedProposal.sourceRefs.map((ref) => (
													<button
														key={ref}
														type="button"
														onClick={() => void openSourceContext(ref, selectedProposal.summary)}
														className="rounded-full border border-accent/30 bg-accent/8 px-2 py-0.5 font-mono text-ui-11 text-accent transition-colors hover:border-accent hover:bg-accent/15"
													>
														[{ref}]
													</button>
												))}
											</div>
										)}

										{/* Diff / 全文区 */}
										<div className="max-h-[340px] overflow-auto rounded-xl border border-border bg-surface font-mono text-ui-12 select-text">
											{diffViewMode === "diff" ? (
												<div className="divide-y divide-border/40 py-1">
													{diffLines.map((line, idx) => (
														<div
															key={idx}
															className={`flex gap-2 px-3 py-0.5 whitespace-pre-wrap break-all ${
																line.kind === "add"
																	? "bg-emerald-500/12 text-emerald-800 dark:text-emerald-200"
																	: line.kind === "del"
																		? "bg-rose-500/12 text-rose-800 dark:text-rose-200"
																		: "text-ink-2"
															}`}
														>
															<span className="w-8 shrink-0 text-right text-ui-10 text-ink-faint select-none">
																{line.oldLine ?? ""}
															</span>
															<span className="w-8 shrink-0 text-right text-ui-10 text-ink-faint select-none">
																{line.newLine ?? ""}
															</span>
															<span className="w-3 shrink-0 select-none font-bold">
																{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
															</span>
															<span className="min-w-0 flex-1">{line.text || " "}</span>
														</div>
													))}
												</div>
											) : (
												<pre className="whitespace-pre-wrap break-words p-3.5 text-ink">
													{selectedProposal.afterContent}
												</pre>
											)}
										</div>

										{/* 落锤审批按钮 */}
										{selectedProposal.status === "pending" ? (
											<div className="flex flex-wrap items-center justify-between gap-2 pt-1">
												{viewerScope.kind !== "gm" ? (
													<p className="text-ui-12 text-warn">
														当前为非 GM 视角，请先在画布顶栏切回「GM 全局」后再执行落锤裁决。
													</p>
												) : (
													<p className="text-ui-11 text-ink-faint">
														批准后将原子写入目标正史文件；驳回不会改动现有档案。
													</p>
												)}
												<div className="flex items-center gap-2">
													<button
														type="button"
														disabled={viewerScope.kind !== "gm" || decidingId !== null}
														onClick={() => void handleDecide("rejected")}
														className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:border-err/40 hover:bg-err/10 hover:text-err disabled:opacity-45"
													>
														驳回提案
													</button>
													<button
														type="button"
														disabled={viewerScope.kind !== "gm" || decidingId !== null}
														onClick={() => void handleDecide("approved")}
														className="rounded-lg bg-ok px-3.5 py-1.5 text-ui-12 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
													>
														{decidingId === selectedProposal.proposalId ? "处理中…" : "批准合入正史"}
													</button>
												</div>
											</div>
										) : (
											<p className="text-ui-11 text-ink-faint">
												已于 {formatShortTime(selectedProposal.decidedAt)} 裁决为「
												{PROPOSAL_STATUS_META[selectedProposal.status].label}」。
											</p>
										)}
									</div>
								)}
							</>
						)}
					</div>
				)}

				{section === "export" && (
					<div className="space-y-4">
						<div className="space-y-2">
							<h3 className="text-ui-14 font-semibold text-ink">群友离线包泄密预检与发包</h3>
							<p className="text-ui-12 leading-relaxed text-ink-dim">
								系统会按选定视角强制物理拦截 <code className="font-mono">private/</code> 与{" "}
								<code className="font-mono">00-群聊收集/</code> 原始聊天记录，并自动剥离超出权限的{" "}
								<code className="font-mono">:::secret[...]</code> 暗线块。
							</p>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<label htmlFor="wenyou-export-viewer" className="text-ui-12 text-ink-dim">
								发包视角
							</label>
							<select
								id="wenyou-export-viewer"
								value={preflightTargetViewer}
								onChange={(e) => setPreflightTargetViewer(e.target.value)}
								className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
							>
								<option value="public">公开视角（public · 群友通用）</option>
								{factions.map((f) => (
									<option key={f} value={`faction:${f}`}>
										阵营专属（faction:{f}）
									</option>
								))}
							</select>
							<button
								type="button"
								disabled={preflightLoading}
								onClick={() => void runExportPreflight(preflightTargetViewer)}
								className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90 disabled:opacity-50"
							>
								{preflightLoading ? "预检中…" : "运行泄密预检"}
							</button>
						</div>

						{preflightResult && (
							<div className="space-y-4 border-t border-border pt-4">
								{/* 4 项预检指标 */}
								<div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">放行文件</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-ok">
											{preflightResult.allowedFiles.length}
										</p>
									</div>
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">物理拦截私有/群聊</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-warn">
											{preflightResult.blockedPrivateFiles.length}
										</p>
									</div>
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">可见性隔离</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-ink">
											{preflightResult.blockedVisibilityFiles.length}
										</p>
									</div>
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">剥离暗线块</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-accent">
											{preflightResult.strippedSecretBlockCount}
										</p>
									</div>
								</div>

								{preflightResult.warnings.length > 0 && (
									<div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-ui-12 text-emerald-700 dark:text-emerald-300">
										{preflightResult.warnings.map((w, idx) => (
											<p key={idx}>✓ {w}</p>
										))}
									</div>
								)}

								{/* 明确列出已拦截清单，让主持人直观核验绝不泄密 */}
								{preflightResult.blockedPrivateFiles.length > 0 && (
									<div className="space-y-1.5">
										<p className="text-ui-12 font-medium text-ink">
											已物理拦截清单（private/ 与 00-群聊收集/，绝不打包）：
										</p>
										<div className="max-h-36 overflow-y-auto rounded-xl border border-border bg-surface px-3 py-2 font-mono text-ui-11 text-ink-dim">
											{preflightResult.blockedPrivateFiles.map((file) => (
												<div key={file} className="truncate py-0.5">
													✕ {file}
												</div>
											))}
										</div>
									</div>
								)}

								{preflightResult.blockedVisibilityFiles.length > 0 && (
									<div className="space-y-1.5">
										<p className="text-ui-12 font-medium text-ink">
											已按可见性隔离清单（仅 GM 或其他阵营可见）：
										</p>
										<div className="max-h-32 overflow-y-auto rounded-xl border border-border bg-surface px-3 py-2 font-mono text-ui-11 text-ink-dim">
											{preflightResult.blockedVisibilityFiles.map((file) => (
												<div key={file} className="truncate py-0.5">
													⊘ {file}
												</div>
											))}
										</div>
									</div>
								)}

								<div className="flex flex-wrap items-center gap-2 pt-1">
									<button
										type="button"
										disabled={exportingFormat !== null}
										onClick={() => void handleExportBundle("html")}
										className="rounded-lg bg-accent px-3.5 py-1.5 text-ui-12 font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
									>
										{exportingFormat === "html" ? "导出中…" : "导出单文件离线 HTML 图史包"}
									</button>
									<button
										type="button"
										disabled={exportingFormat !== null}
										onClick={() => void handleExportBundle("json")}
										className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
									>
										{exportingFormat === "json" ? "导出中…" : "导出 JSON 归档包"}
									</button>
								</div>
							</div>
						)}
					</div>
				)}

				{section === "canon" && (
					<div className="space-y-3">
						<p className="text-ui-12 text-ink-dim">
							当前视角下可见的设定、国力实册与编年史（切换顶栏视角可即时验证暗线裁剪效果）：
						</p>
						{canonDocs.length === 0 ? (
							<div className="py-10 text-center text-ui-12 text-ink-faint">
								当前视角下暂无可见正史或设定文档。
							</div>
						) : (
							<div className="divide-y divide-border rounded-xl border border-border bg-surface">
								{canonDocs.map((doc) => (
									<button
										key={doc.relPath}
										type="button"
										onClick={() => void handleOpenCanonDoc(doc.relPath)}
										className={`flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors ${
											previewDocPath === doc.relPath ? "bg-accent/8" : "hover:bg-hover/70"
										}`}
									>
										<div className="min-w-0">
											<p className="truncate text-ui-13 font-medium text-ink">{doc.title}</p>
											<p className="truncate font-mono text-ui-11 text-ink-faint">{doc.relPath}</p>
										</div>
										<span className="shrink-0 rounded-full border border-border bg-hover px-2 py-0.5 text-ui-10 text-ink-dim">
											{doc.visibility}
										</span>
									</button>
								))}
							</div>
						)}

						{previewDocPath && (
							<div className="space-y-2 border-t border-border pt-3">
								<div className="flex items-center justify-between text-ui-11 text-ink-dim">
									<span className="font-mono">{previewDocPath}</span>
									{previewDocContent && previewDocContent.strippedSecretBlocks > 0 && (
										<span className="text-accent">
											已剥离 {previewDocContent.strippedSecretBlocks} 处受限暗线块
										</span>
									)}
								</div>
								{previewLoading ? (
									<p className="py-6 text-center text-ui-12 text-ink-faint">读取中…</p>
								) : previewDocContent ? (
									<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3.5 text-ui-12 leading-relaxed text-ink select-text">
										{previewDocContent.content}
									</pre>
								) : null}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
