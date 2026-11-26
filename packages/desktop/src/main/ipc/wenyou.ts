import { copyFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
	createExecutionHandlers,
	isPrivateVaultPath,
	normalizeVaultPath,
	type PiBackend,
	resolveRealPathInsideWorkspace,
} from "@percho/backend";
import { WENYOU_CHANNELS, WENYOU_DESKTOP_CHANNELS } from "@percho/shared";
import { BrowserWindow, dialog, shell } from "electron";
import { createWorldDirectory, defaultWorldsRootDir } from "../wenyou-world-dir";
import { registerInvokeHandlers } from "./invoke";

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

		wenyouExportBundleDialog: async ({ defaultName, content, format }) => {
			const window = BrowserWindow.getAllWindows()[0];
			const ext = format === "html" ? "html" : "json";
			const options: Electron.SaveDialogOptions = {
				defaultPath: defaultName.endsWith(`.${ext}`) ? defaultName : `${defaultName}.${ext}`,
				filters: [
					format === "html"
						? { name: "Offline Chronicle HTML", extensions: ["html"] }
						: { name: "Wenyou Archive Bundle JSON", extensions: ["json"] },
				],
			};
			const result = window
				? await dialog.showSaveDialog(window, options)
				: await dialog.showSaveDialog(options);
			if (result.canceled || !result.filePath) return null;
			await writeFile(result.filePath, content, "utf8");
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
				properties: ["openDirectory"],
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
				filters: [{ name: "JSON 文件", extensions: ["json"] }],
				properties: ["openFile"],
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
	});
}
