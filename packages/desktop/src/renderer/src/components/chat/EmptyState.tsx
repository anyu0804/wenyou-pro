import type { WenyouCanvasTab } from "@percho/shared";
import { useEffect } from "react";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { isDailyCwd } from "../../lib/daily";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { fillWenyouPrompt, useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { Composer } from "../composer/Composer";
import { ProjectBranchPicker } from "../session/ProjectBranchPicker";

interface QuickPromptCard {
	id: string;
	tag: string;
	title: string;
	desc: string;
	tab: WenyouCanvasTab;
	prompt: string;
}

const WENYOU_QUICK_CARDS: QuickPromptCard[] = [
	{
		id: "briefing",
		tag: "局势书",
		title: "拉取各群新消息出局势书",
		desc: "增量扫描 00-群聊收集/，按【进度/外交局势/情报核查】落盘并推游标防重报",
		tab: "briefing",
		prompt:
			"请先调用 wenyou_pull_qq 拉取 00-群聊收集/ 各群最新增量消息，结合 wenyou_read_memory 读取三层记忆与国力实册，整理并调用 wenyou_publish_briefing 发布本轮三段式局势书（【进度】【外交局势】【情报核查】与战略判断），关键论断均附 [sourceId] 便于我点击回查原文。",
	},
	{
		id: "policy",
		tag: "国策 .docx",
		title: "按实册与局势写本轮国策",
		desc: "严格核对国力底账，过零表格/零套话静态门禁并输出宋体 Word (.docx)",
		tab: "policy-desk",
		prompt:
			"请调用 wenyou_read_memory 读取最新局势书与 01-设定与国力实册/ 的真实国力底账，为我起草本轮国策并通过 wenyou_write_policy_docx 过门禁生成规范宋体 Word (.docx) 文书。全文采用编号自然段叙事，严禁 Markdown 表格、多层嵌套清单和空泛 AI 套话。",
	},
	{
		id: "intel",
		tag: "情报核查",
		title: "核查群内传闻辨明真伪",
		desc: "回溯前后 10 条群聊原文，拆解 GM 裁定事实、单方宣传口径与小群未定案草案",
		tab: "briefing",
		prompt:
			"请检索近期群聊记录并调用 wenyou_lookup_source 回查关键发言的前后 10 条原始上下文，帮我逐条核查群内传闻与各方宣称，明确区分：1）GM 裁定事实、2）单方外交宣传口径、3）小群未定案草案、4）玩家 OOC，并给出可点击的 [sourceId] 证据链。",
	},
	{
		id: "maps",
		tag: "舆图比对",
		title: "双屏比对两期战略态势图",
		desc: "在右侧画布展开 05-沙盘与图集/ 双屏同步缩放视图，研判疆域与前线演变",
		tab: "atlas-compare",
		prompt:
			"请扫描 05-沙盘与图集/ 中的战略态势图，调用 wenyou_open_maps 以左右双屏同步比对模式打开最近两期地图，并结合最新局势书与编年史为我研判两回合之间的疆域、交通要道与前线兵力态势变化。",
	},
];

/** 空态：居中 Wenyou Pro 品牌标语、输入框、项目/分支选择，以及空世界引导或 4 张文游快捷指令卡 */
export function EmptyState() {
	const t = useT();
	const load = useProjectsStore((s) => s.load);
	const activeCwd = useSessionsStore(selectActiveCwd);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const setCreateWorldDialogOpen = useWenyouCanvasStore((s) => s.setCreateWorldDialogOpen);

	useEffect(() => {
		void load();
	}, [load]);

	const hasInitializedWorld = Boolean(activeCwd) && !isDailyCwd(activeCwd) && overview?.initialized === true;

	return (
		<div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-8 py-8 pb-[6vh]">
			<div className="flex min-h-16 w-full max-w-[760px] flex-col items-center justify-center gap-1.5 min-[721px]:mb-1 min-[721px]:min-h-20">
				<h1 className="text-center text-ui-28 min-[721px]:text-ui-32 font-normal leading-[1.35] tracking-[-0.015em] text-ink">
					<span className="mr-3 inline-block text-ui-36 min-[721px]:text-ui-40 font-medium text-ink-faint">
						Wenyou Pro
					</span>{" "}
					{t("emptyState.slogan")}
				</h1>
			</div>
			<Composer centered />
			<ProjectBranchPicker />

			{hasInitializedWorld ? (
				/* 已进入文游世界：4 张常用快捷指令卡 */
				<div className="grid w-full max-w-[760px] grid-cols-1 gap-2.5 pt-1 min-[640px]:grid-cols-2">
					{WENYOU_QUICK_CARDS.map((card) => (
						<button
							key={card.id}
							type="button"
							onClick={() => fillWenyouPrompt(card.prompt, card.tab)}
							className="group flex flex-col items-start rounded-xl border border-border bg-surface/80 px-3.5 py-3 text-left transition-colors hover:border-border-strong hover:bg-hover/70"
						>
							<div className="flex w-full items-center justify-between gap-2">
								<span className="text-ui-13 font-medium text-ink">{card.title}</span>
								<span className="shrink-0 rounded-full border border-border bg-canvas px-2 py-0.5 text-ui-10 text-ink-dim transition-colors group-hover:border-accent/40 group-hover:text-accent">
									{card.tag}
								</span>
							</div>
							<p className="mt-1 line-clamp-2 text-ui-12 leading-relaxed text-ink-dim">
								{card.desc}
							</p>
						</button>
					))}
				</div>
			) : (
				/* 世界留空态：直接引导新建空白世界并绑群让 Agent 抓取建档 */
				<div className="flex w-full max-w-[680px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/85 px-4 py-3.5">
					<div className="min-w-0 flex-1">
						<p className="text-ui-13 font-medium text-ink">从空白世界开始</p>
						<p className="mt-0.5 text-ui-12 text-ink-dim">
							不预设剧情模板。指定主要 QQ 群后，由 Agent 直接抓取群聊梳理世界观与首轮局势。
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<button
							type="button"
							onClick={() => void pickDirectory()}
							className="rounded-lg border border-border bg-canvas px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
						>
							打开已有目录
						</button>
						<button
							type="button"
							onClick={() => setCreateWorldDialogOpen(true)}
							className="rounded-lg bg-ink px-3.5 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90"
						>
							新建空白世界
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
