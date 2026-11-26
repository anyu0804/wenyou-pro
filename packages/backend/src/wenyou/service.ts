import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
	type BriefingIntelCheck,
	type BriefingProgressItem,
	buildWenyouAssetUrl,
	type DiffPatchProposal,
	formatViewerScope,
	type MapAssetItem,
	parseViewerScope,
	type PolicyArtifact,
	type PolicyLintReport,
	type RollingLedgerCategory,
	type RollingLedgerEntry,
	type SituationBriefing,
	type SourceContextWindow,
	type ViewerScope,
	type VisibilityLevel,
	WENYOU_STANDARD_DIRS,
	type WenyouCanonDocSummary,
	type WenyouCanvasEvent,
	type WenyouExportPreflightResult,
	type WenyouPullQqResult,
	type WenyouWorkspaceOverview,
	type WenyouWritePolicyResult,
} from "@percho/shared";
import { buildPolicyDocx } from "./docx-builder";
import { NtqqSyncService, type NtqqSyncServiceOptions } from "./ntqq-sync";
import { type LintVaultEntity, lintPolicyDraft } from "./policy-lint";
import {
	computeUnreportedMessages,
	loadCursors,
	loadEvidenceRecords,
	lookupSourceContext,
	pullQqGroupsIncremental,
	refreshCursorStats,
	saveCursors,
	searchEvidenceRecords,
} from "./qq-ingest";
import {
	assertPathInsideWorkspace,
	canViewerSee,
	isPrivateVaultPath,
	normalizeVaultPath,
	parseMarkdownWithFrontmatter,
	stripRestrictedMarkdownBlocks,
} from "./secret-blocks";

const MAP_IMAGE_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function slugSafe(raw: string): string {
	return (
		raw
			.trim()
			.replace(/[\\/:*?"<>|]+/g, "-")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64) || "untitled"
	);
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, filePath);
}

async function atomicWriteBuffer(filePath: string, content: Buffer): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
	await writeFile(tmp, content);
	await rename(tmp, filePath);
}

async function walkRelativeFiles(root: string, relPrefix = ""): Promise<string[]> {
	const dir = relPrefix ? join(root, relPrefix) : root;
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...(await walkRelativeFiles(root, rel)));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

function parseVisibility(value: unknown): VisibilityLevel {
	if (value === "gm" || value === "public" || value === "faction") return value;
	return "public";
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const list = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
	return list.length ? list : undefined;
}

export interface PublishBriefingInput {
	cwd: string;
	title: string;
	turnLabel: string;
	headline: string;
	progressItems: BriefingProgressItem[];
	diplomacySummary: string;
	intelChecks: BriefingIntelCheck[];
	strategicJudgment: string;
	coveredSourceIds?: string[];
	ledgerUpdates?: Array<{
		category: RollingLedgerCategory;
		faction?: string;
		summary: string;
		sourceRefs?: string[];
	}>;
	sessionId?: string;
}

export interface ProposeCanonInput {
	cwd: string;
	targetPath: string;
	summary: string;
	afterContent: string;
	sourceRefs?: string[];
	warnings?: string[];
	viewer?: ViewerScope;
	sessionId?: string;
}

export class WenyouService {
	readonly ntqq: NtqqSyncService;

	constructor(
		private readonly emitCanvasEvent?: (event: WenyouCanvasEvent) => void,
		ntqqOptions?: NtqqSyncServiceOptions,
	) {
		this.ntqq = new NtqqSyncService(ntqqOptions);
	}

	emitCanvas(event: WenyouCanvasEvent): void {
		this.emitCanvasEvent?.(event);
	}

