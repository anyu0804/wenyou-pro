// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
	channelWatchEnabled: true as boolean | null,
	setChannelWatchEnabled: vi.fn(),
	setOpen: vi.fn(),
}));
vi.mock("../../stores/settings", () => ({
	useSettingsStore: (select: (state: typeof settings) => unknown) => select(settings),
}));
vi.mock("./TaskNotificationSettings", () => ({ TaskNotificationSettings: () => null }));
vi.mock("./CacheWarmingSettings", () => ({ CacheWarmingSettings: () => null }));
vi.mock("../onboarding/NtqqConfigSection", () => ({
	NtqqConfigSection: () => <div data-testid="ntqq-config">ntqq</div>,
}));

import { useI18nStore } from "../../i18n";
import { GeneralPanel } from "./GeneralPanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.clearAllMocks();
	settings.channelWatchEnabled = true;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	useI18nStore.setState({ language: "zh" });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it("不显示 Code Mode 开关与语言切换器，保留频道唤醒开关和本机 NTQQ 配置", async () => {
	await act(async () => root.render(<GeneralPanel />));
	expect(host.textContent).not.toContain("Code Mode");
	expect(host.textContent).not.toContain("界面语言");
	expect(host.querySelector('[data-testid="ntqq-config"]')).not.toBeNull();
	const switches = host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
	expect(switches).toHaveLength(1);
	expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
	await act(async () => switches[0]?.click());
	expect(settings.setChannelWatchEnabled).toHaveBeenCalledWith(false);
});

it("频道唤醒未加载时开关保持禁用", async () => {
	settings.channelWatchEnabled = null;
	await act(async () => root.render(<GeneralPanel />));
	const sw = host.querySelector<HTMLButtonElement>('[role="switch"]');
	expect(sw?.disabled).toBe(true);
});
