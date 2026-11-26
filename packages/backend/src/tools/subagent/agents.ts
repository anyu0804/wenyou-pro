import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel, type PermissionMode, type ThinkingLevel } from "@percho/shared";
import { isDenyPattern } from "./policy";

export type AgentSource = "builtin" | "user" | "project";

export interface SubagentDefinition {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	permissionMode?: PermissionMode;
	deny?: string[];
	denyWarnings?: string[];
	/** frontmatter `thinking`（合法档位才保留；非法值丢弃并由 thinkingWarning 带原文） */
	thinking?: ThinkingLevel;
	/** frontmatter thinking 非法时的原文（设置页警示用；合法/缺失时 undefined） */
	thinkingWarning?: string;
	systemPrompt: string;
	source: AgentSource;
	path?: string;
}

export interface DiscoverAgentsOptions {
	projectTrusted: boolean;
	agentDir?: string;
}

export const DEFAULT_AGENT = "worker";

const BUILTIN_WORKER: SubagentDefinition = {
	name: DEFAULT_AGENT,
	description: "实现开发任务并自主验证，返回结论与改动。",
	tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "webfetch"],
	systemPrompt: "You are worker, a development subagent responsible for implementing the assigned task.",
	source: "builtin",
};

const BUILTIN_WENYOU_AGENTS: readonly SubagentDefinition[] = [
	{
		name: "qq-intel-analyst",
		description: "群聊增量情报分析员：洗水群、长程传话溯源、核实敌方宣传 vs GM 裁定事实并产出三段式局势简报。",
		tools: [
			"wenyou_pull_qq",
			"wenyou_lookup_source",
			"wenyou_read_memory",
			"wenyou_publish_briefing",
			"read",
			"ls",
		],
		thinking: "medium",
		systemPrompt:
			"你是 Wenyou Pro 的群聊情报分析员（qq-intel-analyst）。职责：优先调用 wenyou_pull_qq（支持增量拉取与最高 20,000 条/群 backfill 回溯）、wenyou_read_memory 与 wenyou_lookup_source（追查最初原话用 order='earliest'，核对后续转述用 order='latest' 及前后上下文窗口），严格区分 GM 正式裁定（gm_fact）、阵营外交宣传（propaganda）、内阁未定案草案（unconfirmed_draft）与玩家吹水（player_ooc）；每条关键论断必须给出精确 [sourceId] 证据锚点，禁止脑补未落锤事实。",
		source: "builtin",
	},
	{
		name: "policy-drafter",
		description: "纯手写抓大放小国策参谋：联动实册与沙盘里程核账，严守国策门禁起草并生成规范 .docx 施政方略。",
		tools: [
			"wenyou_read_memory",
			"wenyou_lookup_source",
			"wenyou_inspect_map",
			"wenyou_write_policy_docx",
			"read",
			"ls",
		],
		thinking: "high",
		systemPrompt:
			"你是 Wenyou Pro 的国策参谋（policy-drafter）。职责：动笔前先调 wenyou_read_memory 核实国力实册与 L1 台账，涉及边防行军、海港或邻国博弈时先调 wenyou_inspect_map 核对真实六角接壤邻国与城际公里里程；起草单居中标题 + 平实自然段或一级序号条陈的中文手写体国策（不设章节小标题），写完调用 wenyou_write_policy_docx 闭环过门禁并落盘 .docx。硬红线：严禁 Markdown 表格、严禁多层嵌套清单、严禁「顶层设计/组合拳/赋能/抓手/把规矩立住/攒下班底/抓在自己人手里/大铺摊子/既……又……」等模板套话，严禁超游引用当前视角不可见情报。",
		source: "builtin",
	},
	{
		name: "chronicle-historian",
		description: "正史编纂与旧账审计史官：交叉核对编年史、群聊铁证与沙盘疆域变化，提交待审正史修订提案。",
		tools: [
			"wenyou_read_memory",
			"wenyou_lookup_source",
			"wenyou_inspect_map",
			"wenyou_propose_canon",
			"read",
			"ls",
		],
		thinking: "high",
		systemPrompt:
			"你是 Wenyou Pro 的史官与旧账审计员（chronicle-historian）。职责：调用 wenyou_read_memory、wenyou_lookup_source 与 wenyou_inspect_map 交叉核查时间线穿帮、城邦易手与兵力账目矛盾；严守「模型只有提案权、人类握紧落锤权」，一切对 01-设定与国力实册/ 或 04-编年史与条约/ 的修改必须通过 wenyou_propose_canon 提交带完整 sourceRefs 的待审提案，绝不直接覆写正史。",
		source: "builtin",
	},
	{
		name: "sandbox-cartographer",
		description: "图史沙盘与疆域里程判读员：解析 FMG/图片底图快照、六角接壤邻国、真实公里测距与跨回合领土差分。",
		tools: ["wenyou_inspect_map", "wenyou_open_maps", "wenyou_read_memory", "read", "ls"],
		thinking: "medium",
		systemPrompt:
			"你是 Wenyou Pro 的舆图判读与沙盘助理（sandbox-cartographer）。职责：调用 wenyou_inspect_map（list / inspect / diff）精确读取 FMG 矢量或静态图片底图战区的政权地块、六角网格接壤邻国、城邦八方位与海港/首都标识、去重后的编制兵力及真实公里比例尺里程，并可按需调用 wenyou_open_maps 在右侧动态画布打开双屏比对或内置沙盘，严禁脱离地图快照凭空臆造地理方位与行军距离。",
		source: "builtin",
	},
];

