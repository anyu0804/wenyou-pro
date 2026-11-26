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
	"private/proposals",
	".wenyou",
] as const;

export const WENYOU_ASSET_PROTOCOL = "wenyou-asset";

export const VISIBILITY_LEVELS = ["gm", "public", "faction"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

export type ViewerScope =
	| { readonly kind: "gm" }
	| { readonly kind: "public" }
	| { readonly kind: "faction"; readonly factionId: string };

export function parseViewerScope(raw?: string | ViewerScope | null): ViewerScope {
	if (!raw) return { kind: "gm" };
	if (typeof raw === "object") {
		if (raw.kind === "gm" || raw.kind === "public") return { kind: raw.kind };
		if (raw.kind === "faction" && typeof raw.factionId === "string" && raw.factionId.trim().length > 0) {
			return { kind: "faction", factionId: raw.factionId.trim() };
		}
		throw new Error("无效的 ViewerScope 对象");
	}
	const trimmed = raw.trim();
	if (trimmed === "gm") return { kind: "gm" };
	if (trimmed === "public") return { kind: "public" };
	if (trimmed.startsWith("faction:")) {
		const factionId = trimmed.slice("faction:".length).trim();
		if (factionId.length > 0) return { kind: "faction", factionId };
	}
	throw new Error(`无效视角格式：${raw}（应为 gm | public | faction:<id>）`);
}

export function formatViewerScope(scope: ViewerScope): string {
	return scope.kind === "faction" ? `faction:${scope.factionId}` : scope.kind;
}

export function buildWenyouAssetUrl(cwd: string, relPath: string): string {
	const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const params = new URLSearchParams({ cwd, path: normalized });
	return `${WENYOU_ASSET_PROTOCOL}://vault?${params.toString()}`;
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

export type EvidenceMessageKind = "chat" | "gm_ruling" | "dice_roll" | "diplomacy" | "ooc";

export interface EvidenceMessageRecord {
	sourceId: string;
	groupId: string;
	groupName: string;
	sender: string;
	senderId?: string;
	timestamp: string;
	text: string;
	kind: EvidenceMessageKind;
	visibility: VisibilityLevel;
	visibleToFactions?: string[];
	fingerprint: string;
	lineIndex: number;
}

export interface SourceContextWindow {
	targetSourceId: string;
	groupId: string;
	groupName: string;
	targetIndex: number;
	messages: EvidenceMessageRecord[];
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
	/** <=120字核心结论 */
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

export const POLICY_LINT_CODES = [
	"CROSS_FACTION_LEAK",
	"TIMELINE_ANACHRONISM",
	"FORBIDDEN_MARKDOWN_TABLE",
	"NESTED_LIST_VIOLATION",
	"CLICHE_PHRASE",
] as const;
export type PolicyLintCode = (typeof POLICY_LINT_CODES)[number];

export type PolicyLintSeverity = "error" | "warning" | "info";

export interface PolicyLintIssue {
	code: PolicyLintCode;
	severity: PolicyLintSeverity;
	message: string;
	excerpt: string;
	relatedEntityId?: string;
}

export interface PolicyLintReport {
	actorEntityId?: string;
	branchId?: string;
	currentOrder?: number;
	passed: boolean;
	issues: PolicyLintIssue[];
	rewriteInstructions?: string;
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
	lintReport: PolicyLintReport;
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

export type ProposalStatus = "pending" | "approved" | "rejected";
export type PatchOperation = "create" | "update";

export interface DiffPatchProposal {
	proposalId: string;
	createdAt: string;
	targetPath: string;
	operation: PatchOperation;
	summary: string;
	beforeContent?: string;
	afterContent: string;
	sourceRefs: string[];
	warnings: string[];
	status: ProposalStatus;
	viewer: ViewerScope;
	decidedAt?: string;
}

export interface WenyouCanonDocSummary {
	relPath: string;
	title: string;
	kind: "setting" | "chronicle" | "wiki";
	visibility: VisibilityLevel;
	visibleToFactions?: string[];
	turn?: number;
	era?: string;
}

export interface WenyouExportPreflightResult {
	targetViewer: ViewerScope;
	allowedFiles: string[];
	blockedPrivateFiles: string[];
	blockedVisibilityFiles: string[];
	strippedSecretBlockCount: number;
	warnings: string[];
	bundleJson: string;
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
	visibility?: VisibilityLevel;
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
	lintReport: PolicyLintReport;
	artifact?: PolicyArtifact;
	error?: string;
}

export interface WenyouWorkspaceOverview {
	cwd: string;
	initialized: boolean;
	worldTitle: string;
	worldId: string;
	currentEra?: string;
	viewer: ViewerScope;
	cursors: GroupCursorRecord[];
	totalEvidenceCount: number;
	unreportedCount: number;
	briefings: SituationBriefing[];
	rollingLedger: RollingLedgerEntry[];
	policies: PolicyArtifact[];
	maps: MapAssetItem[];
	proposals: DiffPatchProposal[];
	canonDocs: WenyouCanonDocSummary[];
}

export type WenyouCanvasTab = "briefing" | "policy-desk" | "atlas-compare" | "archive-export";

export type WenyouCanvasEvent =
	| { kind: "open_tab"; cwd: string; tab: WenyouCanvasTab; sessionId?: string }
	| { kind: "briefing_published"; cwd: string; briefing: SituationBriefing; sessionId?: string }
	| { kind: "policy_written"; cwd: string; policy: PolicyArtifact; sessionId?: string }
	| { kind: "focus_source"; cwd: string; sourceId: string; highlightQuote?: string; sessionId?: string }
	| {
			kind: "open_maps";
			cwd: string;
			mode: "single" | "side-by-side" | "slider" | "pixi-sandbox";
			leftMapPath?: string;
			rightMapPath?: string;
			pixiUrl?: string;
			sessionId?: string;
	  }
	| { kind: "proposal_created"; cwd: string; proposal: DiffPatchProposal; sessionId?: string }
	| { kind: "workspace_changed"; cwd: string; reason: string; sessionId?: string };
