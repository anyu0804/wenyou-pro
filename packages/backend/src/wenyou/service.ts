import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
	type BriefingIntelCheck,
	type BriefingProgressItem,
	buildWenyouAssetUrl,
	clampViewerScope,
	type DiffPatchProposal,
	formatViewerScope,
	type GroupCursorRecord,
	type MapAssetItem,
	type MapInspectResult,
	type MapSnapshotDiffResult,
	type MapSnapshotSummary,
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
import {
	diffMapSnapshots,
	inspectMapSnapshot,
	listMapSnapshots,
	type MapInspectOptions,
	readMapSnapshotRaw,
	saveMapSnapshot,
} from "./map-state";
import { NtqqSyncService, type NtqqSyncServiceOptions } from "./ntqq-sync";
import { type LintVaultEntity, lintPolicyDraft } from "./policy-lint";
import {
	computeUnreportedMessages,
	DEFAULT_SOURCE_CONTEXT_WINDOW,
	loadCursors,
	loadEvidenceRecords,
	lookupSourceContext,
	pullQqGroupsIncremental,
	refreshCursorStats,
	saveCursors,
	type SearchEvidenceResult,
	searchEvidenceRecords,
	searchEvidenceWithStats,
} from "./qq-ingest";
import {
	assertPathInsideWorkspace,
	assertRealTargetInsideWorkspace,
	canViewerSee,
	isPrivateVaultPath,
	isRawChatPath,
	normalizeVaultPath,
	parseMarkdownWithFrontmatter,
	parseVisibility,
	resolveRealPathInsideWorkspace,
	stripRestrictedMarkdownBlocks,
} from "./secret-blocks";

const MAP_IMAGE_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const ALLOWED_CANON_PREFIXES = ["01-设定与国力实册/", "04-编年史与条约/", "chronicle/", "wiki/"] as const;
const SERIAL_NO_RE = /^[A-Za-z0-9_-]{1,24}$/;

function normalizeWorkspaceKey(cwd: string): string {
	const resolved = resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const list = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
	return list.length ? list : undefined;
}

function isBriefingVaultPath(normPath: string): boolean {
	return normPath === "02-局势简报与台账" || normPath.startsWith("02-局势简报与台账/");
}

function isPolicyVaultPath(normPath: string): boolean {
	return normPath === "03-国策与文书" || normPath.startsWith("03-国策与文书/");
}

/**
 * 解析文档可见性（按目录类别实施不同缺省策略）：
 * - `02-局势简报与台账/`（内部参谋简报/台账）与 `03-国策与文书/`（各国国策/内阁文书）：
 *   未显式标 `visibility` 时默认非公开（若有 `visibleToFactions` 则为 `"faction"`，否则 `"gm"`）；
 * - 其余正史目录：未显式标 `visibility` 时默认 `"public"`；
 * - 任何非空未知值均 Fail-Closed 返回 `"gm"`。
 */
