import "./pi-package-dir";
import "./dev-agent-dir";
import "./fix-path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger, initLogging, loadWorkspaces, localSessionPaths, PiBackend } from "@percho/backend";
import { WENYOU_ASSET_PROTOCOL, WENYOU_SANDBOX_PROTOCOL } from "@percho/shared";
import { app, BrowserWindow, Menu, nativeTheme, net, protocol, screen, shell } from "electron";
import { releaseChannel } from "./app-identity";
import { backgroundsDir } from "./background";
import { localStorageSelection } from "./dev-agent-dir";
import { registerIpc } from "./ipc";
import { initLanObserver, type LanObserverHandle } from "./lan";
import { remoteConnectionManager } from "./remote-connection";
import { attachRendererWatchdog } from "./renderer-watchdog";
import { prepareLocalStorage } from "./storage-startup";
import { UiPluginManager, uiPluginsResourcesDir } from "./ui-plugins/manager";
import { loadUiState } from "./ui-state";
import { initUpdater, scheduleAutoUpdateCheck } from "./updater";
import {
	createWorkspaceAllowlistChecker,
	registerWenyouAssetProtocolHandler,
	registerWenyouSandboxProtocolHandler,
	wenyouNtqqAssetsDir,
	wenyouSkillsDir,
} from "./wenyou-protocol";
import { defaultWorldsRootDir } from "./wenyou-world-dir";
import { applyChromeTheme, createWindow, markQuitting, resolveTheme } from "./window";
import { sanitizeWindowBounds } from "./window-bounds";

const log = createLogger("main");
let backend: PiBackend;
let uiPluginsManager: UiPluginManager;
let lanObserver: LanObserverHandle | undefined;

/**
 * 追加进每次会话系统提示词的桌面端段落（精简明确）：
 * 让 agent 知道自己名为「司命」，运行在 Wenyou Pro 独立文游桌面端，掌握内置文游工具与右侧画布。
 */
const WENYOU_DESKTOP_PROMPT: string[] = [
	"你是「司命」，运行在 Wenyou Pro 独立文游桌面端（基于 Percho MIT 开源底座深度定制的 Electron 图形工作台）中的文游推演 Agent。右侧提供实时联动「文游动态画布」（局势书与群聊 sourceId 核查 / 国策 .docx 书案 / 高清地图双屏比对与沙盘 / 档案速览与泄密发包）。",
	"在文游战役目录中，优先使用内置 wenyou_* 工具链：wenyou_pull_qq（增量采群及最高 20,000 条/群历史补抓）、wenyou_lookup_source（全库检索最高 20,000 条/群，支持 earliest 追最早原话与拉长前后上下文回查）、wenyou_read_memory（读三层记忆）、wenyou_publish_briefing（发三段式局势书并推游标）、wenyou_write_policy_docx（过门禁并生成宋体规范 .docx）、wenyou_open_maps（右侧开双屏地图/内置沙盘）、wenyou_inspect_map（核对沙盘政权/城邦/海港/里程与疆域差分）；整理与维护 01-设定与国力实册/、04-编年史与条约/ 档案时，可直接使用读写工具落盘并附 [sourceId] 溯源。",
	"界面支持 UI 插件扩展，规范位于 ~/.wenyou-pro/ui-plugins/SPEC.md（启用由用户在设置页手动确认）。",
];

/** renderer 加载自定义背景图的协议（pi-bg://background/<文件名>，只读 userData/backgrounds/） */
const BG_PROTOCOL = "pi-bg";

