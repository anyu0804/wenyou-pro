// @vitest-environment happy-dom
import type { AppInfo } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReleasesUrl, buildReleaseTagUrl, formatReleaseTag } from "../../lib/release-links";

const piMocks = vi.hoisted(() => ({
	getAppInfo: vi.fn<() => Promise<AppInfo>>(),
	getUpdateDiagnostics: vi.fn(async () => null),
	checkForUpdates: vi.fn(async () => undefined),
	installUpdate: vi.fn(),
	openExternal: vi.fn(async () => undefined),
	exportUpdateDiagnostics: vi.fn(async () => null),
}));

vi.mock("../../api", () => ({
	getPi: () => piMocks,
}));
vi.mock("./SessionSwitchDiagnostics", () => ({
	SessionSwitchDiagnostics: () => null,
}));

import { useUpdateStore } from "../../stores/update";
import { AboutPanel } from "./AboutPanel";

const baseInfo: AppInfo = {
	name: "司命 · 文游 Pro",
	releaseChannel: "stable",
	supportsUpdates: false,
	version: "0.2.4",
	electron: "35.0.0",
	chrome: "134.0.0",
	node: "22.0.0",
	platform: "win32",
	arch: "x64",
	repoUrl: "https://github.com/anyu0804/wenyou-pro",
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	useUpdateStore.setState({ state: null });
	piMocks.getAppInfo.mockResolvedValue(baseInfo);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("release-links & AboutPanel", () => {
	it("formatReleaseTag 统一生成 wenyou-v 前缀并避免重复拼接", () => {
		expect(formatReleaseTag("0.2.4")).toBe("wenyou-v0.2.4");
		expect(formatReleaseTag("v0.2.4")).toBe("wenyou-v0.2.4");
		expect(formatReleaseTag("wenyou-v0.2.4")).toBe("wenyou-v0.2.4");
		expect(buildReleaseTagUrl("https://github.com/anyu0804/wenyou-pro", "0.2.4")).toBe(
			"https://github.com/anyu0804/wenyou-pro/releases/tag/wenyou-v0.2.4",
		);
		expect(buildReleasesUrl("https://github.com/anyu0804/wenyou-pro/")).toBe(
			"https://github.com/anyu0804/wenyou-pro/releases",
		);
	});

	it("离线优先构建（supportsUpdates=false）点击更新按钮打开 Releases 页并给出明确反馈，而非静默无响应", async () => {
		await act(async () => {
			root.render(<AboutPanel />);
			await Promise.resolve();
			await Promise.resolve();
		});

		const buttons = [...host.querySelectorAll("button")];
		const updateBtn = buttons[0];
		expect(updateBtn).toBeDefined();
		expect(updateBtn?.disabled).toBe(false);
		expect(updateBtn?.textContent).toBe("查看新版本");

		await act(async () => {
			updateBtn?.click();
			await Promise.resolve();
		});
		expect(piMocks.checkForUpdates).not.toHaveBeenCalled();
		expect(piMocks.openExternal).toHaveBeenCalledWith({
			url: "https://github.com/anyu0804/wenyou-pro/releases",
		});
		expect(host.textContent).toContain("Releases");

		// 源码与反馈打开 Wenyou Pro 仓库，底部致谢卡片保留上游 Jaxton07/percho MIT 链接
		const sourceBtn = buttons.find((b) => b.textContent === "源码与反馈");
		expect(sourceBtn).toBeDefined();
		await act(async () => {
			sourceBtn?.click();
		});
		expect(piMocks.openExternal).toHaveBeenLastCalledWith({
			url: "https://github.com/anyu0804/wenyou-pro",
		});

		const upstreamBtn = buttons.find((b) => b.textContent?.includes("Jaxton07/percho"));
		expect(upstreamBtn).toBeDefined();
		await act(async () => {
			upstreamBtn?.click();
		});
		expect(piMocks.openExternal).toHaveBeenLastCalledWith({
			url: "https://github.com/Jaxton07/percho",
		});
	});

	it("manual 构建发现新版本时跳转到 wenyou-v<version> 标签页", async () => {
		piMocks.getAppInfo.mockResolvedValue({ ...baseInfo, supportsUpdates: true });
		useUpdateStore.setState({ state: { phase: "available", version: "0.2.5", manual: true } });

		await act(async () => {
			root.render(<AboutPanel />);
			await Promise.resolve();
			await Promise.resolve();
		});

		const updateBtn = host.querySelectorAll("button")[0];
		expect(updateBtn).toBeDefined();
		await act(async () => {
			updateBtn?.click();
			await Promise.resolve();
		});
		expect(piMocks.openExternal).toHaveBeenCalledWith({
			url: "https://github.com/anyu0804/wenyou-pro/releases/tag/wenyou-v0.2.5",
		});
	});
});
