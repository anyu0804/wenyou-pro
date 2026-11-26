import { buildWenyouAssetUrl, formatViewerScope, type MapAssetItem } from "@percho/shared";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { fillWenyouPrompt, useWenyouCanvasStore, type WenyouMapMode } from "../../stores/wenyou-canvas";
import { formatFileSize, unwrapCwdPath } from "./wenyou-helpers";

interface ViewportTransform {
	scale: number;
	x: number;
	y: number;
}

const DEFAULT_VIEWPORT: ViewportTransform = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

function clampScale(s: number): number {
	return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)) * 100) / 100;
}

function resolveMapUrl(rawCwd: string | null, item: MapAssetItem | null): string | null {
	if (!item) return null;
	if (rawCwd) return buildWenyouAssetUrl(rawCwd, item.relPath);
	return item.assetUrl;
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
			const rect = el.getBoundingClientRect();
			const cur = viewportRef.current;
			const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
			const nextScale = clampScale(cur.scale * factor);
			if (nextScale === cur.scale) return;
			// 以鼠标在容器中心的相对偏移为锚点平滑缩放
			const cx = event.clientX - rect.left - rect.width / 2;
			const cy = event.clientY - rect.top - rect.height / 2;
			const ratio = nextScale / cur.scale;
			const nextX = cx - (cx - cur.x) * ratio;
			const nextY = cy - (cy - cur.y) * ratio;
			onViewportChange({ scale: nextScale, x: nextX, y: nextY });
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [onViewportChange]);

	const finishDrag = useCallback((el?: HTMLDivElement | null) => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		const pid = pointerIdRef.current;
		pointerIdRef.current = null;
		if (el && pid !== null && el.hasPointerCapture(pid)) {
			el.releasePointerCapture(pid);
		}
	}, []);

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || !src) return;
		draggingRef.current = true;
		pointerIdRef.current = e.pointerId;
		dragOriginRef.current = {
			clientX: e.clientX,
			clientY: e.clientY,
			x: viewport.x,
			y: viewport.y,
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
		const dx = e.clientX - dragOriginRef.current.clientX;
		const dy = e.clientY - dragOriginRef.current.clientY;
		onViewportChange({
			scale: viewport.scale,
			x: dragOriginRef.current.x + dx,
			y: dragOriginRef.current.y + dy,
		});
	};

	const onDoubleClick = () => {
		if (viewport.scale > 1.1) {
			onViewportChange(DEFAULT_VIEWPORT);
		} else {
			onViewportChange({ scale: 2, x: 0, y: 0 });
		}
	};

	return (
		<div
			ref={containerRef}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={(e) => finishDrag(e.currentTarget)}
			onPointerCancel={(e) => finishDrag(e.currentTarget)}
			onLostPointerCapture={(e) => finishDrag(e.currentTarget)}
			onDoubleClick={onDoubleClick}
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
					className="max-h-full max-w-full select-none object-contain will-change-transform"
					style={{
						transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
						transformOrigin: "center center",
					}}
				/>
			)}
		</div>
	);
}

