import type { CampaignNtqqGroupBinding, GroupRole, NtqqGroupSummary, NtqqStatusSnapshot } from "@percho/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getPi } from "../../api";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { bootstrapCampaignWorld, WENYOU_GROUP_ROLE_LABELS } from "./world-bootstrap";

const ROLE_OPTIONS: Array<{ value: GroupRole; label: string }> = [
	{ value: "main", label: WENYOU_GROUP_ROLE_LABELS.main },
	{ value: "cabinet", label: WENYOU_GROUP_ROLE_LABELS.cabinet },
	{ value: "dice", label: WENYOU_GROUP_ROLE_LABELS.dice },
	{ value: "diplomacy", label: WENYOU_GROUP_ROLE_LABELS.diplomacy },
	{ value: "other", label: WENYOU_GROUP_ROLE_LABELS.other },
];

const INITIAL_SYNC_LIMIT_OPTIONS = [
	{ value: 500, label: "500 条（默认快启）" },
	{ value: 2000, label: "2,000 条（推荐）" },
	{ value: 5000, label: "5,000 条（长程）" },
	{ value: 20000, label: "20,000 条（上限）" },
] as const;

function stripInvokePrefix(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

/**
 * 「新建空白文游世界」统一弹窗：
 * 世界默认完全留空（不塞任何演示模板），支持直接选/填主要 QQ 群并一键让 Agent 抓取群聊自动建档。
 */
export function CreateWorldDialog() {
	const open = useWenyouCanvasStore((s) => s.createWorldDialogOpen);
	const setOpen = useWenyouCanvasStore((s) => s.setCreateWorldDialogOpen);

	if (!open) return null;
	return <CreateWorldDialogBody onClose={() => setOpen(false)} />;
}

function CreateWorldDialogBody({ onClose }: { onClose: () => void }) {
	const [worldTitle, setWorldTitle] = useState("");
	const [titleTouched, setTitleTouched] = useState(false);
	const [defaultWorldsDir, setDefaultWorldsDir] = useState("");
	const [customParentDir, setCustomParentDir] = useState<string | null>(null);

	const [snapshot, setSnapshot] = useState<NtqqStatusSnapshot | null>(null);
	const [availableGroups, setAvailableGroups] = useState<NtqqGroupSummary[]>([]);
	const [bindings, setBindings] = useState<CampaignNtqqGroupBinding[]>([]);
	const [search, setSearch] = useState("");
	const [manualGroupId, setManualGroupId] = useState("");
	const [manualGroupName, setManualGroupName] = useState("");
	const [syncLimit, setSyncLimit] = useState<number>(500);

	const [loadingInit, setLoadingInit] = useState(true);
	const [loadingGroups, setLoadingGroups] = useState(false);
	const [submitting, setSubmitting] = useState<"agent" | "empty" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadInitial = useCallback(async () => {
		setLoadingInit(true);
		setError(null);
		try {
			const [dir, st] = await Promise.all([
				getPi().wenyouGetDefaultWorldsDir().catch(() => ""),
				getPi().wenyouNtqqGetStatus().catch(() => null),
			]);
			setDefaultWorldsDir(dir);
			setSnapshot(st);
			if (st?.status.ready) {
				setLoadingGroups(true);
				try {
					const res = await getPi().wenyouNtqqListGroups({});
					setAvailableGroups(res.groups);
				} catch (err) {
					setError(stripInvokePrefix(err));
				} finally {
					setLoadingGroups(false);
				}
			}
		} catch (err) {
			setError(stripInvokePrefix(err));
		} finally {
			setLoadingInit(false);
		}
	}, []);

	useEffect(() => {
		void loadInitial();
	}, [loadInitial]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !submitting) onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose, submitting]);

	const boundMap = useMemo(() => new Map(bindings.map((b) => [b.groupId, b])), [bindings]);

	const filteredGroups = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return availableGroups;
		return availableGroups.filter(
			(g) => g.groupId.includes(q) || g.groupName.toLowerCase().includes(q),
		);
	}, [availableGroups, search]);

	const maybeAutofillTitle = (candidateName: string) => {
		const clean = candidateName.trim();
		if (!titleTouched && !worldTitle.trim() && clean && !/^\d+$/.test(clean)) {
			setWorldTitle(clean);
		}
	};

	const toggleGroup = (group: NtqqGroupSummary) => {
		const exists = bindings.some((b) => b.groupId === group.groupId);
		if (!exists && bindings.length === 0) {
			maybeAutofillTitle(group.groupName);
		}
		setBindings((prev) => {
			if (prev.some((b) => b.groupId === group.groupId)) {
				return prev.filter((b) => b.groupId !== group.groupId);
			}
			const isFirst = prev.length === 0;
			return [
				...prev,
				{
					groupId: group.groupId,
					groupName: group.groupName,
					role: isFirst ? "main" : "other",
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
		const name = manualGroupName.trim() || gid;
		const exists = bindings.some((b) => b.groupId === gid);
		if (!exists && bindings.length === 0 && manualGroupName.trim()) {
			maybeAutofillTitle(manualGroupName);
		}
		setBindings((prev) => {
			if (prev.some((b) => b.groupId === gid)) return prev;
			const isFirst = prev.length === 0;
			return [
				...prev,
				{
					groupId: gid,
					groupName: name,
					role: isFirst ? "main" : "other",
				},
			];
		});
		setManualGroupId("");
		setManualGroupName("");
	};

	const handlePickParentDir = async () => {
		const picked = await getPi().pickDirectory();
		if (picked) setCustomParentDir(picked);
	};

	const handleSubmit = async (autoStartAgent: boolean) => {
		setSubmitting(autoStartAgent ? "agent" : "empty");
		setError(null);
		try {
			// 若用户在手动群号框里输入了有效群号却忘了点「添加」，顺手并入绑定列表，减少操作折返
			let finalBindings = bindings;
			const pendingGid = manualGroupId.trim();
			if (/^\d{5,15}$/.test(pendingGid) && !bindings.some((b) => b.groupId === pendingGid)) {
				finalBindings = [
					...bindings,
					{
						groupId: pendingGid,
						groupName: manualGroupName.trim() || pendingGid,
						role: bindings.length === 0 ? "main" : "other",
					},
				];
			}

			await bootstrapCampaignWorld({
				parentDir: customParentDir ?? undefined,
				worldTitle: worldTitle.trim() || undefined,
				bindings: finalBindings,
				ntqqReady: snapshot?.status.ready === true,
				syncLimit,
				autoStartAgent,
			});
			onClose();
		} catch (err) {
			setError(stripInvokePrefix(err));
		} finally {
			setSubmitting(null);
		}
	};

	const ready = snapshot?.status.ready === true;
	const isOfflinePlatform = snapshot !== null && !snapshot.status.platformSupported;
	const targetLocation = customParentDir ?? defaultWorldsDir;
	const effectiveGroupCount =
		bindings.length +
		(/^\d{5,15}$/.test(manualGroupId.trim()) && !bindings.some((b) => b.groupId === manualGroupId.trim())
			? 1
			: 0);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4"
			role="dialog"
			aria-modal="true"
			aria-label="新建空白文游世界"
		>
			<div className="flex max-h-[min(86vh,680px)] w-[620px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-dialog">
				{/* 顶栏 */}
				<div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
					<div>
						<h2 className="text-ui-15 font-semibold text-ink">新建空白文游世界</h2>
						<p className="mt-0.5 text-ui-12 text-ink-dim">
							不塞演示模板；选定或输入主要 QQ 群后，由司命直接抓取群聊梳理设定与局势
						</p>
					</div>
					<button
						type="button"
						disabled={Boolean(submitting)}
						onClick={onClose}
						className="rounded-lg px-2 py-1 text-ui-12 text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-40"
					>
						关闭
					</button>
				</div>

				{/* 主体滚动区 */}
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
					{/* 世界名称与存放位置 */}
					<div className="space-y-2">
						<label className="block space-y-1">
							<span className="text-ui-12 font-medium text-ink">世界名称（可选）</span>
							<input
								type="text"
								value={worldTitle}
								onChange={(e) => {
									setWorldTitle(e.target.value);
									setTitleTouched(true);
								}}
								placeholder="留空则自动使用主群名，如：文明不朽 / 顺唐文游"
								className="w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-ui-13 text-ink outline-none focus:border-accent"
							/>
						</label>
						<div className="flex items-center justify-between gap-2 text-ui-11 text-ink-faint">
							<span className="min-w-0 truncate" title={targetLocation}>
								存放目录：{targetLocation || "默认本地世界目录"}
							</span>
							<div className="flex shrink-0 items-center gap-2">
								{customParentDir && (
									<button
										type="button"
										onClick={() => setCustomParentDir(null)}
										className="text-ink-dim hover:text-ink"
									>
										恢复默认
									</button>
								)}
								<button
									type="button"
									onClick={() => void handlePickParentDir()}
									className="rounded-md border border-border px-2 py-0.5 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
								>
									更改位置
								</button>
							</div>
						</div>
					</div>

					{/* 主要群聊绑定区 */}
					<div className="space-y-2.5 border-t border-border pt-4">
						<div className="flex items-center justify-between gap-2">
							<span className="text-ui-12 font-medium text-ink">
								主要群聊{bindings.length > 0 ? `（已选 ${bindings.length} 个）` : ""}
							</span>
							{ready && (
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
							)}
						</div>

						{bindings.length > 0 && (
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
						)}

						{loadingInit ? (
							<p className="py-4 text-center text-ui-12 text-ink-faint">正在检测本机 NTQQ 状态…</p>
						) : ready ? (
							<div className="space-y-2">
								<input
									type="text"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="搜索本机 QQ 群名或群号，勾选主群 / 内阁群 / 骰子群…"
									className="w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
								/>
								<div className="max-h-40 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-canvas/40">
									{loadingGroups ? (
										<p className="py-5 text-center text-ui-12 text-ink-faint">正在只读读取本机群列表…</p>
									) : filteredGroups.length === 0 ? (
										<p className="py-5 text-center text-ui-12 text-ink-faint">未匹配到群，可在下方直接输入群号</p>
									) : (
										filteredGroups.slice(0, 80).map((g) => {
											const checked = boundMap.has(g.groupId);
											return (
												<label
													key={g.groupId}
													className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-ui-12 hover:bg-hover/60"
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
						) : isOfflinePlatform ? (
							<div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-canvas/50 px-3.5 py-2.5 text-ui-12">
								<span className="min-w-0 flex-1 text-ink-dim">
									当前系统暂不支持一键直采本机 QQ；创建世界后直接将导出的{" "}
									<code className="font-mono">.txt</code> / <code className="font-mono">.json</code>{" "}
									聊天记录放入 <code className="font-mono">00-群聊收集/</code> 即可交由司命梳理
								</span>
								<button
									type="button"
									onClick={() => {
										onClose();
										useUiPreferencesStore.getState().openOnboarding(2);
									}}
									className="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1 text-ui-11 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
								>
									手动导入密钥
								</button>
							</div>
						) : (
							<div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-canvas/50 px-3.5 py-2.5 text-ui-12">
								<span className="min-w-0 flex-1 text-ink-dim">
									本机 QQ 只读抓取未就绪（{(snapshot?.status.missingReasons ?? ["尚未配置 QQ 号与密钥"]).join("；")}）
								</span>
								<button
									type="button"
									onClick={() => {
										onClose();
										useUiPreferencesStore.getState().openOnboarding(2);
									}}
									className="shrink-0 rounded-lg border border-border bg-surface px-2.5 py-1 text-ui-11 font-medium text-ink transition-colors hover:bg-hover"
								>
									去配置 QQ 号与密钥
								</button>
							</div>
						)}

						{/* 手动输入主群号（随时可用） */}
						<div className="flex items-center gap-2">
							<input
								type="text"
								value={manualGroupId}
								onChange={(e) => setManualGroupId(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleAddManual();
								}}
								placeholder="输入 QQ 群号（如 951594174）"
								className="w-56 rounded-lg border border-border bg-canvas px-2.5 py-1.5 font-mono text-ui-12 text-ink outline-none focus:border-accent"
							/>
							<input
								type="text"
								value={manualGroupName}
								onChange={(e) => setManualGroupName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleAddManual();
								}}
								placeholder="群备注名（可选）"
								className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
							/>
							<button
								type="button"
								onClick={handleAddManual}
								className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
							>
								添加
							</button>
						</div>

						{ready && (
							<div className="flex items-center justify-between gap-2 pt-1 text-ui-11 text-ink-dim">
								<span>首轮每群拉取历史深度（后续可在「绑定 QQ 群」随时补抓至 20,000 条）</span>
								<select
									aria-label="首轮每群拉取历史条数"
									value={syncLimit}
									onChange={(e) => setSyncLimit(Number(e.target.value))}
									className="shrink-0 rounded-md border border-border bg-canvas px-2 py-1 text-ui-11 text-ink outline-none focus:border-accent"
								>
									{INITIAL_SYNC_LIMIT_OPTIONS.map((opt) => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
							</div>
						)}
					</div>

					{error && (
						<p className="rounded-lg border border-err/30 bg-err/8 px-3 py-2 text-ui-12 text-err">
							{error}
						</p>
					)}
				</div>

				{/* 底栏 */}
				<div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-canvas/40 px-5 py-3">
					<button
						type="button"
						disabled={Boolean(submitting)}
						onClick={onClose}
						className="rounded-lg px-2.5 py-1.5 text-ui-12 text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-40"
					>
						取消
					</button>
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={Boolean(submitting)}
							onClick={() => void handleSubmit(false)}
							className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
						>
							{submitting === "empty" ? "创建中…" : "仅建空世界"}
						</button>
						<button
							type="button"
							disabled={Boolean(submitting)}
							onClick={() => void handleSubmit(true)}
							className="rounded-lg bg-ink px-4 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{submitting === "agent"
								? "正在同步并唤起司命…"
								: effectiveGroupCount > 0
									? `创建并抓取 ${effectiveGroupCount} 个群建档`
									: "创建并让司命引导建档"}
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
