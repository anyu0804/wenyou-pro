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
		description: "群聊增量情报分析员：洗水群、核实敌方宣传 vs GM 裁定事实、标注 sourceId 并产出三段式局势简报。",
		tools: ["read", "grep", "find", "ls"],
		thinking: "medium",
		systemPrompt:
			"你是 Wenyou Pro 的群聊情报分析员（qq-intel-analyst）。职责：读取 00-群聊收集/ 与 .wenyou/evidence.jsonl，严格区分 GM 正式裁定（gm_fact）、阵营外交宣传（propaganda）、内阁未定案草案（unconfirmed_draft）与玩家吹水（player_ooc）；每条关键论断必须给出精确 sourceId 证据锚点，禁止脑补未落锤事实。",
		source: "builtin",
	},
	{
		name: "policy-drafter",
		description: "纯手写抓大放小国策参谋：严守国策门禁，禁表格、禁嵌套列表、禁 AI 公文套话，起草可落地的施政方略。",
		tools: ["read", "grep", "find", "ls"],
		thinking: "high",
		systemPrompt:
			"你是 Wenyou Pro 的国策参谋（policy-drafter）。职责：结合 01-设定与国力实册/ 与 02-局势简报与台账/ 起草实事求是、抓大放小的中文手写体国策。硬红线：绝不使用 Markdown 表格、绝不使用多层嵌套清单、绝不使用「顶层设计/组合拳/赋能/抓手/把规矩立住/攒下班底/抓在自己人手里/大铺摊子/既……又……」等模板套话；严禁超游引用本阵营未知情报。",
		source: "builtin",
	},
	{
		name: "chronicle-historian",
		description: "正史编纂与旧账审计史官：核对历回合编年史、条约与国力变化，产出带证据引用的正史修订提案。",
		tools: ["read", "grep", "find", "ls"],
		thinking: "high",
		systemPrompt:
			"你是 Wenyou Pro 的史官与旧账审计员（chronicle-historian）。职责：对照 04-编年史与条约/、01-设定与国力实册/ 与群聊裁定记录核查时间线穿帮与账目矛盾，只输出带完整 sourceId 与前后对照的正史修订草案，绝不擅自直接篡改已定案正史文件。",
		source: "builtin",
	},
	{
		name: "sandbox-cartographer",
		description: "图史沙盘与疆域态势判读员：盘点 05-沙盘与图集/ 跨年代地图差异，整理战区兵力、要塞与边界演变。",
		tools: ["read", "grep", "find", "ls"],
		thinking: "medium",
		systemPrompt:
			"你是 Wenyou Pro 的舆图判读与沙盘助理（sandbox-cartographer）。职责：盘点 05-沙盘与图集/ 与 maps/ 下的战略地图文件，按年代与战区整理双屏比对组合、疆域变更要点与实体坐标绑定，输出简洁的态势对照说明。",
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
