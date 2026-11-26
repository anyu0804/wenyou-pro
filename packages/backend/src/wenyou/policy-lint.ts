import type { PolicyLintIssue, PolicyLintReport, ViewerScope, VisibilityLevel } from "@percho/shared";
import { canViewerSee } from "./secret-blocks";

export interface LintVaultEntity {
	id: string;
	title: string;
	aliases?: string[];
	visibility: VisibilityLevel;
	visibleToFactions?: string[];
	firstOrder?: number;
	branch?: string;
}

export interface PolicyLintContext {
	viewer?: ViewerScope;
	actorEntityId?: string;
	branchId?: string;
	currentOrder?: number;
	entities?: readonly LintVaultEntity[];
}

const CLICHE_PATTERNS: readonly { readonly label: string; readonly regex: RegExp }[] = [
	{ label: "把规矩立住", regex: /把规矩立住/ },
	{ label: "攒下班底", regex: /攒下班底/ },
	{ label: "抓在自己人手里", regex: /抓在自己人手里/ },
	{ label: "大铺摊子", regex: /大铺摊子/ },
	{ label: "顶层设计", regex: /顶层设计/ },
	{ label: "组合拳", regex: /组合拳/ },
	{ label: "赋能", regex: /赋能/ },
	{ label: "抓手", regex: /抓手/ },
	{ label: "政论排比尾巴（既……又……）", regex: /既[^。；！？\n]{2,24}又[^。；！？\n]{2,24}[。！？]/ },
];

const TABLE_DIVIDER_RE = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?[ \t]*$/m;
const NESTED_LIST_RE = /^(?: {2,}|\t+)(?:[-*+]|\d+[.)])\s+\S+/m;

function stripCodeFences(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, "\n")
		.replace(/`[^`\n]+`/g, " ");
}

function buildExcerpt(text: string, idx: number, matchLen: number): string {
	const start = Math.max(0, idx - 16);
	const end = Math.min(text.length, idx + matchLen + 16);
	return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * 确定性国策静态门禁（零 LLM 依赖）：
 * 1. 禁止 Markdown 表格
 * 2. 禁止多层嵌套清单（二级及以上缩进列表）
 * 3. 拦截高频 AI 公文套话与政论排比尾巴
 * 4. 跨阵营/裁判暗线透题预警
 * 5. 跨时间线穿帮预警
 */
export function lintPolicyDraft(draftText: string, ctx: PolicyLintContext = {}): PolicyLintReport {
	const cleanText = stripCodeFences(draftText);
	const issues: PolicyLintIssue[] = [];

	// 1. Markdown 表格拦截
	const tableMatch = cleanText.match(TABLE_DIVIDER_RE);
	if (tableMatch && tableMatch.index !== undefined) {
		issues.push({
			code: "FORBIDDEN_MARKDOWN_TABLE",
			severity: "error",
			message: "检测到 Markdown 表格；国策必须采用纯手写自然段叙述，严禁使用表格",
			excerpt: buildExcerpt(cleanText, tableMatch.index, tableMatch[0].length),
		});
	}

	// 2. 多层嵌套清单拦截
	const nestedMatch = cleanText.match(NESTED_LIST_RE);
	if (nestedMatch && nestedMatch.index !== undefined) {
		issues.push({
			code: "NESTED_LIST_VIOLATION",
			severity: "error",
			message: "检测到多层嵌套清单（缩进子列表）；请改为平实分段或最多一级条款叙述",
			excerpt: buildExcerpt(cleanText, nestedMatch.index, nestedMatch[0].length),
		});
	}

	// 3. AI 公文套话拦截
	for (const item of CLICHE_PATTERNS) {
		const match = cleanText.match(item.regex);
		if (match && match.index !== undefined) {
			issues.push({
				code: "CLICHE_PHRASE",
				severity: "error",
				message: `检测到 AI 公文/模板套话「${item.label}」，请改为具体人事、钱粮、军政举措的平实手写口吻`,
				excerpt: buildExcerpt(cleanText, match.index, match[0].length),
			});
		}
	}

	// 4 & 5. 跨阵营透题与时间线穿帮
	const viewer = ctx.viewer ?? { kind: "gm" };
	const seenLeak = new Set<string>();
	for (const entity of ctx.entities ?? []) {
		const terms = [entity.title, ...(entity.aliases ?? [])].filter((t) => t.trim().length >= 2);
		const visible = canViewerSee(entity.visibility, entity.visibleToFactions, viewer);

		if (!visible) {
			for (const term of terms) {
				const idx = cleanText.indexOf(term);
				if (idx !== -1 && !seenLeak.has(entity.id)) {
					seenLeak.add(entity.id);
					issues.push({
						code: "CROSS_FACTION_LEAK",
						severity: "error",
						message: `命中当前视角不可见的受限词条「${entity.title}」，涉嫌跨阵营超游或暗线透题`,
						excerpt: buildExcerpt(cleanText, idx, term.length),
						relatedEntityId: entity.id,
					});
				}
			}
			continue;
		}

		if (
			ctx.branchId !== undefined &&
			ctx.currentOrder !== undefined &&
			entity.branch === ctx.branchId &&
			entity.firstOrder !== undefined &&
			entity.firstOrder > ctx.currentOrder
		) {
			for (const term of terms) {
				const idx = cleanText.indexOf(term);
				if (idx !== -1) {
					issues.push({
						code: "TIMELINE_ANACHRONISM",
						severity: "error",
						message: `引用了支线 ${ctx.branchId} 后续阶段（order=${entity.firstOrder} > ${ctx.currentOrder}）才出现的「${entity.title}」`,
						excerpt: buildExcerpt(cleanText, idx, term.length),
						relatedEntityId: entity.id,
					});
					break;
				}
			}
		}
	}

	const errors = issues.filter((i) => i.severity === "error");
	const passed = errors.length === 0;
	const rewriteInstructions = passed
		? undefined
		: [
				`国策门禁未通过（共 ${errors.length} 项违规），请立刻按以下要求重写正文后重新调用 wenyou_write_policy_docx：`,
				...errors.map((err, i) => `${i + 1}. [${err.code}] ${err.message}（命中片段：「${err.excerpt}」）`),
				"重写要求：删去所有表格、多层嵌套清单和空洞套话，改用“抓大放小、实事求是”的中文手写公文/策论自然段。",
			].join("\n");

	return {
		...(ctx.actorEntityId ? { actorEntityId: ctx.actorEntityId } : {}),
		...(ctx.branchId ? { branchId: ctx.branchId } : {}),
		...(ctx.currentOrder !== undefined ? { currentOrder: ctx.currentOrder } : {}),
		passed,
		issues,
		...(rewriteInstructions ? { rewriteInstructions } : {}),
	};
}
