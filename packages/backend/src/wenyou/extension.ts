import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { INTEL_RELIABILITIES, type WenyouCanvasEvent } from "@percho/shared";
import { Type } from "typebox";
import type { WenyouService } from "./service";

export interface WenyouExtensionOptions {
	service: WenyouService;
	cwd: string;
}

const initCampaignParams = Type.Object({
	worldTitle: Type.Optional(Type.String({ description: "战役/世界标题，例如「沧澜纪元」" })),
	currentEra: Type.Optional(Type.String({ description: "当前年代或轮次，例如「景平六年春」" })),
});

const pullQqParams = Type.Object({
	groupId: Type.Optional(Type.String({ description: "可选：仅拉取指定群 ID；留空则扫描 00-群聊收集/ 下全部群" })),
	maxMessages: Type.Optional(
		Type.Number({ minimum: 1, maximum: 200, description: "返回给模型的未汇报消息上限（默认 80）" }),
	),
});

const lookupSourceParams = Type.Object({
	sourceId: Type.Optional(Type.String({ description: "精确消息 sourceId，返回同群前后 N 条完整上下文" })),
	window: Type.Optional(Type.Number({ minimum: 0, maximum: 30, description: "上下文前后条数，默认 10" })),
	keyword: Type.Optional(Type.String({ description: "按关键词检索 L0 群聊证据" })),
	sender: Type.Optional(Type.String({ description: "按发言人筛选 L0 群聊证据" })),
	groupId: Type.Optional(Type.String({ description: "按群 ID 限定检索范围" })),
	focusInCanvas: Type.Optional(Type.Boolean({ description: "是否同步在右侧画布弹出该 sourceId 原文抽屉" })),
});

const readMemoryParams = Type.Object({
	includeSettings: Type.Optional(Type.Boolean({ description: "是否一并读取 01-设定与国力实册 摘要（默认 true）" })),
	maxBriefings: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "读取最近几份局势书（默认 2）" })),
});

const publishBriefingParams = Type.Object({
	title: Type.String({ minLength: 1, description: "局势简报标题，如「景平六年春河朔局势简报」" }),
	turnLabel: Type.String({ minLength: 1, description: "轮次或年代标签，如「景平六年春」" }),
	headline: Type.String({ minLength: 1, maxLength: 160, description: "<=120字核心结论，先说结论再列细节" }),
	progressItems: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1 }),
			detail: Type.String({ minLength: 1 }),
			status: Type.Union([
				Type.Literal("settled"),
				Type.Literal("in_progress"),
				Type.Literal("pending_roll"),
				Type.Literal("blocked"),
			]),
			sourceRefs: Type.Array(Type.String()),
		}),
		{ description: "【进度】已落地裁定、进行中事项与待骰事项" },
	),
	diplomacySummary: Type.String({ minLength: 1, description: "【外交局势】各方阵营博弈、照会与条约动向" }),
	intelChecks: Type.Array(
		Type.Object({
			claim: Type.String({ minLength: 1 }),
			reliability: Type.Union(INTEL_RELIABILITIES.map((r) => Type.Literal(r))),
			verdict: Type.String({ minLength: 1 }),
			sourceRefs: Type.Array(Type.String()),
		}),
		{ description: "【情报核查】逐条区分 gm_fact / propaganda / unconfirmed_draft / player_ooc" },
	),
	strategicJudgment: Type.String({ minLength: 1, description: "战略判断与下一步行动建议" }),
	coveredSourceIds: Type.Optional(
		Type.Array(Type.String(), { description: "本次简报覆盖的消息 sourceId；留空则自动推进全部已入库未报消息游标" }),
	),
	ledgerUpdates: Type.Optional(
		Type.Array(
			Type.Object({
				category: Type.Union([
					Type.Literal("fact"),
					Type.Literal("treaty"),
					Type.Literal("military"),
					Type.Literal("economy"),
					Type.Literal("unconfirmed_draft"),
				]),
				faction: Type.Optional(Type.String()),
				summary: Type.String({ minLength: 1 }),
				sourceRefs: Type.Optional(Type.Array(Type.String())),
			}),
			{ description: "同步追加至 L1 滚动台账的条目；未定案内阁讨论必须用 unconfirmed_draft 隔离" },
		),
	),
});

