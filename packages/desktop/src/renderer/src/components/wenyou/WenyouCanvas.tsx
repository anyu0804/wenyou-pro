import type { WenyouCanvasTab } from "@percho/shared";
import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getPi } from "../../api";
import {
	useWenyouCanvasStore,
	WENYOU_CANVAS_MAX_WIDTH,
	WENYOU_CANVAS_MIN_WIDTH,
} from "../../stores/wenyou-canvas";
import { CloseIcon } from "../icons";
import { AtlasComparePanel } from "./AtlasComparePanel";
import { BriefingPanel } from "./BriefingPanel";
import { PolicyDeskPanel } from "./PolicyDeskPanel";
import { ProposalsExportPanel } from "./ProposalsExportPanel";
import { SourceContextDrawer } from "./SourceContextDrawer";
import { isRemoteCwd, unwrapCwdPath } from "./wenyou-helpers";
import { bootstrapCampaignWorld } from "./world-bootstrap";

const TABS: Array<{ id: WenyouCanvasTab; label: string }> = [
	{ id: "briefing", label: "局势书与台账" },
	{ id: "policy-desk", label: "国策书案" },
	{ id: "atlas-compare", label: "地图与沙盘" },
	{ id: "archive-export", label: "设定与编年史" },
];

/** 左缘 8px 隐形拖拽把手（镜像 SidebarResizeHandle，具备多路径松手兜底防粘滞） */
function WenyouCanvasResizeHandle({
	value,
	onResizingChange,
}: {
	value: number;
	onResizingChange: (resizing: boolean) => void;
}) {
	const previewWidth = useWenyouCanvasStore((s) => s.previewWidth);
	const commitWidth = useWenyouCanvasStore((s) => s.commitWidth);
	const handleRef = useRef<HTMLHRElement | null>(null);
	const draggingRef = useRef(false);
	const pointerIdRef = useRef<number | null>(null);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const finish = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		const pointerId = pointerIdRef.current;
		pointerIdRef.current = null;
		document.body.style.cursor = "";
		onResizingChange(false);
		commitWidth();
		const handle = handleRef.current;
		if (handle && pointerId !== null && handle.hasPointerCapture(pointerId)) {
			handle.releasePointerCapture(pointerId);
		}
	}, [commitWidth, onResizingChange]);

	useEffect(() => {
		const onBlurOrHide = () => finish();
		window.addEventListener("blur", onBlurOrHide);
		document.addEventListener("visibilitychange", onBlurOrHide);
		return () => {
			window.removeEventListener("blur", onBlurOrHide);
			document.removeEventListener("visibilitychange", onBlurOrHide);
		};
	}, [finish]);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLHRElement>) => {
			if (event.button !== 0 || draggingRef.current) return;
			draggingRef.current = true;
			handleRef.current = event.currentTarget;
			pointerIdRef.current = event.pointerId;
			startXRef.current = event.clientX;
			startWidthRef.current = useWenyouCanvasStore.getState().width;
			event.currentTarget.setPointerCapture(event.pointerId);
			document.body.style.cursor = "col-resize";
			onResizingChange(true);
			event.preventDefault();
		},
		[onResizingChange],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLHRElement>) => {
			if (!draggingRef.current) return;
			if (event.buttons === 0) {
				finish();
				return;
			}
			// 右侧面板：指针向左拉（clientX 减小）= 宽度增加
			const next = startWidthRef.current + (startXRef.current - event.clientX);
			previewWidth(next);
		},
		[finish, previewWidth],
	);

	return (
		<hr
			ref={handleRef}
			className="wenyou-canvas-resize-handle"
			aria-orientation="vertical"
			aria-label="调整文游工作台宽度"
			aria-valuemin={WENYOU_CANVAS_MIN_WIDTH}
			aria-valuemax={WENYOU_CANVAS_MAX_WIDTH}
			aria-valuenow={value}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
		/>
	);
}

