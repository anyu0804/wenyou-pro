// @vitest-environment happy-dom
import type {
	CampaignNtqqGroupBinding,
	NtqqGroupSummary,
	NtqqStatusSnapshot,
	NtqqSyncCampaignResult,
	WenyouWorkspaceOverview,
} from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const piMocks = vi.hoisted(() => ({
	wenyouGetDefaultWorldsDir: vi.fn<() => Promise<string>>(),
	wenyouCreateWorldDir: vi.fn<(args: { worldTitle?: string; parentDir?: string }) => Promise<{ cwd: string; worldTitle: string }>>(),
	wenyouNtqqGetStatus: vi.fn<() => Promise<NtqqStatusSnapshot>>(),
	wenyouNtqqListGroups: vi.fn<() => Promise<{ groups: NtqqGroupSummary[]; elapsedMs: number }>>(),
	wenyouNtqqSaveCampaignBindings: vi.fn<(args: { cwd: string; bindings: CampaignNtqqGroupBinding[] }) => Promise<CampaignNtqqGroupBinding[]>>(),
	wenyouNtqqSyncCampaign: vi.fn<() => Promise<NtqqSyncCampaignResult>>(),
	pickDirectory: vi.fn<() => Promise<string | null>>(),
}));

const execMocks = vi.hoisted(() => ({
	wenyouInitCampaign: vi.fn<(args: { cwd: string; worldTitle?: string; currentEra?: string }) => Promise<WenyouWorkspaceOverview>>(),
	wenyouGetOverview: vi.fn<(args: { cwd: string; viewer?: string }) => Promise<WenyouWorkspaceOverview>>(),
	ensureProjectTrust: vi.fn<() => Promise<void>>(),
	prompt: vi.fn<(args: { sessionId: string; text: string }) => Promise<void>>(),
}));

const projectsMocks = vi.hoisted(() => ({
	addKnownProject: vi.fn<(cwd: string) => void>(),
}));

const sessionsState = vi.hoisted(() => ({
	activeSessionId: null as string | null,
	newSessionDraft: {
		cwd: null as string | null,
		environment: { kind: "local" as const },
		model: { provider: "deepseek", modelId: "deepseek-chat" } as { provider: string; modelId: string } | null,
	},
	models: [{ provider: "deepseek", modelId: "deepseek-chat", authed: true }],
	activateNewSessionDraftForCwd: vi.fn<(cwd: string) => void>(),
	createSession: vi.fn<() => Promise<string | null>>(),
}));

const transcriptMocks = vi.hoisted(() => ({
	markAgentActive: vi.fn(),
	appendOptimisticUser: vi.fn(() => "opt-1"),
	removeOptimisticUser: vi.fn(),
}));

const draftMocks = vi.hoisted(() => ({
	updateDraft: vi.fn(),
}));

const toastMock = vi.hoisted(() => vi.fn());

vi.mock("../../api", () => ({
	getPi: () => piMocks,
}));

vi.mock("../../environment-api", () => ({
	getExecutionApi: () => execMocks,
}));

vi.mock("../../stores/projects", () => ({
	useProjectsStore: {
		getState: () => projectsMocks,
	},
}));

vi.mock("../../stores/sessions", () => ({
	useSessionsStore: {
		getState: () => sessionsState,
	},
}));

vi.mock("../../stores/transcript", () => ({
	useTranscriptStore: {
		getState: () => transcriptMocks,
	},
}));

vi.mock("../../stores/drafts", () => ({
	COMPOSER_FOCUS_EVENT: "pi:composer-focus",
	newSessionDraftKey: (_env: unknown, cwd: string | null) => `draft:${cwd ?? ""}`,
	withDraftText: (entry: unknown, text: string) => ({ ...(entry as object), text }),
	useDraftStore: {
		getState: () => draftMocks,
	},
}));

vi.mock("../../stores/toasts", () => ({
	pushExtensionToast: toastMock,
}));

import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { CreateWorldDialog } from "./CreateWorldDialog";
import { buildWorldBootstrapPrompt } from "./world-bootstrap";

