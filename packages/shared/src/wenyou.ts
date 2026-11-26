/**
 * Wenyou Pro 跨进程领域契约（共享纯类型与轻量解析工具；零 Electron/React/Node 依赖）。
 */

export const WENYOU_STANDARD_DIRS = [
	"00-群聊收集",
	"01-设定与国力实册",
	"02-局势简报与台账",
	"03-国策与文书",
	"04-编年史与条约",
	"05-沙盘与图集",
	"private",
	".wenyou",
] as const;

export const WENYOU_ASSET_PROTOCOL = "wenyou-asset";

export function buildWenyouAssetUrl(
	cwd: string,
	relPath: string,
	versionTag?: number | string,
): string {
	const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const params = new URLSearchParams({ cwd, path: normalized });
	if (versionTag !== undefined && versionTag !== "") {
		params.set("v", String(versionTag));
	}
	return `${WENYOU_ASSET_PROTOCOL}://vault?${params.toString()}`;
}

export const WENYOU_MAP_BRIDGE_PROTOCOL = "wenyou-map-bridge/v1";
export const WENYOU_SANDBOX_PROTOCOL = "wenyou-sandbox";
export const BUILTIN_PIXI_SANDBOX_URL = `${WENYOU_SANDBOX_PROTOCOL}://app/index.html`;
export const DEFAULT_PIXI_SANDBOX_URL = BUILTIN_PIXI_SANDBOX_URL;
export const PIXI_SANDBOX_PRESET_URLS = [
	BUILTIN_PIXI_SANDBOX_URL,
	"http://127.0.0.1:5173",
	"http://127.0.0.1:5174",
] as const;

export function buildBuiltinSandboxUrl(workspaceKey?: string | null): string {
	const trimmed = workspaceKey?.trim();
	if (!trimmed) return BUILTIN_PIXI_SANDBOX_URL;
	const params = new URLSearchParams({ workspace: trimmed });
	return `${BUILTIN_PIXI_SANDBOX_URL}?${params.toString()}`;
}

export type GroupRole = "main" | "dice" | "cabinet" | "diplomacy" | "other";

export interface GroupCursorRecord {
	groupId: string;
	groupName: string;
	role: GroupRole;
	totalIngested: number;
	/** 总入库最新游标 */
	lastIngestedSourceId: string | null;
	lastIngestedTimestamp: string | null;
	/** 上次局势简报已汇报游标（防重报） */
	lastReportedSourceId: string | null;
	lastReportedAt: string | null;
	/** 尚未进入最新简报的消息条数 */
	unreportedCount: number;
	sourceFiles: string[];
}

export interface EvidenceMessageRecord {
	sourceId: string;
	groupId: string;
	groupName: string;
	sender: string;
	senderId?: string;
	timestamp: string;
	text: string;
	fingerprint: string;
	lineIndex: number;
}

export interface SourceContextWindow {
	targetSourceId: string;
	groupId: string;
	groupName: string;
	targetIndex: number;
	messages: EvidenceMessageRecord[];
	/** 本次实际生效的单侧上下文窗口条数（前后各 windowSize 条） */
	windowSize?: number;
	/** 该群已入库的消息总数 */
	totalGroupMessages?: number;
	/** 当前切片之前尚未展示的同群消息条数 */
	beforeRemaining?: number;
	/** 当前切片之后尚未展示的同群消息条数 */
	afterRemaining?: number;
}

export const INTEL_RELIABILITIES = [
	"gm_fact",
	"propaganda",
	"unconfirmed_draft",
	"player_ooc",
] as const;
export type IntelReliability = (typeof INTEL_RELIABILITIES)[number];

export interface BriefingProgressItem {
	title: string;
	detail: string;
	status: "settled" | "in_progress" | "pending_roll" | "blocked";
	sourceRefs: string[];
}

export interface BriefingIntelCheck {
	claim: string;
	reliability: IntelReliability;
	verdict: string;
	sourceRefs: string[];
}

