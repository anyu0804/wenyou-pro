import {
	formatViewerScope,
	parseViewerScope,
	type SourceContextWindow,
	type ViewerScope,
	type WenyouCanvasEvent,
	type WenyouCanvasTab,
	type WenyouExportPreflightResult,
	type WenyouWorkspaceOverview,
} from "@percho/shared";
import { create } from "zustand";
import { getExecutionApi } from "../environment-api";
import { COMPOSER_FOCUS_EVENT, newSessionDraftKey, useDraftStore, withDraftText } from "./drafts";
import { useSessionsStore } from "./sessions";
import { pushExtensionToast } from "./toasts";
import { useUiStore } from "./ui";
import { sameDirectoryPath } from "../components/wenyou/wenyou-helpers";

export const WENYOU_CANVAS_MIN_WIDTH = 380;
export const WENYOU_CANVAS_MAX_WIDTH = 1040;
export const WENYOU_CANVAS_DEFAULT_WIDTH = 560;

const WIDTH_STORAGE_KEY = "wenyou.canvas.width";
const PIXI_URL_STORAGE_KEY = "wenyou.canvas.pixiUrl";

export type WenyouMapMode = "single" | "side-by-side" | "slider" | "pixi-sandbox";

export interface SourceContextDrawerState {
	open: boolean;
	loading: boolean;
	sourceId: string | null;
	highlightQuote?: string;
	data: SourceContextWindow | null;
	error: string | null;
}

export interface LastPullSummary {
	newlyIngested: number;
	skippedDuplicates: number;
	unreportedCount: number;
	at: number;
}

function clampWidth(raw: number): number {
	if (!Number.isFinite(raw)) return WENYOU_CANVAS_DEFAULT_WIDTH;
	return Math.round(Math.min(WENYOU_CANVAS_MAX_WIDTH, Math.max(WENYOU_CANVAS_MIN_WIDTH, raw)));
}

function readStoredWidth(): number {
	try {
		const saved = localStorage.getItem(WIDTH_STORAGE_KEY);
		if (!saved) return WENYOU_CANVAS_DEFAULT_WIDTH;
		return clampWidth(Number(saved));
	} catch {
		return WENYOU_CANVAS_DEFAULT_WIDTH;
	}
}

function readStoredPixiUrl(): string {
	try {
		return localStorage.getItem(PIXI_URL_STORAGE_KEY) || "http://127.0.0.1:4173";
	} catch {
		return "http://127.0.0.1:4173";
	}
}

const EMPTY_SOURCE_DRAWER: SourceContextDrawerState = {
	open: false,
	loading: false,
	sourceId: null,
	data: null,
	error: null,
};

let overviewRequestSeq = 0;
let sourceRequestSeq = 0;

interface WenyouCanvasState {
	open: boolean;
	maximized: boolean;
	width: number;
	activeTab: WenyouCanvasTab;
	cwd: string | null;
	viewerScope: ViewerScope;
	overview: WenyouWorkspaceOverview | null;
	loading: boolean;
	error: string | null;
	unreadCount: number;

	// Tab 1: 局势书与台账
	selectedBriefingId: string | null;
	briefingSubView: "briefing" | "ledger";
	pullingQq: boolean;
	lastPullSummary: LastPullSummary | null;
	sourceDrawer: SourceContextDrawerState;

	// Tab 2: 国策书案
	selectedPolicyId: string | null;

	// Tab 3: 地图比对与沙盘
	mapMode: WenyouMapMode;
	leftMapPath: string | null;
	rightMapPath: string | null;
	syncViewport: boolean;
	pixiUrl: string;

	// Tab 4: 正史提案与发包
	selectedProposalId: string | null;
	preflightTargetViewer: string;
	preflightResult: WenyouExportPreflightResult | null;
	preflightLoading: boolean;

	// 全局弹窗：新建空白文游世界
	createWorldDialogOpen: boolean;

	// 基础控制
	setOpen: (open: boolean) => void;
	toggleOpen: () => void;
	setCreateWorldDialogOpen: (open: boolean) => void;
	setMaximized: (maximized: boolean) => void;
	toggleMaximized: () => void;
	previewWidth: (width: number) => void;
	commitWidth: () => void;
	setActiveTab: (tab: WenyouCanvasTab) => void;
	setViewerScope: (scope: ViewerScope | string) => Promise<void>;

