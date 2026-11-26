import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import channels from "../../build/app-channels.json";

// 打包通道只取随包元数据，避免环境变量把正式版伪装成内测版或反过来。
const metadata = app.isPackaged
	? (JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as {
			releaseChannel?: unknown;
			disableAutoUpdate?: unknown;
		})
	: null;
if (metadata?.releaseChannel !== undefined && !["stable", "beta"].includes(String(metadata.releaseChannel)))
	throw new Error("Invalid packaged release channel");
export const releaseChannel = !app.isPackaged
	? "dev"
	: metadata?.releaseChannel === "beta"
		? "beta"
		: "stable";
export const appIdentity = channels[releaseChannel];
/** 本地/独立分发包通过 extraMetadata.disableAutoUpdate=true 关闭自动更新，防止误连上游 Percho 源或报缺 app-update.yml 错 */
export const supportsUpdates =
	app.isPackaged && releaseChannel === "stable" && metadata?.disableAutoUpdate !== true;

// 先统一设置应用名，再为 dev / beta 通道隔离 userData 目录；自定义 --user-data-dir 始终优先。
export function configureAppIdentity(): void {
	app.setName(appIdentity.name);
	if (releaseChannel === "dev" || releaseChannel === "beta") {
		const custom = app.commandLine.getSwitchValue("user-data-dir");
		app.setPath("userData", custom || join(app.getPath("appData"), appIdentity.name));
	}
	if (process.platform === "win32") app.setAppUserModelId(appIdentity.appId);
}