const writePolicyDocxParams = Type.Object({
	title: Type.String({ minLength: 1, description: "国策或文书标题，如「景平六年春北周整军理财疏」" }),
	content: Type.String({
		minLength: 20,
		description: "纯手写体自然段国策正文：严禁 Markdown 表格、严禁多层嵌套清单、严禁 AI 公文套话",
	}),
	actor: Type.Optional(Type.String({ description: "上疏/执行阵营或国家名" })),
	turnLabel: Type.Optional(Type.String({ description: "所属轮次/年代" })),
	serialNo: Type.Optional(Type.String({ description: "可选编号（如 002），留空自动递增" })),
});

const openMapsParams = Type.Object({
	mode: Type.Union([
		Type.Literal("single"),
		Type.Literal("side-by-side"),
		Type.Literal("slider"),
		Type.Literal("pixi-sandbox"),
	]),
	leftMap: Type.Optional(Type.String({ description: "左侧/主地图相对路径或文件名关键词" })),
	rightMap: Type.Optional(Type.String({ description: "右侧对比地图相对路径或文件名关键词（双图比对用）" })),
	pixiUrl: Type.Optional(Type.String({ description: "可选外部 wenyou-pixi-app 沙盘地址" })),
});

const proposeCanonParams = Type.Object({
	targetPath: Type.String({
		minLength: 4,
		description: "目标正史路径（仅限 01-设定与国力实册/、04-编年史与条约/、chronicle/ 或 wiki/ 下的 .md）",
	}),
	summary: Type.String({ minLength: 1, description: "本次正史变更摘要" }),
	afterContent: Type.String({ minLength: 1, description: "提案修改后的完整 Markdown 正文（含 frontmatter）" }),
	sourceRefs: Type.Optional(Type.Array(Type.String(), { description: "支撑该变更的群聊 sourceId 证据列表" })),
	warnings: Type.Optional(Type.Array(Type.String(), { description: "需主持人工核对的风险提示" })),
});

/**
 * Wenyou Pro 核心内联扩展：
 * - 注册 8 个文游专职工具（采集/回查/记忆/局势书/国策.docx门禁/双屏地图/正史提案）
 * - 在文游工作区内通过 context_with_system 动态注入精简战役态势头
 */
