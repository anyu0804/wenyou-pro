import type { BriefingProgressItem, IntelReliability, RollingLedgerCategory } from "@percho/shared";
import { Fragment, useEffect, useMemo, useState } from "react";
import { getPi } from "../../api";
import { fillWenyouPrompt, useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { NtqqGroupBindDialog } from "./NtqqGroupBindDialog";
import { formatShortTime, isRemoteCwd, unwrapCwdPath } from "./wenyou-helpers";

const PROGRESS_STATUS_META: Record<
	BriefingProgressItem["status"],
	{ label: string; className: string }
> = {
	settled: {
		label: "已定案",
		className: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
	},
	in_progress: {
		label: "推进中",
		className: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
	},
	pending_roll: {
		label: "待掷骰",
		className: "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300",
	},
	blocked: {
		label: "受阻",
		className: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
	},
};

const RELIABILITY_META: Record<
	IntelReliability,
	{ label: string; className: string; dotClass: string }
> = {
	gm_fact: {
		label: "GM 裁定事实",
		className: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
		dotClass: "bg-emerald-500",
	},
	propaganda: {
		label: "单方宣传口径",
		className: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
		dotClass: "bg-rose-500",
	},
	unconfirmed_draft: {
		label: "小群未定案草案",
		className: "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300",
		dotClass: "bg-amber-500",
	},
	player_ooc: {
		label: "玩家 OOC",
		className: "border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-300",
		dotClass: "bg-zinc-400",
	},
};

const LEDGER_CATEGORY_LABEL: Record<RollingLedgerCategory, string> = {
	fact: "事实",
	treaty: "条约",
	military: "军事",
	economy: "国力经济",
	unconfirmed_draft: "未定案草案",
};

/** 渲染内联可点击的 [sourceId] 溯源胶囊 */
function SourceRefPills({
	refs,
	highlightQuote,
	onOpen,
}: {
	refs: string[];
	highlightQuote?: string;
	onOpen: (sourceId: string, highlightQuote?: string) => void;
}) {
	if (!refs.length) return null;
	return (
		<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
			{refs.map((ref) => (
				<button
					key={ref}
					type="button"
					onClick={() => onOpen(ref, highlightQuote)}
					className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-accent/30 bg-accent/8 px-2 py-0.5 font-mono text-ui-11 text-accent transition-colors hover:border-accent hover:bg-accent/15"
					title={`点击回查 ${ref} 的原始群聊上下文（支持扩展长程回溯）`}
				>
					<span>[{ref}]</span>
				</button>
			))}
		</div>
	);
}

/** 将正文中的 [qq-xxx] / [src-xxx] 引用自动渲染为可点溯源胶囊 */
function TextWithSourceLinks({
	text,
	onOpen,
}: {
	text: string;
	onOpen: (sourceId: string, highlightQuote?: string) => void;
}) {
	const parts = useMemo(() => text.split(/(\[(?:qq|src|msg|ev)[-_a-zA-Z0-9]+\])/g), [text]);
	return (
		<>
			{parts.map((part, idx) => {
				const match = part.match(/^\[((?:qq|src|msg|ev)[-_a-zA-Z0-9]+)\]$/);
				if (!match?.[1]) return <Fragment key={idx}>{part}</Fragment>;
				const id = match[1];
				return (
					<button
						key={`${id}-${idx}`}
						type="button"
						onClick={() => onOpen(id)}
						className="mx-0.5 inline-flex cursor-pointer items-center rounded border border-accent/30 bg-accent/8 px-1.5 py-0.5 font-mono text-ui-11 text-accent transition-colors hover:border-accent hover:bg-accent/15"
					>
						{part}
					</button>
				);
			})}
		</>
	);
}

/** Tab 1 — 局势书与台账面板 */
export function BriefingPanel() {
	const overview = useWenyouCanvasStore((s) => s.overview);
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const selectedBriefingId = useWenyouCanvasStore((s) => s.selectedBriefingId);
	const setSelectedBriefingId = useWenyouCanvasStore((s) => s.setSelectedBriefingId);
	const subView = useWenyouCanvasStore((s) => s.briefingSubView);
	const setSubView = useWenyouCanvasStore((s) => s.setBriefingSubView);
	const pullingQq = useWenyouCanvasStore((s) => s.pullingQq);
	const lastPullSummary = useWenyouCanvasStore((s) => s.lastPullSummary);
	const pullQqIncremental = useWenyouCanvasStore((s) => s.pullQqIncremental);
	const openSourceContext = useWenyouCanvasStore((s) => s.openSourceContext);

	const [ledgerFilter, setLedgerFilter] = useState<RollingLedgerCategory | "all">("all");
	const [bindDialogOpen, setBindDialogOpen] = useState(false);
	const [boundGroupCount, setBoundGroupCount] = useState(0);

	const rawCwd = unwrapCwdPath(cwd);
	const isLocalCampaign = Boolean(rawCwd) && !isRemoteCwd(cwd);

	useEffect(() => {
		if (!isLocalCampaign || !rawCwd) {
			setBoundGroupCount(0);
			return;
		}
		let cancelled = false;
		void getPi()
			.wenyouNtqqGetCampaignBindings({ cwd: rawCwd })
			.then((list) => {
				if (!cancelled) setBoundGroupCount(list.length);
			})
			.catch(() => {
				if (!cancelled) setBoundGroupCount(0);
			});
		return () => {
			cancelled = true;
		};
	}, [isLocalCampaign, rawCwd, bindDialogOpen]);

	const briefings = overview?.briefings ?? [];
	const currentBriefing =
		briefings.find((b) => b.id === selectedBriefingId) ?? briefings[0] ?? null;
	const ledger = overview?.rollingLedger ?? [];
	const cursors = overview?.cursors ?? [];

	const filteredLedger = useMemo(() => {
		const list =
			ledgerFilter === "all" ? ledger : ledger.filter((entry) => entry.category === ledgerFilter);
		return [...list].reverse();
	}, [ledger, ledgerFilter]);

	const handleGenerateBriefingPrompt = () => {
		fillWenyouPrompt(
			"请先调用 wenyou_pull_qq 拉取 00-群聊收集/ 各群最新增量消息，结合 wenyou_read_memory 读取历史局势书、L1 滚动台账与设定实册，梳理本轮【进度】【外交局势】【情报核查】并调用 wenyou_publish_briefing 发布结构化局势书。严禁把敌方单方宣传或小群未定案草案写成 GM 裁定事实，每条关键论断须附可点击的 [sourceId]。",
		);
	};

	const handleDraftPolicyFromBriefing = () => {
		const refTitle = currentBriefing ? `《${currentBriefing.title}》（${currentBriefing.turnLabel}）` : "最新局势书";
		fillWenyouPrompt(
			`请依据${refTitle}的战略判断以及 01-设定与国力实册/ 的真实国力数据，为我起草本轮国策并通过 wenyou_write_policy_docx 生成规范 Word (.docx) 文书。要求全自然段编号叙事，严禁 Markdown 表格、多层嵌套清单和空泛套话。`,
			"policy-desk",
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶工具条：子视图切换 + 增量采群 + 快捷出简报 */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-1 rounded-lg bg-hover p-0.5">
					<button
						type="button"
						onClick={() => setSubView("briefing")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							subView === "briefing"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						局势书{briefings.length > 0 ? ` (${briefings.length})` : ""}
					</button>
					<button
						type="button"
						onClick={() => setSubView("ledger")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							subView === "ledger"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						L1 滚动台账{ledger.length > 0 ? ` (${ledger.length})` : ""}
					</button>
				</div>

				<div className="flex flex-wrap items-center gap-1.5">
					{isLocalCampaign && (
						<button
							type="button"
							onClick={() => setBindDialogOpen(true)}
							className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-ui-12 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
							title="选择本机 NTQQ 群并绑定到当前战役，实现直读增量采群"
						>
							<span>绑定 QQ 群</span>
							{boundGroupCount > 0 && (
								<span className="rounded-full bg-hover px-1.5 font-mono text-ui-10 text-ink-dim">
									{boundGroupCount}
								</span>
							)}
						</button>
					)}
					<button
						type="button"
						disabled={pullingQq}
						onClick={() => void pullQqIncremental()}
						className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-ui-12 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink disabled:opacity-50"
					>
						<span>{pullingQq ? "扫描中…" : "扫描群聊增量"}</span>
						{(overview?.unreportedCount ?? 0) > 0 && (
							<span className="rounded-full bg-accent/15 px-1.5 py-0.2 font-mono text-ui-10 font-semibold text-accent">
								+{overview?.unreportedCount}
							</span>
						)}
					</button>
					<button
						type="button"
						onClick={handleGenerateBriefingPrompt}
						className="rounded-lg bg-ink px-2.5 py-1 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90"
					>
						让司命出局势书
					</button>
				</div>
				{bindDialogOpen && <NtqqGroupBindDialog onClose={() => setBindDialogOpen(false)} />}
			</div>

			{/* 各群游标摘要带（仅在存在群游标或刚完成扫描时展示，单层轻量） */}
			{(cursors.length > 0 || lastPullSummary) && (
				<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-hover/40 px-4 py-1.5 text-ui-11 text-ink-dim">
					<span>群聊游标：</span>
					{cursors.map((c) => (
						<span key={c.groupId} className="inline-flex items-center gap-1">
							<span className="text-ink-2">{c.groupName}</span>
							<span className="font-mono text-ink-faint">({c.totalIngested})</span>
							{c.unreportedCount > 0 && (
								<span className="font-mono font-semibold text-warn">
									未报 {c.unreportedCount}
								</span>
							)}
						</span>
					))}
					{lastPullSummary && (
						<span className="ml-auto text-ui-10 text-ink-faint">
							最近扫描 +{lastPullSummary.newlyIngested} 条
						</span>
					)}
				</div>
			)}

			{/* 主体滚动区 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{subView === "briefing" ? (
					currentBriefing ? (
						<div className="space-y-5">
							{/* 历史局势书切换器 */}
							{briefings.length > 1 && (
								<div className="flex items-center gap-2">
									<label htmlFor="wenyou-briefing-select" className="shrink-0 text-ui-12 text-ink-dim">
										期次
									</label>
									<select
										id="wenyou-briefing-select"
										value={currentBriefing.id}
										onChange={(e) => setSelectedBriefingId(e.target.value)}
										className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
									>
										{briefings.map((b) => (
											<option key={b.id} value={b.id}>
												{b.turnLabel} · {b.title} ({b.id})
											</option>
										))}
									</select>
								</div>
							)}

							{/* 核心结论卡（1层轻边框） */}
							<section className="rounded-xl border border-border bg-surface px-4 py-3.5">
								<div className="flex flex-wrap items-center justify-between gap-2 text-ui-11 text-ink-faint">
									<span className="font-medium text-accent">{currentBriefing.turnLabel}</span>
									<span className="font-mono">
										{currentBriefing.id} · {formatShortTime(currentBriefing.createdAt)}
									</span>
								</div>
								<h2 className="mt-1 text-ui-16 font-semibold text-ink">{currentBriefing.title}</h2>
								<p className="mt-2 select-text text-ui-14 leading-relaxed text-ink">
									<TextWithSourceLinks
										text={currentBriefing.headline}
										onOpen={(id, q) => void openSourceContext(id, q)}
									/>
								</p>
							</section>

							{/* 【进度】时间线 */}
							<section className="space-y-2.5">
								<h3 className="text-ui-13 font-semibold text-ink">【进度】</h3>
								{currentBriefing.progressItems.length === 0 ? (
									<p className="text-ui-12 text-ink-faint">本轮暂未记录节点进度。</p>
								) : (
									<div className="space-y-3 border-l-2 border-border pl-3.5">
										{currentBriefing.progressItems.map((item, idx) => {
											const statusMeta = PROGRESS_STATUS_META[item.status] ?? PROGRESS_STATUS_META.in_progress;
											return (
												<div key={`${item.title}-${idx}`} className="relative">
													<div className="flex flex-wrap items-center gap-2">
														<span className="text-ui-13 font-medium text-ink">{item.title}</span>
														<span
															className={`rounded-full border px-2 py-0.5 text-ui-10 font-medium ${statusMeta.className}`}
														>
															{statusMeta.label}
														</span>
													</div>
													<p className="mt-1 select-text text-ui-13 leading-relaxed text-ink-2">
														<TextWithSourceLinks
															text={item.detail}
															onOpen={(id, q) => void openSourceContext(id, q)}
														/>
													</p>
													<SourceRefPills
														refs={item.sourceRefs}
														highlightQuote={item.detail}
														onOpen={(id, q) => void openSourceContext(id, q)}
													/>
												</div>
											);
										})}
									</div>
								)}
							</section>

							{/* 【外交局势】 */}
							<section className="space-y-2 border-t border-border pt-4">
								<h3 className="text-ui-13 font-semibold text-ink">【外交局势】</h3>
								<p className="select-text whitespace-pre-wrap text-ui-13 leading-relaxed text-ink-2">
									<TextWithSourceLinks
										text={currentBriefing.diplomacySummary}
										onOpen={(id, q) => void openSourceContext(id, q)}
									/>
								</p>
							</section>

							{/* 【情报核查】四色语义区分 */}
							<section className="space-y-2.5 border-t border-border pt-4">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<h3 className="text-ui-13 font-semibold text-ink">【情报核查】</h3>
									<div className="flex flex-wrap items-center gap-2 text-ui-10 text-ink-faint">
										{(Object.keys(RELIABILITY_META) as IntelReliability[]).map((k) => (
											<span key={k} className="inline-flex items-center gap-1">
												<span className={`h-1.5 w-1.5 rounded-full ${RELIABILITY_META[k].dotClass}`} />
												{RELIABILITY_META[k].label}
											</span>
										))}
									</div>
								</div>

								{currentBriefing.intelChecks.length === 0 ? (
									<p className="text-ui-12 text-ink-faint">本轮无待核查传闻或单方宣称。</p>
								) : (
									<div className="divide-y divide-border rounded-xl border border-border bg-surface">
										{currentBriefing.intelChecks.map((check, idx) => {
											const meta = RELIABILITY_META[check.reliability] ?? RELIABILITY_META.unconfirmed_draft;
											return (
												<div key={`${check.claim}-${idx}`} className="px-3.5 py-3">
													<div className="flex flex-wrap items-start justify-between gap-2">
														<span className="select-text text-ui-13 font-medium text-ink">
															{check.claim}
														</span>
														<span
															className={`shrink-0 rounded-full border px-2 py-0.5 text-ui-10 font-medium ${meta.className}`}
														>
															{meta.label}
														</span>
													</div>
													<p className="mt-1 select-text text-ui-12 leading-relaxed text-ink-2">
														<TextWithSourceLinks
															text={check.verdict}
															onOpen={(id, q) => void openSourceContext(id, q)}
														/>
													</p>
													<SourceRefPills
														refs={check.sourceRefs}
														highlightQuote={check.claim}
														onOpen={(id, q) => void openSourceContext(id, q)}
													/>
												</div>
											);
										})}
									</div>
								)}
							</section>

							{/* 战略判断与下一步建议 */}
							<section className="space-y-2.5 border-t border-border pt-4">
								<div className="flex items-center justify-between gap-2">
									<h3 className="text-ui-13 font-semibold text-ink">战略判断与下一步建议</h3>
									<button
										type="button"
										onClick={handleDraftPolicyFromBriefing}
										className="rounded-lg border border-border px-2.5 py-1 text-ui-11 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
									>
										据此起草本轮国策 →
									</button>
								</div>
								<p className="select-text whitespace-pre-wrap text-ui-13 leading-relaxed text-ink-2">
									<TextWithSourceLinks
										text={currentBriefing.strategicJudgment}
										onOpen={(id, q) => void openSourceContext(id, q)}
									/>
								</p>
							</section>
						</div>
					) : (
						<div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
							<p className="text-ui-14 font-medium text-ink">尚未发布结构化局势书</p>
							<p className="max-w-sm text-ui-12 leading-relaxed text-ink-dim">
								把 QQ 群聊导出文本（.txt / .json / .jsonl）放入 <code className="font-mono">00-群聊收集/</code>{" "}
								后，先点击「扫描群聊增量」，再让司命发布三段式局势书。
							</p>
							<div className="mt-1 flex items-center gap-2">
								<button
									type="button"
									disabled={pullingQq}
									onClick={() => void pullQqIncremental()}
									className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
								>
									{pullingQq ? "扫描中…" : "扫描群聊增量"}
								</button>
								<button
									type="button"
									onClick={handleGenerateBriefingPrompt}
									className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90"
								>
									生成首期局势书
								</button>
							</div>
						</div>
					)
				) : (
					/* L1 跨群滚动台账视图 */
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-1.5">
							{(["all", "fact", "treaty", "military", "economy", "unconfirmed_draft"] as const).map((cat) => (
								<button
									key={cat}
									type="button"
									onClick={() => setLedgerFilter(cat)}
									className={`rounded-full border px-2.5 py-0.5 text-ui-11 transition-colors ${
										ledgerFilter === cat
											? "border-accent bg-accent/12 font-medium text-accent"
											: "border-border text-ink-dim hover:bg-hover hover:text-ink"
									}`}
								>
									{cat === "all" ? `全部 (${ledger.length})` : LEDGER_CATEGORY_LABEL[cat]}
								</button>
							))}
						</div>

						{filteredLedger.length === 0 ? (
							<div className="py-12 text-center text-ui-12 text-ink-faint">
								当前筛选条件下暂无跨群滚动台账记录。
							</div>
						) : (
							<div className="divide-y divide-border rounded-xl border border-border bg-surface">
								{filteredLedger.map((entry) => {
									const isDraft =
										entry.category === "unconfirmed_draft" || entry.tag.includes("未定案草案");
									return (
										<div key={entry.id} className="px-3.5 py-3">
											<div className="flex flex-wrap items-center justify-between gap-2">
												<div className="flex flex-wrap items-center gap-1.5">
													<span
														className={`rounded-full border px-2 py-0.5 text-ui-10 font-medium ${
															isDraft
																? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
																: "border-border bg-hover text-ink-2"
														}`}
													>
														{isDraft ? "[未定案草案]" : LEDGER_CATEGORY_LABEL[entry.category] ?? entry.tag}
													</span>
													{entry.faction && (
														<span className="rounded-md bg-hover px-1.5 py-0.5 text-ui-11 text-ink-dim">
															{entry.faction}
														</span>
													)}
												</div>
												<span className="font-mono text-ui-10 text-ink-faint">
													{formatShortTime(entry.updatedAt)}
												</span>
											</div>
											<p className="mt-1.5 select-text text-ui-13 leading-relaxed text-ink">
												{entry.summary}
											</p>
											<SourceRefPills
												refs={entry.sourceRefs}
												highlightQuote={entry.summary}
												onOpen={(id, q) => void openSourceContext(id, q)}
											/>
										</div>
									);
								})}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