	// 工作区与数据拉取
	syncActiveCwd: (cwd: string | null) => Promise<void>;
	refreshOverview: (targetCwd?: string | null, opts?: { silent?: boolean }) => Promise<void>;
	initCampaign: (worldTitle?: string, currentEra?: string) => Promise<void>;

	// Tab 1 Actions
	setSelectedBriefingId: (id: string | null) => void;
	setBriefingSubView: (view: "briefing" | "ledger") => void;
	pullQqIncremental: (groupId?: string) => Promise<void>;
	openSourceContext: (sourceId: string, highlightQuote?: string) => Promise<void>;
	closeSourceContext: () => void;

	// Tab 2 Actions
	setSelectedPolicyId: (id: string | null) => void;

	// Tab 3 Actions
	setMapMode: (mode: WenyouMapMode) => void;
	setLeftMapPath: (path: string | null) => void;
	setRightMapPath: (path: string | null) => void;
	setSyncViewport: (sync: boolean) => void;
	setPixiUrl: (url: string) => void;

	// Tab 4 Actions
	setSelectedProposalId: (id: string | null) => void;
	decideProposal: (proposalId: string, decision: "approved" | "rejected") => Promise<void>;
	setPreflightTargetViewer: (viewer: string) => void;
	runExportPreflight: (targetViewer?: string) => Promise<WenyouExportPreflightResult | null>;

	// Agent 推送事件总入口
	handleCanvasEvent: (event: WenyouCanvasEvent) => void;
}

