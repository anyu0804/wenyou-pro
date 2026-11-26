import {
	BUILTIN_PIXI_SANDBOX_URL,
	buildBuiltinSandboxUrl,
	buildWenyouAssetUrl,
	formatViewerScope,
	type MapAssetItem,
	type MapSnapshotDiffResult,
	type MapSnapshotSummary,
	PIXI_SANDBOX_PRESET_URLS,
	type SandboxProbeResult,
	WENYOU_MAP_BRIDGE_PROTOCOL,
	WENYOU_SANDBOX_PROTOCOL,
	type WenyouBridgeHostMessage,
	type WenyouBridgeSandboxMessage,
} from "@percho/shared";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { pushExtensionToast } from "../../stores/toasts";
import { fillWenyouPrompt, useWenyouCanvasStore, type WenyouMapMode } from "../../stores/wenyou-canvas";
import {
	compareImageAspects,
	DEFAULT_VIEWPORT,
	type ImageDimensions,
	toggleDoubleClickZoom,
	type ViewportTransform,
	WHEEL_ZOOM_STEP,
	zoomAtPoint,
	zoomCentered,
} from "./atlas-viewport";
import {
	formatFileSize,
	isRemoteCwd,
	sameDirectoryPath,
	sanitizePixiSandboxUrl,
	unwrapCwdPath,
} from "./wenyou-helpers";

function resolveMapUrl(rawCwd: string | null, item: MapAssetItem | null): string | null {
	if (!item) return null;
	if (rawCwd) return buildWenyouAssetUrl(rawCwd, item.relPath, Math.trunc(item.modifiedAt));
	return item.assetUrl;
}

function isBuiltinSandboxUrl(rawUrl: string): boolean {
	try {
		return new URL(rawUrl).protocol === `${WENYOU_SANDBOX_PROTOCOL}:`;
	} catch {
		return false;
	}
}

function isLoopbackHttpUrl(rawUrl: string): boolean {
	try {
		const u = new URL(rawUrl);
		return (
			u.protocol === "http:" &&
			(u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]")
		);
	} catch {
		return false;
	}
}

function formatSigned(n: number): string {
	return n > 0 ? `+${n}` : String(n);
}

function defaultExportFileName(era?: string): string {
	const now = new Date();
	const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
	const safeEra = (era ?? "")
		.trim()
		.replace(/[\\/:*?"<>|\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24);
	return safeEra ? `沙盘快照-${safeEra}-${stamp}.json` : `沙盘快照-${stamp}.json`;
}

/** 可滚轮缩放（50%~500%）与指针拖拽平移的高清图集视口 */
function ZoomableMapStage({
	src,
	label,
	viewport,
	onViewportChange,
}: {
	src: string | null;
	label: string;
	viewport: ViewportTransform;
	onViewportChange: (next: ViewportTransform) => void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const draggingRef = useRef(false);
	const pointerIdRef = useRef<number | null>(null);
	const dragOriginRef = useRef({ clientX: 0, clientY: 0, x: 0, y: 0 });
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const [loadError, setLoadError] = useState(false);

	useEffect(() => {
		setLoadError(false);
	}, [src]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const factor = event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
			const next = zoomAtPoint(
				viewportRef.current,
				factor,
				{ clientX: event.clientX, clientY: event.clientY },
				el.getBoundingClientRect(),
			);
			if (next !== viewportRef.current) onViewportChange(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [onViewportChange]);

	const finishDrag = useCallback((el?: HTMLDivElement | null) => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		const pid = pointerIdRef.current;
		pointerIdRef.current = null;
		const target = el ?? containerRef.current;
		if (target && pid !== null && target.hasPointerCapture(pid)) {
			target.releasePointerCapture(pid);
		}
	}, []);

	useEffect(() => {
		const onRelease = () => finishDrag();
		window.addEventListener("blur", onRelease);
		document.addEventListener("visibilitychange", onRelease);
		return () => {
			window.removeEventListener("blur", onRelease);
			document.removeEventListener("visibilitychange", onRelease);
		};
	}, [finishDrag]);

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !src) return;
		draggingRef.current = true;
		pointerIdRef.current = e.pointerId;
		dragOriginRef.current = {
			clientX: e.clientX,
			clientY: e.clientY,
			x: viewportRef.current.x,
			y: viewportRef.current.y,
		};
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	};

	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		if (e.buttons === 0) {
			finishDrag(e.currentTarget);
			return;
		}
		onViewportChange({
			scale: viewportRef.current.scale,
			x: dragOriginRef.current.x + (e.clientX - dragOriginRef.current.clientX),
			y: dragOriginRef.current.y + (e.clientY - dragOriginRef.current.clientY),
		});
	};

	return (
		<div
			ref={containerRef}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={(e) => finishDrag(e.currentTarget)}
			onPointerCancel={(e) => finishDrag(e.currentTarget)}
			onLostPointerCapture={(e) => finishDrag(e.currentTarget)}
			onDoubleClick={() => onViewportChange(toggleDoubleClickZoom(viewportRef.current))}
			className="relative flex h-full min-h-[260px] w-full flex-1 cursor-grab items-center justify-center overflow-hidden rounded-xl border border-border bg-hover/50 active:cursor-grabbing"
			style={{ touchAction: "none" }}
		>
			<div className="pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-canvas/85 px-2 py-0.5 text-ui-11 font-medium text-ink shadow-soft backdrop-blur-xs">
				{label}
			</div>
			{!src ? (
				<span className="text-ui-12 text-ink-faint">未选择地图</span>
			) : loadError ? (
				<span className="px-4 text-center text-ui-12 text-err">地图加载失败，请确认文件位于工作区允许目录内</span>
			) : (
				<img
					src={src}
					alt={label}
					draggable={false}
					onError={() => setLoadError(true)}
					className="h-full w-full select-none object-contain will-change-transform"
					style={{
						transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
						transformOrigin: "center center",
					}}
				/>
			)}
		</div>
	);
}

