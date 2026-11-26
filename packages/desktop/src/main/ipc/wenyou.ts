import { existsSync } from "node:fs";
import { copyFile, mkdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
	assertPathInsideWorkspace,
	createExecutionHandlers,
	isPrivateVaultPath,
	normalizeVaultPath,
	type PiBackend,
	resolveRealPathInsideWorkspace,
} from "@percho/backend";
import { IpcChannels, WENYOU_CHANNELS, WENYOU_DESKTOP_CHANNELS } from "@percho/shared";
import { BrowserWindow, dialog, shell } from "electron";
import { probeLocalSandbox } from "../wenyou-sandbox-probe";
import { createWorldDirectory, defaultWorldsRootDir } from "../wenyou-world-dir";
import { registerInvokeHandlers } from "./invoke";
import { sendToRenderer } from "./send";

const ALLOWED_IMPORT_MAP_EXTS = new Set([
	".svg",
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".bmp",
	".json",
	".map",
]);

function sanitizeImportedStem(rawStem: string): string {
	const cleaned = rawStem
		.trim()
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/^\.+|\.+$/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 80);
	if (!cleaned) return "imported-map";
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${cleaned}-map`;
	return cleaned;
}

/** 文游领域 IPC：执行域全部委派 createExecutionHandlers，本机原生域处理导出对话框与目录定位 */
export function registerWenyouIpc(backend: PiBackend): void {
	registerInvokeHandlers(WENYOU_CHANNELS, createExecutionHandlers(backend));

	registerInvokeHandlers(WENYOU_DESKTOP_CHANNELS, {
		wenyouExportDocxDialog: async ({ cwd, relPath, defaultName }) => {
			const normalized = normalizeVaultPath(relPath);
			if (isPrivateVaultPath(normalized) || extname(normalized).toLowerCase() !== ".docx") {
				throw new Error("仅允许导出工作区内非私有目录的 .docx 文书文件");
			}
			const sourceReal = await resolveRealPathInsideWorkspace(cwd, normalized);
			const realRoot = await realpath(resolve(cwd));
			const realRel = normalizeVaultPath(relative(realRoot, sourceReal));
			if (
				!realRel ||
				realRel.split("/").includes("..") ||
				isPrivateVaultPath(realRel) ||
				extname(sourceReal).toLowerCase() !== ".docx"
			) {
				throw new Error("仅允许导出工作区内非私有目录的 .docx 文书文件");
			}
			const window = BrowserWindow.getAllWindows()[0];
			const options: Electron.SaveDialogOptions = {
				defaultPath: defaultName?.trim() || basename(sourceReal),
				filters: [{ name: "Word Document (.docx)", extensions: ["docx"] }],
			};
			const result = window
				? await dialog.showSaveDialog(window, options)
				: await dialog.showSaveDialog(options);
			if (result.canceled || !result.filePath) return null;
			await copyFile(sourceReal, result.filePath);
			return result.filePath;
		},

		wenyouRevealFile: async ({ cwd, relPath }) => {
			const normalized = normalizeVaultPath(relPath);
			const realTarget = await resolveRealPathInsideWorkspace(cwd, normalized);
			shell.showItemInFolder(realTarget);
		},

		wenyouGetDefaultWorldsDir: async () => defaultWorldsRootDir(),

		wenyouCreateWorldDir: async (args) =>
			createWorldDirectory({
				worldTitle: args?.worldTitle,
				parentDir: args?.parentDir,
			}),

		wenyouNtqqGetStatus: async () => backend.wenyou.ntqq.getStatus(),

		wenyouNtqqSaveConfig: async (patch) => backend.wenyou.ntqq.saveConfig(patch),

		wenyouNtqqPickDbDir: async () => {
			const window = BrowserWindow.getAllWindows()[0];
			const options: Electron.OpenDialogOptions = {
				title: "选择本机 QQ 数据目录（nt_db / nt_qq / QQ号目录均可）",
				message: "选择本机 QQ 数据目录（nt_db / nt_qq / QQ号目录均可）",
				properties: ["openDirectory", "showHiddenFiles"],
			};
			const result = window
				? await dialog.showOpenDialog(window, options)
				: await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		},

		wenyouNtqqPickKeyMap: async () => {
			const window = BrowserWindow.getAllWindows()[0];
			const options: Electron.OpenDialogOptions = {
				title: "选择 NTQQ 解密密钥文件（key_map.json）",
				message: "选择 NTQQ 解密密钥文件（key_map.json）",
				filters: [{ name: "JSON 文件", extensions: ["json"] }],
				properties: ["openFile", "showHiddenFiles"],
			};
			const result = window
				? await dialog.showOpenDialog(window, options)
				: await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		},

		wenyouNtqqExtractKey: async (args) => backend.wenyou.ntqq.extractKey(args?.qqUin),

		wenyouNtqqListGroups: async (args) => backend.wenyou.ntqq.listGroups(args),

		wenyouNtqqGetCampaignBindings: async ({ cwd }) => backend.wenyou.ntqq.getCampaignBindings(cwd),

		wenyouNtqqSaveCampaignBindings: async ({ cwd, bindings }) =>
			backend.wenyou.ntqq.saveCampaignBindings(cwd, bindings),

		wenyouNtqqSyncCampaign: async ({ cwd, groupId, limit, force }) =>
			backend.wenyou.syncNtqqCampaign(cwd, { groupId, limit, force }),

		wenyouProbeSandbox: ({ url, timeoutMs }) => probeLocalSandbox(url, timeoutMs),

		wenyouImportMapFileDialog: async ({ cwd }) => {
			const window = BrowserWindow.getAllWindows()[0];
			const options: Electron.OpenDialogOptions = {
				title: "导入地图图片或沙盘快照到 05-沙盘与图集/",
				filters: [
					{
						name: "地图与沙盘文件",
						extensions: ["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "json", "map"],
					},
					{ name: "沙盘工程与底图 (.json / .map)", extensions: ["json", "map"] },
					{ name: "静态地图图片", extensions: ["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp"] },
				],
				properties: ["openFile"],
			};
			const result = window
				? await dialog.showOpenDialog(window, options)
				: await dialog.showOpenDialog(options);
			if (result.canceled || !result.filePaths[0]) return null;

			const sourcePath = result.filePaths[0];
			const rawExt = extname(sourcePath);
			const ext = rawExt.toLowerCase();
			if (!ALLOWED_IMPORT_MAP_EXTS.has(ext)) {
				throw new Error(`不支持的地图文件扩展名：${ext || "(无)"}`);
			}

			const atlasDirRel = "05-沙盘与图集";
			const atlasDirAbs = assertPathInsideWorkspace(cwd, atlasDirRel);
			await mkdir(atlasDirAbs, { recursive: true });
			const realAtlasDir = await resolveRealPathInsideWorkspace(cwd, atlasDirRel);
			const realRoot = await realpath(resolve(cwd));
			const realAtlasRel = normalizeVaultPath(relative(realRoot, realAtlasDir));
			if (!realAtlasRel || realAtlasRel.split("/").includes("..") || isPrivateVaultPath(realAtlasRel)) {
				throw new Error("目标地图目录越界或位于受限目录");
			}

			const rawBaseName = basename(sourcePath);
			const rawStem = rawExt ? rawBaseName.slice(0, -rawExt.length) : rawBaseName;
			const baseStem = sanitizeImportedStem(rawStem);
			let candidateName = `${baseStem}${ext}`;
			let suffix = 2;
			while (existsSync(join(realAtlasDir, candidateName))) {
				candidateName = `${baseStem}-${suffix}${ext}`;
				suffix += 1;
			}

			const relPath = normalizeVaultPath(`${atlasDirRel}/${candidateName}`);
			if (isPrivateVaultPath(relPath)) {
				throw new Error("目标路径不允许写入受限目录");
			}
			assertPathInsideWorkspace(cwd, relPath);
			const destAbs = join(realAtlasDir, candidateName);
			await copyFile(sourcePath, destAbs);
			sendToRenderer(IpcChannels.WenyouCanvasEvent, {
				kind: "workspace_changed",
				cwd,
				reason: "map_file_imported",
			});
			return { relPath, name: candidateName.slice(0, -ext.length) };
		},
	});
}