/** 未初始化工作区引导卡（无预设模板：支持一键新建空白世界或直接绑群让 Agent 抓取建档） */
function InitCampaignGuide({
	cwd,
	loading,
	onInit,
	onOpenCreateWorld,
}: {
	cwd: string | null;
	loading: boolean;
	onInit: (worldTitle?: string, currentEra?: string) => Promise<void>;
	onOpenCreateWorld: () => void;
}) {
	const [worldTitle, setWorldTitle] = useState("");
	const [mainGroupId, setMainGroupId] = useState("");
	const [mainGroupName, setMainGroupName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);

	const rawCwd = unwrapCwdPath(cwd);
	const isLocal = Boolean(rawCwd) && !isRemoteCwd(cwd);

	const handleInitAndGrab = async () => {
		if (!rawCwd) return;
		const gid = mainGroupId.trim();
		if (gid && !/^\d{5,15}$/.test(gid)) {
			setLocalError("主群号需为 5～15 位纯数字（或留空稍后绑定）");
			return;
		}
		setLocalError(null);
		setSubmitting(true);
		try {
			let ntqqReady = false;
			if (gid && isLocal) {
				const st = await getPi().wenyouNtqqGetStatus().catch(() => null);
				ntqqReady = st?.status.ready === true;
			}
			await bootstrapCampaignWorld({
				existingCwd: rawCwd,
				worldTitle: worldTitle.trim() || undefined,
				bindings: gid
					? [
							{
								groupId: gid,
								groupName: mainGroupName.trim() || gid,
								role: "main",
							},
						]
					: [],
				ntqqReady,
				autoStartAgent: true,
			});
		} catch (error) {
			setLocalError(error instanceof Error ? error.message : String(error));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center">
			<div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-surface p-6 text-left">
				<div>
					<h2 className="text-ui-16 font-semibold text-ink">
						{cwd ? "初始化空白文游世界" : "从空白世界开始"}
					</h2>
					<p className="mt-1 text-ui-12 leading-relaxed text-ink-dim">
						{cwd
							? "不会写入任何演示模板；初始化空目录结构后，绑定主要 QQ 群即可由司命直接抓取建档。"
							: "当前还没有打开文游世界。点击下方新建空白世界，选定主要 QQ 群后让司命自动抓取群聊梳理设定与局势。"}
					</p>
				</div>

				{!cwd ? (
					<button
						type="button"
						onClick={onOpenCreateWorld}
						className="w-full rounded-xl bg-ink px-4 py-2 text-ui-13 font-medium text-on-ink transition-opacity hover:opacity-90"
					>
						新建空白世界（绑群抓取）
					</button>
				) : (
					<>
						<div className="space-y-2.5">
							<label className="block space-y-1">
								<span className="text-ui-11 text-ink-dim">世界名称（可选）</span>
								<input
									type="text"
									value={worldTitle}
									onChange={(e) => setWorldTitle(e.target.value)}
									placeholder="例如：文明不朽 / 顺唐文游"
									className="w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-ui-13 text-ink outline-none focus:border-accent"
								/>
							</label>
							{isLocal && (
								<div className="space-y-1">
									<span className="text-ui-11 text-ink-dim">主要 QQ 群号（可选，填入后自动拉取建档）</span>
									<div className="flex gap-2">
										<input
											type="text"
											value={mainGroupId}
											onChange={(e) => setMainGroupId(e.target.value)}
											placeholder="主群号（如 951594174）"
											className="w-40 rounded-lg border border-border bg-canvas px-2.5 py-1.5 font-mono text-ui-12 text-ink outline-none focus:border-accent"
										/>
										<input
											type="text"
											value={mainGroupName}
											onChange={(e) => setMainGroupName(e.target.value)}
											placeholder="群名（可选）"
											className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
										/>
									</div>
								</div>
							)}
						</div>
						{localError && (
							<p className="rounded-lg border border-err/30 bg-err/8 px-3 py-1.5 text-ui-12 text-err">
								{localError}
							</p>
						)}
						<div className="flex flex-col gap-2">
							{isLocal && (
								<button
									type="button"
									disabled={loading || submitting}
									onClick={() => void handleInitAndGrab()}
									className="w-full rounded-xl bg-ink px-4 py-2 text-ui-13 font-medium text-on-ink transition-opacity hover:opacity-90 disabled:opacity-50"
								>
									{submitting ? "正在同步并唤起司命…" : "初始化并让司命抓取建档"}
								</button>
							)}
							<button
								type="button"
								disabled={loading || submitting}
								onClick={() => void onInit(worldTitle, "起始建档")}
								className={`w-full rounded-xl px-4 py-2 text-ui-12 font-medium transition-colors disabled:opacity-50 ${
									isLocal
										? "border border-border bg-canvas text-ink-2 hover:bg-hover hover:text-ink"
										: "bg-ink text-on-ink hover:opacity-90"
								}`}
							>
								{loading ? "初始化中…" : "仅初始化空白目录"}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/** 右侧并排可拖拽「文游动态画布」 */
export function WenyouCanvas() {
	const open = useWenyouCanvasStore((s) => s.open);
	const maximized = useWenyouCanvasStore((s) => s.maximized);
	const width = useWenyouCanvasStore((s) => s.width);
	const activeTab = useWenyouCanvasStore((s) => s.activeTab);
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const loading = useWenyouCanvasStore((s) => s.loading);
	const error = useWenyouCanvasStore((s) => s.error);

	const setOpen = useWenyouCanvasStore((s) => s.setOpen);
	const setCreateWorldDialogOpen = useWenyouCanvasStore((s) => s.setCreateWorldDialogOpen);
	const toggleMaximized = useWenyouCanvasStore((s) => s.toggleMaximized);
	const setActiveTab = useWenyouCanvasStore((s) => s.setActiveTab);
	const refreshOverview = useWenyouCanvasStore((s) => s.refreshOverview);
	const initCampaign = useWenyouCanvasStore((s) => s.initCampaign);

	const [resizing, setResizing] = useState(false);
	const [containerWidth, setContainerWidth] = useState(1280);
	const asideRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const update = () => {
			const parentWidth = asideRef.current?.parentElement?.clientWidth ?? window.innerWidth;
			setContainerWidth(parentWidth);
		};
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, [open]);

	const renderWidth = useMemo(() => {
		// 确保中间聊天列至少留出 360px
		const maxAllowed = Math.max(WENYOU_CANVAS_MIN_WIDTH, containerWidth - 380);
		if (maximized) return Math.min(maxAllowed, Math.max(760, Math.round(containerWidth * 0.64)));
		return Math.min(maxAllowed, Math.max(WENYOU_CANVAS_MIN_WIDTH, width));
	}, [containerWidth, maximized, width]);

	if (!open) return null;

	return (
		<aside
			ref={asideRef}
			data-wenyou-canvas=""
			className={`wenyou-canvas relative flex min-h-0 flex-col border-l border-border bg-canvas ${
				resizing ? "is-resizing" : ""
			}`}
			style={{ "--wenyou-canvas-width": `${renderWidth}px` } as CSSProperties}
			aria-label="文游动态画布"
		>
			{!maximized && <WenyouCanvasResizeHandle value={renderWidth} onResizingChange={setResizing} />}

			{/* 顶栏：世界标题 + 刷新/宽屏/收起 */}
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3.5 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-ui-13 font-semibold text-ink">
						{overview?.initialized ? overview.worldTitle : "文游工作台"}
					</span>
					{overview?.currentEra && (
						<span className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-ui-10 text-ink-dim">
							{overview.currentEra}
						</span>
					)}
				</div>

				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						disabled={loading || !cwd}
						onClick={() => void refreshOverview()}
						title="刷新工作区数据"
						aria-label="刷新工作区数据"
						className="rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className={loading ? "animate-spin" : ""}
							aria-hidden="true"
						>
							<path d="M21 12a9 9 0 1 1-2.64-6.36" />
							<path d="M21 3v6h-6" />
						</svg>
					</button>

					<button
						type="button"
						onClick={toggleMaximized}
						title={maximized ? "恢复标准分屏宽度" : "宽屏展开（适合双屏比对地图）"}
						aria-label={maximized ? "恢复标准分屏宽度" : "宽屏展开"}
						className={`rounded-lg p-1.5 transition-colors ${
							maximized
								? "bg-hover text-ink"
								: "text-ink-dim hover:bg-hover hover:text-ink"
						}`}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							{maximized ? (
								<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
							) : (
								<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
							)}
						</svg>
					</button>

					<button
						type="button"
						onClick={() => setOpen(false)}
						title="收起文游工作台"
						aria-label="收起文游工作台"
						className="rounded-lg p-1.5 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
					>
						<CloseIcon size={11} />
					</button>
				</div>
			</div>

			{/* 4 页签栏 */}
			<div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
				{TABS.map((tab) => {
					const active = activeTab === tab.id;
					const badge =
						tab.id === "briefing" && (overview?.unreportedCount ?? 0) > 0
							? overview?.unreportedCount
							: 0;
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							className={`relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-ui-12 font-medium transition-colors ${
								active
									? "bg-bubble text-ink"
									: "text-ink-dim hover:bg-hover hover:text-ink"
							}`}
						>
							<span>{tab.label}</span>
							{badge ? (
								<span className="rounded-full bg-accent/15 px-1.5 font-mono text-ui-10 font-semibold text-accent">
									{badge}
								</span>
							) : null}
						</button>
					);
				})}
			</div>

			{/* 内容视口（含原文核查浮层抽屉） */}
			<div className="relative min-h-0 flex-1 overflow-hidden">
				{error && (
					<div className="m-4 rounded-xl border border-err/30 bg-err/8 px-3.5 py-2.5 text-ui-12 text-err">
						读取文游工作区失败：{error}
					</div>
				)}
				{error && !overview ? null : !cwd || (overview && !overview.initialized) ? (
					<InitCampaignGuide
						cwd={cwd}
						loading={loading}
						onInit={initCampaign}
						onOpenCreateWorld={() => setCreateWorldDialogOpen(true)}
					/>
				) : loading && !overview ? (
					<div className="flex h-full items-center justify-center text-ui-13 text-ink-dim">
						正在读取文游工作区…
					</div>
				) : (
					<>
						{activeTab === "briefing" && <BriefingPanel />}
						{activeTab === "policy-desk" && <PolicyDeskPanel />}
						{activeTab === "atlas-compare" && <AtlasComparePanel />}
						{activeTab === "archive-export" && <ProposalsExportPanel />}
					</>
				)}
				<SourceContextDrawer />
			</div>
		</aside>
	);
}
