// @vitest-environment happy-dom
import {
	BUILTIN_PIXI_SANDBOX_URL,
	type MapSnapshotSummary,
	WENYOU_MAP_BRIDGE_PROTOCOL,
	WENYOU_SANDBOX_PROTOCOL,
} from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execApiMocks = vi.hoisted(() => ({
	wenyouListMapSnapshots: vi.fn<() => Promise<MapSnapshotSummary[]>>(),
	wenyouReadMapSnapshotRaw:
		vi.fn<(args: { cwd: string; relPath: string }) => Promise<{ fileName: string; content: string }>>(),
	wenyouSaveMapSnapshot: vi.fn(),
	wenyouDiffMaps: vi.fn(),
}));

const piMocks = vi.hoisted(() => ({
	wenyouProbeSandbox: vi.fn(async () => ({ url: "", reachable: true, latencyMs: 1 })),
	wenyouImportMapFileDialog: vi.fn(async () => null),
	openExternal: vi.fn(async () => undefined),
}));

const toastMocks = vi.hoisted(() => ({ pushExtensionToast: vi.fn() }));

vi.mock("../../api", () => ({ getPi: () => piMocks }));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => execApiMocks }));
vi.mock("../../stores/toasts", () => ({ pushExtensionToast: toastMocks.pushExtensionToast }));

import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { AtlasComparePanel } from "./AtlasComparePanel";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeSnapshot(relPath: string, name: string): MapSnapshotSummary {
	return {
		id: name,
		name,
		relPath,
		format: "wenyou-project",
		theaters: [],
		sizeBytes: 128,
		modifiedAt: 1700000000000,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	execApiMocks.wenyouListMapSnapshots.mockResolvedValue([
		makeSnapshot("05-沙盘与图集/world-a.json", "world-a"),
	]);
	useWenyouCanvasStore.setState({
		cwd: "D:\\worlds\\world-a",
		overview: null,
		mapMode: "pixi-sandbox",
		pixiUrl: BUILTIN_PIXI_SANDBOX_URL,
		leftMapPath: null,
		rightMapPath: null,
		syncViewport: true,
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

function attachMockIframeWindow(iframe: HTMLIFrameElement) {
	const postMessage = vi.fn();
	const mockWin = { postMessage } as unknown as Window;
	Object.defineProperty(iframe, "contentWindow", {
		configurable: true,
		value: mockWin,
	});
	return { mockWin, postMessage };
}

function dispatchSandboxReady(mockWin: Window, workspaceKey: string) {
	const event = new MessageEvent("message", {
		origin: `${WENYOU_SANDBOX_PROTOCOL}://app`,
		source: mockWin,
		data: {
			protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
			type: "ready",
			payload: {
				version: "1.0.0",
				activeMapId: "map-1",
				mapName: "已有地图",
				theaterCount: 1,
				workspaceKey,
			},
		},
	});
	window.dispatchEvent(event);
}

describe("AtlasComparePanel 跨世界异步载入快照防串档", () => {
	it("读取旧世界快照期间切换到新世界时，绝不向新世界 iframe 发送 forceOverwrite load_project", async () => {
		const readDeferred = deferred<{ fileName: string; content: string }>();
		execApiMocks.wenyouReadMapSnapshotRaw.mockReturnValueOnce(readDeferred.promise);

		await act(async () => {
			root.render(<AtlasComparePanel />);
			await Promise.resolve();
			await Promise.resolve();
		});

		const iframeA = host.querySelector<HTMLIFrameElement>("iframe");
		expect(iframeA).not.toBeNull();
		if (!iframeA) return;
		const { mockWin: winA, postMessage: postA } = attachMockIframeWindow(iframeA);

		await act(async () => {
			dispatchSandboxReady(winA, "D:\\worlds\\world-a");
		});
		postA.mockClear();

		const loadBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "载入快照");
		expect(loadBtn).toBeDefined();
		expect(loadBtn?.disabled).toBe(false);

		// 在 World A 点击载入快照，此时异步读取尚未返回
		await act(async () => {
			loadBtn?.click();
		});
		expect(execApiMocks.wenyouReadMapSnapshotRaw).toHaveBeenCalledWith({
			cwd: "D:\\worlds\\world-a",
			relPath: "05-沙盘与图集/world-a.json",
		});

		// 在快照读取返回前切换到 World B
		execApiMocks.wenyouListMapSnapshots.mockResolvedValueOnce([]);
		await act(async () => {
			useWenyouCanvasStore.setState({ cwd: "D:\\worlds\\world-b" });
			await Promise.resolve();
			await Promise.resolve();
		});

		const iframeB = host.querySelector<HTMLIFrameElement>("iframe");
		expect(iframeB).not.toBeNull();
		if (!iframeB) return;
		const { postMessage: postB } = attachMockIframeWindow(iframeB);

		// 旧世界快照终于返回：必须立即中止，不得向旧/新 iframe 发送 load_project
		await act(async () => {
			readDeferred.resolve({ fileName: "world-a.json", content: '{"world":"A"}' });
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(postA.mock.calls.some(([msg]) => msg?.type === "load_project")).toBe(false);
		expect(postB.mock.calls.some(([msg]) => msg?.type === "load_project")).toBe(false);
	});

	it("留在同一世界时，异步读取完成后正常发送 load_project", async () => {
		const readDeferred = deferred<{ fileName: string; content: string }>();
		execApiMocks.wenyouReadMapSnapshotRaw.mockReturnValueOnce(readDeferred.promise);

		await act(async () => {
			root.render(<AtlasComparePanel />);
			await Promise.resolve();
			await Promise.resolve();
		});

		const iframeA = host.querySelector<HTMLIFrameElement>("iframe");
		expect(iframeA).not.toBeNull();
		if (!iframeA) return;
		const { mockWin: winA, postMessage: postA } = attachMockIframeWindow(iframeA);
		await act(async () => {
			dispatchSandboxReady(winA, "D:\\worlds\\world-a");
		});
		postA.mockClear();

		const loadBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "载入快照");
		await act(async () => {
			loadBtn?.click();
		});

		await act(async () => {
			readDeferred.resolve({ fileName: "world-a.json", content: '{"world":"A"}' });
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(postA).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "load_project",
				payload: expect.objectContaining({
					fileName: "world-a.json",
					projectJson: '{"world":"A"}',
					forceOverwrite: true,
				}),
			}),
			`${WENYOU_SANDBOX_PROTOCOL}://app`,
		);
	});
});
