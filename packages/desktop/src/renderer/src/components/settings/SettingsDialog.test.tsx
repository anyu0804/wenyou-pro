// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./GeneralPanel", () => ({ GeneralPanel: () => <div>general content</div> }));
vi.mock("./AppearancePanel", () => ({ AppearancePanel: () => null }));
vi.mock("./ArchivedChatsPanel", () => ({ ArchivedChatsPanel: () => null }));
vi.mock("./extensions/ExtensionsPanel", () => ({ ExtensionsPanel: () => null }));
vi.mock("./mcp/McpPanel", () => ({ McpPanel: () => <div>mcp content</div> }));
vi.mock("./providers/ProvidersPanel", () => ({ ProvidersPanel: () => null }));
vi.mock("./SkillsPanel", () => ({ SkillsPanel: () => null }));
vi.mock("./AboutPanel", () => ({ AboutPanel: () => null }));
vi.mock("../../lib/use-edge-fade", () => ({ useEdgeFade: () => {} }));

import { useLocalSettingsStore } from "../../stores/settings";
import { SettingsDialog } from "./SettingsDialog";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("设置导航隐藏 remote / lan 分类与左上角 SSH 环境切换器，仅保留核心分类", async () => {
	useLocalSettingsStore.setState({ open: true, category: "general" });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<SettingsDialog />));
	const navText = container.querySelector("nav")?.textContent ?? "";
	expect(navText).toContain("settings.category.general");
	expect(navText).toContain("settings.category.appearance");
	expect(navText).toContain("settings.category.models");
	expect(navText).toContain("settings.category.about");
	expect(navText).not.toContain("settings.category.remote");
	expect(navText).not.toContain("settings.category.lan");
	expect(container.querySelector('[aria-label="settings.environment"]')).toBeNull();
	await act(async () => root.unmount());
	container.remove();
});

it("历史残留 remote / lan 分类打开时平滑回落至通用设置面板", async () => {
	useLocalSettingsStore.setState({ open: true, category: "remote" });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<SettingsDialog />));
	expect(container.textContent).toContain("general content");
	await act(async () => root.unmount());
	container.remove();
});

it("打开设置后可选择分类并用 Escape 关闭", async () => {
	useLocalSettingsStore.setState({ open: true, category: "general" });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<SettingsDialog />));
	expect(container.textContent).toContain("general content");
	const mcp = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("settings.category.mcp"),
	);
	await act(async () => mcp?.click());
	expect(container.textContent).toContain("mcp content");
	expect(mcp?.getAttribute("aria-current")).toBe("page");
	const close = container.querySelector('button[aria-label="common.close"]');
	expect(close?.querySelector("svg")).not.toBeNull();
	expect(close?.hasAttribute("title")).toBe(false);
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	expect(container.querySelector('[role="dialog"]')).toBeNull();
	await act(async () => root.unmount());
	container.remove();
});