export function makeWenyouExtension(options: WenyouExtensionOptions): InlineExtension {
	const { service, cwd } = options;

	return {
		name: "wenyou",
		factory: (pi) => {
			let activeSessionId: string | undefined;

			pi.on("session_start", (_event, ctx) => {
				activeSessionId = ctx.sessionManager.getSessionId();
			});

			pi.on("session_shutdown", () => {
				activeSessionId = undefined;
			});

			// 1. wenyou_init_campaign
			pi.registerTool(
				defineTool({
					name: "wenyou_init_campaign",
					label: "初始化文游工作区",
					annotations: { readOnlyHint: false, idempotentHint: true },
					description:
						"在当前项目目录初始化标准 Wenyou Pro 文游战役目录结构（00-群聊收集 至 05-沙盘与图集、private/proposals、.wenyou 及 manifest.json）。",
					promptSnippet: "wenyou_init_campaign({worldTitle?, currentEra?})",
					parameters: initCampaignParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const overview = await service.initCampaign(workDir, {
							worldTitle: params.worldTitle,
							currentEra: params.currentEra,
							sessionId: activeSessionId,
						});
						return {
							content: [
								{
									type: "text",
									text: `已初始化文游工作区「${overview.worldTitle}」（轮次：${overview.currentEra ?? "未定"}），标准目录 00~05 与 private/proposals 已就绪。`,
								},
							],
							details: { wenyouAction: "init_campaign", worldTitle: overview.worldTitle },
						};
					},
				}),
			);

			// 2. wenyou_pull_qq
			pi.registerTool(
				defineTool({
					name: "wenyou_pull_qq",
					label: "增量拉取 QQ 群聊",
					annotations: { readOnlyHint: false, idempotentHint: true },
					description:
						"扫描 00-群聊收集/ 下全部群聊文件（.txt / QCE .json / .jsonl），按指纹幂等去重入库至 L0 evidence.jsonl，并返回尚未进入局势简报的增量消息及各群双游标统计。",
					promptSnippet: "wenyou_pull_qq({groupId?, maxMessages?})",
					parameters: pullQqParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const res = await service.pullQq(workDir, params.groupId, activeSessionId);
						const cap = params.maxMessages ?? 80;
						const slice = res.unreportedMessages.slice(0, cap);
						const cursorLines = res.cursors.map(
							(c) =>
								`- ${c.groupName} (${c.groupId}/${c.role}): 总入库 ${c.totalIngested}，未汇报 ${c.unreportedCount}（已报至 ${c.lastReportedSourceId ?? "无"}）`,
						);
						const msgLines = slice.map(
							(m) => `[${m.sourceId}] (${m.groupName}) ${m.timestamp} ${m.sender} [${m.kind}]: ${m.text}`,
						);
						const summary = [
							`增量采集完成：新入库 ${res.newlyIngested} 条${res.ntqqSyncedCount ? `（其中本机 NTQQ 直读 ${res.ntqqSyncedCount} 条）` : ""}，跳过重复 ${res.skippedDuplicates} 条，总证据 ${res.totalEvidenceCount} 条，待汇报 ${res.unreportedMessages.length} 条。`,
							...(res.ntqqWarning ? [`[本机 NTQQ 提示] ${res.ntqqWarning}`] : []),
							"",
							"各群游标：",
							...(cursorLines.length
								? cursorLines
								: ["（暂无群聊记录，可在右侧「局势书与台账」绑定本机 QQ 群或将聊天记录放入 00-群聊收集/）"]),
							"",
							`未汇报新消息（展示 ${slice.length}/${res.unreportedMessages.length} 条）：`,
							...(msgLines.length ? msgLines : ["（无新增未汇报消息）"]),
						].join("\n");
						return {
							content: [{ type: "text", text: summary }],
							details: {
								wenyouAction: "pull_qq",
								newlyIngested: res.newlyIngested,
								unreportedCount: res.unreportedMessages.length,
							},
						};
					},
				}),
			);

			// 3. wenyou_lookup_source
			pi.registerTool(
				defineTool({
					name: "wenyou_lookup_source",
					label: "回查群聊原文证据",
					annotations: { readOnlyHint: true, openWorldHint: false },
					description:
						"按 sourceId 取出同群前后 N（默认 10）条完整上下文，或按关键词/发言人检索 L0 群聊证据，用于核实敌方宣传、玩家吹水与 GM 正式裁定事实。",
					promptSnippet: "wenyou_lookup_source({sourceId?, window?, keyword?, sender?, groupId?})",
					parameters: lookupSourceParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						if (params.sourceId) {
							const win = await service.lookupSource(workDir, params.sourceId, params.window ?? 10);
							if (!win) {
								return {
									content: [{ type: "text", text: `未在 L0 证据库中找到 sourceId=${params.sourceId}` }],
									details: { wenyouAction: "lookup_source", found: false },
								};
							}
							if (params.focusInCanvas !== false) {
								service.emitCanvas({
									kind: "focus_source",
									cwd: workDir,
									sourceId: params.sourceId,
									sessionId: activeSessionId,
								});
							}
							const lines = win.messages.map((m, idx) => {
								const mark = idx === win.targetIndex ? ">>> " : "    ";
								return `${mark}[${m.sourceId}] ${m.timestamp} ${m.sender} (${m.kind}): ${m.text}`;
							});
							return {
								content: [
									{
										type: "text",
										text: `群「${win.groupName}」(${win.groupId}) 上下文（目标 ${win.targetSourceId}，共 ${win.messages.length} 条）：\n${lines.join("\n")}`,
									},
								],
								details: { wenyouAction: "lookup_source", sourceId: params.sourceId, count: win.messages.length },
							};
						}
						const found = await service.searchSources(workDir, {
							keyword: params.keyword,
							sender: params.sender,
							groupId: params.groupId,
							limit: 25,
						});
						const lines = found.map(
							(m) => `[${m.sourceId}] (${m.groupName}) ${m.timestamp} ${m.sender}: ${m.text}`,
						);
						return {
							content: [
								{
									type: "text",
									text:
										lines.length > 0
											? `命中 ${lines.length} 条群聊证据：\n${lines.join("\n")}`
											: "未命中匹配的群聊证据。",
								},
							],
							details: { wenyouAction: "lookup_source", count: found.length },
						};
					},
				}),
			);

			// 4. wenyou_read_memory
			pi.registerTool(
				defineTool({
					name: "wenyou_read_memory",
					label: "读取文游三层记忆",
					annotations: { readOnlyHint: true, openWorldHint: false },
					description:
						"读取当前工作区的最新局势简报（L1）、跨群滚动台账（含 [未定案草案] 隔离条目）与 01-设定与国力实册 关键基线文档。",
					promptSnippet: "wenyou_read_memory({includeSettings?, maxBriefings?})",
					parameters: readMemoryParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const overview = await service.getOverview(workDir);
						const maxB = params.maxBriefings ?? 2;
						const recentBriefings = overview.briefings.slice(0, maxB);
						const sections: string[] = [
							`世界：${overview.worldTitle}｜当前轮次：${overview.currentEra ?? "未定"}｜总证据：${overview.totalEvidenceCount}｜未汇报：${overview.unreportedCount}`,
						];

						if (recentBriefings.length > 0) {
							sections.push("\n## 最新局势简报（L1）");
							for (const b of recentBriefings) {
								sections.push(`### ${b.title} (${b.turnLabel}, ${b.id})\n核心结论：${b.headline}\n外交：${b.diplomacySummary}\n判断：${b.strategicJudgment}`);
							}
						}

						if (overview.rollingLedger.length > 0) {
							sections.push("\n## 跨群滚动台账（L1）");
							for (const entry of overview.rollingLedger.slice(-30)) {
								const refs = entry.sourceRefs.length ? ` [${entry.sourceRefs.join(", ")}]` : "";
								sections.push(`- ${entry.tag}${entry.faction ? `(${entry.faction})` : ""} ${entry.summary}${refs}`);
							}
						}

						if (params.includeSettings !== false) {
							const settingDocs = overview.canonDocs.filter((d) => d.kind === "setting").slice(0, 6);
							if (settingDocs.length > 0) {
								sections.push("\n## 01-设定与国力实册基线");
								for (const doc of settingDocs) {
									const abs = join(workDir, doc.relPath);
									if (existsSync(abs)) {
										const text = (await readFile(abs, "utf8")).slice(0, 2000);
										sections.push(`### ${doc.title} (${doc.relPath})\n${text}`);
									}
								}
							}
						}

						return {
							content: [{ type: "text", text: sections.join("\n") }],
							details: {
								wenyouAction: "read_memory",
								briefingCount: recentBriefings.length,
								ledgerCount: overview.rollingLedger.length,
							},
						};
					},
				}),
			);

			// 5. wenyou_publish_briefing
			pi.registerTool(
				defineTool({
					name: "wenyou_publish_briefing",
					label: "发布局势简报并推游标",
					annotations: { readOnlyHint: false },
					description:
						"落盘结构化三段式【进度/外交局势/情报核查】局势书（JSON+Markdown）并追加 L1 滚动台账，推进各群已汇报游标防止重报，同时自动在右侧画布切到「局势书」面板。",
					promptSnippet: "wenyou_publish_briefing({title, turnLabel, headline, progressItems, diplomacySummary, intelChecks, strategicJudgment})",
					parameters: publishBriefingParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const result = await service.publishBriefing({
							cwd: workDir,
							title: params.title,
							turnLabel: params.turnLabel,
							headline: params.headline,
							progressItems: params.progressItems,
							diplomacySummary: params.diplomacySummary,
							intelChecks: params.intelChecks,
							strategicJudgment: params.strategicJudgment,
							coveredSourceIds: params.coveredSourceIds,
							ledgerUpdates: params.ledgerUpdates,
							sessionId: activeSessionId,
						});
						return {
							content: [
								{
									type: "text",
									text: `局势书已落盘：${result.briefing.markdownPath}（编号 ${result.briefing.id}），已推进 ${result.advancedGroups.length} 个群的汇报游标，追加台账 ${result.addedLedgerCount} 条，右侧「局势书」画布已自动打开。`,
								},
							],
							details: {
								wenyouAction: "publish_briefing",
								briefingId: result.briefing.id,
								markdownPath: result.briefing.markdownPath,
							},
						};
					},
				}),
			);

			// 6. wenyou_write_policy_docx
			pi.registerTool(
				defineTool({
					name: "wenyou_write_policy_docx",
					label: "校验并生成国策 DOCX",
					annotations: { readOnlyHint: false },
					description:
						"对国策正文执行确定性静态门禁（拦截 Markdown 表格、多层嵌套清单、AI 套话、跨阵营透题与时间线穿帮）。若未通过则拒绝落盘并返回修改指令，请立即在当前轮重写后重试；通过则同时写入 03-国策与文书/*.md 与规范 .docx 并打开右侧「国策书案」面板。",
					promptSnippet: "wenyou_write_policy_docx({title, content, actor?, turnLabel?, serialNo?})",
					parameters: writePolicyDocxParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const res = await service.writePolicyDocx({
							cwd: workDir,
							title: params.title,
							content: params.content,
							actor: params.actor,
							turnLabel: params.turnLabel,
							serialNo: params.serialNo,
							sessionId: activeSessionId,
						});
						if (!res.ok || !res.artifact) {
							return {
								content: [
									{
										type: "text",
										text: res.error ?? "国策门禁未通过，请修改后重新调用 wenyou_write_policy_docx。",
									},
								],
								details: {
									wenyouAction: "write_policy_docx_rejected",
									lintReport: res.lintReport,
								},
							};
						}
						return {
							content: [
								{
									type: "text",
									text: `国策门禁全部通过！已写出：\n- Markdown：${res.artifact.markdownPath}\n- Word 文书：${res.artifact.docxPath}（宋体五号 10.5pt、首行缩进 2 字符、1.25 倍行距、居中 15pt 标题）\n右侧「国策书案」画布已自动更新。`,
								},
							],
							details: {
								wenyouAction: "write_policy_docx",
								artifactId: res.artifact.id,
								markdownPath: res.artifact.markdownPath,
								docxPath: res.artifact.docxPath,
							},
						};
					},
				}),
			);

			// 7. wenyou_open_maps
			pi.registerTool(
				defineTool({
					name: "wenyou_open_maps",
					label: "打开地图双屏比对/沙盘",
					annotations: { readOnlyHint: true, openWorldHint: false },
					description:
						"检索 05-沙盘与图集/ 或 maps/ 下的战略地图，在右侧动态画布打开单图查看、左右双图同步缩放比对、卷帘比对或切入 wenyou-pixi-app 交互沙盘模式。",
					promptSnippet: "wenyou_open_maps({mode, leftMap?, rightMap?, pixiUrl?})",
					parameters: openMapsParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const maps = await service.listMaps(workDir);
						const matchMap = (query?: string) => {
							if (!query) return undefined;
							const q = query.trim().toLowerCase();
							return maps.find(
								(m) => m.relPath.toLowerCase() === q || m.relPath.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
							);
						};
						const left = matchMap(params.leftMap) ?? maps[0];
						const right = matchMap(params.rightMap) ?? (maps.length > 1 ? maps[maps.length - 1] : maps[0]);

						const event: WenyouCanvasEvent = {
							kind: "open_maps",
							cwd: workDir,
							mode: params.mode,
							...(left ? { leftMapPath: left.relPath } : {}),
							...(right && (params.mode === "side-by-side" || params.mode === "slider")
								? { rightMapPath: right.relPath }
								: {}),
							...(params.pixiUrl ? { pixiUrl: params.pixiUrl } : {}),
							...(activeSessionId ? { sessionId: activeSessionId } : {}),
						};
						service.emitCanvas(event);
						return {
							content: [
								{
									type: "text",
									text:
										params.mode === "pixi-sandbox"
											? `已在右侧画布切入 wenyou-pixi-app 沙盘模式（共检出 ${maps.length} 张静态图集）。`
											: `已在右侧画布打开地图模式「${params.mode}」：左图=${left?.relPath ?? "无"}，右图=${right?.relPath ?? "无"}（共 ${maps.length} 张地图可用）。`,
								},
							],
							details: { wenyouAction: "open_maps", mode: params.mode, mapCount: maps.length },
						};
					},
				}),
			);

			// 8. wenyou_propose_canon
			pi.registerTool(
				defineTool({
					name: "wenyou_propose_canon",
					label: "提交正史变更提案",
					annotations: { readOnlyHint: false },
					description:
						"遵循「模型只有提案权、人类握紧落锤权」原则：将对 01-设定与国力实册/ 或 04-编年史与条约/ 的新增或修改提交为待审提案写入 private/proposals/，并在右侧画布弹出 Diff 审批台等待人类批准。",
					promptSnippet: "wenyou_propose_canon({targetPath, summary, afterContent, sourceRefs?, warnings?})",
					parameters: proposeCanonParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const proposal = await service.proposeCanon({
							cwd: workDir,
							targetPath: params.targetPath,
							summary: params.summary,
							afterContent: params.afterContent,
							sourceRefs: params.sourceRefs,
							warnings: params.warnings,
							sessionId: activeSessionId,
						});
						return {
							content: [
								{
									type: "text",
									text: `正史变更提案已创建：${proposal.proposalId}（目标：${proposal.targetPath}，操作：${proposal.operation}）。已通知右侧画布等待主持批准落盘，当前正史文件未被直接篡改。`,
								},
							],
							details: {
								wenyouAction: "propose_canon",
								proposalId: proposal.proposalId,
								targetPath: proposal.targetPath,
							},
						};
					},
				}),
			);

			// 动态文游态势感知注入（仅当工作区为文游战役目录时生效）
			pi.on("context_with_system", async (event, ctx) => {
				try {
					const workDir = ctx.cwd || cwd;
					if (!(await service.isCampaignWorkspace(workDir))) return;
					const overview = await service.getOverview(workDir);
					const latest = overview.briefings[0];
					const note = [
						`[Wenyou Pro 战役工作区态] 世界：${overview.worldTitle}｜轮次：${overview.currentEra ?? "未定"}｜已入库群聊：${overview.totalEvidenceCount} 条｜待汇报新消息：${overview.unreportedCount} 条｜待审正史提案：${overview.proposals.filter((p) => p.status === "pending").length} 份｜图集：${overview.maps.length} 张。`,
						latest ? `最新局势简报（${latest.id} / ${latest.turnLabel}）：${latest.headline}` : "尚无已发布的局势简报。",
						"纪律：1) 汇报局势前先调 wenyou_pull_qq 与 wenyou_read_memory，严禁混同敌方宣传与 GM 裁定事实，关键论断附 [sourceId]；2) 写国策必须走 wenyou_write_policy_docx 过门禁，禁表格、禁嵌套列表、禁 AI 套话；3) 改写正史/实册须经 wenyou_propose_canon 提提案，不得越权直改。",
					].join("\n");
					return {
						messages: [
							...event.messages,
							{
								role: "custom" as const,
								customType: "wenyou-workspace-status",
								content: note,
								display: false,
								timestamp: Date.now(),
							},
						],
					};
				} catch {
					// 态势注入失败绝不阻断正常对话
				}
			});
		},
	};
}
