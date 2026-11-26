import {
	type CampaignNtqqGroupBinding,
	type GroupRole,
	LOCAL_ENVIRONMENT,
	type NtqqSyncCampaignResult,
} from "@percho/shared";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { pushExtensionToast } from "../../stores/toasts";
import { useTranscriptStore } from "../../stores/transcript";
import { fillWenyouPrompt, useWenyouCanvasStore } from "../../stores/wenyou-canvas";

export const WENYOU_GROUP_ROLE_LABELS: Record<GroupRole, string> = {
	main: "主群",
	dice: "骰子群",
	cabinet: "内阁密群",
	diplomacy: "外交群",
	other: "其他",
};

export interface BuildWorldBootstrapPromptInput {
	worldTitle: string;
	bindings: readonly CampaignNtqqGroupBinding[];
	syncResult?: NtqqSyncCampaignResult | null;
	syncWarning?: string | null;
}

/** 构造全新空白世界的首轮抓群建档指令（严格要求基于真实群聊建档，不编造预设模板） */
export function buildWorldBootstrapPrompt(input: BuildWorldBootstrapPromptInput): string {
	const title = input.worldTitle.trim() || "新建文游世界";
	const groupLines = input.bindings.map((b) => {
		const role = WENYOU_GROUP_ROLE_LABELS[b.role] ?? b.role;
		const name = b.groupName?.trim() || b.groupId;
		return `${role}「${name}」（群号 ${b.groupId}）`;
	});

	if (groupLines.length === 0) {
		return [
			`我刚刚创建了空白文游世界「${title}」，尚未绑定 QQ 群。`,
			"请你保持世界档案空白，不要编造任何预设剧情或架空模板。",
			"请先简洁告知我需要补充哪些信息（例如：点击右侧「绑定 QQ 群」勾选主群，或把历史群聊导出文本放入 00-群聊收集/），等我提供群聊记录后再为我抓取建档并生成首份局势书。",
		].join("\n");
	}

	const syncNote = input.syncResult
		? `系统已尝试直读本机 NTQQ，本次新入库 ${input.syncResult.newlyIngested} 条消息（待汇报 ${input.syncResult.unreportedCount} 条）。`
		: input.syncWarning
			? `刚才自动拉取本机 QQ 消息时遇到提示：${input.syncWarning}。请仍先调用 wenyou_pull_qq 检查 00-群聊收集/ 或已入库证据。`
			: "请先调用 wenyou_pull_qq 拉取已绑定群聊的最新增量消息。";

	return [
		`我刚刚创建了空白文游世界「${title}」，已绑定以下主要群聊：${groupLines.join("、")}。`,
		syncNote,
		"请你基于真实群聊记录完成首轮抓取建档（严格以群聊原文为准，绝不编造群里没有出现的国家、数字或设定）：",
		"1. 先调用 wenyou_pull_qq 确认各绑定群最新增量，并结合 wenyou_read_memory / wenyou_lookup_source 梳理出本世界的背景设定、当前纪年/回合、核心国家与阵营、关键人物与已定案事件；",
		"2. 调用 wenyou_publish_briefing 发布本世界首份局势书（含【进度】【外交局势】【情报核查】与战略判断），每条关键论断均附可点击的 [sourceId]，严格区分 GM 裁定事实、单方宣传口径、小群未定案草案与玩家 OOC；",
		"3. 对群聊中已明确的世界设定与各国实册，通过 wenyou_propose_canon 提交至 01-设定与国力实册/ 待审提案供我审核落盘；若目前抓取到的消息量较少或缺少某项关键设定，直接列出缺口提醒我补充对应群聊或文档。",
	].join("\n");
}

export interface BootstrapCampaignWorldInput {
	/** 若已有目标目录（例如在未初始化目录中点击初始化）则复用；否则自动新建空白目录 */
	existingCwd?: string;
	/** 可选自定义父目录（仅新建时生效；留空则建在默认 ~/.wenyou-pro/worlds 下） */
	parentDir?: string;
	worldTitle?: string;
	currentEra?: string;
	bindings: CampaignNtqqGroupBinding[];
	ntqqReady?: boolean;
	/** 是否在建完并同步后自动发起 Agent 首轮抓取建档 */
	autoStartAgent: boolean;
}

export interface BootstrapCampaignWorldResult {
	cwd: string;
	worldTitle: string;
	syncResult: NtqqSyncCampaignResult | null;
	syncWarning: string | null;
	agentTriggered: "sent" | "prefilled" | "skipped";
}

function hasConfiguredModel(): boolean {
	const sessions = useSessionsStore.getState();
	if (sessions.newSessionDraft?.model) return true;
	return sessions.models.some((m) => m.authed);
}

/**
 * 统一执行：创建/初始化空白世界 → 注册项目并切换上下文 → 保存绑群与直读同步 → 触发 Agent 首轮抓群建档。
 */