/** 卷帘比对视口：指针锚点滚轮缩放 + 防粘滞拖拽平移与垂直卷帘线 + 双图比例对齐检查 */
function SliderCompareStage({
	leftSrc,
	rightSrc,
	leftLabel,
	rightLabel,
	viewport,
	onViewportChange,
}: {
	leftSrc: string | null;
	rightSrc: string | null;
	leftLabel: string;
	rightLabel: string;
	viewport: ViewportTransform;
	onViewportChange: (next: ViewportTransform) => void;
}) {
	const [splitPct, setSplitPct] = useState(50);
	const [leftDims, setLeftDims] = useState<ImageDimensions | null>(null);
	const [rightDims, setRightDims] = useState<ImageDimensions | null>(null);
	const [leftError, setLeftError] = useState(false);
	const [rightError, setRightError] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const draggingRef = useRef<"pan" | "split" | null>(null);
	const pointerIdRef = useRef<number | null>(null);
	const dragOriginRef = useRef({ clientX: 0, clientY: 0, x: 0, y: 0 });

	useEffect(() => {
		setLeftDims(null);
		setLeftError(false);
	}, [leftSrc]);

	useEffect(() => {
		setRightDims(null);
		setRightError(false);
	}, [rightSrc]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const factor = event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
			const next = zoomAtPoint(
				viewportRef.current,
				factor,
				{ clientX: event.clientX, clientY: event.clientY },
				el.getBoundingClientRect(),
			);
			if (next !== viewportRef.current) onViewportChange(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [onViewportChange]);

	const finishDrag = useCallback((el?: HTMLDivElement | null) => {
		if (!draggingRef.current) return;
		draggingRef.current = null;
		const pid = pointerIdRef.current;
		pointerIdRef.current = null;
		const target = el ?? containerRef.current;
		if (target && pid !== null && target.hasPointerCapture(pid)) {
			target.releasePointerCapture(pid);
		}
	}, []);

	useEffect(() => {
		const onRelease = () => finishDrag();
		window.addEventListener("blur", onRelease);
		document.addEventListener("visibilitychange", onRelease);
		return () => {
			window.removeEventListener("blur", onRelease);
			document.removeEventListener("visibilitychange", onRelease);
		};
	}, [finishDrag]);

	const updateSplitFromClientX = (clientX: number) => {
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return;
		const pct = ((clientX - rect.left) / rect.width) * 100;
		setSplitPct(Math.max(4, Math.min(96, Math.round(pct * 10) / 10)));
	};

	const aspectInfo = useMemo(() => compareImageAspects(leftDims, rightDims), [leftDims, rightDims]);

	const transformStyle = {
		transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
		transformOrigin: "center center",
	};

	const hasAnyError = leftError || rightError;

	return (
		<div
			ref={containerRef}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				const isSplit = (e.target as HTMLElement).closest("[data-slider-divider]") !== null;
				draggingRef.current = isSplit ? "split" : "pan";
				pointerIdRef.current = e.pointerId;
				dragOriginRef.current = {
					clientX: e.clientX,
					clientY: e.clientY,
					x: viewportRef.current.x,
					y: viewportRef.current.y,
				};
				e.currentTarget.setPointerCapture(e.pointerId);
				e.preventDefault();
			}}
			onPointerMove={(e) => {
				if (!draggingRef.current) return;
				if (e.buttons === 0) {
					finishDrag(e.currentTarget);
					return;
				}
				if (draggingRef.current === "split") {
					updateSplitFromClientX(e.clientX);
				} else {
					onViewportChange({
						scale: viewportRef.current.scale,
						x: dragOriginRef.current.x + (e.clientX - dragOriginRef.current.clientX),
						y: dragOriginRef.current.y + (e.clientY - dragOriginRef.current.clientY),
					});
				}
			}}
			onPointerUp={(e) => finishDrag(e.currentTarget)}
			onPointerCancel={(e) => finishDrag(e.currentTarget)}
			onLostPointerCapture={(e) => finishDrag(e.currentTarget)}
			onDoubleClick={(e) => {
				if ((e.target as HTMLElement).closest("[data-slider-divider]")) return;
				onViewportChange(toggleDoubleClickZoom(viewportRef.current));
			}}
			className="relative flex h-full min-h-[280px] w-full flex-1 cursor-grab overflow-hidden rounded-xl border border-border bg-hover/50 active:cursor-grabbing"
			style={{ touchAction: "none" }}
		>
			{rightSrc && !rightError && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<img
						src={rightSrc}
						alt={rightLabel}
						draggable={false}
						onLoad={(e) =>
							setRightDims({
								width: e.currentTarget.naturalWidth,
								height: e.currentTarget.naturalHeight,
							})
						}
						onError={() => setRightError(true)}
						className="h-full w-full select-none object-contain will-change-transform"
						style={transformStyle}
					/>
				</div>
			)}
			{leftSrc && !leftError && (
				<div
					className="pointer-events-none absolute inset-0 flex items-center justify-center"
					style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
				>
					<img
						src={leftSrc}
						alt={leftLabel}
						draggable={false}
						onLoad={(e) =>
							setLeftDims({
								width: e.currentTarget.naturalWidth,
								height: e.currentTarget.naturalHeight,
							})
						}
						onError={() => setLeftError(true)}
						className="h-full w-full select-none object-contain will-change-transform"
						style={transformStyle}
					/>
				</div>
			)}

			{hasAnyError && (
				<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-ui-12 text-err">
					{leftError && rightError
						? "左右两张地图均加载失败，请检查工作区路径"
						: leftError
							? `左图加载失败：${leftLabel}`
							: `右图加载失败：${rightLabel}`}
				</div>
			)}

			<div className="pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-canvas/85 px-2 py-0.5 text-ui-11 font-medium text-ink shadow-soft">
				左：{leftLabel}
			</div>
			<div className="pointer-events-none absolute top-2 right-2 z-10 rounded-md bg-canvas/85 px-2 py-0.5 text-ui-11 font-medium text-ink shadow-soft">
				右：{rightLabel}
			</div>

			{aspectInfo?.mismatched && (
				<div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-md bg-canvas/90 px-2.5 py-0.5 text-ui-10 text-amber-700 shadow-soft dark:text-amber-300">
					两图纵横比差异较大（左 {aspectInfo.leftText} · 右 {aspectInfo.rightText}），已等比居中对齐
				</div>
			)}

			{/* 垂直卷帘拖拽把手 */}
			<div
				data-slider-divider=""
				className="absolute inset-y-0 z-20 flex w-6 -translate-x-1/2 cursor-ew-resize items-center justify-center"
				style={{ left: `${splitPct}%` }}
			>
				<div className="h-full w-0.5 bg-accent shadow-soft" />
				<div className="absolute flex h-7 w-7 items-center justify-center rounded-full border border-accent bg-canvas text-ui-11 font-bold text-accent shadow-pop">
					⇄
				</div>
			</div>
		</div>
	);
}

