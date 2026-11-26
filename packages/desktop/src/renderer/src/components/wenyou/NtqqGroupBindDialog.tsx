import type { CampaignNtqqGroupBinding, GroupRole, NtqqGroupSummary, NtqqStatusSnapshot } from "@percho/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getPi } from "../../api";
import { pushExtensionToast } from "../../stores/toasts";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { unwrapCwdPath } from "./wenyou-helpers";

const ROLE_OPTIONS: Array<{ value: GroupRole; label: string }> = [
	{ value: "main", label: "主群" },
	{ value: "dice", label: "骰子群" },
	{ value: "cabinet", label: "内阁密群" },
	{ value: "diplomacy", label: "外交群" },
	{ value: "other", label: "其他" },
];

const SYNC_LIMIT_OPTIONS = [
	{ value: 500, label: "500 条（快速）" },
	{ value: 2000, label: "2,000 条（推荐）" },
	{ value: 5000, label: "5,000 条（长程）" },
	{ value: 20000, label: "20,000 条（上限）" },
] as const;

function stripInvokePrefix(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

/**
 * 为当前战役绑定本机 NTQQ 群并一键增量拉取消息的对话框。
 * 绑定配置仅写入战役私有目录 `.wenyou/ntqq-groups.json`（对外导出自动隔离）。
 */
export function NtqqGroupBindDialog({ onClose }: { onClose: () => void }) {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const refreshOverview = useWenyouCanvasStore((s) => s.refreshOverview);
	const rawCwd = unwrapCwdPath(cwd);

	const [snapshot, setSnapshot] = useState<NtqqStatusSnapshot | null>(null);
	const [bindings, setBindings] = useState<CampaignNtqqGroupBinding[]>([]);
	const [availableGroups, setAvailableGroups] = useState<NtqqGroupSummary[]>([]);
	const [search, setSearch] = useState("");
	const [manualGroupId, setManualGroupId] = useState("");
	const [manualGroupName, setManualGroupName] = useState("");
	const [syncLimit, setSyncLimit] = useState<number>(2000);
	const [forceBackfill, setForceBackfill] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadingGroups, setLoadingGroups] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadInitial = useCallback(async () => {
		if (!rawCwd) return;
		setLoading(true);
		setError(null);
		try {
			const [st, saved] = await Promise.all([
				getPi().wenyouNtqqGetStatus(),
				getPi().wenyouNtqqGetCampaignBindings({ cwd: rawCwd }),
			]);
			setSnapshot(st);
			setBindings(saved);
			if (st.status.ready) {
				setLoadingGroups(true);
				try {
					const listRes = await getPi().wenyouNtqqListGroups({});
					setAvailableGroups(listRes.groups);
				} catch (err) {
					setError(stripInvokePrefix(err));
				} finally {
					setLoadingGroups(false);
				}
			}
		} catch (err) {
			setError(stripInvokePrefix(err));
		} finally {
			setLoading(false);
		}
	}, [rawCwd]);

	useEffect(() => {
		void loadInitial();
	}, [loadInitial]);

	const boundMap = useMemo(() => new Map(bindings.map((b) => [b.groupId, b])), [bindings]);

	const filteredGroups = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return availableGroups;
		return availableGroups.filter(
			(g) => g.groupId.includes(q) || g.groupName.toLowerCase().includes(q),
		);
	}, [availableGroups, search]);

	const toggleGroup = (group: NtqqGroupSummary) => {
		setBindings((prev) => {
			if (prev.some((b) => b.groupId === group.groupId)) {
				return prev.filter((b) => b.groupId !== group.groupId);
			}
			return [
				...prev,
				{
					groupId: group.groupId,
					groupName: group.groupName,
					role: prev.length === 0 ? "main" : "other",
				},
			];
		});
	};

	const updateRole = (groupId: string, role: GroupRole) => {
		setBindings((prev) =>
			prev.map((b) =>
				b.groupId === groupId ? { ...b, role, visibility: role === "cabinet" ? "gm" : "public" } : b,
			),
		);
	};

	const handleAddManual = () => {
		const gid = manualGroupId.trim();
		if (!/^\d{5,15}$/.test(gid)) {
			setError("请输入 5～15 位纯数字 QQ 群号");
			return;
		}
		setError(null);
		setBindings((prev) => {
			if (prev.some((b) => b.groupId === gid)) return prev;
			return [
				...prev,
				{
					groupId: gid,
					groupName: manualGroupName.trim() || gid,
					role: prev.length === 0 ? "main" : "other",
				},
			];
		});
		setManualGroupId("");
		setManualGroupName("");
	};

	const handleSave = async (syncNow: boolean) => {
		if (!rawCwd) return;
		setSaving(true);
		setError(null);
		try {
			const saved = await getPi().wenyouNtqqSaveCampaignBindings({ cwd: rawCwd, bindings });
			if (syncNow && saved.length > 0) {
				const syncRes = await getPi().wenyouNtqqSyncCampaign({
					cwd: rawCwd,
					limit: syncLimit,
					...(forceBackfill ? { force: true } : {}),
				});
				pushExtensionToast(
					"info",
					`本机 NTQQ 同步完成（${Math.round(syncRes.elapsedMs)} ms）：新入库 ${syncRes.newlyIngested} 条，去重 ${syncRes.skippedDuplicates} 条，待汇报 ${syncRes.unreportedCount} 条`,
					"Wenyou Pro",
				);
			} else {
				pushExtensionToast("info", `已保存本战役的 ${saved.length} 个 QQ 群绑定`, "Wenyou Pro");
			}
			await refreshOverview(cwd, { silent: true });
			onClose();
		} catch (err) {
			setError(stripInvokePrefix(err));
		} finally {
			setSaving(false);
		}
	};

	const ready = snapshot?.status.ready === true;
	const isOfflinePlatform = snapshot !== null && !snapshot.status.platformSupported;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4"
			role="dialog"
			aria-modal="true"
			aria-label="绑定本机 QQ 群"
		>
			<div className="flex max-h-[min(84vh,640px)] w-[580px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-dialog">
				<div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
					<div>
						<h3 className="text-ui-15 font-semibold text-ink">绑定本机 QQ 群（NTQQ 只读直采）</h3>
						<p className="mt-0.5 text-ui-11 text-ink-dim">
							绑定记录仅存于战役私有目录 .wenyou/ntqq-groups.json，不会进入对外发包
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg px-2 py-1 text-ui-12 text-ink-dim hover:bg-hover hover:text-ink"
					>
						关闭
					</button>
				</div>

				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
					{loading ? (
						<p className="py-8 text-center text-ui-12 text-ink-faint">正在读取本机 NTQQ 状态…</p>
					) : !ready ? (
						isOfflinePlatform ? (
							<div className="space-y-3 rounded-xl border border-border bg-canvas/60 p-4">
								<p className="text-ui-13 font-medium text-ink">当前系统推荐离线导入聊天记录</p>
								<p className="text-ui-12 leading-relaxed text-ink-dim">
									macOS / Linux 暂不支持一键提取本机 QQ 密钥。推荐将导出的{" "}
									<code className="font-mono">.txt</code> / <code className="font-mono">.json</code>{" "}
									聊天记录放入当前战役目录的 <code className="font-mono">00-群聊收集/</code>{" "}
									自动解析入库。
								</p>
								<p className="text-ui-11 text-ink-faint">
									若已有 <code className="font-mono">key_map.json</code>，也可手动配置密钥与本机{" "}
									<code className="font-mono">nt_db</code> 数据目录后启用只读直采。
								</p>
								<button
									type="button"
									onClick={() => {
										onClose();
										useUiPreferencesStore.getState().openOnboarding(2);
									}}
									className="rounded-lg border border-border bg-surface px-3.5 py-1.5 text-ui-12 font-medium text-ink transition-colors hover:bg-hover"
								>
									手动配置密钥与数据目录
								</button>
							</div>
						) : (
							<div className="space-y-3 rounded-xl border border-border bg-canvas/60 p-4">
								<p className="text-ui-13 font-medium text-ink">本机 NTQQ 只读环境尚未就绪</p>
								<ul className="list-disc space-y-1 pl-4 text-ui-12 text-ink-dim">
									{(snapshot?.status.missingReasons ?? ["尚未完成 QQ 号与密钥配置"]).map((r) => (
										<li key={r}>{r}</li>
									))}
								</ul>
								<button
									type="button"
									onClick={() => {
										onClose();
										useUiPreferencesStore.getState().openOnboarding(2);
									}}
									className="rounded-lg bg-ink px-3.5 py-1.5 text-ui-12 font-medium text-on-ink hover:bg-ink-2"
								>
									去配置 QQ 号与密钥
								</button>
							</div>
						)
					) : (
						<>
							{/* 已绑定群列表 */}
							<div className="space-y-2">
								<div className="flex items-center justify-between text-ui-12">
									<span className="font-medium text-ink">当前战役已绑定（{bindings.length}）</span>
									<button
										type="button"
										disabled={loadingGroups}
										onClick={() => {
											setLoadingGroups(true);
											void getPi()
												.wenyouNtqqListGroups({ force: true })
												.then((res) => setAvailableGroups(res.groups))
												.catch((err) => setError(stripInvokePrefix(err)))
												.finally(() => setLoadingGroups(false));
										}}
										className="text-ui-11 text-ink-dim hover:text-ink disabled:opacity-40"
									>
										{loadingGroups ? "读取群列表…" : "刷新本机群列表"}
									</button>
								</div>

								{bindings.length > 0 ? (
									<div className="divide-y divide-border rounded-xl border border-border bg-canvas/50">
										{bindings.map((b) => (
											<div key={b.groupId} className="flex items-center justify-between gap-2 px-3 py-2 text-ui-12">
												<div className="min-w-0 flex-1">
													<span className="truncate font-medium text-ink">{b.groupName || b.groupId}</span>
													<span className="ml-2 font-mono text-ui-11 text-ink-faint">{b.groupId}</span>
												</div>
												<select
													aria-label={`设置 ${b.groupName || b.groupId} 群角色`}
													value={b.role}
													onChange={(e) => updateRole(b.groupId, e.target.value as GroupRole)}
													className="rounded-md border border-border bg-surface px-2 py-0.5 text-ui-11 text-ink outline-none focus:border-accent"
												>
													{ROLE_OPTIONS.map((opt) => (
														<option key={opt.value} value={opt.value}>
															{opt.label}
														</option>
													))}
												</select>
												<button
													type="button"
													onClick={() =>
														setBindings((prev) => prev.filter((item) => item.groupId !== b.groupId))
													}
													className="rounded px-1.5 py-0.5 text-ui-11 text-ink-faint hover:bg-hover hover:text-err"
												>
													移除
												</button>
											</div>
										))}
									</div>
								) : (
									<p className="rounded-xl border border-border bg-canvas/40 px-3.5 py-3 text-ui-12 text-ink-faint">
										暂未绑定 QQ 群，请在下方勾选或手动输入群号。
									</p>
								)}
							</div>

							{/* 本机群搜索与勾选 */}
							<div className="space-y-2">
								<input
									type="text"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="搜索本机 QQ 群名或群号…"
									className="w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
								/>
								<div className="max-h-44 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-canvas/40">
									{loadingGroups ? (
										<p className="py-6 text-center text-ui-12 text-ink-faint">正在只读解密本机群列表…</p>
									) : filteredGroups.length === 0 ? (
										<p className="py-6 text-center text-ui-12 text-ink-faint">未匹配到群</p>
									) : (
										filteredGroups.slice(0, 80).map((g) => {
											const checked = boundMap.has(g.groupId);
											return (
												<label
													key={g.groupId}
													className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-ui-12 hover:bg-hover/60"
												>
													<span className="flex min-w-0 items-center gap-2">
														<input
															type="checkbox"
															checked={checked}
															onChange={() => toggleGroup(g)}
															className="accent-ink"
														/>
														<span className="truncate text-ink">{g.groupName}</span>
													</span>
													<span className="shrink-0 font-mono text-ui-11 text-ink-faint">{g.groupId}</span>
												</label>
											);
										})
									)}
								</div>
							</div>

							{/* 手动输入群号兜底 */}
							<div className="flex items-center gap-2">
								<input
									type="text"
									inputMode="numeric"
									value={manualGroupId}
									onChange={(e) => setManualGroupId(e.target.value.replace(/[^\d]/g, "").slice(0, 15))}
									placeholder="手动输入群号"
									className="w-36 rounded-lg border border-border bg-canvas px-2.5 py-1.5 font-mono text-ui-12 text-ink outline-none focus:border-accent"
								/>
								<input
									type="text"
									value={manualGroupName}
									onChange={(e) => setManualGroupName(e.target.value)}
									placeholder="可选备注群名"
									className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
								/>
								<button
									type="button"
									onClick={handleAddManual}
									className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 hover:bg-hover hover:text-ink"
								>
									添加
								</button>
							</div>

							{/* 单群同步回溯深度设置 */}
							<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-ui-12">
								<label className="flex items-center gap-2 text-ink-2">
									<span>单群拉取上限</span>
									<select
										aria-label="单群拉取历史条数上限"
										value={syncLimit}
										onChange={(e) => setSyncLimit(Number(e.target.value))}
										className="rounded-md border border-border bg-canvas px-2 py-1 text-ui-11 text-ink outline-none focus:border-accent"
									>
										{SYNC_LIMIT_OPTIONS.map((opt) => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</select>
								</label>
								<label className="flex cursor-pointer items-center gap-1.5 text-ui-11 text-ink-dim hover:text-ink">
									<input
										type="checkbox"
										checked={forceBackfill}
										onChange={(e) => setForceBackfill(e.target.checked)}
										className="accent-ink"
									/>
									<span>回溯补抓更早历史（按时间线去重补齐）</span>
								</label>
							</div>
						</>
					)}

					{error && <p className="rounded-lg bg-err/10 px-3 py-2 text-ui-12 text-err">{error}</p>}
				</div>

				<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-canvas/40 px-5 py-3">
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg px-3 py-1.5 text-ui-12 text-ink-dim hover:bg-hover hover:text-ink"
					>
						取消
					</button>
					{ready && (
						<>
							<button
								type="button"
								disabled={saving}
								onClick={() => void handleSave(false)}
								className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
							>
								仅保存绑定
							</button>
							<button
								type="button"
								disabled={saving || bindings.length === 0}
								onClick={() => void handleSave(true)}
								className="rounded-lg bg-ink px-3.5 py-1.5 text-ui-12 font-medium text-on-ink hover:bg-ink-2 disabled:opacity-40"
							>
								{saving ? "同步中…" : "保存并立即同步"}
							</button>
						</>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