export interface SituationBriefing {
	id: string;
	title: string;
	turnLabel: string;
	createdAt: string;
	/** 核心结论 */
	headline: string;
	/** 【进度】 */
	progressItems: BriefingProgressItem[];
	/** 【外交局势】 */
	diplomacySummary: string;
	/** 【情报核查】 */
	intelChecks: BriefingIntelCheck[];
	/** 战略判断与下一步建议 */
	strategicJudgment: string;
	coveredSourceIds: string[];
	markdownPath: string;
	jsonPath: string;
}

export type RollingLedgerCategory = "fact" | "treaty" | "military" | "economy" | "unconfirmed_draft";

export interface RollingLedgerEntry {
	id: string;
	category: RollingLedgerCategory;
	/** category === "unconfirmed_draft" 时强制标为 "[未定案草案]" */
	tag: string;
	faction?: string;
	summary: string;
	updatedAt: string;
	sourceRefs: string[];
}

export interface PolicyArtifact {
	id: string;
	serialNo: string;
	title: string;
	actor?: string;
	turnLabel?: string;
	createdAt: string;
	markdownPath: string;
	docxPath?: string;
	excerpt: string;
	content: string;
}

export interface MapAssetItem {
	id: string;
	name: string;
	relPath: string;
	assetUrl: string;
	ext: string;
	yearLabel?: string;
	theater?: string;
	sizeBytes: number;
	modifiedAt: number;
}

export type CardinalSector =
	| "中枢"
	| "正北"
	| "东北"
	| "正东"
	| "东南"
	| "正南"
	| "西南"
	| "正西"
	| "西北";

export type MapSnapshotFormat = "wenyou-project" | "fmg-map";

export interface MapTheaterBrief {
	mapId: string;
	name: string;
	stateCount: number;
	burgCount: number;
	unitCount: number;
}

export interface MapSnapshotSummary {
	id: string;
	name: string;
	relPath: string;
	format: MapSnapshotFormat;
	version?: number;
	yearLabel?: string;
	theaters: MapTheaterBrief[];
	sizeBytes: number;
	modifiedAt: number;
}

export interface MapStateSummary {
	stateId: number;
	name: string;
	color?: string;
	cellCount: number;
	burgCount: number;
	capitalName?: string;
	totalPopulation: number;
	totalPersonnel: number;
	unitCount: number;
	sector?: CardinalSector;
	neighborStateNames: string[];
}

export interface MapBurgSummary {
	burgId: number;
	name: string;
	stateId: number;
	stateName: string;
	isCapital: boolean;
	isPort: boolean;
	population: number;
	x: number;
	y: number;
	normX: number;
	normY: number;
	sector: CardinalSector;
}

export interface MapUnitSummary {
	unitId: string;
	name: string;
	side?: string;
	branch?: string;
	echelon?: string;
	personnel: number;
	status?: string;
	x?: number;
	y?: number;
	sector?: CardinalSector;
	nearestBurgName?: string;
	nearestBurgDistanceKm?: number;
}

export interface MapDistancePairKm {
	from: string;
	to: string;
	distanceKm: number;
}

export interface MapInspectResult {
	relPath: string;
	format: MapSnapshotFormat;
	baseKind?: "fmg" | "image";
	imageAssetPath?: string;
	kmPerPixel?: number;
	mapWidthKm?: number;
	theaterId: string;
	theaterName: string;
	availableTheaters: Array<{ mapId: string; name: string }>;
	width: number;
	height: number;
	totalLandCells: number;
	states: MapStateSummary[];
	burgs: MapBurgSummary[];
	units: MapUnitSummary[];
	keyDistancesKm?: MapDistancePairKm[];
	frontlineCount: number;
	arrowCount: number;
	fieldBattleCount: number;
}