export function resolveMarkdownDocVisibility(
	normPath: string,
	data: Record<string, unknown>,
): { visibility: VisibilityLevel; visibleToFactions?: string[] } {
	const visibleToFactions = parseStringArray(data.visibleToFactions);
	if (isBriefingVaultPath(normPath) || isPolicyVaultPath(normPath)) {
		const rawVis = data.visibility;
		if (rawVis === undefined || rawVis === null || (typeof rawVis === "string" && rawVis.trim() === "")) {
			return {
				visibility: visibleToFactions && visibleToFactions.length > 0 ? "faction" : "gm",
				...(visibleToFactions ? { visibleToFactions } : {}),
			};
		}
		return {
			visibility: parseVisibility(rawVis, "gm"),
			...(visibleToFactions ? { visibleToFactions } : {}),
		};
	}
	return {
		visibility: parseVisibility(data.visibility, "public"),
		...(visibleToFactions ? { visibleToFactions } : {}),
	};
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

export interface ParsedCampaignManifest {
	worldId: string;
	title: string;
	currentEra?: string;
	maxViewer?: ViewerScope;
	branchId?: string;
	currentOrder?: number;
}

export class WenyouService {
	readonly ntqq: NtqqSyncService;
	private readonly activeViewers = new Map<string, ViewerScope>();
	private readonly maxViewers = new Map<string, ViewerScope>();
	private readonly workspaceLocks = new Map<string, Promise<unknown>>();

	constructor(
		private readonly emitCanvasEvent?: (event: WenyouCanvasEvent) => void,
		ntqqOptions?: NtqqSyncServiceOptions,
	) {
		this.ntqq = new NtqqSyncService(ntqqOptions);
	}

	emitCanvas(event: WenyouCanvasEvent): void {
		this.emitCanvasEvent?.(event);
	}

	private async withWorkspaceLock<T>(cwd: string, task: () => Promise<T>): Promise<T> {
		const key = normalizeWorkspaceKey(cwd);
		const prev = this.workspaceLocks.get(key) ?? Promise.resolve();
		const next = prev.then(task, task);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.workspaceLocks.set(key, settled);
		try {
			return await next;
		} finally {
			if (this.workspaceLocks.get(key) === settled) {
				this.workspaceLocks.delete(key);
			}
		}
	}

	async setViewerScope(
		cwd: string,
		viewerRaw: string | ViewerScope,
		maxViewerRaw?: string | ViewerScope,
	): Promise<{ viewer: ViewerScope; maxViewer: ViewerScope }> {
		const key = normalizeWorkspaceKey(cwd);
		const manifest = await this.readManifest(cwd);
		if (maxViewerRaw !== undefined) {
			const parsedMax = parseViewerScope(maxViewerRaw);
			const effectiveMax = clampViewerScope(parsedMax, manifest?.maxViewer);
			this.maxViewers.set(key, effectiveMax);
		}
		const maxViewer = clampViewerScope(this.maxViewers.get(key) ?? { kind: "gm" }, manifest?.maxViewer);
		const requested = parseViewerScope(viewerRaw);
		const viewer = clampViewerScope(requested, maxViewer);
		this.activeViewers.set(key, viewer);
		return { viewer, maxViewer };
	}

	private async getViewerBounds(
		cwd: string,
		requestedViewer?: string | ViewerScope,
	): Promise<{ viewer: ViewerScope; maxViewer: ViewerScope }> {
		const key = normalizeWorkspaceKey(cwd);
		const manifest = await this.readManifest(cwd);
		const maxViewer = clampViewerScope(this.maxViewers.get(key) ?? { kind: "gm" }, manifest?.maxViewer);
		const base =
			requestedViewer !== undefined
				? parseViewerScope(requestedViewer)
				: (this.activeViewers.get(key) ?? { kind: "gm" });
		const viewer = clampViewerScope(base, maxViewer);
		return { viewer, maxViewer };
	}

	async getEffectiveViewer(cwd: string, requestedViewer?: string | ViewerScope): Promise<ViewerScope> {
		const { viewer } = await this.getViewerBounds(cwd, requestedViewer);
		return viewer;
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

	async readManifest(cwd: string): Promise<ParsedCampaignManifest | null> {
		const file = join(cwd, "manifest.json");
		if (!existsSync(file)) return null;
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as {
				worldId?: string;
				title?: string;
				currentEra?: string;
				maxViewer?: unknown;
				branchId?: unknown;
				currentOrder?: unknown;
				branches?: Array<{
					id?: unknown;
					currentEra?: string;
					currentOrder?: unknown;
					order?: unknown;
				}>;
			};
			let maxViewer: ViewerScope | undefined;
			if (raw.maxViewer !== undefined && raw.maxViewer !== null && raw.maxViewer !== "") {
				try {
					maxViewer = parseViewerScope(raw.maxViewer as string | ViewerScope);
				} catch {
					// Fail-Closed: 非法 maxViewer 视为最严格的 public
					maxViewer = { kind: "public" };
				}
			}
			const firstBranch = raw.branches?.[0];
			const branchId =
				typeof raw.branchId === "string" && raw.branchId.trim()
					? raw.branchId.trim()
					: typeof firstBranch?.id === "string" && firstBranch.id.trim()
						? firstBranch.id.trim()
						: undefined;
			const rawOrder = raw.currentOrder ?? firstBranch?.currentOrder ?? firstBranch?.order;
			const currentOrder =
				typeof rawOrder === "number" && Number.isFinite(rawOrder) ? rawOrder : undefined;

			return {
				worldId: raw.worldId || slugSafe(basename(cwd)),
				title: raw.title || basename(cwd),
				currentEra: raw.currentEra ?? firstBranch?.currentEra,
				...(maxViewer ? { maxViewer } : {}),
				...(branchId ? { branchId } : {}),
				...(currentOrder !== undefined ? { currentOrder } : {}),
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

	async pullQq(
		cwd: string,
		groupId?: string,
		sessionId?: string,
		options?: { historyLimit?: number; backfill?: boolean },
	): Promise<WenyouPullQqResult> {
		return this.withWorkspaceLock(cwd, async () => {
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
						const syncRes = await this.ntqq.syncCampaign(cwd, {
							groupId,
							...(options?.historyLimit ? { limit: options.historyLimit } : {}),
							...(options?.backfill ? { force: true } : {}),
						});
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
		});
	}

	async syncNtqqCampaign(
		cwd: string,
		options?: { groupId?: string; limit?: number; force?: boolean; sessionId?: string },
	) {
		return this.withWorkspaceLock(cwd, async () => {
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
		});
	}

	async lookupSource(
		cwd: string,
		sourceId: string,
		windowSize = DEFAULT_SOURCE_CONTEXT_WINDOW,
		viewerRaw?: string | ViewerScope,
	): Promise<SourceContextWindow | null> {
		const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
		return lookupSourceContext(cwd, sourceId, windowSize, viewer);
	}

	async searchSources(
		cwd: string,
		query: {
			keyword?: string;
			sender?: string;
			groupId?: string;
			since?: string;
			until?: string;
			order?: "latest" | "earliest";
			limit?: number;
			viewer?: string | ViewerScope;
		},
	) {
		const viewer = await this.getEffectiveViewer(cwd, query.viewer);
		return searchEvidenceRecords(cwd, {
			keyword: query.keyword,
			sender: query.sender,
			groupId: query.groupId,
			since: query.since,
			until: query.until,
			order: query.order,
			limit: query.limit,
			viewer,
		});
	}

	async searchSourcesWithStats(
		cwd: string,
		query: {
			keyword?: string;
			sender?: string;
			groupId?: string;
			since?: string;
			until?: string;
			order?: "latest" | "earliest";
			limit?: number;
			viewer?: string | ViewerScope;
		},
	): Promise<SearchEvidenceResult> {
		const viewer = await this.getEffectiveViewer(cwd, query.viewer);
		return searchEvidenceWithStats(cwd, {
			keyword: query.keyword,
			sender: query.sender,
			groupId: query.groupId,
			since: query.since,
			until: query.until,
			order: query.order,
			limit: query.limit,
			viewer,
		});
	}

	async listBriefings(cwd: string, viewerRaw?: string | ViewerScope): Promise<SituationBriefing[]> {
		const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
		const dir = join(cwd, "02-局势简报与台账", "briefings");
		if (!existsSync(dir)) return [];
		const entries = await readdir(dir, { withFileTypes: true });
		const briefings: SituationBriefing[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await readFile(join(dir, entry.name), "utf8")) as SituationBriefing & {
					visibility?: unknown;
					visibleToFactions?: unknown;
				};
				if (!parsed || typeof parsed.id !== "string" || typeof parsed.headline !== "string") continue;
				if (viewer.kind !== "gm") {
					const vis = parseVisibility(parsed.visibility, "gm");
					const factions = parseStringArray(parsed.visibleToFactions);
					if (!canViewerSee(vis, factions, viewer)) continue;
				}
				briefings.push(parsed);
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
			const raw = JSON.parse(await readFile(file, "utf8")) as
				| { entries?: RollingLedgerEntry[] }
				| RollingLedgerEntry[];
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

	private async nextBriefingSeqNumber(briefingsDir: string): Promise<number> {
		let maxNum = 0;
		if (existsSync(briefingsDir)) {
			const entries = await readdir(briefingsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const nameMatch = entry.name.match(/^briefing-(\d+)/);
				if (nameMatch?.[1]) {
					const n = Number.parseInt(nameMatch[1], 10);
					if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
				}
				if (entry.name.endsWith(".json")) {
					try {
						const parsed = JSON.parse(await readFile(join(briefingsDir, entry.name), "utf8")) as {
							id?: unknown;
						};
						const idMatch = typeof parsed?.id === "string" ? parsed.id.match(/^briefing-(\d+)$/) : null;
						if (idMatch?.[1]) {
							const n = Number.parseInt(idMatch[1], 10);
							if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
						}
					} catch {
						// ignore malformed file
					}
				}
			}
		}
		return maxNum + 1;
	}

	async publishBriefing(input: PublishBriefingInput): Promise<{
		briefing: SituationBriefing;
		advancedGroups: string[];
		addedLedgerCount: number;
	}> {
		return this.withWorkspaceLock(input.cwd, async () => {
			const briefingsDir = join(input.cwd, "02-局势简报与台账", "briefings");
			await mkdir(briefingsDir, { recursive: true });
			const nextNum = await this.nextBriefingSeqNumber(briefingsDir);
			const seq = String(nextNum).padStart(3, "0");
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

			// 推进各群已汇报游标：严格单调前进（绝不因引用旧证据倒退）；
			// 未显式指定 coveredSourceIds 时，对存在未报消息的群推进至当前末尾。
			const explicitCovered = Boolean(input.coveredSourceIds && input.coveredSourceIds.length > 0);
			const advancedGroups: string[] = [];
			const byGroup = new Map<string, string[]>();
			for (const rec of allEvidence) {
				const arr = byGroup.get(rec.groupId) ?? [];
				arr.push(rec.sourceId);
				byGroup.set(rec.groupId, arr);
			}
			for (const [gid, cursor] of Object.entries(cursors)) {
				const ids = byGroup.get(gid) ?? [];
				const prevIdx = cursor.lastReportedSourceId ? ids.indexOf(cursor.lastReportedSourceId) : -1;
				let highestRefIdx = -1;
				for (let i = 0; i < ids.length; i += 1) {
					if (referenced.has(ids[i]!)) highestRefIdx = i;
				}
				let targetIdx = highestRefIdx;
				if (!explicitCovered && ids.length > 0 && prevIdx < ids.length - 1) {
					targetIdx = Math.max(targetIdx, ids.length - 1);
				}
				const nextIdx = Math.max(prevIdx, targetIdx);
				if (nextIdx >= 0 && nextIdx > prevIdx) {
					cursor.lastReportedSourceId = ids[nextIdx]!;
					cursor.lastReportedAt = now;
					cursor.unreportedCount = Math.max(0, ids.length - 1 - nextIdx);
					advancedGroups.push(gid);
				} else if (prevIdx >= 0) {
					cursor.unreportedCount = Math.max(0, ids.length - 1 - prevIdx);
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
		});
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
						visibility: parseVisibility(data.visibility, "public"),
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

	private matchActorEntity(
		entities: readonly LintVaultEntity[],
		actor?: string,
		actorEntityId?: string,
	): LintVaultEntity | undefined {
		const idTarget = actorEntityId?.trim();
		if (idTarget) {
			const byId = entities.find((e) => e.id === idTarget);
			if (byId) return byId;
		}
		const nameTarget = actor?.trim();
		if (!nameTarget) return undefined;
		return entities.find(
			(e) => e.id === nameTarget || e.title === nameTarget || (e.aliases?.includes(nameTarget) ?? false),
		);
	}

	async lintPolicy(
		cwd: string,
		text: string,
		options?: {
			viewer?: string | ViewerScope;
			actor?: string;
			actorEntityId?: string;
			branchId?: string;
			currentOrder?: number;
		},
	): Promise<PolicyLintReport> {
		const [effectiveViewer, manifest, entities] = await Promise.all([
			this.getEffectiveViewer(cwd, options?.viewer),
			this.readManifest(cwd),
			this.collectLintEntities(cwd),
		]);
		const matchedActor = this.matchActorEntity(entities, options?.actor, options?.actorEntityId);
		let lintViewer: ViewerScope = effectiveViewer;
		if (effectiveViewer.kind === "gm" && matchedActor) {
			const inferredFaction = matchedActor.visibleToFactions?.[0] ?? matchedActor.id;
			lintViewer = { kind: "faction", factionId: inferredFaction };
		}
		const branchId = options?.branchId ?? manifest?.branchId;
		const currentOrder = options?.currentOrder ?? manifest?.currentOrder;
		return lintPolicyDraft(text, {
			viewer: lintViewer,
			actorEntityId: options?.actorEntityId ?? matchedActor?.id,
			branchId,
			currentOrder,
			entities,
		});
	}

	private async nextPolicySerialNumber(dir: string): Promise<number> {
		if (!existsSync(dir)) return 1;
		const entries = await readdir(dir, { withFileTypes: true });
		let maxNum = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const stem = basename(entry.name, ".md");
			const stemMatch = stem.match(/^(\d{1,6})[-_]/);
			if (stemMatch?.[1]) {
				const n = Number.parseInt(stemMatch[1], 10);
				if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
			}
			try {
				const raw = await readFile(join(dir, entry.name), "utf8");
				const { data } = parseMarkdownWithFrontmatter(raw);
				if (typeof data.serialNo === "string") {
					const n = Number.parseInt(data.serialNo, 10);
					if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
				}
			} catch {
				// ignore unreadable file
			}
		}
		return maxNum + 1;
	}

	async listPolicies(cwd: string, viewerRaw?: string | ViewerScope): Promise<PolicyArtifact[]> {
		const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
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
			const { visibility, visibleToFactions } = resolveMarkdownDocVisibility(relMd, data);
			if (!canViewerSee(visibility, visibleToFactions, viewer)) continue;
			const stripped = stripRestrictedMarkdownBlocks(body, viewer);
			const visibleBody = stripped.visibleBody;
			const serialMatch = stem.match(/^(\d{2,4})[-_]/);
			const serialNo =
				typeof data.serialNo === "string"
					? data.serialNo
					: serialMatch?.[1] ?? String(policies.length + 1).padStart(3, "0");
			const headingMatch = visibleBody.match(/^#\s+(.+)$/m);
			const title =
				typeof data.title === "string"
					? data.title
					: headingMatch?.[1]?.trim() || stem.replace(/^\d{2,4}[-_]/, "");
			const lintReport = await this.lintPolicy(cwd, visibleBody, {
				viewer,
				actor: typeof data.actor === "string" ? data.actor : undefined,
			});
			const excerpt = visibleBody
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
				content: visibleBody.trim(),
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
		actorEntityId?: string;
		branchId?: string;
		currentOrder?: number;
		force?: boolean;
		sessionId?: string;
	}): Promise<WenyouWritePolicyResult> {
		if (input.serialNo !== undefined && input.serialNo.trim() !== "") {
			const trimmedSerial = input.serialNo.trim();
			if (!SERIAL_NO_RE.test(trimmedSerial)) {
				throw new Error(
					`非法国策编号 serialNo：${input.serialNo}（仅允许 1-24 位字母、数字、下划线或短横线，禁止路径穿越字符）`,
				);
			}
		}

		const effectiveViewer = await this.getEffectiveViewer(input.cwd, input.viewer);
		const lintReport = await this.lintPolicy(input.cwd, input.content, {
			viewer: effectiveViewer,
			actor: input.actor,
			actorEntityId: input.actorEntityId,
			branchId: input.branchId,
			currentOrder: input.currentOrder,
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
		const nextNum = await this.nextPolicySerialNumber(dir);
		const serialNo = input.serialNo?.trim() || String(nextNum).padStart(3, "0");
		if (!SERIAL_NO_RE.test(serialNo)) {
			throw new Error(`非法国策编号 serialNo：${serialNo}`);
		}
		const stem = `${serialNo}-${slugSafe(input.title)}`;
		const mdRel = `03-国策与文书/${stem}.md`;
		const docxRel = `03-国策与文书/${stem}.docx`;
		const [mdChecked, docxChecked] = await Promise.all([
			assertRealTargetInsideWorkspace(input.cwd, mdRel),
			assertRealTargetInsideWorkspace(input.cwd, docxRel),
		]);
		if (
			!mdChecked.realRelPath.startsWith("03-国策与文书/") ||
			!docxChecked.realRelPath.startsWith("03-国策与文书/")
		) {
			throw new Error("国策输出路径越界或落入受限目录，已拒绝写入");
		}
		const createdAt = new Date().toISOString();

		// 确定国策可见性 frontmatter：阵营视角或可归属阵营的国策写入 faction 隔离，GM 无归属文书默认 gm，不裸露给公开导出包
		let policyVisibility: VisibilityLevel;
		let policyVisibleToFactions: string[] | undefined;
		if (effectiveViewer.kind === "faction") {
			policyVisibility = "faction";
			policyVisibleToFactions = [effectiveViewer.factionId];
		} else if (effectiveViewer.kind === "gm") {
			if (lintReport.actorEntityId) {
				const entities = await this.collectLintEntities(input.cwd);
				const matched = entities.find((e) => e.id === lintReport.actorEntityId);
				const factionId = matched?.visibleToFactions?.[0] ?? lintReport.actorEntityId;
				policyVisibility = "faction";
				policyVisibleToFactions = [factionId];
			} else {
				policyVisibility = "gm";
			}
		} else {
			policyVisibility = "public";
		}

		const fmLines = [
			"---",
			`id: ${stem}`,
			`serialNo: "${serialNo}"`,
			`title: ${JSON.stringify(input.title.trim())}`,
			...(input.actor ? [`actor: ${JSON.stringify(input.actor.trim())}`] : []),
			...(input.turnLabel ? [`turnLabel: ${JSON.stringify(input.turnLabel.trim())}`] : []),
			`visibility: ${policyVisibility}`,
			...(policyVisibleToFactions
				? [`visibleToFactions: [${policyVisibleToFactions.map((f) => JSON.stringify(f)).join(", ")}]`]
				: []),
			`createdAt: ${JSON.stringify(createdAt)}`,
			"---",
		];
		const cleanBody = input.content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
		await atomicWriteUtf8(mdChecked.absPath, `${fmLines.join("\n")}\n\n${cleanBody}\n`);

		const subtitleParts = [input.actor?.trim(), input.turnLabel?.trim()].filter(Boolean);
		const docxBuf = buildPolicyDocx({
			title: input.title.trim(),
			bodyMarkdown: cleanBody,
			subtitle: subtitleParts.length ? subtitleParts.join(" · ") : undefined,
			createdAt,
		});
		await atomicWriteBuffer(docxChecked.absPath, docxBuf);

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
					assetUrl: buildWenyouAssetUrl(cwd, rel, Math.trunc(info.mtimeMs)),
					ext,
					...(yearMatch?.[1] ? { yearLabel: yearMatch[1].trim() } : {}),
					sizeBytes: info.size,
					modifiedAt: info.mtimeMs,
				});
			}
		}
		return items.sort((a, b) => a.relPath.localeCompare(b.relPath));
	}

	async listMapSnapshots(cwd: string): Promise<MapSnapshotSummary[]> {
		return listMapSnapshots(cwd);
	}

	async inspectMap(cwd: string, relPath: string, options?: MapInspectOptions): Promise<MapInspectResult> {
		return inspectMapSnapshot(cwd, relPath, options);
	}

	async diffMaps(
		cwd: string,
		fromRelPath: string,
		toRelPath: string,
		theaterId?: string,
	): Promise<MapSnapshotDiffResult> {
		return diffMapSnapshots(cwd, fromRelPath, toRelPath, theaterId);
	}

	async readMapSnapshotRaw(
		cwd: string,
		relPath: string,
	): Promise<{ relPath: string; fileName: string; content: string }> {
		return readMapSnapshotRaw(cwd, relPath);
	}

	async saveMapSnapshot(
		cwd: string,
		fileName: string,
		content: string,
		sessionId?: string,
	): Promise<MapSnapshotSummary> {
		const saved = await saveMapSnapshot(cwd, fileName, content);
		this.emitCanvas({
			kind: "workspace_changed",
			cwd,
			reason: "map_snapshot_saved",
			...(sessionId ? { sessionId } : {}),
		});
		return saved;
	}

	async listCanonDocs(cwd: string, viewerRaw?: string | ViewerScope): Promise<WenyouCanonDocSummary[]> {
		const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
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
				const visibility = parseVisibility(data.visibility, "public");
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
		const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
		const normalized = normalizeVaultPath(relPath);
		if (!normalized || normalized.split("/").includes("..")) {
			throw new Error(`非法文档路径：${relPath}`);
		}
		if (isRawChatPath(normalized)) {
			throw new Error("当前接口禁止读取 00-群聊收集/ 原始群聊目录");
		}
		if (viewer.kind !== "gm" && isPrivateVaultPath(normalized)) {
			throw new Error("当前视角无权访问 private/ 受限目录");
		}
		const realTarget = await resolveRealPathInsideWorkspace(cwd, normalized);
		const realRoot = await realpath(resolve(cwd));
		const realRel = normalizeVaultPath(relative(realRoot, realTarget));
		if (isRawChatPath(realRel)) {
			throw new Error("符号链接目标落入 00-群聊收集/，已拒绝读取");
		}
		if (viewer.kind !== "gm" && isPrivateVaultPath(realRel)) {
			throw new Error("符号链接目标落入受限目录，已拒绝读取");
		}
		const raw = await readFile(realTarget, "utf8");
		const { data, body } = parseMarkdownWithFrontmatter(raw);
		const { visibility, visibleToFactions } = resolveMarkdownDocVisibility(realRel, data);
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
		const viewer = await this.getEffectiveViewer(input.cwd, input.viewer);
		const normalized = normalizeVaultPath(input.targetPath);
		if (
			normalized.split("/").includes("..") ||
			isPrivateVaultPath(normalized) ||
			!normalized.endsWith(".md") ||
			!ALLOWED_CANON_PREFIXES.some((p) => normalized.startsWith(p))
		) {
			throw new Error(
				"正史提案 targetPath 仅允许指向 01-设定与国力实册/、04-编年史与条约/、chronicle/ 或 wiki/ 下的 .md 文件",
			);
		}
		const { absPath: absTarget, realRelPath } = await assertRealTargetInsideWorkspace(input.cwd, normalized);
		if (
			isPrivateVaultPath(realRelPath) ||
			!realRelPath.endsWith(".md") ||
			!ALLOWED_CANON_PREFIXES.some((p) => realRelPath.startsWith(p))
		) {
			throw new Error("正史提案目标真实路径落入非法或受限目录");
		}
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
			viewer,
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
		const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
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
		return this.withWorkspaceLock(cwd, async () => {
			const viewer = await this.getEffectiveViewer(cwd, viewerRaw);
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
				const normalizedTarget = normalizeVaultPath(proposal.targetPath);
				if (
					!normalizedTarget ||
					normalizedTarget.split("/").includes("..") ||
					isPrivateVaultPath(normalizedTarget) ||
					!normalizedTarget.endsWith(".md") ||
					!ALLOWED_CANON_PREFIXES.some((p) => normalizedTarget.startsWith(p))
				) {
					throw new Error(`提案目标路径不合法，已拒绝写入：${proposal.targetPath}`);
				}
				const { absPath: absTarget, realRelPath } = await assertRealTargetInsideWorkspace(cwd, normalizedTarget);
				if (
					isPrivateVaultPath(realRelPath) ||
					!realRelPath.endsWith(".md") ||
					!ALLOWED_CANON_PREFIXES.some((p) => realRelPath.startsWith(p))
				) {
					throw new Error(`提案目标真实路径越界或落入受限目录，已拒绝写入：${proposal.targetPath}`);
				}
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
		});
	}

	async exportPreflight(cwd: string, targetViewerRaw: string): Promise<WenyouExportPreflightResult> {
		const targetViewer = await this.getEffectiveViewer(cwd, targetViewerRaw);
		const allFiles = await walkRelativeFiles(cwd);
		const allowedFiles: string[] = [];
		const blockedPrivateFiles: string[] = [];
		const blockedVisibilityFiles: string[] = [];
		const warnings: string[] = [];
		let strippedSecretBlockCount = 0;

		const exportedDocs: Array<{ relPath: string; title: string; content: string }> = [];
		const manifest = await this.readManifest(cwd);

		// 缓存国策 .md 可见性，供同名 .docx 联动隔离
		const policyMdAllowed = new Map<string, boolean>();

		for (const rel of allFiles) {
			const norm = normalizeVaultPath(rel);
			if (isPrivateVaultPath(norm) || isRawChatPath(norm)) {
				blockedPrivateFiles.push(norm);
				continue;
			}
			if (norm.endsWith(".md")) {
				const raw = await readFile(join(cwd, norm), "utf8");
				const { data, body } = parseMarkdownWithFrontmatter(raw);
				const { visibility: vis, visibleToFactions: factions } = resolveMarkdownDocVisibility(norm, data);
				if (!canViewerSee(vis, factions, targetViewer)) {
					blockedVisibilityFiles.push(norm);
					if (isPolicyVaultPath(norm)) policyMdAllowed.set(norm.slice(0, -3), false);
					continue;
				}
				if (isPolicyVaultPath(norm)) policyMdAllowed.set(norm.slice(0, -3), true);
				const stripped = stripRestrictedMarkdownBlocks(body, targetViewer);
				strippedSecretBlockCount += stripped.strippedBlockCount;
				allowedFiles.push(norm);
				const title =
					typeof data.title === "string"
						? data.title
						: body.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(norm, ".md");
				exportedDocs.push({ relPath: norm, title, content: stripped.visibleBody });
			} else if (isBriefingVaultPath(norm) && norm.endsWith(".json")) {
				if (targetViewer.kind === "gm") {
					allowedFiles.push(norm);
				} else {
					let visible = false;
					try {
						const parsed = JSON.parse(await readFile(join(cwd, norm), "utf8")) as {
							visibility?: unknown;
							visibleToFactions?: unknown;
						};
						const vis = parseVisibility(parsed?.visibility, "gm");
						const factions = parseStringArray(parsed?.visibleToFactions);
						visible = canViewerSee(vis, factions, targetViewer);
					} catch {
						visible = false;
					}
					if (visible) allowedFiles.push(norm);
					else blockedVisibilityFiles.push(norm);
				}
			} else if (isPolicyVaultPath(norm) && norm.endsWith(".docx")) {
				if (targetViewer.kind === "gm") {
					allowedFiles.push(norm);
				} else {
					const stemKey = norm.slice(0, -5);
					let allowed = policyMdAllowed.get(stemKey);
					if (allowed === undefined) {
						const mdPeer = join(cwd, `${stemKey}.md`);
						if (existsSync(mdPeer)) {
							const { data } = parseMarkdownWithFrontmatter(await readFile(mdPeer, "utf8"));
							const { visibility, visibleToFactions } = resolveMarkdownDocVisibility(`${stemKey}.md`, data);
							allowed = canViewerSee(visibility, visibleToFactions, targetViewer);
						} else {
							allowed = false;
						}
					}
					if (allowed) allowedFiles.push(norm);
					else blockedVisibilityFiles.push(norm);
				}
			} else if (norm === "manifest.json") {
				allowedFiles.push(norm);
			} else if (MAP_IMAGE_EXTS.has(extname(norm).toLowerCase())) {
				const isPublicMapRoot =
					norm.startsWith("05-沙盘与图集/") || norm.startsWith("maps/") || norm.startsWith("assets/maps/");
				if (targetViewer.kind === "gm" || isPublicMapRoot) {
					allowedFiles.push(norm);
				} else {
					blockedVisibilityFiles.push(norm);
				}
			}
		}

		if (blockedPrivateFiles.length > 0) {
			warnings.push(`已物理拦截 ${blockedPrivateFiles.length} 个私有/原始群聊文件，禁止进入发包产物`);
		}
		if (blockedVisibilityFiles.length > 0) {
			warnings.push(`已按视角 ${formatViewerScope(targetViewer)} 隔离 ${blockedVisibilityFiles.length} 个受限简报/国策/档案文件`);
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

	private filterLedgerForViewer(
		entries: readonly RollingLedgerEntry[],
		viewer: ViewerScope,
		entities: readonly LintVaultEntity[],
	): RollingLedgerEntry[] {
		if (viewer.kind === "gm") return [...entries];
		const allowedFactionTokens = new Set<string>();
		if (viewer.kind === "faction") {
			allowedFactionTokens.add(viewer.factionId.toLowerCase());
			for (const ent of entities) {
				const belongs =
					ent.id === viewer.factionId ||
					(ent.visibleToFactions?.includes(viewer.factionId) ?? false);
				if (belongs) {
					allowedFactionTokens.add(ent.id.toLowerCase());
					allowedFactionTokens.add(ent.title.toLowerCase());
					for (const al of ent.aliases ?? []) {
						allowedFactionTokens.add(al.toLowerCase());
					}
				}
			}
		}
		return entries.filter((entry) => {
			if (entry.category === "unconfirmed_draft") return false;
			const ext = entry as RollingLedgerEntry & { visibility?: unknown; visibleToFactions?: unknown };
			if (ext.visibility !== undefined) {
				const vis = parseVisibility(ext.visibility, "gm");
				const facs = parseStringArray(ext.visibleToFactions);
				if (!canViewerSee(vis, facs, viewer)) return false;
			}
			if (entry.faction && entry.faction.trim().length > 0) {
				if (viewer.kind === "public") return false;
				const token = entry.faction.trim().toLowerCase();
				if (!allowedFactionTokens.has(token)) return false;
			}
			return true;
		});
	}

	async getOverview(cwd: string, viewerRaw?: string | ViewerScope): Promise<WenyouWorkspaceOverview> {
		const { viewer, maxViewer } = await this.getViewerBounds(cwd, viewerRaw);
		const initialized = await this.isCampaignWorkspace(cwd);
		const manifest = await this.readManifest(cwd);
		const allEvidence = await loadEvidenceRecords(cwd);
		const visibleEvidence =
			viewer.kind === "gm"
				? allEvidence
				: allEvidence.filter((rec) => canViewerSee(rec.visibility, rec.visibleToFactions, viewer));
		const rawCursors = await loadCursors(cwd);
		let scopedExistingCursors: Record<string, GroupCursorRecord> = rawCursors;
		if (viewer.kind !== "gm") {
			const visibleGroupIds = new Set(visibleEvidence.map((rec) => rec.groupId));
			scopedExistingCursors = {};
			for (const [gid, cur] of Object.entries(rawCursors)) {
				if (visibleGroupIds.has(gid)) {
					scopedExistingCursors[gid] = cur;
				}
			}
		}
		const cursorsMap = refreshCursorStats(visibleEvidence, scopedExistingCursors);
		const cursors = Object.values(cursorsMap).sort((a, b) => a.groupId.localeCompare(b.groupId));
		const unreportedCount = cursors.reduce((sum, c) => sum + c.unreportedCount, 0);
		const [briefings, rawLedger, entities, policies, maps, proposals, canonDocs] = await Promise.all([
			this.listBriefings(cwd, viewer),
			this.loadRollingLedger(cwd),
			viewer.kind === "gm" ? Promise.resolve([] as LintVaultEntity[]) : this.collectLintEntities(cwd),
			this.listPolicies(cwd, viewer),
			this.listMaps(cwd),
			this.listProposals(cwd, viewer),
			this.listCanonDocs(cwd, viewer),
		]);
		const rollingLedger = this.filterLedgerForViewer(rawLedger, viewer, entities);

		return {
			cwd,
			initialized,
			worldTitle: manifest?.title ?? basename(cwd),
			worldId: manifest?.worldId ?? slugSafe(basename(cwd)),
			...(manifest?.currentEra ? { currentEra: manifest.currentEra } : {}),
			viewer,
			maxViewer,
			cursors,
			totalEvidenceCount: visibleEvidence.length,
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