export async function bootstrapCampaignWorld(
	input: BootstrapCampaignWorldInput,
): Promise<BootstrapCampaignWorldResult> {
	const pi = getPi();
	const execApi = getExecutionApi(LOCAL_ENVIRONMENT);

	const mainGroup = input.bindings.find((b) => b.role === "main") ?? input.bindings[0];
	const inferredTitle = input.worldTitle?.trim() || mainGroup?.groupName?.trim() || "";

	let cwd = input.existingCwd?.trim() || "";
	let worldTitle = inferredTitle;

	if (!cwd) {
		const created = await pi.wenyouCreateWorldDir({
			...(inferredTitle ? { worldTitle: inferredTitle } : {}),
			...(input.parentDir?.trim() ? { parentDir: input.parentDir.trim() } : {}),
		});
		cwd = created.cwd;
		worldTitle = created.worldTitle;
	}

	const overview = await execApi.wenyouInitCampaign({
		cwd,
		...(worldTitle ? { worldTitle } : {}),
		currentEra: input.currentEra?.trim() || "起始建档",
	});
	const finalTitle = overview.worldTitle || worldTitle || "新建文游世界";

	// 信任前置 + 加入左侧项目列表 + 切换到该世界的新会话草稿页
	void execApi.ensureProjectTrust({ cwd }).catch(() => {});
	useProjectsStore.getState().addKnownProject(cwd);
	useSessionsStore.getState().activateNewSessionDraftForCwd(cwd, LOCAL_ENVIRONMENT);

	let syncResult: NtqqSyncCampaignResult | null = null;
	let syncWarning: string | null = null;

	if (input.bindings.length > 0) {
		await pi.wenyouNtqqSaveCampaignBindings({ cwd, bindings: input.bindings });
		if (input.ntqqReady) {
			try {
				syncResult = await pi.wenyouNtqqSyncCampaign({ cwd, limit: 500 });
			} catch (error) {
				syncWarning = error instanceof Error ? error.message : String(error);
			}
		} else {
			syncWarning = "本机 NTQQ 解密环境尚未就绪，暂未自动拉取本机 QQ 消息";
		}
	}

	// 打开右侧文游画布并同步新世界概览
	const canvas = useWenyouCanvasStore.getState();
	await canvas.syncActiveCwd(cwd);
	canvas.setActiveTab("briefing");
	canvas.setOpen(true);
	await canvas.refreshOverview(cwd, { silent: true });

	if (!input.autoStartAgent) {
		pushExtensionToast(
			"info",
			syncResult
				? `已创建空白世界「${finalTitle}」并同步 ${syncResult.newlyIngested} 条群聊消息`
				: `已创建空白世界「${finalTitle}」`,
			"Wenyou Pro",
		);
		return { cwd, worldTitle: finalTitle, syncResult, syncWarning, agentTriggered: "skipped" };
	}

	const prompt = buildWorldBootstrapPrompt({
		worldTitle: finalTitle,
		bindings: input.bindings,
		syncResult,
		syncWarning,
	});

	if (!hasConfiguredModel()) {
		fillWenyouPrompt(prompt, "briefing");
		pushExtensionToast(
			"warning",
			`已创建世界「${finalTitle}」并填好抓群建档指令；请先在设置中配置可用模型后回车发送`,
			"Wenyou Pro",
		);
		return { cwd, worldTitle: finalTitle, syncResult, syncWarning, agentTriggered: "prefilled" };
	}

	let sessionId: string | null = null;
	let optimisticId: string | null = null;
	try {
		sessionId = await useSessionsStore.getState().createSession();
		if (!sessionId) {
			fillWenyouPrompt(prompt, "briefing");
			pushExtensionToast(
				"warning",
				`已创建世界「${finalTitle}」，未能自动建会话；抓群建档指令已填入输入框，直接回车即可开始`,
				"Wenyou Pro",
			);
			return { cwd, worldTitle: finalTitle, syncResult, syncWarning, agentTriggered: "prefilled" };
		}
		useTranscriptStore.getState().markAgentActive(sessionId, true);
		optimisticId = useTranscriptStore.getState().appendOptimisticUser(sessionId, {
			text: prompt,
			images: [],
		});
		await getExecutionApi(sessionId).prompt({ sessionId, text: prompt });
		pushExtensionToast(
			"info",
			syncResult
				? `已创建「${finalTitle}」（同步 ${syncResult.newlyIngested} 条消息），Agent 已开始抓取建档`
				: `已创建「${finalTitle}」，Agent 已开始抓取建档`,
			"Wenyou Pro",
		);
		return { cwd, worldTitle: finalTitle, syncResult, syncWarning, agentTriggered: "sent" };
	} catch (error) {
		if (sessionId) {
			if (optimisticId) useTranscriptStore.getState().removeOptimisticUser(sessionId, optimisticId);
			useTranscriptStore.getState().markAgentActive(sessionId, false);
		}
		fillWenyouPrompt(prompt, "briefing");
		const message = error instanceof Error ? error.message : String(error);
		pushExtensionToast(
			"warning",
			`世界「${finalTitle}」已创建，自动发送建档指令失败（${message}）；已填入输入框，可随时重试发送`,
			"Wenyou Pro",
		);
		return { cwd, worldTitle: finalTitle, syncResult, syncWarning, agentTriggered: "prefilled" };
	}
}