protocol.registerSchemesAsPrivileged([
	{ scheme: BG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
	{
		scheme: WENYOU_ASSET_PROTOCOL,
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
	{
		scheme: WENYOU_SANDBOX_PROTOCOL,
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
]);

// Windows/Linux 不显示默认应用菜单（File/Edit/...）；macOS 菜单在系统菜单栏且承担复制粘贴等快捷键，保留
if (process.platform !== "darwin") Menu.setApplicationMenu(null);
// 系统深浅色变化（或用户切换主题导致 themeSource 变更）→ 同步窗口底色与 Windows 窗口按钮覆盖层
nativeTheme.on("updated", () => applyChromeTheme(nativeTheme.themeSource));

app.whenReady().then(async () => {
	// 必须早于 prepareLocalStorage：它会创建并加载首个文档，后补 handler 对该文档不生效。
	// 自定义背景图协议：pi-bg://background/<文件名> → userData/backgrounds/<文件名>（文件名白名单防路径穿越）
	protocol.handle(BG_PROTOCOL, (request) => {
		let name: string;
		try {
			name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		} catch {
			return new Response("invalid background url", { status: 400 });
		}
		if (!name || name === "." || name === ".." || !/^[\w.-]+$/.test(name)) {
			return new Response("invalid background name", { status: 400 });
		}
		return net.fetch(pathToFileURL(join(backgroundsDir(), name)).toString());
	});
	// 文游工作区高清地图/静态图集只读流式协议（工作区白名单 + realpath 沙箱校验，禁 private/）
	const isAllowedAssetWorkspace = createWorkspaceAllowlistChecker(() => {
		const exactRoots: string[] = [];
		if (backend) {
			for (const session of backend.getLoadedSessions()) {
				if (session.meta.cwd) exactRoots.push(session.meta.cwd);
			}
		}
		const agentDir = localStorageSelection?.target || process.env.PI_CODING_AGENT_DIR;
		if (agentDir) {
			const ws = loadWorkspaces(agentDir);
			for (const [projectRoot, entry] of Object.entries(ws.projects)) {
				exactRoots.push(projectRoot);
				for (const extraRoot of entry.roots) exactRoots.push(extraRoot);
			}
		}
		return {
			exactRoots,
			parentRoots: [defaultWorldsRootDir()],
		};
	});
	registerWenyouAssetProtocolHandler(isAllowedAssetWorkspace);
	// 文游内置 Pixi 互动沙盘特权静态协议（免双开直载 resources/pixi-sandbox）
	registerWenyouSandboxProtocolHandler();

	if (releaseChannel === "dev") app.dock?.setIcon(join(__dirname, "../../build/icon-dev.png"));
	const uiState = await loadUiState();
	nativeTheme.themeSource = uiState?.theme ?? "system";
	const initialBounds = sanitizeWindowBounds(
		uiState?.windowBounds ?? null,
		screen.getAllDisplays().map((display) => display.workArea),
	);
	const storage = await prepareLocalStorage(resolveTheme(uiState?.theme), initialBounds);
	try {
		initLogging(join(app.getPath("userData"), "logs"));
		log.info("app ready", { version: app.getVersion(), userData: app.getPath("userData") });
		if (!process.env.WENYOU_NTQQ_ASSETS_DIR) {
			process.env.WENYOU_NTQQ_ASSETS_DIR = wenyouNtqqAssetsDir();
		}

		backend = new PiBackend({
			localSessionPaths: localSessionPaths(storage.record, storage.selection.legacyRoots),
			// 桌面端集成：文游随包技能 + UI 插件技能目录与系统提示词段落
			// MCP OAuth 授权页交给系统浏览器（官方内置 mcp 扩展用；缺省则扩展自行回落到平台默认浏览器）
			openExternal: (url) => shell.openExternal(url),
			desktopIntegration: {
				appendSystemPrompt:
					process.env.WENYOU_AGENT_DIR || process.env.PERCHO_AGENT_DIR || releaseChannel === "beta"
						? WENYOU_DESKTOP_PROMPT.map((line) =>
								line.replace("~/.wenyou-pro/ui-plugins", join(app.getPath("userData"), "ui-plugins")),
							)
						: WENYOU_DESKTOP_PROMPT,
				additionalSkillPaths: [wenyouSkillsDir(), join(uiPluginsResourcesDir(), "skills")],
			},
		});
		await backend.init();
		attachRendererWatchdog(backend);

		lanObserver = await initLanObserver(
			backend,
			join(app.getPath("userData"), "lan-observer.json"),
			join(app.getPath("userData"), "lan-audit.jsonl"),
		);
		uiPluginsManager = new UiPluginManager();
		await uiPluginsManager.init();
		registerIpc(backend, uiPluginsManager, lanObserver);
		await initUpdater();
		scheduleAutoUpdateCheck();
		storage.launchWorkbench();

		app.on("activate", () => {
			const [win] = BrowserWindow.getAllWindows();
			// macOS 关窗只是隐藏窗口：点 Dock 图标要把原窗口（含会话与草稿）原样带回来
			if (win) {
				if (win.isMinimized()) win.restore();
				win.show();
				win.focus();
				return;
			}
			createWindow(resolveTheme(uiState?.theme), initialBounds);
		});
	} catch (error) {
		storage.failWorkbench(error);
	}
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	// 先放行 close 拦截：否则 macOS 下 ⌘Q 会被当成「关窗 → 隐藏」而退不掉
	markQuitting();
	void lanObserver?.stop();
	void remoteConnectionManager.shutdown();
	backend?.dispose();
	uiPluginsManager?.disposeWatcher();
});