export interface MapStateDeltaItem {
	stateId: number;
	stateName: string;
	beforeCells: number;
	afterCells: number;
	netCells: number;
	gainedCells: number;
	lostCells: number;
	beforePersonnel: number;
	afterPersonnel: number;
	netPersonnel: number;
}

export interface MapTransferredBurg {
	burgId: number;
	burgName: string;
	isCapital: boolean;
	isPort: boolean;
	fromStateId: number;
	fromStateName: string;
	toStateId: number;
	toStateName: string;
	sector: CardinalSector;
}

export interface MapSnapshotDiffResult {
	fromRelPath: string;
	toRelPath: string;
	theaterId: string;
	theaterName: string;
	changedCellCount: number;
	stateDeltas: MapStateDeltaItem[];
	transferredBurgs: MapTransferredBurg[];
	addedBurgs: string[];
	removedBurgs: string[];
	beforeTotalPersonnel: number;
	afterTotalPersonnel: number;
	netTotalPersonnel: number;
	frontlineDelta: number;
	summaryText: string;
}

export interface SandboxProbeResult {
	url: string;
	reachable: boolean;
	statusCode?: number;
	latencyMs: number;
	title?: string;
	error?: string;
}

export type WenyouBridgeHostMessage =
	| { protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL; type: "ping"; requestId?: string }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "sync_context";
			payload: {
				worldId: string;
				worldTitle: string;
				currentEra: string;
				viewer?: string;
				workspaceKey?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "load_project";
			requestId?: string;
			payload: {
				fileName: string;
				projectJson: string;
				forceOverwrite?: boolean;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "request_export_project";
			requestId?: string;
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "reset_sandbox";
			requestId?: string;
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "create_image_theater";
			requestId?: string;
			payload: {
				name: string;
				imageUrl: string;
				imageRelPath?: string;
				gridPreset?: "coarse" | "standard" | "fine";
				mapWidthKm?: number;
			};
	  };

export type WenyouBridgeSandboxMessage =
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "ready" | "pong";
			requestId?: string;
			payload: {
				version: string;
				activeMapId: string | null;
				mapName: string | null;
				theaterCount: number;
				workspaceKey?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "context_acked";
			payload: {
				worldId: string;
				currentEra: string;
				activeMapId: string | null;
				workspaceKey?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "project_loaded";
			requestId?: string;
			payload: {
				ok: boolean;
				activeMapId?: string | null;
				mapName?: string | null;
				theaterCount?: number;
				workspaceKey?: string;
				error?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "project_exported";
			requestId?: string;
			payload: {
				ok: boolean;
				projectJson?: string;
				activeMapId?: string | null;
				mapName?: string | null;
				theaterCount?: number;
				workspaceKey?: string;
				error?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "image_theater_created";
			requestId?: string;
			payload: {
				ok: boolean;
				activeMapId?: string | null;
				mapName?: string | null;
				cellCount?: number;
				kmPerPixel?: number;
				workspaceKey?: string;
				error?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "autosave_project";
			payload: {
				projectJson: string;
				activeMapId: string;
				mapName: string;
				theaterCount: number;
				workspaceKey?: string;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "selection_changed";
			payload: {
				kind: "burg" | "unit";
				id: number | string;
				name: string;
				stateName?: string;
				personnel?: number;
				x?: number;
				y?: number;
			};
	  }
	| {
			protocol: typeof WENYOU_MAP_BRIDGE_PROTOCOL;
			type: "focus_source";
			payload: {
				sourceId: string;
				highlightQuote?: string;
			};
	  };

export interface WenyouCanonDocSummary {
	relPath: string;
	title: string;
	kind: "setting" | "chronicle";
	turn?: number;
	era?: string;
}

export interface WenyouPullQqResult {
	cwd: string;
	newlyIngested: number;
	skippedDuplicates: number;
	totalEvidenceCount: number;
	unreportedMessages: EvidenceMessageRecord[];
	cursors: GroupCursorRecord[];
	/** 本次经本机 NTQQ VFS 直读新同步进 L0 的条数（未启用或无绑定群时为 0/undefined） */
	ntqqSyncedCount?: number;
	/** 本机 NTQQ 直读出现非致命提示/告警时的说明（不影响 00-群聊收集/ 文件采集） */
	ntqqWarning?: string;
}

/** 本机 NTQQ 配置（仅落盘用户本机 ~/.wenyou-pro/ntqq/config.json，绝不写入任何可分享战役目录） */
export interface NtqqLocalConfig {
	qqUin: string | null;
	dbDir: string | null;
	keyMapPath: string | null;
	pythonPath: string | null;
}

/** 本机 NTQQ 只读解库环境探测快照 */
export interface NtqqProbeStatus {
	platformSupported: boolean;
	qqUin: string | null;
	resolvedDbDir: string | null;
	dbDirAutoDetected: boolean;
	msgDbExists: boolean;
	groupDbExists: boolean;
	walSizeBytes: number;
	resolvedKeyMapPath: string | null;
	keyMapExists: boolean;
	canExtractKey: boolean;
	pythonPath: string | null;
	pythonVersion: string | null;
	/** 是否命中随包内置的绿色嵌入式 Python 运行时（免用户自行安装 Python） */
	pythonBundled?: boolean;
	assetsDir: string | null;
	assetsReady: boolean;
	ready: boolean;
	missingReasons: string[];
}

export interface NtqqStatusSnapshot {
	config: NtqqLocalConfig;
	status: NtqqProbeStatus;
}

export interface NtqqGroupSummary {
	groupId: string;
	groupName: string;
}

export interface CampaignNtqqGroupBinding {
	groupId: string;
	groupName?: string;
	role: GroupRole;
}

export interface NtqqSyncGroupDetail {
	groupId: string;
	groupName: string;
	fetchedRows: number;
	exportedMessages: number;
	newlyIngested: number;
	skippedDuplicates: number;
	lastTs: number;
	lastRowid: number;
	truncated: boolean;
}

export interface NtqqSyncCampaignResult {
	cwd: string;
	newlyIngested: number;
	skippedDuplicates: number;
	totalEvidenceCount: number;
	unreportedCount: number;
	elapsedMs: number;
	backend: string;
	pagesDecrypted: number;
	pagesFromWal: number;
	groups: NtqqSyncGroupDetail[];
}

export interface WenyouWritePolicyResult {
	ok: boolean;
	artifact?: PolicyArtifact;
	error?: string;
}

export interface WenyouWorkspaceOverview {
	cwd: string;
	initialized: boolean;
	worldTitle: string;
	worldId: string;
	currentEra?: string;
	cursors: GroupCursorRecord[];
	totalEvidenceCount: number;
	unreportedCount: number;
	briefings: SituationBriefing[];
	rollingLedger: RollingLedgerEntry[];
	policies: PolicyArtifact[];
	maps: MapAssetItem[];
	canonDocs: WenyouCanonDocSummary[];
}

export type WenyouCanvasTab = "briefing" | "policy-desk" | "atlas-compare" | "archive-export";

export type WenyouCanvasEvent =
	| { kind: "open_tab"; cwd: string; tab: WenyouCanvasTab; sessionId?: string }
	| { kind: "briefing_published"; cwd: string; briefing: SituationBriefing; sessionId?: string }
	| { kind: "policy_written"; cwd: string; policy: PolicyArtifact; sessionId?: string }
	| {
			kind: "focus_source";
			cwd: string;
			sourceId: string;
			highlightQuote?: string;
			window?: number;
			sessionId?: string;
	  }
	| {
			kind: "open_maps";
			cwd: string;
			mode: "single" | "side-by-side" | "slider" | "pixi-sandbox";
			leftMapPath?: string;
			rightMapPath?: string;
			pixiUrl?: string;
			sessionId?: string;
	  }
	| { kind: "workspace_changed"; cwd: string; reason: string; sessionId?: string };
