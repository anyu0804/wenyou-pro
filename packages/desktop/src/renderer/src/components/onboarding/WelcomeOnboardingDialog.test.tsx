// @vitest-environment happy-dom
import type { NtqqStatusSnapshot, ProviderInfo } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const piMocks = vi.hoisted(() => ({
	wenyouNtqqGetStatus: vi.fn<() => Promise<NtqqStatusSnapshot>>(),
	wenyouNtqqSaveConfig: vi.fn(),
	wenyouNtqqPickDbDir: vi.fn(),
	wenyouNtqqPickKeyMap: vi.fn(),
	wenyouNtqqExtractKey: vi.fn(),
	loadUiState: vi.fn(async () => null),
	saveUiState: vi.fn(async () => undefined),
}));

const settingsState = vi.hoisted(() => ({
	open: false,
	providers: [] as ProviderInfo[],
	loading: false,
	testResults: {} as Record<string, unknown>,
	refresh: vi.fn(async () => undefined),
	setProviderBaseUrl: vi.fn(async () => undefined),
	saveKey: vi.fn(async () => undefined),
	addCustom: vi.fn(async () => undefined),
	listUpstreamModels: vi.fn(async () => ({ baseUrl: "", models: [] })),
	test: vi.fn(async () => undefined),
}));

const loginState = vi.hoisted(() => ({
	login: null,
	startProviderLogin: vi.fn(async () => undefined),
}));

const sessionsLoadModels = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../api", () => ({
	getPi: () => piMocks,
}));

vi.mock("../../stores/settings", () => ({
	useLocalSettingsStore: (select: (state: typeof settingsState) => unknown) => select(settingsState),
}));

vi.mock("../../stores/provider-login", () => ({
	useProviderLoginStore: (select: (state: typeof loginState) => unknown) => select(loginState),
}));

vi.mock("../../stores/sessions", () => ({
	useSessionsStore: {
		getState: () => ({ loadModels: sessionsLoadModels }),
	},
}));

vi.mock("../settings/providers/LoginDialog", () => ({
	LoginDialog: () => null,
}));

import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { WelcomeOnboardingDialog } from "./WelcomeOnboardingDialog";

function makeNtqqSnapshot(qqUin: string | null, ready = false): NtqqStatusSnapshot {
	return {
		config: { qqUin, dbDir: null, keyMapPath: null, pythonPath: null },
		status: {
			platformSupported: true,
			qqUin,
			resolvedDbDir: qqUin ? `C:\\mock\\Tencent Files\\${qqUin}\\nt_qq\\nt_db` : null,
			dbDirAutoDetected: Boolean(qqUin),
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
			missingReasons: ready ? [] : ["尚未提取密钥"],
		},
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	settingsState.open = false;
	settingsState.loading = false;
	settingsState.testResults = {};
	settingsState.providers = [
		{
			id: "deepseek",
			name: "DeepSeek",
			custom: false,
			configured: false,
			apiKeyLogin: true,
			models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
		},
		{
			id: "openai-codex",
			name: "OpenAI Codex",
			custom: false,
			configured: false,
			oauth: { loginLabel: "ChatGPT Plus/Pro 登录", isSubscription: true },
			models: [{ id: "gpt-5", name: "GPT-5" }],
		},
	];
	piMocks.wenyouNtqqGetStatus.mockResolvedValue(makeNtqqSnapshot(null, false));
	piMocks.wenyouNtqqSaveConfig.mockImplementation(async (patch: { qqUin?: string | null }) =>
		makeNtqqSnapshot(patch.qqUin ?? null, false),
	);
	piMocks.wenyouNtqqExtractKey.mockResolvedValue({
		...makeNtqqSnapshot("10001", true),
		message: "已成功提取并保存本机 NTQQ 解密密钥",
	});
	useUiPreferencesStore.setState({
		onboardingCompleted: false,
		onboardingForceOpen: false,
		onboardingInitialStep: 1,
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

describe("WelcomeOnboardingDialog", () => {
	it("首次打开自动弹出，支持保存 API Key、发起 OAuth 登录，并进入第二步保存 QQ 号与提取密钥", async () => {
		await act(async () => {
			root.render(<WelcomeOnboardingDialog />);
		});

		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain("欢迎使用 Wenyou Pro");
		expect(dialog?.textContent).toContain("DeepSeek");

		// Step 1A: 填写 API Key 并保存
		const keyInput = dialog?.querySelector<HTMLInputElement>('input[type="password"]');
		expect(keyInput).not.toBeNull();
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(keyInput, "sk-test-123456");
			keyInput?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const saveBtn = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "保存配置");
		expect(saveBtn).toBeDefined();
		await act(async () => {
			saveBtn?.click();
		});
		expect(settingsState.saveKey).toHaveBeenCalledWith("deepseek", "sk-test-123456");
		expect(sessionsLoadModels).toHaveBeenCalledTimes(1);

		// Step 1B: 切换「接入订阅账号」并点击登录（仅带 apiKeyLogin 的 DeepSeek 不应出现在 OAuth 列表里）
		const oauthTab = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "接入订阅账号");
		await act(async () => {
			oauthTab?.click();
		});
		const oauthList = dialog?.querySelector("[data-oauth-provider-list]");
		expect(oauthList).not.toBeNull();
		expect(oauthList?.textContent).toContain("OpenAI Codex");
		expect(oauthList?.textContent).not.toContain("DeepSeek");
		const loginBtns = [...(oauthList?.querySelectorAll("button") ?? [])].filter(
			(b) => b.textContent === "登录账号",
		);
		expect(loginBtns).toHaveLength(1);
		const loginBtn = loginBtns[0];
		await act(async () => {
			loginBtn?.click();
		});
		expect(loginState.startProviderLogin).toHaveBeenCalledWith(
			expect.objectContaining({ id: "openai-codex" }),
		);

		// 进入第二步：填写本人 QQ 号并保存、触发一键提取密钥
		const nextBtn = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent?.includes("下一步"),
		);
		await act(async () => {
			nextBtn?.click();
		});
		const qqInput = dialog?.querySelector<HTMLInputElement>("#wenyou-qq-uin-input");
		expect(qqInput).not.toBeNull();
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(qqInput, "10001");
			qqInput?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const saveQqBtn = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent === "保存并检测",
		);
		await act(async () => {
			saveQqBtn?.click();
		});
		expect(piMocks.wenyouNtqqSaveConfig).toHaveBeenCalledWith({ qqUin: "10001" });

		const extractBtn = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent === "一键提取密钥",
		);
		await act(async () => {
			extractBtn?.click();
		});
		expect(piMocks.wenyouNtqqExtractKey).toHaveBeenCalledWith({ qqUin: "10001" });

		// 完成并进入工作台：标记 onboardingCompleted = true 且卸载弹窗
		const finishBtn = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent === "完成并进入工作台",
		);
		await act(async () => {
			finishBtn?.click();
		});
		expect(useUiPreferencesStore.getState().onboardingCompleted).toBe(true);
		expect(piMocks.saveUiState).toHaveBeenCalledWith({ state: { onboardingCompleted: true } });
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
	});

	it("已完成引导时不再自动弹出；设置页调用 openOnboarding(2) 可直达第二步", async () => {
		useUiPreferencesStore.setState({ onboardingCompleted: true, onboardingForceOpen: false });
		await act(async () => {
			root.render(<WelcomeOnboardingDialog />);
		});
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();

		await act(async () => {
			useUiPreferencesStore.getState().openOnboarding(2);
		});
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.querySelector("#wenyou-qq-uin-input")).not.toBeNull();
	});
});
