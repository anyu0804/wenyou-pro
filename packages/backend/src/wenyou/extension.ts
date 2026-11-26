import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { INTEL_RELIABILITIES, type ViewerScope, type WenyouCanvasEvent } from "@percho/shared";
import { Type } from "typebox";
import {
	assertRealTargetInsideWorkspace,
	canViewerSee,
	isPrivateVaultPath,
	isRawChatPath,
	normalizeVaultPath,
	parseMarkdownWithFrontmatter,
} from "./secret-blocks";
import { resolveMarkdownDocVisibility, type WenyouService } from "./service";

export interface WenyouExtensionOptions {
	service: WenyouService;
	cwd: string;
}

const CANON_WRITE_PROTECTED_PREFIXES = [
	"01-设定与国力实册",
	"04-编年史与条约",
	"chronicle",
	"wiki",
] as const;

const POLICY_WRITE_PROTECTED_PREFIX = "03-国策与文书";
const BRIEFING_RESTRICTED_PREFIX = "02-局势简报与台账";

const NON_GM_READ_BLOCKED_PREFIXES = [
	"private",
	".wenyou",
	"00-群聊收集",
	BRIEFING_RESTRICTED_PREFIX,
] as const;

const BASH_PROTECTED_PATH_TOKENS = [
	"private",
	".wenyou",
	"01-设定与国力实册",
	"03-国策与文书",
	"04-编年史与条约",
	"chronicle",
	"wiki",
	"manifest.json",
] as const;

const BASH_NON_GM_BLOCKED_TOKENS = [
	"private",
	".wenyou",
	"00-群聊收集",
	"02-局势简报与台账",
] as const;

const BASH_WRITE_OP_RE =
	/(?:^|[;&|]\s*|[\s(])(?:rm|rmdir|del|erase|mv|move|cp|copy|touch|truncate|chmod|chown|mkdir|tee|dd|install|patch|ln|mklink|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Clear-Content)\b|\bsed\s+[^\n]*-i\b|\bperl\s+[^\n]*-i\b|\bpython\d?\b[^\n]*-c\b|\bnode\b[^\n]*-e\b|[12&]?>{1,2}\s*\S/i;

const BASH_READ_DOC_OP_RE =
	/(?:^|[;&|]\s*|[\s(])(?:cat|head|tail|less|more|grep|rg|ag|ack|find|ls|dir|type|Get-Content|Select-String|Get-ChildItem|awk|sed|python\d?|node)\b/i;

function matchesDirOrPrefix(normRel: string, prefix: string): boolean {
	const lower = normRel.toLowerCase();
	const p = prefix.toLowerCase();
	return lower === p || lower.startsWith(`${p}/`);
}

function isCanonProtectedRel(normRel: string): boolean {
	const lower = normRel.toLowerCase();
	if (lower === "manifest.json") return true;
	return CANON_WRITE_PROTECTED_PREFIXES.some((p) => matchesDirOrPrefix(normRel, p));
}

function isPolicyProtectedRel(normRel: string): boolean {
	return matchesDirOrPrefix(normRel, POLICY_WRITE_PROTECTED_PREFIX);
}

function isNonGmBlockedDir(normRel: string): boolean {
	if (isPrivateVaultPath(normRel) || isRawChatPath(normRel)) return true;
	return NON_GM_READ_BLOCKED_PREFIXES.some((p) => matchesDirOrPrefix(normRel, p));
}

function isAncestorOfNonGmBlockedDir(normRel: string): boolean {
	if (!normRel) return true;
	const lower = normRel.toLowerCase();
	return NON_GM_READ_BLOCKED_PREFIXES.some((p) => p.toLowerCase().startsWith(`${lower}/`));
}

function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
	const out: string[] = [];
	const pushIfString = (v: unknown) => {
		if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
	};
	if (toolName === "show_image") {
		if (Array.isArray(input.paths)) {
			for (const p of input.paths) pushIfString(p);
		}
		pushIfString(input.path);
		return out;
	}
	pushIfString(input.path);
	pushIfString(input.file_path);
	pushIfString(input.filePath);
	pushIfString(input.target);
	pushIfString(input.dir);
	pushIfString(input.directory);
	return out;
}

async function resolveWorkspaceRelCandidates(
	workDir: string,
	rawPath: string,
): Promise<{ inside: boolean; rels: string[]; absPath: string }> {
	const root = resolve(workDir);
	const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
	const rel = relative(root, absPath);
	const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	if (!inside) {
		return { inside: false, rels: [], absPath };
	}
	const rels = new Set<string>([normalizeVaultPath(rel)]);
	try {
		if (existsSync(absPath)) {
			const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absPath)]);
			const realRel = relative(realRoot, realTarget);
			if (realRel !== ".." && !realRel.startsWith(`..${sep}`) && !isAbsolute(realRel)) {
				rels.add(normalizeVaultPath(realRel));
			}
		} else {
			const checked = await assertRealTargetInsideWorkspace(root, absPath);
			rels.add(checked.realRelPath);
		}
	} catch {
		// 符号链接逃逸等情况保留原始 rel，由外层阻断或 permission-gate 拦截
	}
	return { inside: true, rels: [...rels], absPath };
}

