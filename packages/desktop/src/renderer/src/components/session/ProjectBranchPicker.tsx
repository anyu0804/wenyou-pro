import { environmentEntityRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { getDailyDirCached, isDailyCwd } from "../../lib/daily";
import { pathLastSegment } from "../../lib/path-display";
import { deriveProjects, useProjectsStore } from "../../stores/projects";
import { useSessionCatalogStore } from "../../stores/session-catalog";
import { useSessionsStore } from "../../stores/sessions";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { CoffeeIcon } from "../icons";
import { AddProjectDialog } from "../sidebar/AddProjectDialog";
import { Dropdown } from "../ui/Dropdown";

/** 空态 Composer 下方：世界/项目目录选择器 */
export function ProjectBranchPicker() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	// 真实会话的项目在创建时已绑定、不可更改：只在新会话页（无 active）提供切换，
	// 避免选择器看起来能切、实际不生效的假交互
	if (activeSessionId) return null;
	return (
		<div className="flex items-center justify-center gap-2 text-ui-13 text-ink-dim">
			<ProjectPicker />
		</div>
	);
}

function ProjectPicker() {
	const [adding, setAdding] = useState(false);
	const t = useT();
	const cwd = useSessionsStore(selectActiveCwd);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const setDraftCwd = useSessionsStore((s) => s.setDraftCwd);
	const allSessions = useProjectsStore((s) => s.allSessions);
	const addedProjects = useProjectsStore((s) => s.addedProjects);
	const catalogs = useSessionCatalogStore((s) => s.byEnvironment);
	const projects = useMemo(
		() =>
			deriveProjects(
				{ allSessions, addedProjects },
				Object.values(catalogs).flatMap((entry) => entry.projects?.projects ?? []),
			),
		[allSessions, addedProjects, catalogs],
	);
	const name = cwd ? pathLastSegment(cwd) : undefined;
	const daily = isDailyCwd(cwd);
	// 模块缓存（load() 已 await 初始化；空态 EmptyState 挂载即触发 load）
	const dailyDir = getDailyDirCached(cwd ? environmentEntityRef(cwd).environment : LOCAL_ENVIRONMENT);

	return (
		<>
			{adding && <AddProjectDialog onClose={() => setAdding(false)} onLocalProject={pickDirectory} />}
			<Dropdown
				trigger={
					<span className="flex items-center gap-1.5" data-project-picker>
						{daily ? t("projects.daily") : (name ?? t("projects.selectProject"))}
					</span>
				}
			>
				{(close) => (
					<>
						{/* 日常空间钉顶：新会话页可在 日常 ↔ 世界 间双向切换（与侧栏同一空间语义） */}
						{dailyDir && (
							<>
								<button
									type="button"
									className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-13 transition-colors hover:bg-hover ${
										daily ? "text-ink" : "text-ink-2"
									}`}
									onClick={() => {
										setDraftCwd(dailyDir);
										close();
									}}
								>
									<span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-border-strong bg-canvas text-ink">
										<CoffeeIcon size={10} />
									</span>
									<span className="truncate">{t("projects.daily")}</span>
								</button>
								{projects.length > 0 && <div className="my-0.5 border-t border-border" />}
							</>
						)}
						{projects.map((project) => (
							<button
								key={project.cwd}
								type="button"
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-13 transition-colors hover:bg-hover ${
									project.cwd === cwd ? "text-ink" : "text-ink-2"
								}`}
								onClick={() => {
									// 写进 draft 配置（同时记住 lastCwd）：发送首条消息时即用这个目录创建
									setDraftCwd(project.cwd);
									close();
								}}
							>
								<span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded bg-ink-faint text-ui-10 font-semibold text-on-ink">
									{(project.name[0] ?? "P").toUpperCase()}
								</span>
								<span className="truncate">{project.name}</span>
							</button>
						))}
						<button
							type="button"
							className="mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-border px-2 py-1.5 text-left text-ui-13 font-medium text-ink transition-colors hover:bg-hover"
							onClick={() => {
								useWenyouCanvasStore.getState().setCreateWorldDialogOpen(true);
								close();
							}}
						>
							＋ 新建空白世界…
						</button>
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-13 text-ink-dim transition-colors hover:bg-hover"
							onClick={() => {
								setAdding(true);
								close();
							}}
						>
							{t("projects.selectProject")}…
						</button>
					</>
				)}
			</Dropdown>
		</>
	);
}