function makeSnapshot(ready: boolean): NtqqStatusSnapshot {
	return {
		config: { qqUin: ready ? "10001" : null, dbDir: null, keyMapPath: null, pythonPath: null },
		status: {
			platformSupported: true,
			qqUin: ready ? "10001" : null,
			resolvedDbDir: ready ? "C:\\mock\\nt_db" : null,
			dbDirAutoDetected: ready,
			msgDbExists: ready,
			groupDbExists: ready,
			walSizeBytes: 0,
			resolvedKeyMapPath: ready ? "C:\\mock\\key_map.json" : null,
			keyMapExists: ready,
			canExtractKey: true,
			pythonPath: "python",
			pythonVersion: "3.13.9",
			assetsDir: "C:\\mock\\ntqq-vfs",
			assetsReady: true,
			ready,
			missingReasons: ready ? [] : ["尚未配置 QQ 号"],
		},
	};
}

function makeOverview(cwd: string, worldTitle: string): WenyouWorkspaceOverview {
	return {
		cwd,
		initialized: true,
		worldId: "world-1",
		worldTitle,
		currentEra: "起始建档",
		viewer: { kind: "gm" },
		cursors: [],
		totalEvidenceCount: 0,
		unreportedCount: 0,
		briefings: [],
		rollingLedger: [],
		policies: [],
		maps: [],
		proposals: [],
		canonDocs: [],
	};
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

	sessionsState.activeSessionId = null;
	sessionsState.newSessionDraft = {
		cwd: null,
		environment: { kind: "local" },
		model: { provider: "deepseek", modelId: "deepseek-chat" },
	};
	sessionsState.models = [{ provider: "deepseek", modelId: "deepseek-chat", authed: true }];
	sessionsState.activateNewSessionDraftForCwd.mockImplementation((cwd: string) => {
		sessionsState.newSessionDraft.cwd = cwd;
	});
	sessionsState.createSession.mockResolvedValue("sess-new-world-1");

	piMocks.wenyouGetDefaultWorldsDir.mockResolvedValue("C:\\mock\\.wenyou-pro\\worlds");
	piMocks.wenyouCreateWorldDir.mockImplementation(async ({ worldTitle }) => ({
		cwd: `C:\\mock\\.wenyou-pro\\worlds\\${worldTitle || "新世界"}`,
		worldTitle: worldTitle || "新世界",
	}));
	piMocks.wenyouNtqqGetStatus.mockResolvedValue(makeSnapshot(true));
	piMocks.wenyouNtqqListGroups.mockResolvedValue({
		groups: [
			{ groupId: "951594174", groupName: "顺唐文游主群" },
			{ groupId: "778445673", groupName: "威尼西亚内阁" },
		],
		elapsedMs: 12,
	});
	piMocks.wenyouNtqqSaveCampaignBindings.mockImplementation(async ({ bindings }) => bindings);
	piMocks.wenyouNtqqSyncCampaign.mockResolvedValue({
		cwd: "C:\\mock\\.wenyou-pro\\worlds\\顺唐文游主群",
		newlyIngested: 42,
		skippedDuplicates: 0,
		totalEvidenceCount: 42,
		unreportedCount: 42,
		elapsedMs: 85,
		backend: "vfs",
		pagesDecrypted: 4,
		pagesFromWal: 1,
		groups: [],
	});

	execMocks.ensureProjectTrust.mockResolvedValue(undefined);
	execMocks.wenyouInitCampaign.mockImplementation(async ({ cwd, worldTitle }) =>
		makeOverview(cwd, worldTitle ?? "新建文游世界"),
	);
	execMocks.wenyouGetOverview.mockImplementation(async ({ cwd }) => makeOverview(cwd, "顺唐文游主群"));
	execMocks.prompt.mockResolvedValue(undefined);

	useWenyouCanvasStore.setState({
		open: false,
		createWorldDialogOpen: true,
		cwd: null,
		overview: null,
		activeTab: "briefing",
	});

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("CreateWorldDialog", () => {
	it("勾选本机主群自动回填世界名，一键创建空世界、同步群聊并自动发给 Agent 抓取建档", async () => {
		await act(async () => {
			root.render(<CreateWorldDialog />);
		});

		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain("顺唐文游主群");

		// 勾选第一个群（应自动回填世界名并设为主群）
		const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(checkbox).not.toBeNull();
		await act(async () => {
			checkbox?.click();
		});

		const titleInput = dialog?.querySelector<HTMLInputElement>('input[placeholder*="留空则自动使用主群名"]');
		expect(titleInput?.value).toBe("顺唐文游主群");

		const submitBtn = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent?.includes("创建并抓取 1 个群建档"),
		);
		expect(submitBtn).toBeDefined();

		await act(async () => {
			submitBtn?.click();
		});

		expect(piMocks.wenyouCreateWorldDir).toHaveBeenCalledWith({ worldTitle: "顺唐文游主群" });
		expect(execMocks.wenyouInitCampaign).toHaveBeenCalledWith({
			cwd: "C:\\mock\\.wenyou-pro\\worlds\\顺唐文游主群",
			worldTitle: "顺唐文游主群",
			currentEra: "起始建档",
		});
		expect(projectsMocks.addKnownProject).toHaveBeenCalledWith("C:\\mock\\.wenyou-pro\\worlds\\顺唐文游主群");
		expect(piMocks.wenyouNtqqSaveCampaignBindings).toHaveBeenCalledWith({
			cwd: "C:\\mock\\.wenyou-pro\\worlds\\顺唐文游主群",
			bindings: [{ groupId: "951594174", groupName: "顺唐文游主群", role: "main" }],
		});
		expect(piMocks.wenyouNtqqSyncCampaign).toHaveBeenCalledWith({
			cwd: "C:\\mock\\.wenyou-pro\\worlds\\顺唐文游主群",
			limit: 500,
		});
		expect(sessionsState.createSession).toHaveBeenCalledTimes(1);
		expect(execMocks.prompt).toHaveBeenCalledTimes(1);
		const sentPrompt = execMocks.prompt.mock.calls[0]?.[0]?.text ?? "";
		expect(sentPrompt).toContain("顺唐文游主群");
		expect(sentPrompt).toContain("951594174");
		expect(sentPrompt).toContain("42 条消息");
		expect(sentPrompt).toContain("绝不编造");
		expect(useWenyouCanvasStore.getState().createWorldDialogOpen).toBe(false);
		expect(useWenyouCanvasStore.getState().open).toBe(true);
	});

	it("未配置模型时不强发请求，回退写入输入框草稿并打开画布；支持未点添加直接提交手输群号", async () => {
		piMocks.wenyouNtqqGetStatus.mockResolvedValue(makeSnapshot(false));
		sessionsState.newSessionDraft.model = null;
		sessionsState.models = [];

		await act(async () => {
			root.render(<CreateWorldDialog />);
		});

		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("本机 QQ 只读抓取未就绪");

		// 先验证非法群号拦截
		const gidInput = dialog?.querySelector<HTMLInputElement>('input[placeholder*="输入 QQ 群号"]');
		expect(gidInput).not.toBeNull();
		await act(async () => {
			setInputValue(gidInput!, "abc");
		});
		const addBtn = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "添加");
		await act(async () => {
			addBtn?.click();
		});
		expect(dialog?.textContent).toContain("5～15 位纯数字");

		// 输入合法群号但故意不点「添加」，直接点创建并抓取
		await act(async () => {
			setInputValue(gidInput!, "1129584655");
		});
		const submitBtn = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent?.includes("创建并抓取 1 个群建档"),
		);
		expect(submitBtn).toBeDefined();
		await act(async () => {
			submitBtn?.click();
		});

		expect(piMocks.wenyouNtqqSaveCampaignBindings).toHaveBeenCalledWith({
			cwd: expect.any(String),
			bindings: [{ groupId: "1129584655", groupName: "1129584655", role: "main" }],
		});
		// 未就绪时不调 NTQQ 同步
		expect(piMocks.wenyouNtqqSyncCampaign).not.toHaveBeenCalled();
		// 未配模型时不强调 createSession / prompt，而是填进输入框草稿
		expect(sessionsState.createSession).not.toHaveBeenCalled();
		expect(execMocks.prompt).not.toHaveBeenCalled();
		expect(draftMocks.updateDraft).toHaveBeenCalledTimes(1);
		expect(useWenyouCanvasStore.getState().open).toBe(true);
	});

	it("buildWorldBootstrapPrompt 在无群绑定时明确要求保持世界空白且禁止编造模板", () => {
		const text = buildWorldBootstrapPrompt({ worldTitle: "空白新局", bindings: [] });
		expect(text).toContain("空白新局");
		expect(text).toContain("不要编造任何预设剧情或架空模板");
	});
});