/** 卷帘比对视口：支持滚轮缩放平移 + 可拖拽垂直卷帘线 */
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
	const containerRef = useRef<HTMLDivElement | null>(null);
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const draggingRef = useRef<"pan" | "split" | null>(null);
	const dragOriginRef = useRef({ clientX: 0, clientY: 0, x: 0, y: 0 });

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const cur = viewportRef.current;
			const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
			const nextScale = clampScale(cur.scale * factor);
			if (nextScale === cur.scale) return;
			onViewportChange({ ...cur, scale: nextScale });
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [onViewportChange]);

	const updateSplitFromClientX = (clientX: number) => {
		const rect = containerRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return;
		const pct = ((clientX - rect.left) / rect.width) * 100;
		setSplitPct(Math.max(4, Math.min(96, Math.round(pct * 10) / 10)));
	};

	const transformStyle = {
		transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
		transformOrigin: "center center",
	};

	return (
		<div
			ref={containerRef}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				const isSplit = (e.target as HTMLElement).closest("[data-slider-divider]") !== null;
				draggingRef.current = isSplit ? "split" : "pan";
				dragOriginRef.current = {
					clientX: e.clientX,
					clientY: e.clientY,
					x: viewport.x,
					y: viewport.y,
				};
				e.currentTarget.setPointerCapture(e.pointerId);
				e.preventDefault();
			}}
			onPointerMove={(e) => {
				if (!draggingRef.current) return;
				if (e.buttons === 0) {
					draggingRef.current = null;
					return;
				}
				if (draggingRef.current === "split") {
					updateSplitFromClientX(e.clientX);
				} else {
					onViewportChange({
						scale: viewport.scale,
						x: dragOriginRef.current.x + (e.clientX - dragOriginRef.current.clientX),
						y: dragOriginRef.current.y + (e.clientY - dragOriginRef.current.clientY),
					});
				}
			}}
			onPointerUp={() => {
				draggingRef.current = null;
			}}
			onPointerCancel={() => {
				draggingRef.current = null;
			}}
			className="relative flex h-full min-h-[280px] w-full flex-1 cursor-grab overflow-hidden rounded-xl border border-border bg-hover/50 active:cursor-grabbing"
			style={{ touchAction: "none" }}
		>
			{rightSrc && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<img
						src={rightSrc}
						alt={rightLabel}
						draggable={false}
						className="max-h-full max-w-full select-none object-contain"
						style={transformStyle}
					/>
				</div>
			)}
			{leftSrc && (
				<div
					className="pointer-events-none absolute inset-0 flex items-center justify-center"
					style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
				>
					<img
						src={leftSrc}
						alt={leftLabel}
						draggable={false}
						className="max-h-full max-w-full select-none object-contain"
						style={transformStyle}
					/>
				</div>
			)}

			<div className="pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-canvas/85 px-2 py-0.5 text-ui-11 font-medium text-ink shadow-soft">
				左：{leftLabel}
			</div>
			<div className="pointer-events-none absolute top-2 right-2 z-10 rounded-md bg-canvas/85 px-2 py-0.5 text-ui-11 font-medium text-ink shadow-soft">
				右：{rightLabel}
			</div>

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

	const rawCwd = unwrapCwdPath(cwd);
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

	// Pixi 沙盘联动状态
	const [pixiDraftUrl, setPixiDraftUrl] = useState(pixiUrl);
	const [pixiNonce, setPixiNonce] = useState(0);
	const [bridgeStatus, setBridgeStatus] = useState<string>("等待沙盘握手 (wenyou-map-bridge/v1)");
	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	useEffect(() => {
		setPixiDraftUrl(pixiUrl);
	}, [pixiUrl]);

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
		const nextScale = clampScale(leftViewport.scale * deltaFactor);
		const next = { ...leftViewport, scale: nextScale };
		setLeftViewport(next);
		if (syncViewport) setRightViewport({ ...rightViewport, scale: nextScale });
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

	const sanitizedPixiUrl = useMemo(() => {
		const trimmed = pixiUrl.trim();
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
			return null;
		} catch {
			return null;
		}
	}, [pixiUrl]);

	const postBridgeContext = useCallback(() => {
		if (!iframeRef.current?.contentWindow || !sanitizedPixiUrl) return;
		const targetOrigin = new URL(sanitizedPixiUrl).origin;
		iframeRef.current.contentWindow.postMessage(
			{
				protocol: "wenyou-map-bridge/v1",
				type: "sync_context",
				payload: {
					worldId: overview?.worldId ?? "",
					worldTitle: overview?.worldTitle ?? "",
					currentEra: overview?.currentEra ?? "",
					viewer: formatViewerScope(viewerScope),
				},
			},
			targetOrigin,
		);
		setBridgeStatus(`已下发战役上下文（${overview?.currentEra ?? "当前轮次"}）`);
	}, [sanitizedPixiUrl, overview?.worldId, overview?.worldTitle, overview?.currentEra, viewerScope]);

	useEffect(() => {
		if (mapMode !== "pixi-sandbox") return;
		const onMessage = (event: MessageEvent) => {
			const data = event.data as Record<string, unknown> | null;
			if (!data || data.protocol !== "wenyou-map-bridge/v1") return;
			const type = typeof data.type === "string" ? data.type : "event";
			setBridgeStatus(`收到沙盘消息：${type}`);
			const payload = (data.payload ?? data) as Record<string, unknown>;
			if (
				(type === "focus_source" || type === "open_source") &&
				typeof payload.sourceId === "string"
			) {
				void openSourceContext(payload.sourceId);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [mapMode, openSourceContext]);

	const MODES: Array<{ id: WenyouMapMode; label: string }> = [
		{ id: "single", label: "单图精看" },
		{ id: "side-by-side", label: "双屏比对" },
		{ id: "slider", label: "卷帘比对" },
		{ id: "pixi-sandbox", label: "动态沙盘" },
	];

	const leftSrc = resolveMapUrl(rawCwd, leftMap);
	const rightSrc = resolveMapUrl(rawCwd, rightMap);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 顶栏模式与缩放控件 */}
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
					</div>
				)}
			</div>

			{/* 地图选择器 / 沙盘地址条 */}
			{mapMode === "pixi-sandbox" ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-hover/35 px-4 py-2">
					<input
						type="url"
						value={pixiDraftUrl}
						onChange={(e) => setPixiDraftUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								setPixiUrl(pixiDraftUrl.trim());
								setPixiNonce((n) => n + 1);
							}
						}}
						placeholder="http://127.0.0.1:4173（wenyou-pixi-app 本地沙盘地址）"
						className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1 font-mono text-ui-12 text-ink outline-none focus:border-accent"
					/>
					<button
						type="button"
						onClick={() => {
							setPixiUrl(pixiDraftUrl.trim());
							setPixiNonce((n) => n + 1);
						}}
						className="rounded-lg bg-ink px-2.5 py-1 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90"
					>
						加载沙盘
					</button>
					<button
						type="button"
						onClick={postBridgeContext}
						className="rounded-lg border border-border px-2.5 py-1 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
					>
						同步上下文
					</button>
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

			{/* 主视口 */}
			<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
				{mapMode === "pixi-sandbox" ? (
					<div className="flex min-h-0 flex-1 flex-col gap-2">
						<div className="flex items-center justify-between text-ui-11 text-ink-dim">
							<span>协议：wenyou-map-bridge/v1</span>
							<span>{bridgeStatus}</span>
						</div>
						{sanitizedPixiUrl ? (
							<iframe
								key={`${sanitizedPixiUrl}-${pixiNonce}`}
								ref={iframeRef}
								src={sanitizedPixiUrl}
								title="Wenyou Pixi 互动沙盘"
								sandbox="allow-scripts allow-same-origin allow-forms"
								onLoad={postBridgeContext}
								className="min-h-[300px] w-full flex-1 rounded-xl border border-border bg-surface"
							/>
						) : (
							<div className="flex flex-1 items-center justify-center rounded-xl border border-border bg-surface p-6 text-center text-ui-12 text-ink-dim">
								请输入有效的本地或 HTTPS 沙盘地址（如 http://127.0.0.1:4173）。
							</div>
						)}
					</div>
				) : maps.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
						<p className="text-ui-14 font-medium text-ink">05-沙盘与图集/ 下暂无静态地图</p>
						<p className="max-w-sm text-ui-12 leading-relaxed text-ink-dim">
							将战略态势图、水文海图或战役疆域图（PNG / JPG / WEBP / SVG）放入{" "}
							<code className="font-mono">05-沙盘与图集/</code> 即可支持 50%~500% 双屏同步缩放比对。
						</p>
						<button
							type="button"
							onClick={() =>
								fillWenyouPrompt(
									"请扫描 05-沙盘与图集/ 与 maps/ 下的战略态势图，并调用 wenyou_open_maps 开启双屏比对分析两期疆域变化。",
								)
							}
							className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
						>
							让 Agent 检索并分析地图
						</button>
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
