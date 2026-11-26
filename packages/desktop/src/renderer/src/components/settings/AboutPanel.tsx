import type { AppInfo, UpdateDiagnosticsInfo } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useUpdateStore } from "../../stores/update";
import { SessionSwitchDiagnostics } from "./SessionSwitchDiagnostics";
import { UpdateHelp } from "./UpdateHelp";

/** 关于面板：应用标识 + 软件版本 + 检查更新 + 仓库入口，居中展示 */
export function AboutPanel() {
	const t = useT();
	const [info, setInfo] = useState<AppInfo | null>(null);
	const [diagnostics, setDiagnostics] = useState<UpdateDiagnosticsInfo | null>(null);
	const state = useUpdateStore((s) => s.state);
	const separateChannel = info?.releaseChannel === "beta" || info?.releaseChannel === "dev";

	useEffect(() => {
		let cancelled = false;
		void getPi()
			.getAppInfo()
			.then((appInfo) => {
				if (!cancelled) setInfo(appInfo);
			})
			.catch(() => {
				if (!cancelled) setInfo(null);
			});
		void getPi()
			.getUpdateDiagnostics()
			.then((value) => {
				if (!cancelled) setDiagnostics(value);
			})
			.catch(() => {
				if (!cancelled) setDiagnostics(null);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 状态行文案；downloaded 态按钮语义切换为「重启并安装」；manual 构建（mac 未正式签名）跳 release 页手动下载
	const statusText =
		state?.phase === "checking"
			? t("update.checking")
			: state?.phase === "available"
				? state.manual
					? t("update.availableManual", { version: state.version })
					: t("update.available", { version: state.version })
				: state?.phase === "downloading"
					? t("update.downloading", { percent: state.percent })
					: state?.phase === "downloaded"
						? t("update.downloaded")
						: state?.phase === "not-available"
							? t("update.upToDate")
							: state?.phase === "error"
								? t("update.checkFailed", { message: state.message })
								: null;

	const openReleasePage = async (version: string) => {
		const appInfo = info ?? (await getPi().getAppInfo());
		void getPi().openExternal({ url: `${appInfo.repoUrl}/releases/tag/v${version}` });
	};

	const buttonLabel =
		state?.phase === "downloaded"
			? t("update.installNow")
			: state?.phase === "available" && state.manual
				? t("update.goDownload")
				: t("update.checkForUpdates");

	const displayAppName =
		info?.name && (info.name.startsWith("Wenyou Pro ") || info.name.startsWith("司命 · 文游 Pro"))
			? info.name
			: "司命 · 文游 Pro";
	const upstreamUrl = "https://github.com/Jaxton07/percho";

	return (
		<div className="flex flex-col items-center gap-1.5 py-10 text-center">
			<svg
				viewBox="0 0 48 48"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="h-12 w-12 shrink-0 rounded-xl shadow-sm"
				aria-hidden="true"
			>
				<rect
					x="1.5"
					y="1.5"
					width="45"
					height="45"
					rx="11.5"
					fill="#F8F5EE"
					stroke="#E5DFD3"
					strokeWidth="1.2"
				/>
				<path
					d="M24 34.2C19.6 32.4 14.6 32 9.8 32.8V17.4C14.6 16.6 19.6 17.1 24 19.2Z"
					fill="#FFFDF9"
					stroke="#1F2329"
					strokeWidth="1.75"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
				<path
					d="M24 34.2C28.4 32.4 33.4 32 38.2 32.8V17.4C33.4 16.6 28.4 17.1 24 19.2Z"
					fill="#FFFDF9"
					stroke="#1F2329"
					strokeWidth="1.75"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
				<path
					d="M13.4 22.1C15.8 21.7 18.2 21.9 20.4 22.7M13.4 25.7C15.8 25.3 18.2 25.5 20.4 26.3M13.4 29.2C15.4 28.9 17.4 29 19.1 29.6"
					stroke="#6A707A"
					strokeWidth="1.2"
					strokeLinecap="round"
				/>
				<path d="M36.8 11.2L29.2 18.8" stroke="#F8F5EE" strokeWidth="5.4" strokeLinecap="round" />
				<path
					d="M36.1 9.9L38.1 11.9L31.4 18.6L29.4 16.6Z"
					fill="#1F2329"
					stroke="#1F2329"
					strokeWidth="0.6"
					strokeLinejoin="round"
				/>
				<path
					d="M28.2 18.1C29.3 17.8 30.2 18.7 29.9 19.8C29.4 21.6 27.6 23.4 25.1 24.5C26.1 22 26.9 19.4 28.2 18.1Z"
					fill="#1F2329"
				/>
				<rect x="31.4" y="25.6" width="4.2" height="4.2" rx="1" fill="#c83e37" />
			</svg>
			<p className="mt-2 text-ui-14 font-semibold text-ink">{displayAppName}</p>
			<p className="text-ui-11 text-ink-faint">{t("settings.about.poweredBy")}</p>
			<p className="mt-2 font-mono text-ui-12 text-ink-dim">
				{t("settings.about.version")} {info?.version ?? "…"}
			</p>
			<div className="mt-4 flex flex-wrap items-center justify-center gap-2">
				<button
					type="button"
					disabled={separateChannel}
					className="rounded-lg border border-border px-4 py-1.5 text-ui-13 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
					onClick={() => {
						if (state?.phase === "downloaded") void getPi().installUpdate();
						else if (state?.phase === "available" && state.manual) void openReleasePage(state.version);
						else void getPi().checkForUpdates();
					}}
				>
					{separateChannel ? t("update.separateChannel") : buttonLabel}
				</button>
				<button
					type="button"
					className="rounded-lg border border-border px-4 py-1.5 text-ui-13 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
					onClick={() => {
						void getPi().openExternal({ url: info?.repoUrl || upstreamUrl });
					}}
				>
					{t("settings.about.sourceCode")}
				</button>
			</div>
			<div className="mt-5 max-w-md rounded-xl border border-border bg-surface px-4 py-3 text-left">
				<p className="text-ui-12 font-medium text-ink">{t("settings.about.upstreamTitle")}</p>
				<p className="mt-1 text-ui-11 leading-relaxed text-ink-dim">{t("settings.about.upstreamNotice")}</p>
				<button
					type="button"
					onClick={() => void getPi().openExternal({ url: upstreamUrl })}
					className="mt-1.5 font-mono text-ui-11 text-accent hover:underline"
				>
					github.com/Jaxton07/percho (MIT License)
				</button>
			</div>
			<SessionSwitchDiagnostics />
			{statusText && <p className="mt-1 text-ui-11 text-ink-faint">{statusText}</p>}
			{info && (
				<UpdateHelp diagnostics={diagnostics} windows={info.platform === "win32"} repoUrl={info.repoUrl} />
			)}
		</div>
	);
}
