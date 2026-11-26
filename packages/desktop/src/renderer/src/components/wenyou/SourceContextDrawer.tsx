import type { EvidenceMessageKind } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { CheckIcon, CloseIcon, CopyIcon } from "../icons";
import { formatShortTime } from "./wenyou-helpers";

const KIND_META: Record<EvidenceMessageKind, { label: string; badgeClass: string }> = {
	gm_ruling: {
		label: "GM 裁定",
		badgeClass:
			"border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
	},
	dice_roll: {
		label: "掷骰判定",
		badgeClass: "border-violet-500/30 bg-violet-500/12 text-violet-700 dark:text-violet-300",
	},
	diplomacy: {
		label: "外交照会",
		badgeClass: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
	},
	ooc: {
		label: "OOC 场外",
		badgeClass: "border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-300",
	},
	chat: {
		label: "群聊",
		badgeClass: "border-border bg-hover text-ink-dim",
	},
};

const WINDOW_PRESETS = [10, 30, 100, 300, 1000] as const;

/** 群聊原文核查抽屉：点开任意 sourceId 溯源胶囊后，在画布内浮层展示同群上下文并支持长程回溯与前后翻页追源 */
export function SourceContextDrawer() {
	const drawer = useWenyouCanvasStore((s) => s.sourceDrawer);
	const close = useWenyouCanvasStore((s) => s.closeSourceContext);
	const openSourceContext = useWenyouCanvasStore((s) => s.openSourceContext);
	const setWindow = useWenyouCanvasStore((s) => s.setSourceContextWindow);
	const targetRowRef = useRef<HTMLDivElement | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!drawer.open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [drawer.open, close]);

	useEffect(() => {
		if (!drawer.open || !drawer.data) return;
		const timer = window.setTimeout(() => {
			targetRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
		}, 40);
		return () => window.clearTimeout(timer);
	}, [drawer.open, drawer.data]);

	if (!drawer.open) return null;

	const copySourceRef = () => {
		if (!drawer.sourceId) return;
		void navigator.clipboard?.writeText(`[${drawer.sourceId}]`).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		});
	};

	const activeWin = drawer.data?.windowSize ?? drawer.windowSize;
	const totalInGroup = drawer.data?.totalGroupMessages ?? drawer.data?.messages.length ?? 0;
	const beforeRemaining = drawer.data?.beforeRemaining ?? 0;
	const afterRemaining = drawer.data?.afterRemaining ?? 0;
	const firstMessage = drawer.data?.messages[0];
	const lastMessage = drawer.data?.messages[drawer.data.messages.length - 1];

	return (
		<div
			className="absolute inset-0 z-20 flex flex-col bg-canvas/95 backdrop-blur-xs"
			role="dialog"
			aria-label="群聊原文核查抽屉"
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-ui-13 font-semibold text-ink">原文上下文核查</span>
						{drawer.sourceId && (
							<span className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-ui-11 text-accent">
								{drawer.sourceId}
							</span>
						)}
					</div>
					{drawer.data && (
						<p className="mt-0.5 truncate text-ui-11 text-ink-dim">
							{drawer.data.groupName}（{drawer.data.groupId}）· 前后 ±{activeWin} · 展示{" "}
							{drawer.data.messages.length} / 群库共 {totalInGroup} 条
						</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{drawer.sourceId && (
						<button
							type="button"
							onClick={copySourceRef}
							className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
						>
							{copied ? <CheckIcon size={11} className="text-ok" /> : <CopyIcon size={11} />}
							<span>{copied ? "已复制" : "复制引用"}</span>
						</button>
					)}
					<button
						type="button"
						onClick={close}
						aria-label="关闭原文抽屉"
						className="rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					>
						<CloseIcon size={11} />
					</button>
				</div>
			</div>

			{/* 回溯范围切换条（单层轻量，最高单群覆盖 20,000 条并支持首尾续翻） */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/60 px-4 py-1.5 text-ui-11">
				<div className="flex flex-wrap items-center gap-1">
					<span className="mr-1 text-ink-dim">回溯范围：</span>
					{WINDOW_PRESETS.map((preset) => {
						const active = activeWin === preset;
						return (
							<button
								key={preset}
								type="button"
								disabled={drawer.loading}
								onClick={() => void setWindow(preset)}
								className={`rounded-md border px-2 py-0.5 font-mono transition-colors disabled:opacity-50 ${
									active
										? "border-accent bg-accent/12 font-medium text-accent"
										: "border-border text-ink-dim hover:bg-hover hover:text-ink"
								}`}
							>
								±{preset}
							</button>
						);
					})}
				</div>
				{drawer.loading && drawer.data && <span className="text-ink-faint">正在扩展回溯…</span>}
			</div>

			{drawer.highlightQuote && (
				<div className="shrink-0 border-b border-border bg-hover/60 px-4 py-2 text-ui-12 text-ink-2">
					<span className="mr-1.5 font-medium text-ink">核查摘录：</span>
					<span className="select-text">{drawer.highlightQuote}</span>
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
				{drawer.loading && !drawer.data && (
					<div className="py-12 text-center text-ui-13 text-ink-dim">
						正在回查同群前后 ±{drawer.windowSize} 条原始记录…
					</div>
				)}
				{!drawer.loading && drawer.error && (
					<div className="rounded-xl border border-err/30 bg-err/8 px-3.5 py-3 text-ui-13 text-err">
						{drawer.error}
					</div>
				)}
				{drawer.data && (
					<div className="space-y-2">
						{beforeRemaining > 0 && firstMessage && (
							<button
								type="button"
								disabled={drawer.loading}
								onClick={() => void openSourceContext(firstMessage.sourceId, drawer.highlightQuote, activeWin)}
								className="w-full rounded-lg border border-dashed border-border bg-surface/60 px-3 py-2 text-ui-12 text-ink-2 transition-colors hover:border-accent/50 hover:bg-hover hover:text-ink disabled:opacity-50"
							>
								↑ 继续向上追查更早原话（前方还有 {beforeRemaining} 条同群记录）
							</button>
						)}
						{drawer.data.messages.map((msg, idx) => {
							const isTarget =
								idx === drawer.data?.targetIndex || msg.sourceId === drawer.data?.targetSourceId;
							const meta = KIND_META[msg.kind] ?? KIND_META.chat;
							return (
								<div
									key={msg.sourceId}
									ref={isTarget ? targetRowRef : undefined}
									className={`rounded-xl border px-3 py-2.5 transition-colors select-text ${
										isTarget
											? "border-accent bg-accent/8 shadow-soft"
											: "border-border bg-surface"
									}`}
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<div className="flex min-w-0 items-center gap-1.5">
											<span className="truncate text-ui-12 font-semibold text-ink">
												{msg.sender}
											</span>
											<span
												className={`rounded-full border px-1.5 py-0.5 text-ui-10 font-medium ${meta.badgeClass}`}
											>
												{meta.label}
											</span>
											{isTarget && (
												<span className="rounded-full bg-accent px-1.5 py-0.5 text-ui-10 font-medium text-on-accent">
													目标证据
												</span>
											)}
										</div>
										<div className="flex shrink-0 items-center gap-2 text-ui-11 text-ink-faint">
											<span className="font-mono">{msg.sourceId}</span>
											<span>{formatShortTime(msg.timestamp)}</span>
										</div>
									</div>
									<p className="mt-1.5 whitespace-pre-wrap break-words text-ui-13 leading-relaxed text-ink-2">
										{msg.text}
									</p>
								</div>
							);
						})}
						{afterRemaining > 0 && lastMessage && (
							<button
								type="button"
								disabled={drawer.loading}
								onClick={() => void openSourceContext(lastMessage.sourceId, drawer.highlightQuote, activeWin)}
								className="w-full rounded-lg border border-dashed border-border bg-surface/60 px-3 py-2 text-ui-12 text-ink-2 transition-colors hover:border-accent/50 hover:bg-hover hover:text-ink disabled:opacity-50"
							>
								↓ 继续向下查看后续转述（后方还有 {afterRemaining} 条同群记录）
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