export const useWenyouCanvasStore = create<WenyouCanvasState>((set, get) => ({
	open: false,
	maximized: false,
	width: readStoredWidth(),
	activeTab: "briefing",
	cwd: null,
	viewerScope: { kind: "gm" },
	overview: null,
	loading: false,
	error: null,
	unreadCount: 0,

	selectedBriefingId: null,
	briefingSubView: "briefing",
	pullingQq: false,
	lastPullSummary: null,
	sourceDrawer: EMPTY_SOURCE_DRAWER,

	selectedPolicyId: null,

	mapMode: "single",
	leftMapPath: null,
	rightMapPath: null,
	syncViewport: true,
	pixiUrl: readStoredPixiUrl(),

	selectedProposalId: null,
	preflightTargetViewer: "public",
	preflightResult: null,
	preflightLoading: false,

	createWorldDialogOpen: false,

	setOpen: (open) => {
		if (open) {
			useUiStore.getState().setDiffSidebarOpen(false);
		}
		set({ open, ...(open ? { unreadCount: 0 } : {}) });
		if (open && get().cwd) {
			void get().refreshOverview(get().cwd, { silent: Boolean(get().overview) });
		}
	},

	toggleOpen: () => {
		const next = !get().open;
		get().setOpen(next);
	},

	setCreateWorldDialogOpen: (createWorldDialogOpen) => set({ createWorldDialogOpen }),

	setMaximized: (maximized) => set({ maximized }),
	toggleMaximized: () => set((s) => ({ maximized: !s.maximized })),

	previewWidth: (width) => set({ width: clampWidth(width) }),

	commitWidth: () => {
		try {
			localStorage.setItem(WIDTH_STORAGE_KEY, String(get().width));
		} catch {
			// ignore storage failure
		}
	},

	setActiveTab: (activeTab) => set({ activeTab }),

	setViewerScope: async (rawScope) => {
		let parsed: ViewerScope;
		try {
			parsed = parseViewerScope(rawScope);
		} catch (error) {
			pushExtensionToast("warning", error instanceof Error ? error.message : String(error), "Wenyou Pro");
			return;
		}
		set({ viewerScope: parsed, preflightResult: null });
		await get().refreshOverview(get().cwd);
	},

	syncActiveCwd: async (cwd) => {
		const prevCwd = get().cwd;
		if (sameDirectoryPath(prevCwd, cwd) && (cwd === null || get().overview !== null)) {
			if (prevCwd !== cwd) set({ cwd });
			return;
		}
		set({
			cwd,
			overview: null,
			error: null,
			selectedBriefingId: null,
			selectedPolicyId: null,
			leftMapPath: null,
			rightMapPath: null,
			selectedProposalId: null,
			sourceDrawer: EMPTY_SOURCE_DRAWER,
			lastPullSummary: null,
			preflightResult: null,
		});
		if (cwd) {
			await get().refreshOverview(cwd, { silent: true });
		}
	},

	refreshOverview: async (targetCwd, opts) => {
		const cwd = targetCwd !== undefined ? targetCwd : get().cwd;
		if (!cwd) {
			set({ overview: null, loading: false, error: null });
			return;
		}
		const seq = ++overviewRequestSeq;
		if (!opts?.silent) set({ loading: true, error: null });
		try {
			const viewer = formatViewerScope(get().viewerScope);
			const overview = await getExecutionApi(cwd).wenyouGetOverview({ cwd, viewer });
			if (seq !== overviewRequestSeq) return;
			set((state) => {
				const selectedBriefingId =
					state.selectedBriefingId && overview.briefings.some((b) => b.id === state.selectedBriefingId)
						? state.selectedBriefingId
						: (overview.briefings[0]?.id ?? null);
				const selectedPolicyId =
					state.selectedPolicyId && overview.policies.some((p) => p.id === state.selectedPolicyId)
						? state.selectedPolicyId
						: (overview.policies[0]?.id ?? null);
				const leftMapPath =
					state.leftMapPath && overview.maps.some((m) => m.relPath === state.leftMapPath)
						? state.leftMapPath
						: (overview.maps[0]?.relPath ?? null);
				const rightMapPath =
					state.rightMapPath && overview.maps.some((m) => m.relPath === state.rightMapPath)
						? state.rightMapPath
						: (overview.maps[1]?.relPath ?? overview.maps[0]?.relPath ?? null);
				const pending = overview.proposals.find((p) => p.status === "pending");
				const selectedProposalId =
					state.selectedProposalId &&
					overview.proposals.some((p) => p.proposalId === state.selectedProposalId)
						? state.selectedProposalId
						: (pending?.proposalId ?? overview.proposals[0]?.proposalId ?? null);
				return {
					overview,
					loading: false,
					error: null,
					selectedBriefingId,
					selectedPolicyId,
					leftMapPath,
					rightMapPath,
					selectedProposalId,
				};
			});
		} catch (error) {
			if (seq !== overviewRequestSeq) return;
			set({
				loading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	initCampaign: async (worldTitle, currentEra) => {
		const cwd = get().cwd;
		if (!cwd) return;
		set({ loading: true, error: null });
		try {
			const overview = await getExecutionApi(cwd).wenyouInitCampaign({
				cwd,
				...(worldTitle?.trim() ? { worldTitle: worldTitle.trim() } : {}),
				...(currentEra?.trim() ? { currentEra: currentEra.trim() } : {}),
			});
			set({ overview, loading: false, error: null });
			pushExtensionToast("info", `已初始化标准文游工作区：${overview.worldTitle}`, "Wenyou Pro");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			set({ loading: false, error: message });
			pushExtensionToast("error", `初始化文游工作区失败：${message}`, "Wenyou Pro");
		}
	},

	setSelectedBriefingId: (selectedBriefingId) => set({ selectedBriefingId }),
	setBriefingSubView: (briefingSubView) => set({ briefingSubView }),

	pullQqIncremental: async (groupId) => {
		const cwd = get().cwd;
		if (!cwd || get().pullingQq) return;
		set({ pullingQq: true });
		try {
			const res = await getExecutionApi(cwd).wenyouPullQq({
				cwd,
				...(groupId ? { groupId } : {}),
			});
			const unreportedCount = res.cursors.reduce((sum, c) => sum + c.unreportedCount, 0);
			set({
				pullingQq: false,
				lastPullSummary: {
					newlyIngested: res.newlyIngested,
					skippedDuplicates: res.skippedDuplicates,
					unreportedCount,
					at: Date.now(),
				},
			});
			pushExtensionToast(
				res.ntqqWarning ? "warning" : "info",
				`群聊增量扫描完成：新入库 ${res.newlyIngested} 条${res.ntqqSyncedCount ? `（NTQQ 直读 ${res.ntqqSyncedCount} 条）` : ""}，去重 ${res.skippedDuplicates} 条，待汇报 ${unreportedCount} 条${res.ntqqWarning ? `；提示：${res.ntqqWarning}` : ""}`,
				"Wenyou Pro",
			);
			await get().refreshOverview(cwd, { silent: true });
		} catch (error) {
			set({ pullingQq: false });
			pushExtensionToast(
				"error",
				`扫描群聊增量失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		}
	},

	openSourceContext: async (sourceId, highlightQuote) => {
		const cwd = get().cwd;
		const cleanId = sourceId.trim().replace(/^\[|\]$/g, "");
		if (!cwd || !cleanId) return;
		const seq = ++sourceRequestSeq;
		set({
			sourceDrawer: {
				open: true,
				loading: true,
				sourceId: cleanId,
				highlightQuote,
				data: null,
				error: null,
			},
		});
		try {
			const viewer = formatViewerScope(get().viewerScope);
			const data = await getExecutionApi(cwd).wenyouLookupSource({
				cwd,
				sourceId: cleanId,
				window: 10,
				viewer,
			});
			if (seq !== sourceRequestSeq) return;
			if (!data) {
				set({
					sourceDrawer: {
						open: true,
						loading: false,
						sourceId: cleanId,
						highlightQuote,
						data: null,
						error: `未在当前视角（${viewer}）下找到编号为 ${cleanId} 的群聊原文`,
					},
				});
				return;
			}
			set({
				sourceDrawer: {
					open: true,
					loading: false,
					sourceId: cleanId,
					highlightQuote,
					data,
					error: null,
				},
			});
		} catch (error) {
			if (seq !== sourceRequestSeq) return;
			set({
				sourceDrawer: {
					open: true,
					loading: false,
					sourceId: cleanId,
					highlightQuote,
					data: null,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	},

	closeSourceContext: () => set({ sourceDrawer: EMPTY_SOURCE_DRAWER }),

	setSelectedPolicyId: (selectedPolicyId) => set({ selectedPolicyId }),

	setMapMode: (mapMode) => set({ mapMode }),
	setLeftMapPath: (leftMapPath) => set({ leftMapPath }),
	setRightMapPath: (rightMapPath) => set({ rightMapPath }),
	setSyncViewport: (syncViewport) => set({ syncViewport }),
	setPixiUrl: (pixiUrl) => {
		set({ pixiUrl });
		try {
			localStorage.setItem(PIXI_URL_STORAGE_KEY, pixiUrl);
		} catch {
			// ignore storage failure
		}
	},

	setSelectedProposalId: (selectedProposalId) => set({ selectedProposalId }),

	decideProposal: async (proposalId, decision) => {
		const cwd = get().cwd;
		if (!cwd) return;
		try {
			const viewer = formatViewerScope(get().viewerScope);
			const updated = await getExecutionApi(cwd).wenyouDecideProposal({
				cwd,
				proposalId,
				decision,
				viewer,
			});
			pushExtensionToast(
				"info",
				decision === "approved"
					? `已批准并原子合入正史：${updated.targetPath}`
					: `已驳回正史提案：${updated.targetPath}`,
				"Wenyou Pro",
			);
			await get().refreshOverview(cwd, { silent: true });
		} catch (error) {
			pushExtensionToast(
				"error",
				`提案裁决失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		}
	},

	setPreflightTargetViewer: (preflightTargetViewer) =>
		set({ preflightTargetViewer, preflightResult: null }),

	runExportPreflight: async (targetViewerArg) => {
		const cwd = get().cwd;
		if (!cwd) return null;
		const targetViewer = (targetViewerArg ?? get().preflightTargetViewer).trim() || "public";
		set({ preflightLoading: true, preflightTargetViewer: targetViewer });
		try {
			const result = await getExecutionApi(cwd).wenyouExportPreflight({
				cwd,
				targetViewer,
			});
			set({ preflightLoading: false, preflightResult: result });
			return result;
		} catch (error) {
			set({ preflightLoading: false });
			pushExtensionToast(
				"error",
				`泄密预检失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
			return null;
		}
	},

	handleCanvasEvent: (event) => {
		const state = get();
		const activeSessionId = useSessionsStore.getState().activeSessionId;
		const matchesCwd = !state.cwd || sameDirectoryPath(state.cwd, event.cwd);
		const matchesSession = !event.sessionId || !activeSessionId || event.sessionId === activeSessionId;
		if (!matchesCwd && !matchesSession) return;

		const targetCwd = state.cwd && sameDirectoryPath(state.cwd, event.cwd) ? state.cwd : event.cwd;

		if (event.kind === "workspace_changed") {
			if (sameDirectoryPath(state.cwd, event.cwd)) {
				void get().refreshOverview(state.cwd, { silent: true });
			}
			return;
		}

		// Agent 主动触达画布核心动作：自动展开右侧画布、切 Tab、聚焦产物并刷新
		useUiStore.getState().setDiffSidebarOpen(false);

		switch (event.kind) {
			case "open_tab":
				set({
					open: true,
					unreadCount: 0,
					cwd: targetCwd,
					activeTab: event.tab,
				});
				void get().refreshOverview(targetCwd, { silent: Boolean(state.overview) });
				break;

			case "briefing_published":
				set((prev) => {
					const existing = prev.overview?.briefings ?? [];
					const merged = [event.briefing, ...existing.filter((b) => b.id !== event.briefing.id)];
					return {
						open: true,
						unreadCount: 0,
						cwd: targetCwd,
						activeTab: "briefing",
						briefingSubView: "briefing",
						selectedBriefingId: event.briefing.id,
						overview: prev.overview ? { ...prev.overview, briefings: merged } : prev.overview,
					};
				});
				void get().refreshOverview(targetCwd, { silent: true });
				break;

			case "policy_written":
				set((prev) => {
					const existing = prev.overview?.policies ?? [];
					const merged = [event.policy, ...existing.filter((p) => p.id !== event.policy.id)];
					return {
						open: true,
						unreadCount: 0,
						cwd: targetCwd,
						activeTab: "policy-desk",
						selectedPolicyId: event.policy.id,
						overview: prev.overview ? { ...prev.overview, policies: merged } : prev.overview,
					};
				});
				void get().refreshOverview(targetCwd, { silent: true });
				break;

			case "focus_source":
				set({
					open: true,
					unreadCount: 0,
					cwd: targetCwd,
					activeTab: "briefing",
				});
				void get().openSourceContext(event.sourceId, event.highlightQuote);
				break;

			case "open_maps":
				set((prev) => ({
					open: true,
					unreadCount: 0,
					cwd: targetCwd,
					activeTab: "atlas-compare",
					mapMode: event.mode,
					leftMapPath: event.leftMapPath ?? prev.leftMapPath,
					rightMapPath: event.rightMapPath ?? prev.rightMapPath,
					syncViewport: event.mode === "side-by-side" ? true : prev.syncViewport,
					...(event.pixiUrl ? { pixiUrl: event.pixiUrl } : {}),
				}));
				void get().refreshOverview(targetCwd, { silent: true });
				break;

			case "proposal_created":
				set((prev) => {
					const existing = prev.overview?.proposals ?? [];
					const merged = [
						event.proposal,
						...existing.filter((p) => p.proposalId !== event.proposal.proposalId),
					];
					return {
						open: true,
						unreadCount: 0,
						cwd: targetCwd,
						activeTab: "archive-export",
						selectedProposalId: event.proposal.proposalId,
						overview: prev.overview ? { ...prev.overview, proposals: merged } : prev.overview,
					};
				});
				void get().refreshOverview(targetCwd, { silent: true });
				break;
		}
	},
}));

/** 将自然语言快捷指令填入当前输入框、聚焦 Composer，并可选同步打开文游画布对应页签 */
export function fillWenyouPrompt(prompt: string, tab?: WenyouCanvasTab): void {
	const sessions = useSessionsStore.getState();
	const activeSessionId = sessions.activeSessionId;
	const draftConfig = sessions.newSessionDraft;
	const draftKey = activeSessionId ?? newSessionDraftKey(draftConfig?.environment, draftConfig?.cwd);
	useDraftStore.getState().updateDraft(draftKey, (entry) => withDraftText(entry, prompt));
	window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: { moveToEnd: true } }));
	if (tab) {
		const canvas = useWenyouCanvasStore.getState();
		canvas.setActiveTab(tab);
		canvas.setOpen(true);
	}
}