	async initCampaign(
		cwd: string,
		options?: { worldTitle?: string; currentEra?: string; sessionId?: string },
	): Promise<WenyouWorkspaceOverview> {
		for (const dir of WENYOU_STANDARD_DIRS) {
			await mkdir(join(cwd, dir), { recursive: true });
		}
		await mkdir(join(cwd, "02-局势简报与台账", "briefings"), { recursive: true });

		const manifestPath = join(cwd, "manifest.json");
		const worldTitle = options?.worldTitle?.trim() || basename(cwd) || "新建推演战役";
		const currentEra = options?.currentEra?.trim() || "第一回合";
		if (!existsSync(manifestPath)) {
			const manifest = {
				schemaVersion: 1,
				worldId: slugSafe(worldTitle).toLowerCase(),
				title: worldTitle,
				currentEra,
				updatedAt: new Date().toISOString(),
				branches: [{ id: "main", title: "主线", currentEra }],
				bindings: [],
			};
			await atomicWriteUtf8(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		}

		const ledgerPath = join(cwd, "02-局势简报与台账", "rolling-ledger.json");
		if (!existsSync(ledgerPath)) {
			await atomicWriteUtf8(ledgerPath, `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);
		}

		const cursorsFile = join(cwd, ".wenyou", "cursors.json");
		if (!existsSync(cursorsFile)) {
			await atomicWriteUtf8(cursorsFile, `${JSON.stringify({ version: 1, groups: {} }, null, 2)}\n`);
		}

		this.emitCanvas({
			kind: "workspace_changed",
			cwd,
			reason: "init_campaign",
			...(options?.sessionId ? { sessionId: options.sessionId } : {}),
		});
		return this.getOverview(cwd);
	}

	async readManifest(cwd: string): Promise<{ worldId: string; title: string; currentEra?: string } | null> {
		const file = join(cwd, "manifest.json");
		if (!existsSync(file)) return null;
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as {
				worldId?: string;
				title?: string;
				currentEra?: string;
				branches?: Array<{ currentEra?: string }>;
			};
			return {
				worldId: raw.worldId || slugSafe(basename(cwd)),
				title: raw.title || basename(cwd),
				currentEra: raw.currentEra ?? raw.branches?.[0]?.currentEra,
			};
		} catch {
			return null;
		}
	}

	async isCampaignWorkspace(cwd: string): Promise<boolean> {
		return (
			existsSync(join(cwd, "manifest.json")) ||
			existsSync(join(cwd, ".wenyou")) ||
			existsSync(join(cwd, "00-群聊收集")) ||
			existsSync(join(cwd, "02-局势简报与台账"))
		);
	}

	async pullQq(cwd: string, groupId?: string, sessionId?: string): Promise<WenyouPullQqResult> {
		let ntqqSyncedCount = 0;
		let ntqqWarning: string | undefined;
		try {
			const bindings = await this.ntqq.getCampaignBindings(cwd);
			const hasTargetBinding = groupId
				? bindings.some((b) => b.groupId === groupId.trim())
				: bindings.length > 0;
			if (hasTargetBinding) {
				const { status } = await this.ntqq.getStatus();
				if (status.ready) {
					const syncRes = await this.ntqq.syncCampaign(cwd, { groupId });
					ntqqSyncedCount = syncRes.newlyIngested;
				} else {
					ntqqWarning = `已绑定本机 QQ 群，但 NTQQ 只读环境未就绪：${status.missingReasons.join("；")}`;
				}
			}
		} catch (error) {
			ntqqWarning = error instanceof Error ? error.message : String(error);
		}

		const fileResult = await pullQqGroupsIncremental(cwd, groupId);
		const totalNew = fileResult.newlyIngested + ntqqSyncedCount;
		if (totalNew > 0) {
			this.emitCanvas({
				kind: "workspace_changed",
				cwd,
				reason: ntqqSyncedCount > 0 ? "ntqq_and_qq_pulled" : "qq_pulled",
				...(sessionId ? { sessionId } : {}),
			});
		}
		return {
			...fileResult,
			newlyIngested: totalNew,
			...(ntqqSyncedCount > 0 ? { ntqqSyncedCount } : {}),
			...(ntqqWarning ? { ntqqWarning } : {}),
		};
	}

	async syncNtqqCampaign(
		cwd: string,
		options?: { groupId?: string; limit?: number; force?: boolean; sessionId?: string },
	) {
		const res = await this.ntqq.syncCampaign(cwd, {
			groupId: options?.groupId,
			limit: options?.limit,
			force: options?.force,
		});
		if (res.newlyIngested > 0) {
			this.emitCanvas({
				kind: "workspace_changed",
				cwd,
				reason: "ntqq_synced",
				...(options?.sessionId ? { sessionId: options.sessionId } : {}),
			});
		}
		return res;
	}

	async lookupSource(
		cwd: string,
		sourceId: string,
		windowSize = 10,
		viewerRaw?: string | ViewerScope,
	): Promise<SourceContextWindow | null> {
		const viewer = parseViewerScope(viewerRaw);
		return lookupSourceContext(cwd, sourceId, windowSize, viewer);
	}

	async searchSources(
		cwd: string,
		query: { keyword?: string; sender?: string; groupId?: string; limit?: number; viewer?: string | ViewerScope },
	) {
		return searchEvidenceRecords(cwd, {
			keyword: query.keyword,
			sender: query.sender,
			groupId: query.groupId,
			limit: query.limit,
			viewer: parseViewerScope(query.viewer),
		});
	}

	async listBriefings(cwd: string): Promise<SituationBriefing[]> {
		const dir = join(cwd, "02-局势简报与台账", "briefings");
		if (!existsSync(dir)) return [];
		const entries = await readdir(dir, { withFileTypes: true });
		const briefings: SituationBriefing[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8")) as SituationBriefing;
				if (parsed && typeof parsed.id === "string" && typeof parsed.headline === "string") {
					briefings.push(parsed);
				}
			} catch {
				// ignore malformed briefing json
			}
		}
		return briefings.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
	}

	async loadRollingLedger(cwd: string): Promise<RollingLedgerEntry[]> {
		const file = join(cwd, "02-局势简报与台账", "rolling-ledger.json");
		if (!existsSync(file)) return [];
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as { entries?: RollingLedgerEntry[] } | RollingLedgerEntry[];
			const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
			return list.map((entry) => ({
				...entry,
				tag: entry.category === "unconfirmed_draft" ? "[未定案草案]" : entry.tag || `[${entry.category}]`,
			}));
		} catch {
			return [];
		}
	}

	async saveRollingLedger(cwd: string, entries: RollingLedgerEntry[]): Promise<void> {
		const file = join(cwd, "02-局势简报与台账", "rolling-ledger.json");
		const normalized = entries.map((entry) => ({
			...entry,
			tag: entry.category === "unconfirmed_draft" ? "[未定案草案]" : entry.tag || `[${entry.category}]`,
		}));
		await atomicWriteUtf8(file, `${JSON.stringify({ version: 1, entries: normalized }, null, 2)}\n`);
	}

	private renderBriefingMarkdown(b: SituationBriefing): string {
		const lines: string[] = [
			`# ${b.title}`,
			"",
			`> 轮次：${b.turnLabel}｜生成时间：${b.createdAt}｜编号：${b.id}`,
			"",
			`## 核心结论`,
			"",
			b.headline,
			"",
			`## 【进度】`,
			"",
		];
		for (const item of b.progressItems) {
			const refs = item.sourceRefs.length ? ` ${item.sourceRefs.map((r) => `[${r}]`).join(" ")}` : "";
			lines.push(`- **${item.title}**（${item.status}）：${item.detail}${refs}`);
		}
		lines.push("", `## 【外交局势】`, "", b.diplomacySummary, "", `## 【情报核查】`, "");
		for (const check of b.intelChecks) {
			const refs = check.sourceRefs.length ? ` ${check.sourceRefs.map((r) => `[${r}]`).join(" ")}` : "";
			lines.push(`- [${check.reliability}] **${check.claim}** — ${check.verdict}${refs}`);
		}
		lines.push("", `## 战略判断`, "", b.strategicJudgment, "");
		return lines.join("\n");
	}

	async publishBriefing(input: PublishBriefingInput): Promise<{
		briefing: SituationBriefing;
		advancedGroups: string[];
		addedLedgerCount: number;
	}> {
		const briefingsDir = join(input.cwd, "02-局势简报与台账", "briefings");
		await mkdir(briefingsDir, { recursive: true });
		const existing = await this.listBriefings(input.cwd);
		const seq = String(existing.length + 1).padStart(3, "0");
		const id = `briefing-${seq}`;
		const now = new Date().toISOString();
		const headline = input.headline.trim().slice(0, 120);

		const allEvidence = await loadEvidenceRecords(input.cwd);
		const cursors = refreshCursorStats(allEvidence, await loadCursors(input.cwd));

		// 自动收集所有涉及的 sourceIds，如果未显式给全则覆盖当前各群全部未报记录
		const referenced = new Set<string>(input.coveredSourceIds ?? []);
		for (const item of input.progressItems) for (const r of item.sourceRefs) referenced.add(r);
		for (const chk of input.intelChecks) for (const r of chk.sourceRefs) referenced.add(r);
		const unreported = computeUnreportedMessages(allEvidence, cursors);
		if (referenced.size === 0) {
			for (const msg of unreported) referenced.add(msg.sourceId);
		}

		const slug = slugSafe(input.title);
		const jsonRel = `02-局势简报与台账/briefings/${id}-${slug}.json`;
		const mdRel = `02-局势简报与台账/briefings/${id}-${slug}.md`;

		const briefing: SituationBriefing = {
			id,
			title: input.title.trim(),
			turnLabel: input.turnLabel.trim(),
			createdAt: now,
			headline,
			progressItems: input.progressItems,
			diplomacySummary: input.diplomacySummary.trim(),
			intelChecks: input.intelChecks,
			strategicJudgment: input.strategicJudgment.trim(),
			coveredSourceIds: [...referenced],
			markdownPath: mdRel,
			jsonPath: jsonRel,
		};

		await atomicWriteUtf8(join(input.cwd, jsonRel), `${JSON.stringify(briefing, null, 2)}\n`);
		await atomicWriteUtf8(join(input.cwd, mdRel), this.renderBriefingMarkdown(briefing));

		// 推进各群已汇报游标（仅推进有覆盖或当前存在新消息的群，严格防重报）
		const advancedGroups: string[] = [];
		const byGroup = new Map<string, string[]>();
		for (const rec of allEvidence) {
			const arr = byGroup.get(rec.groupId) ?? [];
			arr.push(rec.sourceId);
			byGroup.set(rec.groupId, arr);
		}
		for (const [gid, cursor] of Object.entries(cursors)) {
			const ids = byGroup.get(gid) ?? [];
			let highestIdx = -1;
			for (let i = 0; i < ids.length; i++) {
				if (referenced.has(ids[i]!)) highestIdx = i;
			}
			// 若本次简报未显式指定 coveredSourceIds，则已将全群当前消息纳入简报
			if (highestIdx === -1 && (!input.coveredSourceIds || input.coveredSourceIds.length === 0) && ids.length > 0) {
				highestIdx = ids.length - 1;
			}
			if (highestIdx >= 0) {
				cursor.lastReportedSourceId = ids[highestIdx]!;
				cursor.lastReportedAt = now;
				cursor.unreportedCount = Math.max(0, ids.length - 1 - highestIdx);
				advancedGroups.push(gid);
			}
		}
		await saveCursors(input.cwd, cursors);

		// 追加 L1 滚动台账，强制标记 [未定案草案]
		let addedLedgerCount = 0;
		if (input.ledgerUpdates && input.ledgerUpdates.length > 0) {
			const ledger = await this.loadRollingLedger(input.cwd);
			for (const upd of input.ledgerUpdates) {
				const tag = upd.category === "unconfirmed_draft" ? "[未定案草案]" : `[${upd.category}]`;
				ledger.push({
					id: `ledger-${randomUUID().slice(0, 8)}`,
					category: upd.category,
					tag,
					...(upd.faction ? { faction: upd.faction } : {}),
					summary:
						upd.category === "unconfirmed_draft" && !upd.summary.includes("[未定案草案]")
							? `[未定案草案] ${upd.summary.trim()}`
							: upd.summary.trim(),
					updatedAt: now,
					sourceRefs: upd.sourceRefs ?? [],
				});
				addedLedgerCount += 1;
			}
			await this.saveRollingLedger(input.cwd, ledger);
		}

		this.emitCanvas({
			kind: "briefing_published",
			cwd: input.cwd,
			briefing,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
		});

		return { briefing, advancedGroups, addedLedgerCount };
	}

	async collectLintEntities(cwd: string): Promise<LintVaultEntity[]> {
		const entities: LintVaultEntity[] = [];
		const dirs = ["01-设定与国力实册", "04-编年史与条约", "wiki", "chronicle"];
		for (const rootDir of dirs) {
			const files = await walkRelativeFiles(cwd, rootDir);
			for (const rel of files) {
				if (!rel.endsWith(".md")) continue;
				try {
					const raw = await readFile(join(cwd, rel), "utf8");
					const { data } = parseMarkdownWithFrontmatter(raw);
					const id = typeof data.id === "string" ? data.id : basename(rel, ".md");
					const title = typeof data.title === "string" ? data.title : basename(rel, ".md");
					entities.push({
						id,
						title,
						aliases: parseStringArray(data.aliases),
						visibility: parseVisibility(data.visibility),
						visibleToFactions: parseStringArray(data.visibleToFactions),
						firstOrder: typeof data.order === "number" ? data.order : undefined,
						branch: typeof data.branch === "string" ? data.branch : undefined,
					});
				} catch {
					// skip unreadable doc
				}
			}
		}
		return entities;
	}

	async lintPolicy(
		cwd: string,
		text: string,
		options?: { viewer?: string | ViewerScope; actorEntityId?: string; branchId?: string; currentOrder?: number },
	): Promise<PolicyLintReport> {
		const entities = await this.collectLintEntities(cwd);
		return lintPolicyDraft(text, {
			viewer: parseViewerScope(options?.viewer),
			actorEntityId: options?.actorEntityId,
			branchId: options?.branchId,
			currentOrder: options?.currentOrder,
			entities,
		});
	}

	async listPolicies(cwd: string): Promise<PolicyArtifact[]> {
		const dir = join(cwd, "03-国策与文书");
		if (!existsSync(dir)) return [];
		const entries = await readdir(dir, { withFileTypes: true });
		const policies: PolicyArtifact[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const mdPath = join(dir, entry.name);
			const relMd = `03-国策与文书/${entry.name}`;
			const stem = basename(entry.name, ".md");
			const docxCandidate = join(dir, `${stem}.docx`);
			const relDocx = existsSync(docxCandidate) ? `03-国策与文书/${stem}.docx` : undefined;
			const raw = await readFile(mdPath, "utf8");
			const fileStat = await stat(mdPath);
			const { data, body } = parseMarkdownWithFrontmatter(raw);
			const serialMatch = stem.match(/^(\d{2,4})[-_]/);
			const serialNo =
				typeof data.serialNo === "string"
					? data.serialNo
					: serialMatch?.[1] ?? String(policies.length + 1).padStart(3, "0");
			const headingMatch = body.match(/^#\s+(.+)$/m);
			const title =
				typeof data.title === "string"
					? data.title
					: headingMatch?.[1]?.trim() || stem.replace(/^\d{2,4}[-_]/, "");
			const lintReport = await this.lintPolicy(cwd, body, { viewer: { kind: "gm" } });
			const excerpt = body
				.replace(/^#.*$/gm, "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 140);
			policies.push({
				id: typeof data.id === "string" ? data.id : stem,
				serialNo,
				title,
				...(typeof data.actor === "string" ? { actor: data.actor } : {}),
				...(typeof data.turnLabel === "string" ? { turnLabel: data.turnLabel } : {}),
				createdAt:
					typeof data.createdAt === "string" ? data.createdAt : new Date(fileStat.mtimeMs).toISOString(),
				markdownPath: relMd,
				...(relDocx ? { docxPath: relDocx } : {}),
				excerpt,
				content: body.trim(),
				lintReport,
			});
		}
		return policies.sort((a, b) => b.serialNo.localeCompare(a.serialNo) || b.createdAt.localeCompare(a.createdAt));
	}

	async writePolicyDocx(input: {
		cwd: string;
		title: string;
		content: string;
		actor?: string;
		turnLabel?: string;
		serialNo?: string;
		viewer?: string | ViewerScope;
		force?: boolean;
		sessionId?: string;
	}): Promise<WenyouWritePolicyResult> {
		const lintReport = await this.lintPolicy(input.cwd, input.content, {
			viewer: input.viewer ?? { kind: "gm" },
		});
		if (!lintReport.passed && !input.force) {
			return {
				ok: false,
				lintReport,
				error: lintReport.rewriteInstructions ?? "国策门禁未通过，请重写后再提交。",
			};
		}

		const dir = join(input.cwd, "03-国策与文书");
		await mkdir(dir, { recursive: true });
		const existing = await this.listPolicies(input.cwd);
		const nextNum =
			existing.reduce((max, p) => {
				const n = Number.parseInt(p.serialNo, 10);
				return Number.isFinite(n) ? Math.max(max, n) : max;
			}, 0) + 1;
		const serialNo = input.serialNo?.trim() || String(nextNum).padStart(3, "0");
		const stem = `${serialNo}-${slugSafe(input.title)}`;
		const mdRel = `03-国策与文书/${stem}.md`;
		const docxRel = `03-国策与文书/${stem}.docx`;
		const createdAt = new Date().toISOString();

		const fmLines = [
			"---",
			`id: ${stem}`,
			`serialNo: "${serialNo}"`,
			`title: ${JSON.stringify(input.title.trim())}`,
			...(input.actor ? [`actor: ${JSON.stringify(input.actor.trim())}`] : []),
			...(input.turnLabel ? [`turnLabel: ${JSON.stringify(input.turnLabel.trim())}`] : []),
			`createdAt: ${JSON.stringify(createdAt)}`,
			"---",
		];
		const cleanBody = input.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
		await atomicWriteUtf8(join(input.cwd, mdRel), `${fmLines.join("\n")}\n\n${cleanBody}\n`);

		const subtitleParts = [input.actor?.trim(), input.turnLabel?.trim()].filter(Boolean);
		const docxBuf = buildPolicyDocx({
			title: input.title.trim(),
			bodyMarkdown: cleanBody,
			subtitle: subtitleParts.length ? subtitleParts.join(" · ") : undefined,
			createdAt,
		});
		await atomicWriteBuffer(join(input.cwd, docxRel), docxBuf);

		const artifact: PolicyArtifact = {
			id: stem,
			serialNo,
			title: input.title.trim(),
			...(input.actor ? { actor: input.actor.trim() } : {}),
			...(input.turnLabel ? { turnLabel: input.turnLabel.trim() } : {}),
			createdAt,
			markdownPath: mdRel,
			docxPath: docxRel,
			excerpt: cleanBody.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 140),
			content: cleanBody,
			lintReport,
		};

		this.emitCanvas({
			kind: "policy_written",
			cwd: input.cwd,
			policy: artifact,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
		});

		return { ok: true, lintReport, artifact };
	}

	async listMaps(cwd: string): Promise<MapAssetItem[]> {
		const searchRoots = ["05-沙盘与图集", "maps", "assets/maps"];
		const items: MapAssetItem[] = [];
		const seen = new Set<string>();
		for (const root of searchRoots) {
			const files = await walkRelativeFiles(cwd, root);
			for (const rel of files) {
				const ext = extname(rel).toLowerCase();
				if (!MAP_IMAGE_EXTS.has(ext) || seen.has(rel)) continue;
				seen.add(rel);
				const abs = join(cwd, rel);
				const info = await stat(abs);
				const name = basename(rel, ext);
				const yearMatch = name.match(/(?:^|[-_\s])([^\-_]*?(?:年|春|夏|秋|冬|纪|回合|T\d+)[^\-_]*)/);
				items.push({
					id: rel,
					name,
					relPath: rel,
					assetUrl: buildWenyouAssetUrl(cwd, rel),
					ext,
					...(yearMatch?.[1] ? { yearLabel: yearMatch[1].trim() } : {}),
					sizeBytes: info.size,
					modifiedAt: info.mtimeMs,
				});
			}
		}
		return items.sort((a, b) => a.relPath.localeCompare(b.relPath));
	}

	async listCanonDocs(cwd: string, viewerRaw?: string | ViewerScope): Promise<WenyouCanonDocSummary[]> {
		const viewer = parseViewerScope(viewerRaw);
		const roots: Array<{ dir: string; kind: "setting" | "chronicle" | "wiki" }> = [
			{ dir: "01-设定与国力实册", kind: "setting" },
			{ dir: "04-编年史与条约", kind: "chronicle" },
			{ dir: "chronicle", kind: "chronicle" },
			{ dir: "wiki", kind: "wiki" },
		];
		const docs: WenyouCanonDocSummary[] = [];
		for (const { dir, kind } of roots) {
			const files = await walkRelativeFiles(cwd, dir);
			for (const rel of files) {
				if (!rel.endsWith(".md")) continue;
				const raw = await readFile(join(cwd, rel), "utf8");
				const { data, body } = parseMarkdownWithFrontmatter(raw);
				const visibility = parseVisibility(data.visibility);
				const visibleToFactions = parseStringArray(data.visibleToFactions);
				if (!canViewerSee(visibility, visibleToFactions, viewer)) continue;
				const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
				docs.push({
					relPath: rel,
					title: typeof data.title === "string" ? data.title : heading || basename(rel, ".md"),
					kind,
					visibility,
					...(visibleToFactions ? { visibleToFactions } : {}),
					...(typeof data.turn === "number" ? { turn: data.turn } : {}),
					...(typeof data.era === "string" ? { era: data.era } : {}),
				});
			}
		}
		return docs;
	}

	async readCanonDoc(
		cwd: string,
		relPath: string,
		viewerRaw?: string | ViewerScope,
	): Promise<{ relPath: string; content: string; strippedSecretBlocks: number }> {
		const viewer = parseViewerScope(viewerRaw);
		const normalized = normalizeVaultPath(relPath);
		if (viewer.kind !== "gm" && isPrivateVaultPath(normalized)) {
			throw new Error("当前视角无权访问 private/ 受限目录");
		}
		const abs = assertPathInsideWorkspace(cwd, normalized);
		const raw = await readFile(abs, "utf8");
		const { data, body } = parseMarkdownWithFrontmatter(raw);
		const visibility = parseVisibility(data.visibility);
		const visibleToFactions = parseStringArray(data.visibleToFactions);
		if (!canViewerSee(visibility, visibleToFactions, viewer)) {
			throw new Error("当前视角无权读取该受限档案");
		}
		const stripped = stripRestrictedMarkdownBlocks(body, viewer);
		return {
			relPath: normalized,
			content: stripped.visibleBody,
			strippedSecretBlocks: stripped.strippedBlockCount,
		};
	}

	async proposeCanon(input: ProposeCanonInput): Promise<DiffPatchProposal> {
		const normalized = normalizeVaultPath(input.targetPath);
		const allowedPrefixes = ["01-设定与国力实册/", "04-编年史与条约/", "chronicle/", "wiki/"];
		if (
			normalized.split("/").includes("..") ||
			!normalized.endsWith(".md") ||
			!allowedPrefixes.some((p) => normalized.startsWith(p))
		) {
			throw new Error(
				"正史提案 targetPath 仅允许指向 01-设定与国力实册/、04-编年史与条约/、chronicle/ 或 wiki/ 下的 .md 文件",
			);
		}
		const absTarget = assertPathInsideWorkspace(input.cwd, normalized);
		const exists = existsSync(absTarget);
		const beforeContent = exists ? await readFile(absTarget, "utf8") : undefined;

		const proposal: DiffPatchProposal = {
			proposalId: `prop-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
			createdAt: new Date().toISOString(),
			targetPath: normalized,
			operation: exists ? "update" : "create",
			summary: input.summary.trim(),
			...(beforeContent !== undefined ? { beforeContent } : {}),
			afterContent: input.afterContent,
			sourceRefs: input.sourceRefs ?? [],
			warnings: input.warnings ?? [],
			status: "pending",
			viewer: input.viewer ?? { kind: "gm" },
		};

		const propDir = join(input.cwd, "private", "proposals");
		await mkdir(propDir, { recursive: true });
		await atomicWriteUtf8(join(propDir, `${proposal.proposalId}.json`), `${JSON.stringify(proposal, null, 2)}\n`);

		this.emitCanvas({
			kind: "proposal_created",
			cwd: input.cwd,
			proposal,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
		});
		return proposal;
	}

	async listProposals(cwd: string, viewerRaw?: string | ViewerScope): Promise<DiffPatchProposal[]> {
		const viewer = parseViewerScope(viewerRaw);
		const propDir = join(cwd, "private", "proposals");
		if (!existsSync(propDir)) return [];
		const entries = await readdir(propDir, { withFileTypes: true });
		const out: DiffPatchProposal[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await readFile(join(propDir, entry.name), "utf8")) as DiffPatchProposal;
				if (!parsed || typeof parsed.proposalId !== "string") continue;
				if (viewer.kind === "gm") {
					out.push(parsed);
				} else if (
					viewer.kind === "faction" &&
					parsed.viewer?.kind === "faction" &&
					parsed.viewer.factionId === viewer.factionId
				) {
					out.push(parsed);
				}
			} catch {
				// ignore malformed proposal
			}
		}
		return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async decideProposal(
		cwd: string,
		proposalId: string,
		decision: "approved" | "rejected",
		viewerRaw?: string | ViewerScope,
	): Promise<DiffPatchProposal> {
		const viewer = parseViewerScope(viewerRaw);
		if (viewer.kind !== "gm") {
			throw new Error("仅 GM 裁判视角有权批准或驳回正史提案");
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(proposalId)) {
			throw new Error("非法 proposalId");
		}
		const propFile = join(cwd, "private", "proposals", `${proposalId}.json`);
		if (!existsSync(propFile)) throw new Error(`未找到提案：${proposalId}`);
		const proposal = JSON.parse(await readFile(propFile, "utf8")) as DiffPatchProposal;
		if (proposal.status !== "pending") {
			throw new Error(`提案 ${proposalId} 已处理（当前状态：${proposal.status}）`);
		}

		if (decision === "approved") {
			const absTarget = assertPathInsideWorkspace(cwd, proposal.targetPath);
			await atomicWriteUtf8(absTarget, proposal.afterContent);
		}

		const updated: DiffPatchProposal = {
			...proposal,
			status: decision,
			decidedAt: new Date().toISOString(),
		};
		await atomicWriteUtf8(propFile, `${JSON.stringify(updated, null, 2)}\n`);
		this.emitCanvas({ kind: "workspace_changed", cwd, reason: `proposal_${decision}` });
		return updated;
	}

	async exportPreflight(cwd: string, targetViewerRaw: string): Promise<WenyouExportPreflightResult> {
		const targetViewer = parseViewerScope(targetViewerRaw);
		const allFiles = await walkRelativeFiles(cwd);
		const allowedFiles: string[] = [];
		const blockedPrivateFiles: string[] = [];
		const blockedVisibilityFiles: string[] = [];
		const warnings: string[] = [];
		let strippedSecretBlockCount = 0;

		const exportedDocs: Array<{ relPath: string; title: string; content: string }> = [];
		const manifest = await this.readManifest(cwd);

		for (const rel of allFiles) {
			const norm = normalizeVaultPath(rel);
			if (isPrivateVaultPath(norm) || norm.startsWith("00-群聊收集/")) {
				blockedPrivateFiles.push(norm);
				continue;
			}
			if (norm.endsWith(".md")) {
				const raw = await readFile(join(cwd, norm), "utf8");
				const { data, body } = parseMarkdownWithFrontmatter(raw);
				const vis = parseVisibility(data.visibility);
				const factions = parseStringArray(data.visibleToFactions);
				if (!canViewerSee(vis, factions, targetViewer)) {
					blockedVisibilityFiles.push(norm);
					continue;
				}
				const stripped = stripRestrictedMarkdownBlocks(body, targetViewer);
				strippedSecretBlockCount += stripped.strippedBlockCount;
				allowedFiles.push(norm);
				const title =
					typeof data.title === "string"
						? data.title
						: body.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(norm, ".md");
				exportedDocs.push({ relPath: norm, title, content: stripped.visibleBody });
			} else if (norm === "manifest.json" || MAP_IMAGE_EXTS.has(extname(norm).toLowerCase())) {
				allowedFiles.push(norm);
			}
		}

		if (blockedPrivateFiles.length > 0) {
			warnings.push(`已物理拦截 ${blockedPrivateFiles.length} 个私有/原始群聊文件，禁止进入发包产物`);
		}
		if (strippedSecretBlockCount > 0) {
			warnings.push(`已按视角 ${formatViewerScope(targetViewer)} 自动剥离 ${strippedSecretBlockCount} 处 :::secret 受限暗线块`);
		}

		const bundleJson = JSON.stringify(
			{
				schemaVersion: 1,
				exportedAt: new Date().toISOString(),
				exportedViewer: targetViewer,
				worldTitle: manifest?.title ?? basename(cwd),
				worldId: manifest?.worldId ?? slugSafe(basename(cwd)),
				documents: exportedDocs,
				maps: (await this.listMaps(cwd)).map((m) => ({ name: m.name, relPath: m.relPath, yearLabel: m.yearLabel })),
			},
			null,
			2,
		);

		return {
			targetViewer,
			allowedFiles,
			blockedPrivateFiles,
			blockedVisibilityFiles,
			strippedSecretBlockCount,
			warnings,
			bundleJson,
		};
	}

	async getOverview(cwd: string, viewerRaw?: string | ViewerScope): Promise<WenyouWorkspaceOverview> {
		const viewer = parseViewerScope(viewerRaw);
		const initialized = await this.isCampaignWorkspace(cwd);
		const manifest = await this.readManifest(cwd);
		const evidence = await loadEvidenceRecords(cwd);
		const cursorsMap = refreshCursorStats(evidence, await loadCursors(cwd));
		const cursors = Object.values(cursorsMap).sort((a, b) => a.groupId.localeCompare(b.groupId));
		const unreportedCount = cursors.reduce((sum, c) => sum + c.unreportedCount, 0);
		const [briefings, rollingLedger, policies, maps, proposals, canonDocs] = await Promise.all([
			this.listBriefings(cwd),
			this.loadRollingLedger(cwd),
			this.listPolicies(cwd),
			this.listMaps(cwd),
			this.listProposals(cwd, viewer),
			this.listCanonDocs(cwd, viewer),
		]);

		return {
			cwd,
			initialized,
			worldTitle: manifest?.title ?? basename(cwd),
			worldId: manifest?.worldId ?? slugSafe(basename(cwd)),
			...(manifest?.currentEra ? { currentEra: manifest.currentEra } : {}),
			viewer,
			cursors,
			totalEvidenceCount: evidence.length,
			unreportedCount,
			briefings,
			rollingLedger,
			policies,
			maps,
			proposals,
			canonDocs,
		};
	}
}