/** Tab 3 — 地图比对与动态沙盘面板 */
export function AtlasComparePanel() {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const viewerScope = useWenyouCanvasStore((s) => s.viewerScope);
	const mapMode = useWenyouCanvasStore((s) => s.mapMode);
	const setMapMode = useWenyouCanvasStore((s) => s.setMapMode);
	const leftMapPath = useWenyouCanvasStore((s) => s.leftMapPath);
	const rightMapPath = useWenyouCanvasStore((s) => s.rightMapPath);
	const setLeftMapPath = useWenyouCanvasStore((s) => s.setLeftMapPath);
	const setRightMapPath = useWenyouCanvasStore((s) => s.setRightMapPath);
	const syncViewport = useWenyouCanvasStore((s) => s.syncViewport);
	const setSyncViewport = useWenyouCanvasStore((s) => s.setSyncViewport);
	const pixiUrl = useWenyouCanvasStore((s) => s.pixiUrl);
	const setPixiUrl = useWenyouCanvasStore((s) => s.setPixiUrl);
	const openSourceContext = useWenyouCanvasStore((s) => s.openSourceContext);
	const refreshOverview = useWenyouCanvasStore((s) => s.refreshOverview);

	const rawCwd = unwrapCwdPath(cwd);
	const localWorkspace = Boolean(rawCwd) && !isRemoteCwd(cwd);
	const maps = overview?.maps ?? [];

	const leftMap = useMemo(
		() => maps.find((m) => m.relPath === leftMapPath) ?? maps[0] ?? null,
		[maps, leftMapPath],
	);
	const rightMap = useMemo(
		() => maps.find((m) => m.relPath === rightMapPath) ?? maps[1] ?? maps[0] ?? null,
		[maps, rightMapPath],
	);

	const [leftViewport, setLeftViewport] = useState<ViewportTransform>(DEFAULT_VIEWPORT);
	const [rightViewport, setRightViewport] = useState<ViewportTransform>(DEFAULT_VIEWPORT);

	// 结构化快照与差分状态
	const [snapshots, setSnapshots] = useState<MapSnapshotSummary[]>([]);
	const [diffFromPath, setDiffFromPath] = useState<string>("");
	const [diffToPath, setDiffToPath] = useState<string>("");
	const [diffResult, setDiffResult] = useState<MapSnapshotDiffResult | null>(null);
	const [diffExpanded, setDiffExpanded] = useState(false);
	const [diffError, setDiffError] = useState<string | null>(null);
	const [selectedSandboxSnapshot, setSelectedSandboxSnapshot] = useState<string>("");
	const [importingFile, setImportingFile] = useState(false);

	// Pixi 沙盘探测与双向桥接状态
	const [pixiDraftUrl, setPixiDraftUrl] = useState(pixiUrl);
	const [pixiNonce, setPixiNonce] = useState(0);
	const [probeMap, setProbeMap] = useState<Record<string, SandboxProbeResult>>({});
	const [probing, setProbing] = useState(false);
	const [bridgeReady, setBridgeReady] = useState(false);
	const [bridgeStatus, setBridgeStatus] = useState<string>("等待沙盘连接");
	const [selectionHint, setSelectionHint] = useState<string | null>(null);
	const [bridgeBusy, setBridgeBusy] = useState(false);
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;
	const bridgeReadyRef = useRef(bridgeReady);
	bridgeReadyRef.current = bridgeReady;
	const snapshotsSeqRef = useRef(0);
	const autoRestoreSeqRef = useRef(0);
	const pendingExportRef = useRef(false);
	const pendingImageTheaterRef = useRef<{
		name: string;
		imageUrl: string;
		imageRelPath: string;
		gridPreset: "coarse" | "standard" | "fine";
	} | null>(null);
	const autoRestoredKeyRef = useRef<string | null>(null);
	const silentAutoLoadRef = useRef(false);
	const autosaveInFlightRef = useRef(false);
	const queuedAutosaveRef = useRef<{ targetCwd: string; projectJson: string } | null>(null);
	const bridgeTimerRef = useRef<number | null>(null);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	const clearBridgeTimer = useCallback(() => {
		if (bridgeTimerRef.current !== null) {
			window.clearTimeout(bridgeTimerRef.current);
			bridgeTimerRef.current = null;
		}
	}, []);

	const armBridgeTimeout = useCallback(
		(timeoutMessage: string) => {
			clearBridgeTimer();
			bridgeTimerRef.current = window.setTimeout(() => {
				bridgeTimerRef.current = null;
				pendingExportRef.current = false;
				setBridgeBusy(false);
				setBridgeStatus(timeoutMessage);
			}, 8000);
		},
		[clearBridgeTimer],
	);

	useEffect(() => clearBridgeTimer, [clearBridgeTimer]);

	// 切换世界时立即清空全部跨世界桥接状态、在途队列与快照列表，防串档写盘或错乱展示
	useEffect(() => {
		clearBridgeTimer();
		snapshotsSeqRef.current += 1;
		autoRestoreSeqRef.current += 1;
		pendingImageTheaterRef.current = null;
		queuedAutosaveRef.current = null;
		pendingExportRef.current = false;
		silentAutoLoadRef.current = false;
		autoRestoredKeyRef.current = null;
		setBridgeBusy(false);
		setBridgeReady(false);
		setBridgeStatus("等待沙盘连接");
		setSelectionHint(null);
		setSnapshots([]);
		setDiffFromPath("");
		setDiffToPath("");
		setDiffResult(null);
		setDiffError(null);
		setSelectedSandboxSnapshot("");
	}, [cwd, clearBridgeTimer]);

	useEffect(() => {
		setPixiDraftUrl(pixiUrl);
	}, [pixiUrl]);

	const reloadSnapshots = useCallback(async () => {
		const targetCwd = cwd;
		const seq = ++snapshotsSeqRef.current;
		if (!targetCwd) {
			setSnapshots([]);
			return;
		}
		try {
			const list = await getExecutionApi(targetCwd).wenyouListMapSnapshots({ cwd: targetCwd });
			if (seq !== snapshotsSeqRef.current || cwdRef.current !== targetCwd) return;
			setSnapshots(list);
			setDiffFromPath((prev) =>
				prev && list.some((s) => s.relPath === prev)
					? prev
					: (list[list.length - 2]?.relPath ?? list[0]?.relPath ?? ""),
			);
			setDiffToPath((prev) =>
				prev && list.some((s) => s.relPath === prev)
					? prev
					: (list[list.length - 1]?.relPath ?? list[0]?.relPath ?? ""),
			);
			const jsonList = list.filter((s) => s.format === "wenyou-project");
			setSelectedSandboxSnapshot((prev) =>
				prev && jsonList.some((s) => s.relPath === prev) ? prev : (jsonList[jsonList.length - 1]?.relPath ?? ""),
			);
		} catch {
			if (seq !== snapshotsSeqRef.current || cwdRef.current !== targetCwd) return;
			setSnapshots([]);
		}
	}, [cwd]);

	useEffect(() => {
		void reloadSnapshots();
	}, [reloadSnapshots, overview]);

	useEffect(() => {
		if (!cwd || snapshots.length < 2 || !diffFromPath || !diffToPath || diffFromPath === diffToPath) {
			setDiffResult(null);
			setDiffError(null);
			return;
		}
		let cancelled = false;
		setDiffError(null);
		void getExecutionApi(cwd)
			.wenyouDiffMaps({ cwd, fromRelPath: diffFromPath, toRelPath: diffToPath })
			.then((res) => {
				if (!cancelled) setDiffResult(res);
			})
			.catch((err) => {
				if (!cancelled) {
					setDiffResult(null);
					setDiffError(err instanceof Error ? err.message : String(err));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, snapshots.length, diffFromPath, diffToPath]);

	const handleLeftViewport = useCallback(
		(next: ViewportTransform) => {
			setLeftViewport(next);
			if (syncViewport) setRightViewport(next);
		},
		[syncViewport],
	);

	const handleRightViewport = useCallback(
		(next: ViewportTransform) => {
			setRightViewport(next);
			if (syncViewport) setLeftViewport(next);
		},
		[syncViewport],
	);

	const adjustZoom = (deltaFactor: number) => {
		const next = zoomCentered(leftViewport, deltaFactor);
		setLeftViewport(next);
		if (syncViewport) setRightViewport(next);
	};

	const resetViewport = () => {
		setLeftViewport(DEFAULT_VIEWPORT);
		setRightViewport(DEFAULT_VIEWPORT);
	};

	const swapMaps = () => {
		const l = leftMap?.relPath ?? null;
		const r = rightMap?.relPath ?? null;
		setLeftMapPath(r);
		setRightMapPath(l);
	};

	const handleImportMapFile = async () => {
		if (!rawCwd || !localWorkspace || importingFile) return;
		setImportingFile(true);
		try {
			const imported = await getPi().wenyouImportMapFileDialog({ cwd: rawCwd });
			if (!imported) return;
			pushExtensionToast("info", `已导入至 ${imported.relPath}`, "Wenyou Pro");
			await refreshOverview(cwd, { silent: true });
			await reloadSnapshots();
		} catch (error) {
			pushExtensionToast(
				"error",
				`导入地图失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			setImportingFile(false);
		}
	};

	const sanitizedPixiUrl = useMemo(() => sanitizePixiSandboxUrl(pixiUrl), [pixiUrl]);

	const isBuiltinSandbox = useMemo(
		() => Boolean(sanitizedPixiUrl && isBuiltinSandboxUrl(sanitizedPixiUrl)),
		[sanitizedPixiUrl],
	);

	const effectiveIframeSrc = useMemo(() => {
		if (!sanitizedPixiUrl) return null;
		return isBuiltinSandbox ? buildBuiltinSandboxUrl(rawCwd) : sanitizedPixiUrl;
	}, [sanitizedPixiUrl, isBuiltinSandbox, rawCwd]);

	const targetOrigin = useMemo(() => {
		if (!sanitizedPixiUrl) return null;
		try {
			const u = new URL(sanitizedPixiUrl);
			if (u.protocol === `${WENYOU_SANDBOX_PROTOCOL}:`) {
				return u.origin && u.origin !== "null" ? u.origin : `${WENYOU_SANDBOX_PROTOCOL}://${u.host || "app"}`;
			}
			return u.origin;
		} catch {
			return null;
		}
	}, [sanitizedPixiUrl]);

	const probeSandboxTargets = useCallback(
		async (overrideUrl?: string | null) => {
			const targets = new Set<string>(
				PIXI_SANDBOX_PRESET_URLS.filter((u) => isLoopbackHttpUrl(u)).map((u) => new URL(u).toString()),
			);
			const active = overrideUrl ?? sanitizedPixiUrl;
			if (active && isLoopbackHttpUrl(active)) {
				targets.add(new URL(active).toString());
			}
			if (targets.size === 0) return;
			setProbing(true);
			try {
				const entries = await Promise.all(
					[...targets].map(async (u) => {
						const res = await getPi().wenyouProbeSandbox({ url: u, timeoutMs: 800 });
						return [u, res] as const;
					}),
				);
				setProbeMap((prev) => {
					const next = { ...prev };
					for (const [u, res] of entries) next[u] = res;
					return next;
				});
			} finally {
				setProbing(false);
			}
		},
		[sanitizedPixiUrl],
	);

	useEffect(() => {
		if (mapMode !== "pixi-sandbox") return;
		setBridgeReady(false);
		setSelectionHint(null);
		if (!isBuiltinSandbox) {
			void probeSandboxTargets();
		}
	}, [mapMode, sanitizedPixiUrl, isBuiltinSandbox, probeSandboxTargets]);

	const activeProbe = sanitizedPixiUrl ? probeMap[sanitizedPixiUrl] : undefined;
	const isLocalTarget = sanitizedPixiUrl ? isLoopbackHttpUrl(sanitizedPixiUrl) : false;
	const canMountIframe = Boolean(sanitizedPixiUrl) && (isBuiltinSandbox || !isLocalTarget || activeProbe?.reachable === true);

	const sendHostMessage = useCallback(
		(msg: WenyouBridgeHostMessage): boolean => {
			if (!iframeRef.current?.contentWindow || !targetOrigin) return false;
			iframeRef.current.contentWindow.postMessage(msg, targetOrigin);
			return true;
		},
		[targetOrigin],
	);

	const dispatchCreateImageTheater = useCallback(
		(req: {
			name: string;
			imageUrl: string;
			imageRelPath: string;
			gridPreset: "coarse" | "standard" | "fine";
		}) => {
			const ok = sendHostMessage({
				protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
				type: "create_image_theater",
				requestId: `img-${Date.now()}`,
				payload: {
					name: req.name,
					imageUrl: req.imageUrl,
					imageRelPath: req.imageRelPath,
					gridPreset: req.gridPreset,
				},
			});
			if (ok) {
				setBridgeBusy(true);
				setBridgeStatus(`正在将「${req.name}」导入动态沙盘…`);
				armBridgeTimeout("导入图片底图超时，请确认沙盘已就绪");
			}
			return ok;
		},
		[sendHostMessage, armBridgeTimeout],
	);

	const flushAutosave = useCallback(
		async (targetCwd: string, projectJson: string) => {
			if (autosaveInFlightRef.current) {
				queuedAutosaveRef.current = { targetCwd, projectJson };
				return;
			}
			if (cwdRef.current !== targetCwd) return;
			autosaveInFlightRef.current = true;
			try {
				const saved = await getExecutionApi(targetCwd).wenyouSaveMapSnapshot({
					cwd: targetCwd,
					fileName: "active-sandbox.json",
					content: projectJson,
				});
				if (cwdRef.current === targetCwd) {
					setBridgeStatus(`已自动同步至 ${saved.relPath}`);
					void reloadSnapshots();
				}
			} catch (err) {
				if (cwdRef.current === targetCwd) {
					const msg = err instanceof Error ? err.message : String(err);
					setBridgeStatus(`自动同步失败：${msg}`);
				}
			} finally {
				autosaveInFlightRef.current = false;
				const nextQueued = queuedAutosaveRef.current;
				queuedAutosaveRef.current = null;
				if (nextQueued && cwdRef.current === nextQueued.targetCwd) {
					void flushAutosave(nextQueued.targetCwd, nextQueued.projectJson);
				}
			}
		},
		[reloadSnapshots],
	);

	const attemptAutoRestoreSnapshot = useCallback(
		async (targetCwd: string) => {
			const seq = ++autoRestoreSeqRef.current;
			try {
				const list = await getExecutionApi(targetCwd).wenyouListMapSnapshots({ cwd: targetCwd });
				if (
					seq !== autoRestoreSeqRef.current ||
					cwdRef.current !== targetCwd ||
					pendingImageTheaterRef.current
				) {
					return;
				}
				const activeFile = list.find(
					(s) =>
						s.format === "wenyou-project" &&
						(s.relPath === "05-沙盘与图集/active-sandbox.json" || s.name === "active-sandbox"),
				);
				const latestProject = [...list]
					.filter((s) => s.format === "wenyou-project")
					.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
				const target = activeFile ?? latestProject;
				if (!target) return;
				const raw = await getExecutionApi(targetCwd).wenyouReadMapSnapshotRaw({
					cwd: targetCwd,
					relPath: target.relPath,
				});
				if (
					seq !== autoRestoreSeqRef.current ||
					cwdRef.current !== targetCwd ||
					pendingImageTheaterRef.current
				) {
					return;
				}
				silentAutoLoadRef.current = true;
				const ok = sendHostMessage({
					protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
					type: "load_project",
					requestId: `autoload-${Date.now()}`,
					payload: {
						fileName: raw.fileName,
						projectJson: raw.content,
						forceOverwrite: true,
					},
				});
				if (ok) {
					setBridgeBusy(true);
					setBridgeStatus(`正在恢复上次沙盘：${raw.fileName}…`);
					armBridgeTimeout("自动恢复沙盘超时");
				} else {
					silentAutoLoadRef.current = false;
				}
			} catch {
				silentAutoLoadRef.current = false;
			}
		},
		[sendHostMessage, armBridgeTimeout],
	);

	const postBridgeContext = useCallback(
		(silent = false) => {
			const ok = sendHostMessage({
				protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
				type: "sync_context",
				payload: {
					worldId: overview?.worldId ?? "",
					worldTitle: overview?.worldTitle ?? "",
					currentEra: overview?.currentEra ?? "",
					viewer: formatViewerScope(viewerScope),
					...(rawCwd ? { workspaceKey: rawCwd } : {}),
				},
			});
			if (ok && !silent) {
				setBridgeStatus(`已发送上下文（${overview?.currentEra ?? "当前"}）`);
			}
		},
		[sendHostMessage, overview?.worldId, overview?.worldTitle, overview?.currentEra, viewerScope, rawCwd],
	);

	// 已握手状态下，世界 ID / 纪年 / 视角变化时自动重新同步上下文
	useEffect(() => {
		if (mapMode !== "pixi-sandbox" || !bridgeReady) return;
		postBridgeContext(true);
	}, [mapMode, bridgeReady, overview?.worldId, overview?.currentEra, viewerScope, postBridgeContext]);

	const handleIframeLoad = useCallback(() => {
		if (!bridgeReadyRef.current) {
			setBridgeStatus("已载入页面，等待沙盘握手…");
		}
		sendHostMessage({
			protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
			type: "ping",
			requestId: `ping-${Date.now()}`,
		});
		postBridgeContext(true);
	}, [sendHostMessage, postBridgeContext]);

	const handleLoadSnapshotToSandbox = async () => {
		if (!cwd || !selectedSandboxSnapshot || bridgeBusy) return;
		setBridgeBusy(true);
		try {
			const raw = await getExecutionApi(cwd).wenyouReadMapSnapshotRaw({
				cwd,
				relPath: selectedSandboxSnapshot,
			});
			const ok = sendHostMessage({
				protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
				type: "load_project",
				requestId: `load-${Date.now()}`,
				payload: {
					fileName: raw.fileName,
					projectJson: raw.content,
					forceOverwrite: true,
				},
			});
			if (!ok) {
				setBridgeBusy(false);
				pushExtensionToast("warning", "沙盘尚未就绪，无法发送快照", "Wenyou Pro");
				return;
			}
			setBridgeStatus(`正在载入 ${raw.fileName}…`);
			armBridgeTimeout("载入快照超时，请确认沙盘已更新至支持桥接的版本");
		} catch (error) {
			clearBridgeTimer();
			setBridgeBusy(false);
			pushExtensionToast(
				"error",
				`读取快照失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		}
	};

	const handleExportSandboxToWorkspace = () => {
		if (!cwd || bridgeBusy) return;
		pendingExportRef.current = true;
		setBridgeBusy(true);
		const ok = sendHostMessage({
			protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
			type: "request_export_project",
			requestId: `export-${Date.now()}`,
		});
		if (!ok) {
			pendingExportRef.current = false;
			setBridgeBusy(false);
			pushExtensionToast("warning", "沙盘尚未连接", "Wenyou Pro");
			return;
		}
		setBridgeStatus("正在从沙盘导出工程…");
		armBridgeTimeout("导出工程超时，请确认沙盘已更新至支持桥接的版本");
	};

	useEffect(() => {
		if (mapMode !== "pixi-sandbox") return;
		const restoreKey = `${cwd ?? ""}::${sanitizedPixiUrl ?? ""}::${pixiNonce}`;
		const matchesWorkspaceKey = (payloadWorkspaceKey?: string): boolean => {
			if (!payloadWorkspaceKey) {
				return !(isBuiltinSandbox && Boolean(rawCwd));
			}
			if (!rawCwd) return false;
			return sameDirectoryPath(payloadWorkspaceKey, rawCwd);
		};
		const onMessage = (event: MessageEvent) => {
			if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) return;
			const originOk =
				Boolean(targetOrigin) &&
				(event.origin === targetOrigin ||
					(isBuiltinSandbox &&
						(event.origin.startsWith(`${WENYOU_SANDBOX_PROTOCOL}://`) || event.origin === "null")));
			if (!originOk) return;
			const data = event.data as WenyouBridgeSandboxMessage | null;
			if (!data || data.protocol !== WENYOU_MAP_BRIDGE_PROTOCOL) return;

			switch (data.type) {
				case "ready":
				case "pong": {
					setBridgeReady(true);
					postBridgeContext(true);
					const mapPart = data.payload.mapName ? ` · ${data.payload.mapName}` : "";
					setBridgeStatus(`已握手 v${data.payload.version}${mapPart}`);
					if (pendingImageTheaterRef.current) {
						const req = pendingImageTheaterRef.current;
						pendingImageTheaterRef.current = null;
						autoRestoredKeyRef.current = restoreKey;
						dispatchCreateImageTheater(req);
					} else if (
						data.type === "ready" &&
						data.payload.activeMapId === null &&
						cwd &&
						autoRestoredKeyRef.current !== restoreKey
					) {
						autoRestoredKeyRef.current = restoreKey;
						void attemptAutoRestoreSnapshot(cwd);
					}
					break;
				}
				case "context_acked": {
					setBridgeReady(true);
					setBridgeStatus(`上下文已确认（${data.payload.currentEra || overview?.currentEra || "当前"}）`);
					break;
				}
				case "project_loaded": {
					clearBridgeTimer();
					setBridgeBusy(false);
					const wasAutoLoad = silentAutoLoadRef.current;
					silentAutoLoadRef.current = false;
					if (data.payload.ok) {
						const name = data.payload.mapName || data.payload.activeMapId || "快照";
						setBridgeStatus(wasAutoLoad ? `已自动恢复沙盘：${name}` : `已载入沙盘：${name}`);
						if (!wasAutoLoad) {
							pushExtensionToast("info", `已载入沙盘：${name}`, "Wenyou Pro");
						}
					} else {
						const reason = data.payload.error || "未知错误";
						setBridgeStatus(`载入失败：${reason}`);
						if (!wasAutoLoad) {
							pushExtensionToast("error", `沙盘载入失败：${reason}`, "Wenyou Pro");
						}
					}
					if (pendingImageTheaterRef.current) {
						const req = pendingImageTheaterRef.current;
						pendingImageTheaterRef.current = null;
						dispatchCreateImageTheater(req);
					}
					break;
				}
				case "image_theater_created": {
					clearBridgeTimer();
					setBridgeBusy(false);
					if (data.payload.ok) {
						const name = data.payload.mapName || data.payload.activeMapId || "图片战区";
						const cellPart = typeof data.payload.cellCount === "number" ? `（${data.payload.cellCount} 格）` : "";
						setBridgeStatus(`已导入图片沙盘：${name}${cellPart}`);
						pushExtensionToast("info", `已将「${name}」载入动态沙盘${cellPart}`, "Wenyou Pro");
					} else {
						const reason = data.payload.error || "未知错误";
						setBridgeStatus(`导入图片失败：${reason}`);
						pushExtensionToast("error", `导入图片沙盘失败：${reason}`, "Wenyou Pro");
					}
					break;
				}
				case "autosave_project": {
					if (!cwd || !matchesWorkspaceKey(data.payload.workspaceKey)) break;
					if (typeof data.payload.projectJson === "string" && data.payload.projectJson.length > 0) {
						void flushAutosave(cwd, data.payload.projectJson);
					}
					break;
				}
				case "project_exported": {
					clearBridgeTimer();
					const shouldSave = pendingExportRef.current;
					pendingExportRef.current = false;
					setBridgeBusy(false);
					if (!data.payload.ok || !data.payload.projectJson) {
						const reason = data.payload.error || "沙盘未返回工程数据";
						setBridgeStatus(`导出失败：${reason}`);
						pushExtensionToast("error", `沙盘导出失败：${reason}`, "Wenyou Pro");
						break;
					}
					if (!shouldSave || !cwd || !matchesWorkspaceKey(data.payload.workspaceKey)) break;
					const targetCwd = cwd;
					const fileName = defaultExportFileName(overview?.currentEra);
					void getExecutionApi(targetCwd)
						.wenyouSaveMapSnapshot({
							cwd: targetCwd,
							fileName,
							content: data.payload.projectJson,
						})
						.then(async (saved) => {
							if (cwdRef.current !== targetCwd) return;
							setBridgeStatus(`已存回 ${saved.relPath}`);
							pushExtensionToast("info", `沙盘工程已存回 ${saved.relPath}`, "Wenyou Pro");
							await refreshOverview(targetCwd, { silent: true });
							await reloadSnapshots();
						})
						.catch((err) => {
							if (cwdRef.current !== targetCwd) return;
							const msg = err instanceof Error ? err.message : String(err);
							setBridgeStatus(`存回失败：${msg}`);
							pushExtensionToast("error", `存回工作区失败：${msg}`, "Wenyou Pro");
						});
					break;
				}
				case "selection_changed": {
					const p = data.payload;
					if (p.kind === "burg") {
						setSelectionHint(`城邦：${p.name}${p.stateName ? `（${p.stateName}）` : ""}`);
					} else {
						setSelectionHint(
							`部队：${p.name}${typeof p.personnel === "number" ? ` · ${p.personnel}人` : ""}`,
						);
					}
					break;
				}
				case "focus_source": {
					if (typeof data.payload.sourceId === "string" && data.payload.sourceId.trim()) {
						void openSourceContext(data.payload.sourceId, data.payload.highlightQuote);
					}
					break;
				}
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [
		mapMode,
		targetOrigin,
		isBuiltinSandbox,
		sanitizedPixiUrl,
		pixiNonce,
		cwd,
		rawCwd,
		overview?.currentEra,
		openSourceContext,
		refreshOverview,
		reloadSnapshots,
		clearBridgeTimer,
		dispatchCreateImageTheater,
		attemptAutoRestoreSnapshot,
		flushAutosave,
		postBridgeContext,
	]);

	const MODES: Array<{ id: WenyouMapMode; label: string }> = [
		{ id: "single", label: "单图精看" },
		{ id: "side-by-side", label: "双屏比对" },
		{ id: "slider", label: "卷帘比对" },
		{ id: "pixi-sandbox", label: "动态沙盘" },
	];

	const jsonSnapshots = useMemo(
		() => snapshots.filter((s) => s.format === "wenyou-project"),
		[snapshots],
	);

	const leftSrc = resolveMapUrl(rawCwd, leftMap);
	const rightSrc = resolveMapUrl(rawCwd, rightMap);

	const handleEditImageInSandbox = () => {
		if (!localWorkspace || !leftMap || !leftSrc) return;
		autoRestoreSeqRef.current += 1;
		pendingImageTheaterRef.current = {
			name: leftMap.name,
			imageUrl: leftSrc,
			imageRelPath: leftMap.relPath,
			gridPreset: "standard",
		};
		if (!sanitizedPixiUrl || (!isBuiltinSandbox && isLocalTarget && activeProbe?.reachable !== true)) {
			setPixiUrl(BUILTIN_PIXI_SANDBOX_URL);
			setPixiDraftUrl(BUILTIN_PIXI_SANDBOX_URL);
		}
		setMapMode("pixi-sandbox");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶栏模式与缩放控件（嵌套 ≤3 层） */}
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-1 rounded-lg bg-hover p-0.5">
					{MODES.map((m) => (
						<button
							key={m.id}
							type="button"
							onClick={() => setMapMode(m.id)}
							className={`rounded-md px-2 py-1 text-ui-12 font-medium transition-colors ${
								mapMode === m.id
									? "bg-canvas text-ink shadow-soft"
									: "text-ink-dim hover:text-ink"
							}`}
						>
							{m.label}
						</button>
					))}
				</div>

				{mapMode !== "pixi-sandbox" && (
					<div className="flex flex-wrap items-center gap-1.5">
						{mapMode === "side-by-side" && (
							<button
								type="button"
								onClick={() => {
									const next = !syncViewport;
									setSyncViewport(next);
									if (next) setRightViewport(leftViewport);
								}}
								className={`rounded-lg border px-2 py-1 text-ui-11 font-medium transition-colors ${
									syncViewport
										? "border-accent/40 bg-accent/12 text-accent"
										: "border-border text-ink-dim hover:bg-hover hover:text-ink"
								}`}
								title="开启后左右两图缩放与平移保持同步"
							>
								{syncViewport ? "视口同步：开" : "视口同步：关"}
							</button>
						)}
						<div className="inline-flex items-center rounded-lg border border-border bg-surface text-ui-11">
							<button
								type="button"
								onClick={() => adjustZoom(1 / 1.25)}
								className="px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink"
								aria-label="缩小地图"
							>
								−
							</button>
							<span className="min-w-11 text-center font-mono text-ink">
								{Math.round(leftViewport.scale * 100)}%
							</span>
							<button
								type="button"
								onClick={() => adjustZoom(1.25)}
								className="px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink"
								aria-label="放大地图"
							>
								+
							</button>
						</div>
						<button
							type="button"
							onClick={resetViewport}
							className="rounded-lg border border-border px-2 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
						>
							复位
						</button>
						{localWorkspace && leftMap && leftSrc && (
							<button
								type="button"
								onClick={handleEditImageInSandbox}
								className="rounded-lg bg-ink px-2.5 py-1 text-ui-11 font-medium text-on-ink transition-opacity hover:opacity-90"
								title="将当前静态地图作为高清底图送入内置动态沙盘，直接涂画势力、擦除旧字、摆放兵牌与公里测距"
							>
								在沙盘中编辑此图
							</button>
						)}
						{localWorkspace && (
							<button
								type="button"
								disabled={importingFile}
								onClick={() => void handleImportMapFile()}
								className="rounded-lg border border-border px-2 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
							>
								{importingFile ? "导入中…" : "导入地图"}
							</button>
						)}
					</div>
				)}
			</div>

			{/* 地图选择器 / 沙盘地址条 */}
			{mapMode === "pixi-sandbox" ? (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-hover/35 px-4 py-2">
					{PIXI_SANDBOX_PRESET_URLS.map((preset) => {
						const presetIsBuiltin = isBuiltinSandboxUrl(preset);
						const normalized = new URL(preset).toString();
						const port = presetIsBuiltin ? "" : new URL(preset).port;
						const probe = probeMap[normalized];
						const active = sanitizedPixiUrl === normalized;
						return (
							<button
								key={preset}
								type="button"
								onClick={() => {
									setPixiUrl(preset);
									setPixiDraftUrl(preset);
									setPixiNonce((n) => n + 1);
								}}
								className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-ui-11 transition-colors ${
									presetIsBuiltin ? "font-medium" : "font-mono"
								} ${
									active
										? "border-accent/50 bg-accent/12 text-accent"
										: "border-border bg-surface text-ink-dim hover:text-ink"
								}`}
								title={
									presetIsBuiltin
										? "内置离线动态沙盘（开箱即用，无需外部进程）"
										: probe?.reachable
											? `外部开发服务在线 (${probe.latencyMs}ms)`
											: "外部开发调试端口（未检测到运行中服务）"
								}
							>
								<span
									className={`h-1.5 w-1.5 rounded-full ${
										presetIsBuiltin || probe?.reachable ? "bg-emerald-500" : "bg-ink-faint/50"
									}`}
								/>
								{presetIsBuiltin ? "内置沙盘" : `:${port}`}
							</button>
						);
					})}
					<input
						type="url"
						value={pixiDraftUrl}
						onChange={(e) => setPixiDraftUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								const next = pixiDraftUrl.trim();
								const valid = sanitizePixiSandboxUrl(next);
								setPixiUrl(next);
								if (valid) {
									setPixiNonce((n) => n + 1);
									if (isLoopbackHttpUrl(valid)) void probeSandboxTargets(valid);
								}
							}
						}}
						placeholder={BUILTIN_PIXI_SANDBOX_URL}
						className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1 font-mono text-ui-12 text-ink outline-none focus:border-accent"
					/>
					<button
						type="button"
						disabled={probing}
						onClick={() => {
							const next = pixiDraftUrl.trim();
							const valid = sanitizePixiSandboxUrl(next);
							setPixiUrl(next);
							if (valid) {
								setPixiNonce((n) => n + 1);
								if (isLoopbackHttpUrl(valid)) void probeSandboxTargets(valid);
							}
						}}
						className="rounded-lg bg-ink px-2.5 py-1 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90 disabled:opacity-50"
					>
						{probing ? "检测中…" : isBuiltinSandbox ? "刷新" : "连接"}
					</button>
					{sanitizedPixiUrl && !isBuiltinSandbox && (
						<button
							type="button"
							onClick={() => void getPi().openExternal({ url: sanitizedPixiUrl })}
							className="rounded-lg border border-border px-2 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
						>
							外部打开
						</button>
					)}
				</div>
			) : (
				maps.length > 0 && (
					<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-hover/35 px-4 py-2">
						<select
							aria-label="选择主图或左侧地图"
							value={leftMap?.relPath ?? ""}
							onChange={(e) => setLeftMapPath(e.target.value)}
							className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-ui-12 text-ink outline-none focus:border-accent"
						>
							{maps.map((m) => (
								<option key={m.relPath} value={m.relPath}>
									{m.name}
									{m.yearLabel ? ` (${m.yearLabel})` : ""} · {formatFileSize(m.sizeBytes)}
								</option>
							))}
						</select>
						{(mapMode === "side-by-side" || mapMode === "slider") && (
							<>
								<button
									type="button"
									onClick={swapMaps}
									className="shrink-0 rounded-lg border border-border px-2 py-1 text-ui-11 text-ink-dim hover:bg-hover hover:text-ink"
									title="交换左右地图"
								>
									⇄
								</button>
								<select
									aria-label="选择右侧比对地图"
									value={rightMap?.relPath ?? ""}
									onChange={(e) => setRightMapPath(e.target.value)}
									className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-ui-12 text-ink outline-none focus:border-accent"
								>
									{maps.map((m) => (
										<option key={m.relPath} value={m.relPath}>
											{m.name}
											{m.yearLabel ? ` (${m.yearLabel})` : ""} · {formatFileSize(m.sizeBytes)}
										</option>
									))}
								</select>
							</>
						)}
					</div>
				)
			)}

			{/* 两期结构化快照差分摘要条（默认收起，单行扁平，视觉嵌套 ≤3 层） */}
			{mapMode !== "pixi-sandbox" && snapshots.length >= 2 && (
				<div className="shrink-0 border-b border-border bg-surface/60 px-4 py-1.5 text-ui-11">
					<div className="flex items-center justify-between gap-2">
						<span className="truncate text-ink-2">
							{diffResult
								? `领土变动 ${diffResult.changedCellCount} 格 · 易手城池 ${diffResult.transferredBurgs.length} 座 · 兵力净变 ${formatSigned(diffResult.netTotalPersonnel)}`
								: diffError
									? `快照差分失败：${diffError}`
									: `已发现 ${snapshots.length} 份沙盘快照，可展开对比两期变迁`}
						</span>
						<button
							type="button"
							onClick={() => setDiffExpanded((v) => !v)}
							className="shrink-0 rounded px-1.5 py-0.5 text-ui-11 font-medium text-accent hover:bg-hover"
						>
							{diffExpanded ? "收起" : "展开差分"}
						</button>
					</div>

					{diffExpanded && (
						<div className="mt-2 max-h-44 space-y-1.5 overflow-y-auto border-t border-border/70 pt-2">
							<div className="flex items-center gap-1.5">
								<select
									aria-label="前期快照"
									value={diffFromPath}
									onChange={(e) => setDiffFromPath(e.target.value)}
									className="min-w-0 flex-1 rounded border border-border bg-canvas px-1.5 py-0.5 text-ui-11 text-ink outline-none"
								>
									{snapshots.map((s) => (
										<option key={s.relPath} value={s.relPath}>
											前：{s.name}
										</option>
									))}
								</select>
								<span className="text-ink-faint">→</span>
								<select
									aria-label="后期快照"
									value={diffToPath}
									onChange={(e) => setDiffToPath(e.target.value)}
									className="min-w-0 flex-1 rounded border border-border bg-canvas px-1.5 py-0.5 text-ui-11 text-ink outline-none"
								>
									{snapshots.map((s) => (
										<option key={s.relPath} value={s.relPath}>
											后：{s.name}
										</option>
									))}
								</select>
							</div>
							{diffResult && (
								<>
									{diffResult.stateDeltas.slice(0, 6).map((st) => (
										<div
											key={st.stateId}
											className="flex items-center justify-between gap-2 text-ui-11 text-ink-2"
										>
											<span className="truncate font-medium text-ink">{st.stateName}</span>
											<span className="shrink-0 font-mono text-ink-dim">
												地块 {formatSigned(st.netCells)}（+{st.gainedCells}/-{st.lostCells}）· 兵力{" "}
												{formatSigned(st.netPersonnel)}
											</span>
										</div>
									))}
									{diffResult.transferredBurgs.slice(0, 6).map((b) => (
										<div
											key={`${b.burgId}-${b.toStateId}`}
											className="flex items-center justify-between gap-2 text-ui-11 text-ink-dim"
										>
											<span className="truncate">
												{b.burgName}（{b.sector}
												{b.isCapital ? "·都" : ""}
												{b.isPort ? "·港" : ""}）
											</span>
											<span className="shrink-0">
												{b.fromStateName} → {b.toStateName}
											</span>
										</div>
									))}
								</>
							)}
						</div>
					)}
				</div>
			)}

			{/* 主视口 */}
			<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
				{mapMode === "pixi-sandbox" ? (
					<>
						<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-ui-11 text-ink-dim">
							<span className="truncate">
								{bridgeStatus}
								{selectionHint ? ` · ${selectionHint}` : ""}
							</span>
							{canMountIframe && (
								<div className="flex items-center gap-1.5">
									{jsonSnapshots.length > 0 && (
										<>
											<select
												aria-label="选择要载入沙盘的工作区快照"
												value={selectedSandboxSnapshot}
												onChange={(e) => setSelectedSandboxSnapshot(e.target.value)}
												className="max-w-36 rounded border border-border bg-surface px-1.5 py-0.5 text-ui-11 text-ink outline-none"
											>
												{jsonSnapshots.map((s) => (
													<option key={s.relPath} value={s.relPath}>
														{s.name}
													</option>
												))}
											</select>
											<button
												type="button"
												disabled={!bridgeReady || bridgeBusy}
												onClick={() => void handleLoadSnapshotToSandbox()}
												className="rounded border border-border px-2 py-0.5 text-ui-11 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
											>
												载入快照
											</button>
										</>
									)}
									<button
										type="button"
										disabled={!bridgeReady || bridgeBusy || !cwd}
										onClick={handleExportSandboxToWorkspace}
										className="rounded border border-border px-2 py-0.5 text-ui-11 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
									>
										存回工作区
									</button>
									<button
										type="button"
										disabled={!bridgeReady}
										onClick={() => postBridgeContext(false)}
										className="rounded border border-border px-2 py-0.5 text-ui-11 text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-40"
									>
										同步上下文
									</button>
								</div>
							)}
						</div>

						{!sanitizedPixiUrl || !effectiveIframeSrc ? (
							<div className="flex flex-1 items-center justify-center rounded-xl border border-border bg-surface p-6 text-center text-ui-12 text-ink-dim">
								仅支持内置沙盘（{BUILTIN_PIXI_SANDBOX_URL}）或本机回环 http://127.0.0.1 / localhost 调试地址。
							</div>
						) : !canMountIframe ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-surface p-6 text-center">
								<p className="text-ui-13 font-medium text-ink">
									{probing ? "正在探测外部调试沙盘服务…" : `未检测到外部调试沙盘（${sanitizedPixiUrl}）`}
								</p>
								<p className="max-w-sm text-ui-12 text-ink-dim">
									{activeProbe?.error ? `原因：${activeProbe.error}。` : ""}建议直接切回开箱即用的
									<strong className="font-medium text-ink">「内置沙盘」</strong>
									，或在 <code className="font-mono">packages/pixi-sandbox</code> 启动开发服务。
								</p>
								<div className="flex flex-wrap items-center justify-center gap-2">
									<button
										type="button"
										onClick={() => {
											setPixiUrl(BUILTIN_PIXI_SANDBOX_URL);
											setPixiDraftUrl(BUILTIN_PIXI_SANDBOX_URL);
											setPixiNonce((n) => n + 1);
										}}
										className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink hover:opacity-90"
									>
										切回内置沙盘
									</button>
									<button
										type="button"
										disabled={probing}
										onClick={() => void probeSandboxTargets()}
										className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-50"
									>
										{probing ? "检测中…" : "重新检测"}
									</button>
									<button
										type="button"
										onClick={() => void getPi().openExternal({ url: sanitizedPixiUrl })}
										className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 hover:bg-hover hover:text-ink"
									>
										在外部浏览器打开
									</button>
								</div>
							</div>
						) : (
							<iframe
								key={`${sanitizedPixiUrl}::${cwd ?? ""}::${pixiNonce}`}
								ref={iframeRef}
								src={effectiveIframeSrc}
								title="Wenyou Pixi 互动沙盘"
								sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
								onLoad={handleIframeLoad}
								className="min-h-[300px] w-full flex-1 rounded-xl border border-border bg-surface"
							/>
						)}
					</>
				) : maps.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
						<p className="text-ui-14 font-medium text-ink">05-沙盘与图集/ 下暂无静态地图</p>
						<p className="max-w-sm text-ui-12 leading-relaxed text-ink-dim">
							将战略态势图（PNG / JPG / WEBP / SVG）或沙盘快照（.json / .map）放入{" "}
							<code className="font-mono">05-沙盘与图集/</code> 即可比对与查图。
						</p>
						<div className="flex flex-wrap items-center justify-center gap-2">
							{localWorkspace && (
								<button
									type="button"
									disabled={importingFile}
									onClick={() => void handleImportMapFile()}
									className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink hover:opacity-90 disabled:opacity-50"
								>
									{importingFile ? "导入中…" : "导入地图 / 快照"}
								</button>
							)}
							<button
								type="button"
								onClick={() =>
									fillWenyouPrompt(
										"请扫描 05-沙盘与图集/ 与 maps/ 下的地图与快照，调用 wenyou_inspect_map 或 wenyou_open_maps 分析当前疆域与变化。",
									)
								}
								className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
							>
								让司命检索并分析地图
							</button>
						</div>
					</div>
				) : !localWorkspace ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-surface p-6 text-center">
						<p className="text-ui-13 font-medium text-ink">SSH 远端工作区暂不支持本地静态图片直读</p>
						<p className="max-w-sm text-ui-12 leading-relaxed text-ink-dim">
							当前工作区位于 SSH 远端环境，本地 <code className="font-mono">wenyou-asset://</code> 协议与「在沙盘中编辑此图」仅支持本机战役目录；你仍可使用上方的结构化快照差分或切换到「动态沙盘」载入 JSON 工程。
						</p>
					</div>
				) : mapMode === "single" ? (
					<ZoomableMapStage
						src={leftSrc}
						label={leftMap?.name ?? "主图"}
						viewport={leftViewport}
						onViewportChange={handleLeftViewport}
					/>
				) : mapMode === "side-by-side" ? (
					<div className="grid min-h-0 flex-1 grid-cols-2 gap-2.5">
						<ZoomableMapStage
							src={leftSrc}
							label={leftMap?.name ?? "左图"}
							viewport={leftViewport}
							onViewportChange={handleLeftViewport}
						/>
						<ZoomableMapStage
							src={rightSrc}
							label={rightMap?.name ?? "右图"}
							viewport={rightViewport}
							onViewportChange={handleRightViewport}
						/>
					</div>
				) : (
					<SliderCompareStage
						leftSrc={leftSrc}
						rightSrc={rightSrc}
						leftLabel={leftMap?.name ?? "前期"}
						rightLabel={rightMap?.name ?? "后期"}
						viewport={leftViewport}
						onViewportChange={handleLeftViewport}
					/>
				)}

				{mapMode !== "pixi-sandbox" && maps.length > 0 && (
					<p className="shrink-0 text-center text-ui-11 text-ink-faint">
						滚轮缩放（50%~500%）· 鼠标左键拖拽平移 · 双击切换 100%/200%
					</p>
				)}
			</div>
		</div>
	);
}