function commandMentionsAnyToken(command: string, tokens: readonly string[]): string | null {
	const lower = command.replace(/\\/g, "/").toLowerCase();
	for (const token of tokens) {
		const t = token.toLowerCase();
		if (lower.includes(t)) return token;
	}
	return null;
}

async function checkNonGmFileReadBlock(
	workDir: string,
	absPath: string,
	normRel: string,
	viewer: ViewerScope,
): Promise<string | null> {
	if (isNonGmBlockedDir(normRel)) {
		return `【非 GM 读隔离】当前视角无权访问受限目录（${normRel}）；请改调 wenyou_read_memory 或 wenyou_lookup_source 受控读取。`;
	}
	const lower = normRel.toLowerCase();
	if (lower.endsWith(".md") && existsSync(absPath)) {
		try {
			const raw = await readFile(absPath, "utf8");
			const { data, body } = parseMarkdownWithFrontmatter(raw);
			const { visibility, visibleToFactions } = resolveMarkdownDocVisibility(normRel, data);
			if (!canViewerSee(visibility, visibleToFactions, viewer)) {
				return `【非 GM 读隔离】文档 ${normRel} 当前视角不可见（visibility=${visibility}），已阻断裸 read。`;
			}
			if (body.includes(":::secret")) {
				return `【暗线块保护】文档 ${normRel} 包含 :::secret 受限暗线块，非 GM 视角禁止裸 read；请改调 wenyou_read_memory 受控裁剪读取。`;
			}
		} catch {
			return `【非 GM 读隔离】无法校验文档 ${normRel} 的权限边界，Fail-Closed 已阻断裸 read。`;
		}
	}
	if (isPolicyProtectedRel(normRel) && lower.endsWith(".docx")) {
		const peerMdRel = `${normRel.slice(0, -5)}.md`;
		const peerMdAbs = join(workDir, peerMdRel);
		if (!existsSync(peerMdAbs)) {
			return `【非 GM 读隔离】无法核实国策文书 ${normRel} 的可见性元数据，已阻断读取。`;
		}
		try {
			const { data } = parseMarkdownWithFrontmatter(await readFile(peerMdAbs, "utf8"));
			const { visibility, visibleToFactions } = resolveMarkdownDocVisibility(peerMdRel, data);
			if (!canViewerSee(visibility, visibleToFactions, viewer)) {
				return `【非 GM 读隔离】国策文书 ${normRel} 当前视角不可见，已阻断读取。`;
			}
		} catch {
			return `【非 GM 读隔离】无法核实国策文书 ${normRel} 的可见性，已阻断读取。`;
		}
	}
	return null;
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
 * - 注册 9 个文游专职工具（采集/回查/记忆/局势书/国策.docx门禁/双屏地图/地图快照核账/正史提案）
 * - 通过 tool_call 钩子实施正史/国策物理写保护与非 GM 视角物理读隔离
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

			// 物理门控：正史/国策写保护（所有视角含 GM）+ 非 GM 读隔离与暗线块保护
			pi.on("tool_call", async (event, ctx) => {
				const workDir = ctx.cwd || cwd;
				if (!(await service.isCampaignWorkspace(workDir))) return;

				const toolName = event.toolName;
				const input = (event.input ?? {}) as Record<string, unknown>;
				const effectiveViewer = await service.getEffectiveViewer(workDir);

				// 1. 内置写工具（edit / write）：所有视角禁止直改正史、manifest.json 与国策目录
				if (toolName === "edit" || toolName === "write") {
					const paths = extractToolPaths(toolName, input);
					for (const rawPath of paths) {
						const { inside, rels } = await resolveWorkspaceRelCandidates(workDir, rawPath);
						if (!inside) continue;
						for (const normRel of rels) {
							if (isCanonProtectedRel(normRel)) {
								return {
									block: true,
									reason: `【正史写保护】禁止使用内置 ${toolName} 直接修改正史档案或 manifest.json（${normRel}）；请改调 wenyou_propose_canon 提交变更提案等待人类审批落盘。`,
								};
							}
							if (isPolicyProtectedRel(normRel)) {
								return {
									block: true,
									reason: `【国策门禁保护】禁止使用内置 ${toolName} 直接写入 ${normRel}；请改调 wenyou_write_policy_docx 经过静态门禁校验并生成规范 .docx。`,
								};
							}
							if (effectiveViewer.kind !== "gm" && isNonGmBlockedDir(normRel)) {
								return {
									block: true,
									reason: `【视角写隔离】非 GM 视角禁止写入受限目录（${normRel}）。`,
								};
							}
						}
					}
					return;
				}

				// 2. bash 命令拦截：写保护（所有视角）+ 读隔离（非 GM Fail-Closed）
				if (toolName === "bash") {
					const command = typeof input.command === "string" ? input.command : "";
					if (!command.trim()) return;
					if (effectiveViewer.kind !== "gm") {
						return {
							block: true,
							reason:
								"【非 GM 物理沙箱】当前非裁判视角在文游战役工作区内禁止执行裸 bash 命令（防止通配符、递归搜索或脚本绕过暗线隔离）；检索情报请调用 wenyou_read_memory、wenyou_lookup_source 或 wenyou_inspect_map。",
						};
					}
					const hitProtected = commandMentionsAnyToken(command, BASH_PROTECTED_PATH_TOKENS);
					const hasGlobWrite = /[*?[]/.test(command) && BASH_WRITE_OP_RE.test(command);
					if ((hitProtected && BASH_WRITE_OP_RE.test(command)) || hasGlobWrite) {
						return {
							block: true,
							reason: `【文游物理门控】禁止通过 bash 对受保护目录/文件（${hitProtected ?? "通配符目标"}）执行写入、重定向或删除操作；改写正史请用 wenyou_propose_canon，写国策请用 wenyou_write_policy_docx。`,
						};
					}
					return;
				}

				// 3. 非 GM 视角内置读/列/看图/搜工具拦截
				if (
					effectiveViewer.kind !== "gm" &&
					(toolName === "read" ||
						toolName === "ls" ||
						toolName === "show_image" ||
						toolName === "grep" ||
						toolName === "find")
				) {
					if (toolName === "grep") {
						return {
							block: true,
							reason:
								"【非 GM 读隔离】当前视角禁止在文游工作区直接调用裸 grep（防穿透 :::secret 暗线块与受限目录）；请改调 wenyou_read_memory 或 wenyou_lookup_source 受控检索。",
						};
					}
					const extracted = extractToolPaths(toolName, input);
					const paths =
						extracted.length === 0 && (toolName === "ls" || toolName === "find") ? ["."] : extracted;
					for (const rawPath of paths) {
						const { inside, rels, absPath } = await resolveWorkspaceRelCandidates(workDir, rawPath);
						if (!inside) continue;
						for (const normRel of rels) {
							if (toolName === "read" || toolName === "show_image") {
								if (!normRel) {
									return {
										block: true,
										reason: `【非 GM 读隔离】当前视角无权直接读取工作区根路径。`,
									};
								}
								const reason = await checkNonGmFileReadBlock(workDir, absPath, normRel, effectiveViewer);
								if (reason) return { block: true, reason };
							} else if (isNonGmBlockedDir(normRel) || isAncestorOfNonGmBlockedDir(normRel)) {
								return {
									block: true,
									reason: `【非 GM 读隔离】当前视角无权使用 ${toolName} 枚举工作区根或受限目录（${normRel || "."}）；请指定允许的子目录或调用 wenyou_read_memory。`,
								};
							}
						}
					}
				}
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
					promptSnippet: "wenyou_pull_qq({groupId?, maxMessages?, historyLimit?, backfill?})",
					parameters: pullQqParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const viewer = await service.getEffectiveViewer(workDir);
						const res = await service.pullQq(workDir, params.groupId, activeSessionId, {
							historyLimit: params.historyLimit,
							backfill: params.backfill,
						});
						const visibleUnreported =
							viewer.kind === "gm"
								? res.unreportedMessages
								: res.unreportedMessages.filter((m) =>
										canViewerSee(m.visibility, m.visibleToFactions, viewer),
									);
						const visibleGroupIds = new Set(visibleUnreported.map((m) => m.groupId));
						const visibleCursors =
							viewer.kind === "gm"
								? res.cursors
								: res.cursors.filter((c) => c.role !== "cabinet" || visibleGroupIds.has(c.groupId));
						const cap = params.maxMessages ?? 80;
						const slice = visibleUnreported.slice(0, cap);
						const cursorLines = visibleCursors.map(
							(c) =>
								`- ${c.groupName} (${c.groupId}/${c.role}): 总入库 ${c.totalIngested}，未汇报 ${c.unreportedCount}（已报至 ${c.lastReportedSourceId ?? "无"}）`,
						);
						const msgLines = slice.map(
							(m) => `[${m.sourceId}] (${m.groupName}) ${m.timestamp} ${m.sender} [${m.kind}]: ${m.text}`,
						);
						const summary = [
							`增量采集完成：新入库 ${res.newlyIngested} 条${res.ntqqSyncedCount ? `（其中本机 NTQQ 直读 ${res.ntqqSyncedCount} 条）` : ""}，跳过重复 ${res.skippedDuplicates} 条，总证据 ${res.totalEvidenceCount} 条，待汇报 ${visibleUnreported.length} 条。`,
							...(res.ntqqWarning ? [`[本机 NTQQ 提示] ${res.ntqqWarning}`] : []),
							"",
							"各群游标：",
							...(cursorLines.length
								? cursorLines
								: ["（暂无群聊记录，可在右侧「局势书与台账」绑定本机 QQ 群或将聊天记录放入 00-群聊收集/）"]),
							"",
							`未汇报新消息（展示 ${slice.length}/${visibleUnreported.length} 条）：`,
							...(msgLines.length ? msgLines : ["（无新增未汇报消息）"]),
						].join("\n");
						return {
							content: [{ type: "text", text: summary }],
							details: {
								wenyouAction: "pull_qq",
								newlyIngested: res.newlyIngested,
								unreportedCount: visibleUnreported.length,
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
						const viewer = await service.getEffectiveViewer(workDir);
						if (params.sourceId) {
							const reqWindow = params.window ?? 30;
							const win = await service.lookupSource(workDir, params.sourceId, reqWindow, viewer);
							if (!win) {
								return {
									content: [{ type: "text", text: `未在 L0 证据库中找到当前视角可见的 sourceId=${params.sourceId}` }],
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
								return `${mark}[${m.sourceId}] ${m.timestamp} ${m.sender} (${m.kind}): ${m.text}`;
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
							viewer,
						});
						const lines = searchRes.records.map(
							(m) => `[${m.sourceId}] (${m.groupName}) ${m.timestamp} ${m.sender}: ${m.text}`,
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
					description:
						"读取当前工作区在当前视角下的最新局势简报（L1）、跨群滚动台账与 01-设定与国力实册 关键基线文档（自动按视角剥离 :::secret 受限暗线）。",
					promptSnippet: "wenyou_read_memory({includeSettings?, maxBriefings?})",
					parameters: readMemoryParams,
					execute: async (_id, params, _sig, _upd, ctx) => {
						const workDir = ctx.cwd || cwd;
						const viewer = await service.getEffectiveViewer(workDir);
						const overview = await service.getOverview(workDir, viewer);
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
									try {
										const safeDoc = await service.readCanonDoc(workDir, doc.relPath, viewer);
										sections.push(`### ${doc.title} (${doc.relPath})\n${safeDoc.content.slice(0, 2000)}`);
									} catch {
										// skip inaccessible doc under current viewer
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
						const viewer = await service.getEffectiveViewer(workDir);
						const res = await service.writePolicyDocx({
							cwd: workDir,
							title: params.title,
							content: params.content,
							actor: params.actor,
							turnLabel: params.turnLabel,
							serialNo: params.serialNo,
							viewer,
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
						"只读解析 05-沙盘与图集/、maps/ 或 assets/maps/ 下的结构化推演工程 JSON（wenyou-project / RLE delta）与 FMG .map 文件，返回真实政权地块、邻国接壤、城邦八方位与海港/首都标识、部队部署兵力及两期跨回合疆域差分，用于审国策核账与写战报防地理错位。",
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

			// 9. wenyou_propose_canon
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
						const viewer = await service.getEffectiveViewer(workDir);
						const proposal = await service.proposeCanon({
							cwd: workDir,
							targetPath: params.targetPath,
							summary: params.summary,
							afterContent: params.afterContent,
							sourceRefs: params.sourceRefs,
							warnings: params.warnings,
							viewer,
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

			// 动态文游态势感知注入（仅当工作区为文游战役目录时生效；严格按当前生效视角裁剪）
			pi.on("context_with_system", async (event, ctx) => {
				try {
					const workDir = ctx.cwd || cwd;
					if (!(await service.isCampaignWorkspace(workDir))) return;
					const viewer = await service.getEffectiveViewer(workDir);
					const [overview, snapshots] = await Promise.all([
						service.getOverview(workDir, viewer),
						service.listMapSnapshots(workDir),
					]);
					const latest = overview.briefings[0];
					const note = [
						`[Wenyou Pro · 司命战役工作区态] 世界：${overview.worldTitle}｜轮次：${overview.currentEra ?? "未定"}｜已入库群聊：${overview.totalEvidenceCount} 条｜待汇报新消息：${overview.unreportedCount} 条｜待审正史提案：${overview.proposals.filter((p) => p.status === "pending").length} 份｜图集：${overview.maps.length} 张｜地图快照：${snapshots.length} 份。`,
						latest ? `最新局势简报（${latest.id} / ${latest.turnLabel}）：${latest.headline}` : "尚无当前视角可见的局势简报。",
						"纪律：1) 汇报局势前先调 wenyou_pull_qq 与 wenyou_read_memory，严禁混同敌方宣传与 GM 裁定事实，关键论断附 [sourceId]；2) 写国策必须走 wenyou_write_policy_docx 过门禁，禁表格、禁嵌套列表、禁 AI 套话；3) 改写正史/实册须经 wenyou_propose_canon 提提案，不得越权直改；4) 审涉海、接壤、行军方位或战报疆域变动前，须先调 wenyou_inspect_map 核对真实城邦坐标、海港与邻国，严禁架空臆造地理。",
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
