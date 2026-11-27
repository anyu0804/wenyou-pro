import type { NtqqProbeStatus, NtqqStatusSnapshot } from "@percho/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

type DetectedNtqqAccount = {
	qqUin: string;
	dbDir: string;
	msgDbExists: boolean;
	groupDbExists: boolean;
	keyReady: boolean;
	mtimeMs: number;
};

type ExtendedNtqqProbeStatus = NtqqProbeStatus & {
	keyMatchedForCurrentDb?: boolean;
	detectedAccounts?: DetectedNtqqAccount[];
};

function formatMb(bytes: number): string {
	if (bytes <= 0) return "";
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripInvokePrefix(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

export interface NtqqConfigSectionProps {
	/** 供引导页「完成」按钮同步读取当前未提交的 QQ 号并代为保存 */
	onDraftQqChange?: (qqUin: string) => void;
	onSnapshotChange?: (snapshot: NtqqStatusSnapshot | null) => void;
	/** 设置页展示「重新打开首次引导」入口 */
	showReopenOnboarding?: boolean;
	onReopenOnboarding?: () => void;
}

/**
 * 本机 QQ 号与 NTQQ 只读解库状态配置块（首开引导第 2 步与设置页通用面板共用）。
 * 保持单层轻边框 + 分割线结构，与 Percho/Wenyou Pro 设置页风格完全一致。
 */
export function NtqqConfigSection({
	onDraftQqChange,
	onSnapshotChange,
	showReopenOnboarding = false,
	onReopenOnboarding,
}: NtqqConfigSectionProps) {
	const [snapshot, setSnapshot] = useState<NtqqStatusSnapshot | null>(null);
	const [qqInput, setQqInput] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [extracting, setExtracting] = useState(false);
	const [feedback, setFeedback] = useState<{ kind: "info" | "error"; text: string } | null>(null);

	const onDraftQqChangeRef = useRef(onDraftQqChange);
	onDraftQqChangeRef.current = onDraftQqChange;
	const onSnapshotChangeRef = useRef(onSnapshotChange);
	onSnapshotChangeRef.current = onSnapshotChange;
	const actionLockRef = useRef(false);

	const applySnapshot = useCallback((next: NtqqStatusSnapshot) => {
		setSnapshot(next);
		onSnapshotChangeRef.current?.(next);
	}, []);

	const loadStatus = useCallback(async () => {
		setLoading(true);
		try {
			const res = await getPi().wenyouNtqqGetStatus();
			applySnapshot(res);
			const uin = res.config.qqUin ?? "";
			setQqInput(uin);
			onDraftQqChangeRef.current?.(uin);
		} catch (error) {
			setFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			setLoading(false);
		}
	}, [applySnapshot]);

	useEffect(() => {
		void loadStatus();
	}, [loadStatus]);

	const handleSaveQq = async () => {
		if (saving || extracting || actionLockRef.current) return;
		actionLockRef.current = true;
		setSaving(true);
		setFeedback(null);
		try {
			const trimmed = qqInput.trim();
			const res = await getPi().wenyouNtqqSaveConfig({ qqUin: trimmed || null });
			applySnapshot(res);
			const nextStatus = res.status as ExtendedNtqqProbeStatus;
			const nextKeyMismatch = Boolean(
				nextStatus.keyMapExists &&
					(nextStatus.msgDbExists || nextStatus.groupDbExists) &&
					nextStatus.keyMatchedForCurrentDb === false,
			);
			setFeedback({
				kind: "info",
				text: trimmed
					? res.status.msgDbExists
						? nextKeyMismatch
							? nextStatus.canExtractKey
								? `已保存 QQ ${trimmed}，已定位消息库；请点击下方「一键提取密钥」补充当前账号密钥`
								: `已保存 QQ ${trimmed}，已定位消息库；请重新导入包含当前账号的 key_map.json`
							: `已保存 QQ ${trimmed}，并检测到本机 NTQQ 消息库`
						: `已保存 QQ ${trimmed}；未在默认位置找到 nt_msg.db，可点击下方「选择目录」指定`
					: "已清空绑定的 QQ 号",
			});
		} catch (error) {
			setFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			actionLockRef.current = false;
			setSaving(false);
		}
	};

	const handleSelectDetectedAccount = async (uin: string) => {
		if (saving || extracting || actionLockRef.current) return;
		actionLockRef.current = true;
		setSaving(true);
		setFeedback(null);
		setQqInput(uin);
		onDraftQqChangeRef.current?.(uin);
		try {
			const res = await getPi().wenyouNtqqSaveConfig({ qqUin: uin });
			applySnapshot(res);
			const nextStatus = res.status as ExtendedNtqqProbeStatus;
			const nextKeyMismatch = Boolean(
				nextStatus.keyMapExists &&
					(nextStatus.msgDbExists || nextStatus.groupDbExists) &&
					nextStatus.keyMatchedForCurrentDb === false,
			);
			setFeedback({
				kind: "info",
				text: res.status.msgDbExists
					? nextKeyMismatch
						? nextStatus.canExtractKey
							? `已切换到 QQ ${uin}，已定位消息库；请点击下方「一键提取密钥」补充当前账号密钥`
							: `已切换到 QQ ${uin}，已定位消息库；请重新导入包含当前账号的 key_map.json`
						: `已切换到 QQ ${uin}，并检测到本机 NTQQ 消息库`
					: `已切换到 QQ ${uin}；未在默认位置找到 nt_msg.db，可点击下方「选择目录」指定`,
			});
		} catch (error) {
			setFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			actionLockRef.current = false;
			setSaving(false);
		}
	};

	const handlePickDbDir = async () => {
		if (saving || extracting || actionLockRef.current) return;
		actionLockRef.current = true;
		setFeedback(null);
		try {
			const picked = await getPi().wenyouNtqqPickDbDir();
			if (!picked) return;
			setSaving(true);
			const res = await getPi().wenyouNtqqSaveConfig({ dbDir: picked });
			applySnapshot(res);
			setFeedback({
				kind: res.status.msgDbExists ? "info" : "error",
				text: res.status.msgDbExists
					? "已定位本机 NTQQ 数据库目录"
					: "所选目录下未检测到 nt_msg.db，请选择到 QQ号目录 / nt_qq / nt_db 任意一层",
			});
		} catch (error) {
			setFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			actionLockRef.current = false;
			setSaving(false);
		}
	};

	const handleExtractKey = async () => {
		if (extracting || saving || actionLockRef.current) return;
		actionLockRef.current = true;
		setExtracting(true);
		setFeedback(null);
		try {
			const trimmed = qqInput.trim();
			const res = await getPi().wenyouNtqqExtractKey(trimmed ? { qqUin: trimmed } : undefined);
			applySnapshot({ config: res.config, status: res.status });
			setFeedback({ kind: "info", text: res.message });
		} catch (error) {
			setFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			actionLockRef.current = false;
			setExtracting(false);
		}
	};

	const handlePickKeyMap = async () => {
		if (saving || extracting || actionLockRef.current) return;
		actionLockRef.current = true;
		setFeedback(null);
		try {
			const picked = await getPi().wenyouNtqqPickKeyMap();
			if (!picked) return;
			setSaving(true);
			const res = await getPi().wenyouNtqqSaveConfig({ keyMapPath: picked });
			applySnapshot(res);
			setFeedback({ kind: "info", text: "已导入 key_map.json 密钥文件" });
		} catch (error) {
			setFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			actionLockRef.current = false;
			setSaving(false);
		}
	};

	const status = snapshot?.status as ExtendedNtqqProbeStatus | undefined;
	const detectedAccounts = status?.detectedAccounts ?? [];
	const showAccountSwitcher =
		detectedAccounts.length > 1 || (detectedAccounts.length === 1 && !qqInput.trim());
	const hasAnyDb = Boolean(status?.msgDbExists || status?.groupDbExists);
	const keyMismatchForCurrent = Boolean(
		status?.keyMapExists && hasAnyDb && status?.keyMatchedForCurrentDb === false,
	);
	const keyReadyForCurrent = Boolean(status?.keyMapExists && !keyMismatchForCurrent);

	return (
		<div className="space-y-4">
			<div>
				<div className="flex items-center justify-between gap-2">
					<label htmlFor="wenyou-qq-uin-input" className="text-ui-13 font-medium text-ink">
						你的 QQ 号（本机消息库直读）
					</label>
					{status && (
						<span
							className={`rounded-full px-2 py-0.5 text-ui-10 font-medium ${
								status.ready
									? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
									: "bg-hover text-ink-dim"
							}`}
						>
							{status.ready ? "本机扒库已就绪" : !status.platformSupported ? "可选离线导入" : "待补全配置"}
						</span>
					)}
				</div>
				<p className="mt-1 text-ui-11 leading-relaxed text-ink-faint">
					QQ 号与密钥仅保存在本机用户目录，绝不写入任何战役目录或导出包；读取 QQ
					消息库全程只读，不修改原文件。
				</p>
				{status && !status.platformSupported && !status.ready && (
					<p className="mt-2 rounded-lg bg-hover/60 px-3 py-2 text-ui-11 leading-relaxed text-ink-dim">
						macOS / Linux 暂不支持一键提取本机 QQ 密钥；可直接跳过此步，随时将导出的{" "}
						<code className="font-mono">.txt</code> / <code className="font-mono">.json</code>{" "}
						聊天记录放入世界目录 <code className="font-mono">00-群聊收集/</code> 离线导入（若已备好{" "}
						<code className="font-mono">key_map.json</code> 仍可手动导入密钥与选择{" "}
						<code className="font-mono">nt_db</code> 目录）。
					</p>
				)}
				<div className="mt-2.5 flex items-center gap-2">
					<input
						id="wenyou-qq-uin-input"
						type="text"
						inputMode="numeric"
						value={qqInput}
						onChange={(e) => {
							const next = e.target.value.replace(/[^\d]/g, "").slice(0, 12);
							setQqInput(next);
							onDraftQqChange?.(next);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleSaveQq();
						}}
						placeholder="输入 5～12 位 QQ 号，例如 10001"
						className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-3 py-1.5 font-mono text-ui-13 text-ink outline-none focus:border-accent"
					/>
					<button
						type="button"
						disabled={saving || loading || extracting}
						onClick={() => void handleSaveQq()}
						className="shrink-0 rounded-lg bg-ink px-3.5 py-1.5 text-ui-12 font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
					>
						{saving ? "保存中…" : "保存并检测"}
					</button>
				</div>
				{showAccountSwitcher && (
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						<span className="text-ui-11 text-ink-faint">本机已检测账号：</span>
						{detectedAccounts.map((acc) => {
							const isCurrent = qqInput.trim() === acc.qqUin;
							return (
								<button
									key={acc.qqUin}
									type="button"
									disabled={saving || extracting}
									onClick={() => void handleSelectDetectedAccount(acc.qqUin)}
									title={acc.dbDir}
									className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-ui-11 transition-colors disabled:opacity-40 ${
										isCurrent
											? "border-ink/40 bg-ink/8 font-medium text-ink"
											: "border-border bg-surface text-ink-2 hover:bg-hover hover:text-ink"
									}`}
								>
									<span>{acc.qqUin}</span>
									<span
										className={`font-sans text-ui-10 ${
											acc.keyReady
												? "text-emerald-600 dark:text-emerald-400"
												: "text-amber-600 dark:text-amber-400"
										}`}
									>
										{acc.keyReady ? "· 已配密钥" : "· 待提取"}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* 3 行只读状态探测（单层容器 + 细分割线，避免卡片套卡片） */}
			<div className="divide-y divide-border rounded-xl border border-border bg-canvas/50 text-ui-12">
				{/* 1. 数据库目录 */}
				<div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="font-medium text-ink">本机 NTQQ 数据目录</span>
							<span
								className={`text-ui-11 ${
									status?.msgDbExists && status?.groupDbExists
										? "text-emerald-600 dark:text-emerald-400"
										: "text-ink-faint"
								}`}
							>
								{loading
									? "探测中…"
									: status?.msgDbExists && status?.groupDbExists
										? `已定位${status.walSizeBytes > 0 ? ` · WAL ${formatMb(status.walSizeBytes)}` : ""}`
										: "未找到 nt_msg.db"}
							</span>
						</div>
						{status?.resolvedDbDir && (
							<p className="mt-0.5 truncate font-mono text-ui-10 text-ink-faint" title={status.resolvedDbDir}>
								{status.resolvedDbDir}
							</p>
						)}
					</div>
					<button
						type="button"
						disabled={saving || extracting}
						onClick={() => void handlePickDbDir()}
						className="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
					>
						选择目录
					</button>
				</div>

				{/* 2. 解密密钥 */}
				<div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="font-medium text-ink">消息库解密密钥</span>
							<span
								className={`text-ui-11 ${
									keyReadyForCurrent
										? "text-emerald-600 dark:text-emerald-400"
										: keyMismatchForCurrent
											? "text-amber-600 dark:text-amber-400"
											: "text-ink-faint"
								}`}
							>
								{loading
									? "探测中…"
									: keyReadyForCurrent
										? "已就绪 (key_map.json)"
										: keyMismatchForCurrent
											? status?.canExtractKey
												? "需提取当前账号密钥"
												: "需导入当前账号密钥"
											: !status || status.canExtractKey
												? "尚未提取"
												: "尚未导入"}
							</span>
						</div>
						<p className="mt-0.5 text-ui-10 text-ink-faint">
							{keyReadyForCurrent
								? "已定位本机 key_map.json，只读按页解密，不修改原库"
								: keyMismatchForCurrent
									? status?.canExtractKey
										? "已保留其他 QQ 账号密钥；请保持当前 QQ 在线并点击「一键提取密钥」合并补充"
										: "已保留其他 QQ 账号密钥；请重新导入包含当前账号的 key_map.json"
									: !status || status.canExtractKey
										? "提取前请保持电脑版 NTQQ 处于已登录状态"
										: "一键提取仅支持 Windows；可手动导入已有 key_map.json，或使用 00-群聊收集/ 离线导入"}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-1.5">
						{status?.canExtractKey && (
							<button
								type="button"
								disabled={extracting || saving || !qqInput.trim()}
								onClick={() => void handleExtractKey()}
								className="rounded-lg border border-border bg-surface px-2.5 py-1 text-ui-11 text-ink transition-colors hover:bg-hover disabled:opacity-40"
								title={
									!qqInput.trim() ? "请先在上方填写你的 QQ 号" : "从已登录的桌面端 NTQQ 提取只读解密密钥"
								}
							>
								{extracting ? "提取中…" : "一键提取密钥"}
							</button>
						)}
						<button
							type="button"
							disabled={saving || extracting}
							onClick={() => void handlePickKeyMap()}
							className="rounded-lg border border-border bg-surface px-2.5 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
						>
							导入密钥
						</button>
					</div>
				</div>

				{/* 3. VFS 引擎与 Python */}
				<div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<span className="font-medium text-ink">只读 VFS 解库引擎</span>
							<span
								className={`text-ui-11 ${
									status?.pythonPath && status?.assetsReady
										? "text-emerald-600 dark:text-emerald-400"
										: "text-amber-600 dark:text-amber-400"
								}`}
							>
								{loading
									? "探测中…"
									: status?.pythonPath && status?.assetsReady
										? status.pythonBundled
											? `随包内置 Python ${status.pythonVersion ?? "3"} · 免安装开箱就绪`
											: `系统 Python ${status.pythonVersion ?? "3"} · 零第三方依赖就绪`
										: !status?.pythonPath
											? "未检测到可用运行环境"
											: "解库组件缺失"}
							</span>
						</div>
						<p className="mt-0.5 text-ui-10 text-ink-faint">
							按群增量读取加密库与实时 WAL 帧，配好后可在「局势书与台账」勾选要同步的文游群
						</p>
					</div>
				</div>
			</div>

			{feedback && (
				<p
					className={`rounded-lg px-3 py-2 text-ui-12 ${
						feedback.kind === "error"
							? "bg-err/10 text-err"
							: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
					}`}
				>
					{feedback.text}
				</p>
			)}

			{showReopenOnboarding && (
				<div className="flex items-center justify-between gap-4 pt-1">
					<div className="min-w-0">
						<p className="text-ui-12 font-medium text-ink">首次启动引导向导</p>
						<p className="mt-0.5 text-ui-11 text-ink-faint">重新打开模型接入与 QQ 号绑定两步向导</p>
					</div>
					<button
						type="button"
						onClick={() => {
							onReopenOnboarding?.();
							useUiPreferencesStore.getState().openOnboarding(1);
						}}
						className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
					>
						重新打开引导
					</button>
				</div>
			)}
		</div>
	);
}