function stripInlineComment(value: string): string {
	let quote: string | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
			quote = quote === char ? undefined : (quote ?? char);
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) return value.slice(0, i).trim();
	}
	return value.trim();
}

function parseScalar(value: string): string {
	const clean = stripInlineComment(value).trim();
	if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
		return clean.slice(1, -1).trim();
	}
	return clean;
}

function parseTools(value: string): string[] {
	const clean = stripInlineComment(value).trim();
	const inner = clean.startsWith("[") && clean.endsWith("]") ? clean.slice(1, -1) : clean;
	return inner
		.split(",")
		.map((item) => parseScalar(item))
		.filter(Boolean);
}

/** 解析官方/community subagent 约定的 markdown + YAML frontmatter。 */
export function parseAgentMarkdown(
	content: string,
	path?: string,
	source: AgentSource = "user",
): SubagentDefinition | null {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return null;

	const metadata = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (match) metadata.set(match[1] ?? "", match[2] ?? "");
	}
	const name = parseScalar(metadata.get("name") ?? "");
	if (!name) return null;
	const description = parseScalar(metadata.get("description") ?? "");
	const tools = parseTools(metadata.get("tools") ?? "read");
	const model = parseScalar(metadata.get("model") ?? "") || undefined;
	const rawMode = parseScalar(metadata.get("permissionMode") ?? "");
	const permissionMode = rawMode === "default" || rawMode === "fullAccess" ? rawMode : undefined;
	const denyLines = lines
		.slice(1, end)
		.join("\n")
		.match(/^deny:.*(?:\n[ \t]+.*)*/m)?.[0];
	const deny: string[] = [];
	const denyWarnings: string[] = [];
	if (denyLines) {
		try {
			const raw = parseFrontmatter(`---\n${denyLines}\n---`).frontmatter.deny;
			for (const pattern of Array.isArray(raw) ? raw : [raw]) {
				if (isDenyPattern(pattern)) deny.push(pattern);
				else denyWarnings.push(String(pattern));
			}
		} catch {
			denyWarnings.push(denyLines);
		}
	}
	// 非法 thinking 不阻断加载：丢弃档位、留原文供设置页提示（spec D3）
	const rawThinking = parseScalar(metadata.get("thinking") ?? "");
	const thinking = isThinkingLevel(rawThinking) ? rawThinking : undefined;
	const thinkingWarning = thinking ? undefined : rawThinking || undefined;
	return {
		name,
		description,
		tools,
		model,
		...(permissionMode ? { permissionMode } : {}),
		...(deny.length ? { deny } : {}),
		...(denyWarnings.length ? { denyWarnings } : {}),
		...(thinking ? { thinking } : {}),
		...(thinkingWarning ? { thinkingWarning } : {}),
		systemPrompt: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
		source,
		path,
	};
}

async function readAgentDirectory(dir: string, source: AgentSource): Promise<SubagentDefinition[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: SubagentDefinition[] = [];
	for (const entry of entries
		.filter((item) => item.isFile() && item.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name);
		try {
			const agent = parseAgentMarkdown(await readFile(path, "utf8"), path, source);
			if (agent) agents.push(agent);
		} catch {
			// A malformed/unreadable optional agent must not prevent the built-in agent from loading.
		}
	}
	return agents;
}

/**
 * 发现 agent：builtin worker → user ~/.percho/agent/agents → trusted project .pi/agents。
 * 后加载的同名定义覆盖前者；projectTrusted=false 时完全不读取 project agents。
 */
export async function discoverAgents(
	cwd: string,
	options: DiscoverAgentsOptions,
): Promise<SubagentDefinition[]> {
	const byName = new Map<string, SubagentDefinition>([
		[BUILTIN_WORKER.name, BUILTIN_WORKER],
		...BUILTIN_WENYOU_AGENTS.map((agent) => [agent.name, agent] as const),
	]);
	const userAgents = await readAgentDirectory(join(options.agentDir ?? getAgentDir(), "agents"), "user");
	for (const agent of userAgents) byName.set(agent.name, agent);
	if (options.projectTrusted) {
		const projectAgents = await readAgentDirectory(join(cwd, ".pi", "agents"), "project");
		for (const agent of projectAgents) byName.set(agent.name, agent);
	}
	return [...byName.values()];
}

export function findAgent(agents: SubagentDefinition[], name: string): SubagentDefinition {
	const agent = agents.find((candidate) => candidate.name === name);
	if (!agent)
		throw new Error(
			`Unknown subagent agent "${name}". Available agents: ${agents.map((a) => a.name).join(", ")}`,
		);
	return agent;
}
