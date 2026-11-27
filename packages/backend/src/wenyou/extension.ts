import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { INTEL_RELIABILITIES, type WenyouCanvasEvent } from "@percho/shared";
import { Type } from "typebox";
import { DEFAULT_PULL_EXPOSURE_LIMIT, type WenyouService } from "./service";

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
		Type.Number({ minimum: 1, maximum: 300, description: "返回给模型的未汇报消息上限（默认 80，最大 300）" }),
	),
	historyLimit: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20_000,
			description: "可选：本机 NTQQ 单群回溯拉取条数上限（1～20000；需要深挖更早传话原话时可指定如 2000～20000）",
		}),
	),
	backfill: Type.Optional(
		Type.Boolean({
			description: "可选：为 true 时忽略本机增量水位，按 historyLimit 向更早历史补抓并按时间线幂等去重入库",
		}),
	),
});

const lookupSourceParams = Type.Object({
	sourceId: Type.Optional(Type.String({ description: "精确消息 sourceId，返回同群前后 N 条完整上下文" })),
	window: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 200,
			description: "上下文前后各回溯条数（默认 30，单次最大 200 即前后共 401 条；可对首尾 sourceId 连续追源覆盖全库 20000 条/群）",
		}),
	),
	keyword: Type.Optional(Type.String({ description: "按关键词检索全库 L0 群聊证据（覆盖全部已入库历史，最高 20000 条/群）" })),
	sender: Type.Optional(Type.String({ description: "按发言人筛选 L0 群聊证据" })),
	groupId: Type.Optional(Type.String({ description: "按群 ID 限定检索范围" })),
	since: Type.Optional(Type.String({ description: "可选起始时间过滤（如 2026-11-20 或 2026-11-20 12:00:00）" })),
	until: Type.Optional(Type.String({ description: "可选截止时间过滤（如 2026-11-26 或 2026-11-26 23:59:59）" })),
	order: Type.Optional(
		Type.Union([Type.Literal("latest"), Type.Literal("earliest")], {
			description: "检索排序：latest=最近命中（默认）；earliest=最早命中（追查传话最初原话与曲解链路时优先用 earliest）",
		}),
	),
	limit: Type.Optional(
		Type.Number({ minimum: 1, maximum: 200, description: "检索模式单次返回条数上限（默认 50，最大 200）" }),
	),
	focusInCanvas: Type.Optional(Type.Boolean({ description: "是否同步在右侧画布弹出该 sourceId 原文抽屉" })),
});

const readMemoryParams = Type.Object({
	includeSettings: Type.Optional(Type.Boolean({ description: "是否一并读取 01-设定与国力实册 摘要（默认 true）" })),
	maxBriefings: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "读取最近几份局势书（默认 2）" })),
});

const publishBriefingParams = Type.Object({
	title: Type.String({ minLength: 1, description: "局势简报标题，如「景平六年春河朔局势简报」" }),
	turnLabel: Type.String({ minLength: 1, description: "轮次或年代标签，如「景平六年春」" }),
	headline: Type.String({ minLength: 1, description: "核心结论，先说结论再列细节" }),
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
		Type.Array(Type.String(), {
			description: "本次简报覆盖的消息 sourceId；留空则仅推进本次已拉取展示窗口（或引用范围）内的游标，绝不吞掉未展示积压",
		}),
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
		description: "国策正文（推荐采用清晰平实的自然段或一级编号条陈，直接落盘为 .md 与规范宋体 .docx）",
	}),
	actor: Type.Optional(Type.String({ description: "上疏/执行阵营或国家名" })),
	turnLabel: Type.Optional(Type.String({ description: "所属轮次/年代" })),
	serialNo: Type.Optional(Type.String({ description: "可选编号（如 002），留空自动递增" })),
	author: Type.Optional(Type.String({ description: "可选：Word 文档元数据作者署名（默认留空）" })),
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

const inspectMapParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("inspect"), Type.Literal("diff")], {
		description:
			"list=列出工作区全部结构化地图快照；inspect=读取政权、邻国、城邦方位/海港与兵力；diff=对比两份快照的领土、易手城邦与兵力变化",
	}),
	target: Type.Optional(
		Type.String({ description: "快照相对路径或文件名关键词（inspect 默认最新快照；diff 作为前一期基准）" }),
	),
	compareTo: Type.Optional(
		Type.String({ description: "仅 diff 使用：后一期快照相对路径或关键词（留空默认最新快照）" }),
	),
	theaterId: Type.Optional(Type.String({ description: "可选：多战区工程中指定战区 mapId 或战区名" })),
	faction: Type.Optional(
		Type.String({ description: "可选：仅 inspect 使用，按政权/城邦/部队关键词过滤以控制输出长度" }),
	),
	maxBurgs: Type.Optional(
		Type.Number({ minimum: 1, maximum: 100, description: "可选：最多返回城邦条数（默认 40）" }),
	),
});

/**
 * Wenyou Pro 核心内联扩展：
 * - 注册 8 个文游专职工具（采集/回查/记忆/局势书/国策.docx生成/双屏地图/地图快照核账/初始化）
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
						"在当前项目目录初始化标准 Wenyou Pro 文游战役目录结构（00-群聊收集 至 05-沙盘与图集、private、.wenyou 及 manifest.json）。",
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
									text: `已初始化文游工作区「${overview.worldTitle}」（轮次：${overview.currentEra ?? "未定"}），标准目录 00~05 与工作区元数据已就绪。`,
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
					promptSnippet: "wenyou_pull_qq({groupId?, maxMessages?, historyLimit?, backfill?})",
					parameters: pullQqParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const res = await service.pullQq(workDir, params.groupId, activeSessionId, {
							historyLimit: params.historyLimit,
							backfill: params.backfill,
						});
						const cap = params.maxMessages ?? DEFAULT_PULL_EXPOSURE_LIMIT;
						const slice = res.unreportedMessages.slice(0, cap);
						service.recordExposedPullWindow(workDir, slice, activeSessionId);
						const cursorLines = res.cursors.map(
							(c) =>
								`- ${c.groupName} (${c.groupId}/${c.role}): 总入库 ${c.totalIngested}，未汇报 ${c.unreportedCount}（已报至 ${c.lastReportedSourceId ?? "无"}）`,
						);
						const msgLines = slice.map((m) =>
							m.timestamp
								? `[${m.sourceId}] (${m.groupName}) ${m.timestamp} ${m.sender}: ${m.text}`
								: `[${m.sourceId}] (${m.groupName}) ${m.sender}: ${m.text}`,
						);
						const remainingHidden = Math.max(0, res.unreportedMessages.length - slice.length);
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
							...(remainingHidden > 0
								? [
										"",
										`提示：尚有 ${remainingHidden} 条未展示消息；发布局势简报时默认仅推进本次已展示窗口内的游标，剩余消息需继续调 wenyou_pull_qq 拉取。`,
									]
								: []),
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
						"按 sourceId 取出同群前后 N（默认 30，最大 200，可连续分段追源覆盖最高 20000 条/群）条完整上下文，或按关键词/发言人/时间段全库检索 L0 群聊证据（支持 earliest 从最早原话还原传话走样链路），用于核实敌方宣传、玩家转述失真与 GM 正式裁定事实。",
					promptSnippet:
						"wenyou_lookup_source({sourceId?, window?, keyword?, sender?, groupId?, since?, until?, order?, limit?})",
					parameters: lookupSourceParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						if (params.sourceId) {
							const reqWindow = params.window ?? 30;
							const win = await service.lookupSource(workDir, params.sourceId, reqWindow);
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
									window: win.windowSize ?? reqWindow,
									sessionId: activeSessionId,
								});
							}
							const lines = win.messages.map((m, idx) => {
								const mark = idx === win.targetIndex ? ">>> " : "    ";
								return m.timestamp
									? `${mark}[${m.sourceId}] ${m.timestamp} ${m.sender}: ${m.text}`
									: `${mark}[${m.sourceId}] ${m.sender}: ${m.text}`;
							});
							const totalInGroup = win.totalGroupMessages ?? win.messages.length;
							const beforeRem = win.beforeRemaining ?? 0;
							const afterRem = win.afterRemaining ?? 0;
							const navHints: string[] = [];
							if (beforeRem > 0 && win.messages[0]) {
								navHints.push(`更早尚有 ${beforeRem} 条（可对首条 ${win.messages[0].sourceId} 继续前溯）`);
							}
							if (afterRem > 0 && win.messages[win.messages.length - 1]) {
								navHints.push(`之后尚有 ${afterRem} 条（可对末条 ${win.messages[win.messages.length - 1]!.sourceId} 继续后查）`);
							}
							const header = `群「${win.groupName}」(${win.groupId}) 上下文（目标 ${win.targetSourceId}，前后 ±${win.windowSize ?? reqWindow}，展示 ${win.messages.length}/${totalInGroup} 条${navHints.length ? `；${navHints.join("，")}` : ""}）：`;
							return {
								content: [
									{
										type: "text",
										text: `${header}\n${lines.join("\n")}`,
									},
								],
								details: {
									wenyouAction: "lookup_source",
									sourceId: params.sourceId,
									count: win.messages.length,
									totalGroupMessages: totalInGroup,
									beforeRemaining: beforeRem,
									afterRemaining: afterRem,
								},
							};
						}
						const searchRes = await service.searchSourcesWithStats(workDir, {
							keyword: params.keyword,
							sender: params.sender,
							groupId: params.groupId,
							since: params.since,
							until: params.until,
							order: params.order ?? "latest",
							limit: params.limit ?? 50,
						});
						const lines = searchRes.records.map((m) =>
							m.timestamp
								? `[${m.sourceId}] (${m.groupName}) ${m.timestamp} ${m.sender}: ${m.text}`
								: `[${m.sourceId}] (${m.groupName}) ${m.sender}: ${m.text}`,
						);
						const orderLabel = searchRes.order === "earliest" ? "最早优先" : "最近优先";
						const overflowHint =
							searchRes.totalMatched > searchRes.records.length
								? `\n提示：全库共命中 ${searchRes.totalMatched} 条，当前仅展示 ${searchRes.records.length} 条；可切换 order="earliest" 或配合 since/until 时间段追查最早原话与后续转述。`
								: "";
						return {
							content: [
								{
									type: "text",
									text:
										lines.length > 0
											? `全库扫描 ${searchRes.totalScanned} 条，共命中 ${searchRes.totalMatched} 条（${orderLabel}展示 ${lines.length} 条）：\n${lines.join("\n")}${overflowHint}`
											: `全库扫描 ${searchRes.totalScanned} 条，未命中匹配的群聊证据。`,
								},
							],
							details: {
								wenyouAction: "lookup_source",
								count: searchRes.records.length,
								totalScanned: searchRes.totalScanned,
								totalMatched: searchRes.totalMatched,
								order: searchRes.order,
							},
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
					description: "读取当前工作区的最新局势简报（L1）、跨群滚动台账与 01-设定与国力实册 关键基线文档。",
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
								sections.push(
									`### ${b.title || b.id} (${b.turnLabel || "未定"}, ${b.id})\n核心结论：${b.headline || ""}\n外交：${b.diplomacySummary || ""}\n判断：${b.strategicJudgment || ""}`,
								);
							}
						}

						if (overview.rollingLedger.length > 0) {
							const shownLedger = overview.rollingLedger.slice(-30);
							const ledgerHeader =
								overview.rollingLedger.length > shownLedger.length
									? `\n## 跨群滚动台账（L1，展示最近 ${shownLedger.length}/${overview.rollingLedger.length} 条）`
									: `\n## 跨群滚动台账（L1，共 ${overview.rollingLedger.length} 条）`;
							sections.push(ledgerHeader);
							for (const entry of shownLedger) {
								const sourceRefs = Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [];
								const refs = sourceRefs.length ? ` [${sourceRefs.join(", ")}]` : "";
								sections.push(`- ${entry.tag || "[fact]"}${entry.faction ? `(${entry.faction})` : ""} ${entry.summary || ""}${refs}`);
							}
						}

						const settingDocsAll = overview.canonDocs.filter((d) => d.kind === "setting");
						const chronicleDocsAll = overview.canonDocs.filter((d) => d.kind !== "setting");
						const MAX_INLINE_SETTINGS = 12;
						const MAX_DOC_CHARS = 2500;

						if (params.includeSettings !== false && settingDocsAll.length > 0) {
							const inlineDocs = settingDocsAll.slice(0, MAX_INLINE_SETTINGS);
							sections.push(
								`\n## 01-设定与国力实册基线（已展开 ${inlineDocs.length}/${settingDocsAll.length} 篇）`,
							);
							for (const doc of inlineDocs) {
								try {
									const safeDoc = await service.readCanonDoc(workDir, doc.relPath);
									const truncated = safeDoc.content.length > MAX_DOC_CHARS;
									const excerpt = truncated
										? `${safeDoc.content.slice(0, MAX_DOC_CHARS)}\n…（已截断，原文共 ${safeDoc.content.length} 字；如需全文请用 read 读取 ${doc.relPath}）`
										: safeDoc.content;
									sections.push(`### ${doc.title} (${doc.relPath})\n${excerpt}`);
								} catch {
									// skip unreadable doc
								}
							}
						}

						if (overview.canonDocs.length > 0) {
							const unexpandedSettings =
								params.includeSettings === false
									? settingDocsAll
									: settingDocsAll.slice(MAX_INLINE_SETTINGS);
							if (unexpandedSettings.length > 0 || chronicleDocsAll.length > 0) {
								sections.push(`\n## 全量设定与编年史档案索引（共 ${overview.canonDocs.length} 篇，按需用 read 精读）`);
								for (const doc of unexpandedSettings) {
									sections.push(`- [未展开实册] ${doc.title} (${doc.relPath})`);
								}
								for (const doc of chronicleDocsAll) {
									sections.push(`- [编年史/条约] ${doc.title} (${doc.relPath})`);
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
						const remainHint =
							result.remainingUnreportedCount > 0
								? `（尚余 ${result.remainingUnreportedCount} 条未汇报消息，请继续调 wenyou_pull_qq 拉取）`
								: "";
						return {
							content: [
								{
									type: "text",
									text: `局势书已落盘：${result.briefing.markdownPath}（编号 ${result.briefing.id}），已推进 ${result.advancedGroups.length} 个群的汇报游标，追加台账 ${result.addedLedgerCount} 条${remainHint}，右侧「局势书」画布已自动打开。`,
								},
							],
							details: {
								wenyouAction: "publish_briefing",
								briefingId: result.briefing.id,
								markdownPath: result.briefing.markdownPath,
								remainingUnreportedCount: result.remainingUnreportedCount,
							},
						};
					},
				}),
			);

			// 6. wenyou_write_policy_docx
			pi.registerTool(
				defineTool({
					name: "wenyou_write_policy_docx",
					label: "生成国策 DOCX",
					annotations: { readOnlyHint: false },
					description:
						"将国策正文写入 03-国策与文书/*.md 并生成规范宋体 .docx 文书，同时刷新右侧「国策书案」面板。",
					promptSnippet: "wenyou_write_policy_docx({title, content, actor?, turnLabel?, serialNo?, author?})",
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
							author: params.author,
							sessionId: activeSessionId,
						});
						if (!res.ok || !res.artifact) {
							return {
								content: [
									{
										type: "text",
										text: res.error ?? "生成国策文书失败。",
									},
								],
								details: {
									wenyouAction: "write_policy_docx_failed",
								},
							};
						}
						return {
							content: [
								{
									type: "text",
									text: `国策文书已写出：\n- Markdown：${res.artifact.markdownPath}\n- Word 文书：${res.artifact.docxPath}（宋体五号 10.5pt、首行缩进 2 字符、1.25 倍行距、居中 15pt 标题）\n右侧「国策书案」画布已自动更新。`,
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
						const [maps, snapshots] = await Promise.all([
							service.listMaps(workDir),
							service.listMapSnapshots(workDir),
						]);
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
						const snapshotHint =
							snapshots.length > 0
								? ` 另检出 ${snapshots.length} 份结构化快照，可调 wenyou_inspect_map 读取政权方位、海港、邻国与跨回合疆域差分。`
								: "";
						return {
							content: [
								{
									type: "text",
									text:
										params.mode === "pixi-sandbox"
											? `已在右侧画布切入 wenyou-pixi-app 沙盘模式（共检出 ${maps.length} 张静态图集）。${snapshotHint}`
											: `已在右侧画布打开地图模式「${params.mode}」：左图=${left?.relPath ?? "无"}，右图=${right?.relPath ?? "无"}（共 ${maps.length} 张地图可用）。${snapshotHint}`,
								},
							],
							details: {
								wenyouAction: "open_maps",
								mode: params.mode,
								mapCount: maps.length,
								snapshotCount: snapshots.length,
							},
						};
					},
				}),
			);

			// 8. wenyou_inspect_map
			pi.registerTool(
				defineTool({
					name: "wenyou_inspect_map",
					label: "核对沙盘地图与疆域差分",
					annotations: { readOnlyHint: true, openWorldHint: false },
					description:
						"只读解析 05-沙盘与图集/、maps/ 或 assets/maps/ 下的结构化推演工程 JSON（wenyou-project）与 FMG .map 文件，返回真实政权地块、邻国接壤、城邦八方位与海港/首都标识、部队部署兵力及两期跨回合疆域差分，用于审国策核账与写战报防地理错位。",
					promptSnippet: "wenyou_inspect_map({action, target?, compareTo?, theaterId?, faction?, maxBurgs?})",
					parameters: inspectMapParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const snapshots = await service.listMapSnapshots(workDir);
						const resolveSnapshotPath = (query?: string): string | undefined => {
							if (!query || !query.trim()) return undefined;
							const q = query.trim().toLowerCase();
							const matched = snapshots.find(
								(s) =>
									s.relPath.toLowerCase() === q ||
									s.relPath.toLowerCase().includes(q) ||
									s.name.toLowerCase().includes(q),
							);
							return matched ? matched.relPath : query.trim();
						};
						const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

						if (params.action === "list") {
							if (snapshots.length === 0) {
								return {
									content: [
										{
											type: "text",
											text: "当前工作区（05-沙盘与图集/、maps/、assets/maps/）尚无结构化地图快照（.json / .map）。",
										},
									],
									details: { wenyouAction: "inspect_map", action: "list", count: 0 },
								};
							}
							const lines = snapshots.map((s) => {
								const theaterDesc = s.theaters
									.map((t) => `${t.name}(${t.mapId}): ${t.stateCount}国/${t.burgCount}城/${t.unitCount}军`)
									.join("；");
								const ver = s.version !== undefined ? ` v${s.version}` : "";
								const year = s.yearLabel ? ` [${s.yearLabel}]` : "";
								return `- ${s.relPath}（${s.format}${ver}${year}）— ${theaterDesc}`;
							});
							return {
								content: [
									{
										type: "text",
										text: `共检出 ${snapshots.length} 份结构化地图快照：\n${lines.join("\n")}`,
									},
								],
								details: { wenyouAction: "inspect_map", action: "list", count: snapshots.length },
							};
						}

						if (params.action === "inspect") {
							const relPath = resolveSnapshotPath(params.target) ?? snapshots[snapshots.length - 1]?.relPath;
							if (!relPath) {
								return {
									content: [{ type: "text", text: "未找到可检视的地图快照，请先在 05-沙盘与图集/ 放入工程 .json 或 .map 文件。" }],
									details: { wenyouAction: "inspect_map", action: "inspect", found: false },
								};
							}
							const res = await service.inspectMap(workDir, relPath, {
								theaterId: params.theaterId,
								factionQuery: params.faction,
								maxBurgs: params.maxBurgs ?? 40,
							});
							const baseLabel = res.baseKind === "image" ? "静态图片底图" : "FMG 矢量";
							const scalePart =
								res.mapWidthKm !== undefined
									? `｜比例尺：全图宽 ${res.mapWidthKm} km`
									: res.kmPerPixel !== undefined
										? `｜比例尺：${res.kmPerPixel} km/px`
										: "";
							const sections: string[] = [
								`快照：${res.relPath}（${res.format}｜${baseLabel}）｜战区：${res.theaterName} (${res.theaterId})｜画幅：${res.width}×${res.height}${scalePart}｜陆地格：${res.totalLandCells}｜战线 ${res.frontlineCount} / 箭头 ${res.arrowCount} / 野战 ${res.fieldBattleCount}`,
							];
							if (res.states.length > 0) {
								sections.push("\n## 政权态势");
								for (const s of res.states) {
									const cap = s.capitalName ? `，首都 ${s.capitalName}` : "";
									const nb = s.neighborStateNames.length > 0 ? s.neighborStateNames.join("、") : "无/未提供邻接表";
									sections.push(
										`- ${s.name} (#${s.stateId})：地块 ${s.cellCount}｜城邦 ${s.burgCount}${cap}｜方位 ${s.sector ?? "未知"}｜兵力 ${s.totalPersonnel}（${s.unitCount}支）｜邻国：${nb}`,
									);
								}
							}
							if (res.burgs.length > 0) {
								sections.push(`\n## 城邦坐标与港口（展示 ${res.burgs.length} 座）`);
								for (const b of res.burgs) {
									const flags = `${b.isCapital ? "[首都]" : ""}${b.isPort ? "[海港]" : ""}`;
									sections.push(
										`- ${b.name}${flags}（${b.stateName}）：方位 ${b.sector}（norm ${b.normX.toFixed(2)}, ${b.normY.toFixed(2)}；坐标 ${b.x}, ${b.y}）｜人口 ${b.population}`,
									);
								}
							}
							if (res.units.length > 0) {
								sections.push(`\n## 兵牌与驻军（共 ${res.units.length} 支）`);
								for (const u of res.units) {
									const meta = [u.side, u.branch, u.echelon, u.status].filter(Boolean).join("/");
									const nearText = u.nearestBurgName
										? u.nearestBurgDistanceKm !== undefined
											? `近城 ${u.nearestBurgName}（约 ${u.nearestBurgDistanceKm} km）`
											: `近城 ${u.nearestBurgName}`
										: "";
									const loc = [u.sector ? `方位 ${u.sector}` : "", nearText].filter(Boolean).join("，");
									sections.push(
										`- ${u.name}${meta ? `（${meta}）` : ""}：兵力 ${u.personnel}${loc ? `｜${loc}` : ""}`,
									);
								}
							}
							if (res.keyDistancesKm && res.keyDistancesKm.length > 0) {
								sections.push("\n## 关键城际直线距离（km）");
								for (const pair of res.keyDistancesKm) {
									sections.push(`- ${pair.from} ↔ ${pair.to}：约 ${pair.distanceKm} km`);
								}
							}
							return {
								content: [{ type: "text", text: sections.join("\n") }],
								details: {
									wenyouAction: "inspect_map",
									action: "inspect",
									relPath: res.relPath,
									baseKind: res.baseKind,
									...(res.mapWidthKm !== undefined ? { mapWidthKm: res.mapWidthKm } : {}),
									theaterId: res.theaterId,
									stateCount: res.states.length,
									burgCount: res.burgs.length,
									unitCount: res.units.length,
								},
							};
						}

						// action === "diff"
						const fromPath =
							resolveSnapshotPath(params.target) ??
							(snapshots.length >= 2 ? snapshots[snapshots.length - 2]!.relPath : undefined);
						const toPath =
							resolveSnapshotPath(params.compareTo) ??
							(snapshots.length >= 2 ? snapshots[snapshots.length - 1]!.relPath : undefined);
						if (!fromPath || !toPath) {
							return {
								content: [{ type: "text", text: "跨回合差分至少需要 2 份结构化地图快照，或显式提供 target 与 compareTo 路径。" }],
								details: { wenyouAction: "inspect_map", action: "diff", found: false },
							};
						}
						const diff = await service.diffMaps(workDir, fromPath, toPath, params.theaterId);
						const lines: string[] = [
							diff.summaryText,
							`对比：${diff.fromRelPath} → ${diff.toRelPath}（战区 ${diff.theaterName} / ${diff.theaterId}）`,
							`变动地块：${diff.changedCellCount} 格｜总兵力：${diff.beforeTotalPersonnel}→${diff.afterTotalPersonnel}（净 ${sign(diff.netTotalPersonnel)}）｜战线变化：${sign(diff.frontlineDelta)}`,
						];
						if (diff.stateDeltas.length > 0) {
							lines.push("\n## 各国领土与兵力变化");
							for (const d of diff.stateDeltas) {
								lines.push(
									`- ${d.stateName} (#${d.stateId})：地块 ${d.beforeCells}→${d.afterCells}（净 ${sign(d.netCells)}，得 +${d.gainedCells} / 失 -${d.lostCells}）｜兵力 ${d.beforePersonnel}→${d.afterPersonnel}（净 ${sign(d.netPersonnel)}）`,
								);
							}
						}
						if (diff.transferredBurgs.length > 0) {
							lines.push("\n## 易手城邦");
							for (const b of diff.transferredBurgs) {
								const flags = `${b.isCapital ? "[首都]" : ""}${b.isPort ? "[海港]" : ""}`;
								lines.push(`- ${b.burgName}${flags}：${b.fromStateName} → ${b.toStateName}（方位：${b.sector}）`);
							}
						}
						if (diff.addedBurgs.length > 0) {
							lines.push(`\n新增城邦：${diff.addedBurgs.join("、")}`);
						}
						if (diff.removedBurgs.length > 0) {
							lines.push(`\n毁弃/移除城邦：${diff.removedBurgs.join("、")}`);
						}
						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: {
								wenyouAction: "inspect_map",
								action: "diff",
								fromRelPath: diff.fromRelPath,
								toRelPath: diff.toRelPath,
								changedCellCount: diff.changedCellCount,
								transferredBurgCount: diff.transferredBurgs.length,
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
					const [overview, snapshots] = await Promise.all([
						service.getOverview(workDir),
						service.listMapSnapshots(workDir),
					]);
					const latest = overview.briefings[0];
					const note = [
						`[Wenyou Pro · 司命战役工作区态] 世界：${overview.worldTitle}｜轮次：${overview.currentEra ?? "未定"}｜已入库群聊：${overview.totalEvidenceCount} 条｜待汇报新消息：${overview.unreportedCount} 条｜设定与编年史档案：${overview.canonDocs.length} 篇｜图集：${overview.maps.length} 张｜地图快照：${snapshots.length} 份。`,
						latest ? `最新局势简报（${latest.id} / ${latest.turnLabel}）：${latest.headline}` : "尚无局势简报。",
						"工作指引：1) 汇报局势前先调 wenyou_pull_qq 与 wenyou_read_memory，区分敌方宣传与 GM 裁定事实，关键论断附 [sourceId]；2) 起草 Word 国策可调 wenyou_write_policy_docx 生成 03-国策与文书/*.md 与规范宋体 .docx；3) 维护世界设定、国力实册与编年史可直接读写 01-设定与国力实册/ 与 04-编年史与条约/ 并注明 [sourceId] 溯源；4) 核查涉海、接壤、行军方位或战报疆域变动前，先调 wenyou_inspect_map 核对真实城邦坐标、海港与邻国。",
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
