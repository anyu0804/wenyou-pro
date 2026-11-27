// @vitest-environment happy-dom
import type {
	CampaignNtqqGroupBinding,
	NtqqGroupSummary,
	NtqqProbeStatus,
	NtqqStatusSnapshot,
} from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestExtendedNtqqProbeStatus = NtqqProbeStatus & {
	keyMatchedForCurrentDb?: boolean;
};

const piMocks = vi.hoisted(() => ({
	wenyouNtqqGetStatus: vi.fn<() => Promise<NtqqStatusSnapshot>>(),
	wenyouNtqqGetCampaignBindings: vi.fn<() => Promise<CampaignNtqqGroupBinding[]>>(),
	wenyouNtqqExtractKey:
		vi.fn<(args?: { qqUin?: string }) => Promise<NtqqStatusSnapshot & { message: string }>>(),
	wenyouNtqqListGroups:
		vi.fn<(args?: { force?: boolean }) => Promise<{ groups: NtqqGroupSummary[]; elapsedMs: number }>>(),
	wenyouNtqqSaveCampaignBindings: vi.fn(),
	wenyouNtqqSyncCampaign: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	pushExtensionToast: vi.fn(),
}));

const canvasState = vi.hoisted(() => ({
	cwd: "/mock/campaign",
	refreshOverview: vi.fn(async () => undefined),
}));

const openOnboarding = vi.hoisted(() => vi.fn());

vi.mock("../../api", () => ({
	getPi: () => piMocks,
}));

vi.mock("../../stores/toasts", () => ({
	pushExtensionToast: toastMocks.pushExtensionToast,
}));

vi.mock("../../stores/wenyou-canvas", () => ({
	useWenyouCanvasStore: (select: (state: typeof canvasState) => unknown) => select(canvasState),
}));

vi.mock("../../stores/ui-preferences", () => ({
	useUiPreferencesStore: {
		getState: () => ({ openOnboarding }),
	},
}));

import { NtqqGroupBindDialog } from "./NtqqGroupBindDialog";

function makeSnapshot(
	qqUin: string | null,
	ready: boolean,
	overrides?: Partial<TestExtendedNtqqProbeStatus>,
): NtqqStatusSnapshot {
	const status: TestExtendedNtqqProbeStatus = {
		platformSupported: true,
		qqUin,
		resolvedDbDir: qqUin ? `C:\\mock\\Tencent Files\\${qqUin}\\nt_qq\\nt_db` : null,
		dbDirAutoDetected: Boolean(qqUin),
		msgDbExists: true,
		groupDbExists: true,
		walSizeBytes: 0,
		resolvedKeyMapPath: "C:\\mock\\key_map.json",
		keyMapExists: true,
		keyMatchedForCurrentDb: ready,
		canExtractKey: true,
		pythonPath: "python",
		pythonVersion: "3.13.9",
		assetsDir: "C:\\mock\\ntqq-vfs",
		assetsReady: true,
		ready,
		missingReasons: ready ? [] : ["当前 key_map.json 未包含此 QQ 账号消息库的解密密钥"],
		...overrides,
	};
	return {
		config: { qqUin, dbDir: null, keyMapPath: null, pythonPath: null },
		status,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	piMocks.wenyouNtqqGetCampaignBindings.mockResolvedValue([]);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("NtqqGroupBindDialog", () => {
	it("ready=false 且存在当前 QQ 号与提取能力时，支持当场一键提取密钥并无缝刷新进入群列表", async () => {
		const onClose = vi.fn();
		const notReadySnap = makeSnapshot("20002", false, { keyMatchedForCurrentDb: false });
		const readySnap = makeSnapshot("20002", true, { keyMatchedForCurrentDb: true });

		piMocks.wenyouNtqqGetStatus.mockResolvedValueOnce(notReadySnap).mockResolvedValueOnce(readySnap);
		piMocks.wenyouNtqqExtractKey.mockResolvedValueOnce({
			...readySnap,
			message: "已补充 QQ 20002 解密密钥",
		});
		piMocks.wenyouNtqqListGroups.mockResolvedValueOnce({
			groups: [
				{ groupId: "888001", groupName: "高卢战记主群" },
				{ groupId: "888002", groupName: "内阁密议群" },
			],
			elapsedMs: 18,
		});

		await act(async () => {
			root.render(<NtqqGroupBindDialog onClose={onClose} />);
		});

		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain(
			"当前读取 QQ：20002 · 绑定记录仅存于本战役 .wenyou/ntqq-groups.json",
		);
		expect(dialog?.textContent).toContain("当前 QQ 账号尚未提取解密密钥");
		expect(piMocks.wenyouNtqqListGroups).not.toHaveBeenCalled();

		const extractBtn = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(btn) => btn.textContent === "一键提取当前 QQ 密钥",
		);
		expect(extractBtn).toBeDefined();

		await act(async () => {
			extractBtn?.click();
		});

		expect(piMocks.wenyouNtqqExtractKey).toHaveBeenCalledWith({ qqUin: "20002" });
		expect(piMocks.wenyouNtqqListGroups).toHaveBeenCalledWith({ force: true });
		expect(toastMocks.pushExtensionToast).toHaveBeenCalledWith(
			"info",
			"已补充 QQ 20002 解密密钥",
			"Wenyou Pro",
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(dialog?.textContent).toContain("高卢战记主群");
		expect(dialog?.textContent).toContain("888001");
		expect(dialog?.textContent).toContain("内阁密议群");
		expect(dialog?.textContent).toContain("保存并立即同步");
	});

	it("一键提取失败时展示剥离 IPC 前缀后的真实错误，不关窗且不触发拉群", async () => {
		const onClose = vi.fn();
		piMocks.wenyouNtqqGetStatus.mockResolvedValueOnce(
			makeSnapshot("20002", false, { keyMatchedForCurrentDb: false }),
		);
		piMocks.wenyouNtqqExtractKey.mockRejectedValueOnce(
			new Error("Error invoking remote method 'wenyou:ntqqExtractKey': Error: 未检测到目标 QQ 进程"),
		);

		await act(async () => {
			root.render(<NtqqGroupBindDialog onClose={onClose} />);
		});

		const dialog = document.body.querySelector('[role="dialog"]');
		const extractBtn = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(btn) => btn.textContent === "一键提取当前 QQ 密钥",
		);
		expect(extractBtn).toBeDefined();

		await act(async () => {
			extractBtn?.click();
		});

		expect(dialog?.textContent).toContain("未检测到目标 QQ 进程");
		expect(piMocks.wenyouNtqqListGroups).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(extractBtn?.disabled).toBe(false);
	});
});
