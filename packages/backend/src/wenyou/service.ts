import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
	type BriefingIntelCheck,
	type BriefingProgressItem,
	buildWenyouAssetUrl,
	type MapAssetItem,
	type MapInspectResult,
	type MapSnapshotDiffResult,
	type MapSnapshotSummary,
	type PolicyArtifact,
	type RollingLedgerCategory,
	type RollingLedgerEntry,
	type SituationBriefing,
	type SourceContextWindow,
	WENYOU_STANDARD_DIRS,
	type WenyouCanonDocSummary,
	type WenyouCanvasEvent,
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
	assertRealTargetInsideWorkspace,
	isPrivateVaultPath,
	isRawChatPath,
	normalizeVaultPath,
	parseMarkdownWithFrontmatter,
	resolveRealPathInsideWorkspace,
} from "./vault-paths";

const MAP_IMAGE_EXTS = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
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

export interface ParsedCampaignManifest {
	worldId: string;
	title: string;
	currentEra?: string;
}

export class WenyouService {
	readonly ntqq: NtqqSyncService;
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
				branches?: Array<{
					currentEra?: string;
				}>;
			};
			const firstBranch = raw.branches?.[0];
			return {
				worldId: raw.worldId || slugSafe(basename(cwd)),
				title: raw.title || basename(cwd),
				currentEra: raw.currentEra ?? firstBranch?.currentEra,
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
	): Promise<SourceContextWindow | null> {
		return lookupSourceContext(cwd, sourceId, windowSize);
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
		},
	) {
		return searchEvidenceRecords(cwd, {
			keyword: query.keyword,
			sender: query.sender,
			groupId: query.groupId,
			since: query.since,
			until: query.until,
			order: query.order,
			limit: query.limit,
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
		},
	): Promise<SearchEvidenceResult> {
		return searchEvidenceWithStats(cwd, {
			keyword: query.keyword,
			sender: query.sender,
			groupId: query.groupId,
			since: query.since,
			until: query.until,
			order: query.order,
			limit: query.limit,
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
				if (!parsed || typeof parsed.id !== "string" || typeof parsed.headline !== "string") continue;
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
			const headline = input.headline.trim();

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
		author?: string;
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
		const cleanBody = input.content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
		await atomicWriteUtf8(mdChecked.absPath, `${fmLines.join("\n")}\n\n${cleanBody}\n`);

		const subtitleParts = [input.actor?.trim(), input.turnLabel?.trim()].filter(Boolean);
		const docxBuf = buildPolicyDocx({
			title: input.title.trim(),
			bodyMarkdown: cleanBody,
			subtitle: subtitleParts.length ? subtitleParts.join(" · ") : undefined,
			createdAt,
			author: input.author,
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
		};

		this.emitCanvas({
			kind: "policy_written",
			cwd: input.cwd,
			policy: artifact,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
		});

		return { ok: true, artifact };
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

	async listCanonDocs(cwd: string): Promise<WenyouCanonDocSummary[]> {
		const roots: Array<{ dir: string; kind: "setting" | "chronicle" }> = [
			{ dir: "01-设定与国力实册", kind: "setting" },
			{ dir: "04-编年史与条约", kind: "chronicle" },
		];
		const docs: WenyouCanonDocSummary[] = [];
		for (const { dir, kind } of roots) {
			const files = await walkRelativeFiles(cwd, dir);
			for (const rel of files) {
				if (!rel.endsWith(".md")) continue;
				const raw = await readFile(join(cwd, rel), "utf8");
				const { data, body } = parseMarkdownWithFrontmatter(raw);
				const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
				docs.push({
					relPath: rel,
					title: typeof data.title === "string" ? data.title : heading || basename(rel, ".md"),
					kind,
					...(typeof data.turn === "number" ? { turn: data.turn } : {}),
					...(typeof data.era === "string" ? { era: data.era } : {}),
				});
			}
		}
		return docs;
	}

	async readCanonDoc(cwd: string, relPath: string): Promise<{ relPath: string; content: string }> {
		const normalized = normalizeVaultPath(relPath);
		if (!normalized || normalized.split("/").includes("..")) {
			throw new Error(`非法文档路径：${relPath}`);
		}
		if (isRawChatPath(normalized)) {
			throw new Error("当前接口禁止读取 00-群聊收集/ 原始群聊目录");
		}
		if (isPrivateVaultPath(normalized)) {
			throw new Error("当前接口禁止读取 private/ 或 .wenyou/ 目录");
		}
		const realTarget = await resolveRealPathInsideWorkspace(cwd, normalized);
		const realRoot = await realpath(resolve(cwd));
		const realRel = normalizeVaultPath(relative(realRoot, realTarget));
		if (isRawChatPath(realRel)) {
			throw new Error("符号链接目标落入 00-群聊收集/，已拒绝读取");
		}
		if (isPrivateVaultPath(realRel)) {
			throw new Error("符号链接目标落入受限目录，已拒绝读取");
		}
		const raw = await readFile(realTarget, "utf8");
		const { body } = parseMarkdownWithFrontmatter(raw);
		return {
			relPath: normalized,
			content: body,
		};
	}

	async getOverview(cwd: string): Promise<WenyouWorkspaceOverview> {
		const initialized = await this.isCampaignWorkspace(cwd);
		const manifest = await this.readManifest(cwd);
		const allEvidence = await loadEvidenceRecords(cwd);
		const rawCursors = await loadCursors(cwd);
		const cursorsMap = refreshCursorStats(allEvidence, rawCursors);
		const cursors = Object.values(cursorsMap).sort((a, b) => a.groupId.localeCompare(b.groupId));
		const unreportedCount = cursors.reduce((sum, c) => sum + c.unreportedCount, 0);
		const [briefings, rollingLedger, policies, maps, canonDocs] = await Promise.all([
			this.listBriefings(cwd),
			this.loadRollingLedger(cwd),
			this.listPolicies(cwd),
			this.listMaps(cwd),
			this.listCanonDocs(cwd),
		]);

		return {
			cwd,
			initialized,
			worldTitle: manifest?.title ?? basename(cwd),
			worldId: manifest?.worldId ?? slugSafe(basename(cwd)),
			...(manifest?.currentEra ? { currentEra: manifest.currentEra } : {}),
			cursors,
			totalEvidenceCount: allEvidence.length,
			unreportedCount,
			briefings,
			rollingLedger,
			policies,
			maps,
			canonDocs,
		};
	}
}
