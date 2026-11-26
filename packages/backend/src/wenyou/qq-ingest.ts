import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
	EvidenceMessageRecord,
	GroupCursorRecord,
	GroupRole,
	SourceContextWindow,
	WenyouPullQqResult,
} from "@percho/shared";

const QQ_DATE_TIME_RE =
	/^(.+?)\s+(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const QQ_TIME_WITH_SEC_RE = /^(.+?)\s+([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const QQ_TIME_NO_SEC_RE = /^(.+?)\s+([01]?\d|2[0-3]):([0-5]\d)$/;
const FULL_DATE_TS_RE = /^\d{4}-\d{2}-\d{2}/;
const DATE_ONLY_TS_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY_TS_RE = /^\d{2}:\d{2}(?::\d{2})?$/;

function isPlausibleShortTimeSender(rawSender: string): boolean {
	const trimmed = rawSender.trim();
	if (!trimmed || trimmed.length > 40) return false;
	// 排除包含正文句末/分句标点或以冒号/等号收尾的普通句子，避免误拆正文中的 "12:30" 或比分
	if (/[。！？，；、：]/.test(trimmed)) return false;
	if (/[.,!?;:=]$/.test(trimmed)) return false;
	return true;
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, filePath);
}

function pad2(val: string): string {
	return val.padStart(2, "0");
}

function normalizeEvidenceTimestamp(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";

	const isoOrDateTime = trimmed.match(
		/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\.\d+)?(?:Z)?$/i,
	);
	if (isoOrDateTime && isoOrDateTime[1] && isoOrDateTime[2] && isoOrDateTime[3] && isoOrDateTime[4] && isoOrDateTime[5]) {
		return `${isoOrDateTime[1]}-${pad2(isoOrDateTime[2])}-${pad2(isoOrDateTime[3])} ${pad2(isoOrDateTime[4])}:${isoOrDateTime[5]}:${pad2(isoOrDateTime[6] ?? "00")}`;
	}

	const dateOnly = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (dateOnly && dateOnly[1] && dateOnly[2] && dateOnly[3]) {
		return `${dateOnly[1]}-${pad2(dateOnly[2])}-${pad2(dateOnly[3])}`;
	}

	const timeWithSec = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/);
	if (timeWithSec && timeWithSec[1] && timeWithSec[2] && timeWithSec[3]) {
		return `${pad2(timeWithSec[1])}:${timeWithSec[2]}:${timeWithSec[3]}`;
	}

	const timeNoSec = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
	if (timeNoSec && timeNoSec[1] && timeNoSec[2]) {
		return `${pad2(timeNoSec[1])}:${timeNoSec[2]}`;
	}

	return trimmed;
}

function cleanSender(rawSender: string): { sender: string; senderId?: string } {
	const trimmed = rawSender.trim();
	const idMatch = trimmed.match(/[（(](qq-demo-\d+|\d{5,12}|[^()（）\s]+@[^()（）\s]+)[)）]$/);
	const senderId = idMatch?.[1];
	const cleaned = trimmed
		.replace(/\s*[（(](?:qq-demo-\d+|\d{5,12}|[^()（）\s]+@[^()（）\s]+)[)）]$/, "")
		.trim();
	return { sender: cleaned.length > 0 ? cleaned : trimmed, ...(senderId ? { senderId } : {}) };
}

export function computeEvidenceFingerprint(record: {
	groupId: string;
	sender: string;
	timestamp: string;
	text: string;
}): string {
	const payload = `${record.groupId}\0${record.sender}\0${record.timestamp}\0${record.text}`;
	let h1 = 0x811c9dc5;
	let h2 = 0x9e3779b1;
	for (let i = 0; i < payload.length; i += 1) {
		const code = payload.charCodeAt(i);
		h1 ^= code;
		h1 = Math.imul(h1, 0x01000193) >>> 0;
		h2 ^= code ^ (i & 0xff);
		h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
	}
	return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function inferGroupMeta(fileName: string): {
	groupId: string;
	groupName: string;
	role: GroupRole;
} {
	const stem = basename(fileName, extname(fileName));
	const idMatch = stem.match(/(group-[a-z0-9-]+|\d{6,12})/i);
	const groupId = idMatch?.[1]?.toLowerCase() ?? stem.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-");
	const lower = stem.toLowerCase();
	let role: GroupRole = "other";
	if (lower.includes("主群") || lower.includes("main")) {
		role = "main";
	} else if (lower.includes("骰") || lower.includes("dice")) {
		role = "dice";
	} else if (lower.includes("内阁") || lower.includes("密") || lower.includes("cabinet") || lower.includes("private")) {
		role = "cabinet";
	} else if (lower.includes("外交") || lower.includes("diplomacy")) {
		role = "diplomacy";
	}
	const groupName = stem.replace(/[_-]group-[a-z0-9-]+$/i, "").trim() || stem;
	return { groupId, groupName, role };
}

interface ParsedEvidenceCandidate {
	record: Omit<EvidenceMessageRecord, "lineIndex">;
	hasExplicitSourceId: boolean;
}

function parsePlainTextMessages(
	rawText: string,
	meta: { groupId: string; groupName: string; role: GroupRole },
): ParsedEvidenceCandidate[] {
	const lines = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
	const records: ParsedEvidenceCandidate[] = [];
	let current: { sender: string; senderId?: string; timestamp: string; body: string[] } | null = null;
	let lastSeenDate: string | undefined;

	const flush = () => {
		if (!current) return;
		const text = current.body.join("\n").trim();
		if (!text) {
			current = null;
			return;
		}
		const fp = computeEvidenceFingerprint({
			groupId: meta.groupId,
			sender: current.sender,
			timestamp: current.timestamp,
			text,
		});
		records.push({
			hasExplicitSourceId: false,
			record: {
				sourceId: `${meta.groupId}-${fp.slice(0, 8)}`,
				groupId: meta.groupId,
				groupName: meta.groupName,
				sender: current.sender,
				...(current.senderId ? { senderId: current.senderId } : {}),
				timestamp: current.timestamp,
				text,
				fingerprint: fp,
			},
		});
		current = null;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		const dtMatch = trimmed.match(QQ_DATE_TIME_RE);
		if (dtMatch && dtMatch[1] && dtMatch[2] && dtMatch[3] && dtMatch[4] && dtMatch[5] && dtMatch[6]) {
			flush();
			const datePart = `${dtMatch[2]}-${pad2(dtMatch[3])}-${pad2(dtMatch[4])}`;
			lastSeenDate = datePart;
			const cleaned = cleanSender(dtMatch[1]);
			current = {
				sender: cleaned.sender,
				senderId: cleaned.senderId,
				timestamp: `${datePart} ${pad2(dtMatch[5])}:${dtMatch[6]}:${pad2(dtMatch[7] ?? "00")}`,
				body: [],
			};
			continue;
		}
		const secMatch = trimmed.match(QQ_TIME_WITH_SEC_RE);
		if (secMatch && secMatch[1] && secMatch[2] && secMatch[3] && secMatch[4]) {
			flush();
			const cleaned = cleanSender(secMatch[1]);
			const timePart = `${pad2(secMatch[2])}:${secMatch[3]}:${secMatch[4]}`;
			current = {
				sender: cleaned.sender,
				senderId: cleaned.senderId,
				timestamp: lastSeenDate ? `${lastSeenDate} ${timePart}` : timePart,
				body: [],
			};
			continue;
		}
		if (lastSeenDate) {
			const shortMatch = trimmed.match(QQ_TIME_NO_SEC_RE);
			if (shortMatch && shortMatch[1] && shortMatch[2] && shortMatch[3] && isPlausibleShortTimeSender(shortMatch[1])) {
				flush();
				const cleaned = cleanSender(shortMatch[1]);
				current = {
					sender: cleaned.sender,
					senderId: cleaned.senderId,
					timestamp: `${lastSeenDate} ${pad2(shortMatch[2])}:${shortMatch[3]}:00`,
					body: [],
				};
				continue;
			}
		}
		if (current) current.body.push(line);
	}
	flush();
	return records;
}

interface RawJsonMessage {
	sourceId?: unknown;
	id?: unknown;
	messageId?: unknown;
	sender?: unknown;
	senderName?: unknown;
	nickname?: unknown;
	senderId?: unknown;
	uin?: unknown;
	timestamp?: unknown;
	time?: unknown;
	text?: unknown;
	content?: unknown;
	groupId?: unknown;
	groupName?: unknown;
}

function normalizeRawJsonItems(
	items: RawJsonMessage[],
	fallbackMeta: { groupId: string; groupName: string; role: GroupRole },
): ParsedEvidenceCandidate[] {
	const out: ParsedEvidenceCandidate[] = [];
	for (const raw of items) {
		const rawText = typeof raw.text === "string" ? raw.text : typeof raw.content === "string" ? raw.content : "";
		const text = rawText.trim();
		if (!text) continue;
		const groupId = typeof raw.groupId === "string" && raw.groupId.trim() ? raw.groupId.trim() : fallbackMeta.groupId;
		const groupName =
			typeof raw.groupName === "string" && raw.groupName.trim() ? raw.groupName.trim() : fallbackMeta.groupName;
		const senderRaw =
			(typeof raw.sender === "string" && raw.sender) ||
			(typeof raw.senderName === "string" && raw.senderName) ||
			(typeof raw.nickname === "string" && raw.nickname) ||
			"未知发言人";
		const cleaned = cleanSender(senderRaw);
		const senderId =
			(typeof raw.senderId === "string" && raw.senderId.trim()) ||
			(typeof raw.uin === "string" && raw.uin.trim()) ||
			cleaned.senderId;
		const rawTimestamp =
			(typeof raw.timestamp === "string" && raw.timestamp.trim()) ||
			(typeof raw.time === "string" && raw.time.trim()) ||
			"";
		const timestamp = normalizeEvidenceTimestamp(rawTimestamp);
		const fp = computeEvidenceFingerprint({ groupId, sender: cleaned.sender, timestamp, text });
		const explicitId =
			(typeof raw.sourceId === "string" && raw.sourceId.trim()) ||
			(typeof raw.id === "string" && raw.id.trim()) ||
			(typeof raw.messageId === "string" && raw.messageId.trim()) ||
			"";
		out.push({
			hasExplicitSourceId: explicitId.length > 0,
			record: {
				sourceId: explicitId || `${groupId}-${fp.slice(0, 8)}`,
				groupId,
				groupName,
				sender: cleaned.sender,
				...(senderId ? { senderId } : {}),
				timestamp,
				text,
				fingerprint: fp,
			},
		});
	}
	return out;
}

export function evidenceJsonlPath(cwd: string): string {
	return join(cwd, ".wenyou", "evidence.jsonl");
}

export function cursorsJsonPath(cwd: string): string {
	return join(cwd, ".wenyou", "cursors.json");
}

export async function loadEvidenceRecords(cwd: string): Promise<EvidenceMessageRecord[]> {
	const file = evidenceJsonlPath(cwd);
	if (!existsSync(file)) return [];
	const raw = await readFile(file, "utf8");
	const records: EvidenceMessageRecord[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<EvidenceMessageRecord>;
			if (parsed && typeof parsed.sourceId === "string" && typeof parsed.text === "string") {
				records.push({
					sourceId: parsed.sourceId,
					groupId: typeof parsed.groupId === "string" ? parsed.groupId : "",
					groupName: typeof parsed.groupName === "string" ? parsed.groupName : "",
					sender: typeof parsed.sender === "string" ? parsed.sender : "未知发言人",
					...(typeof parsed.senderId === "string" && parsed.senderId ? { senderId: parsed.senderId } : {}),
					timestamp: typeof parsed.timestamp === "string" ? normalizeEvidenceTimestamp(parsed.timestamp) : "",
					text: parsed.text,
					fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : "",
					lineIndex: records.length,
				});
			}
		} catch {
			// skip corrupted jsonl line
		}
	}
	return records;
}

export async function saveEvidenceRecords(cwd: string, records: readonly EvidenceMessageRecord[]): Promise<void> {
	const lines = records.map((rec, idx) => JSON.stringify({ ...rec, lineIndex: idx }));
	await atomicWriteUtf8(evidenceJsonlPath(cwd), lines.length ? `${lines.join("\n")}\n` : "");
}

export async function loadCursors(cwd: string): Promise<Record<string, GroupCursorRecord>> {
	const file = cursorsJsonPath(cwd);
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(await readFile(file, "utf8")) as
			| { groups?: Record<string, GroupCursorRecord> }
			| Record<string, GroupCursorRecord>;
		if (raw && typeof raw === "object" && "groups" in raw && raw.groups && typeof raw.groups === "object") {
			return raw.groups as Record<string, GroupCursorRecord>;
		}
		return (raw && typeof raw === "object" ? raw : {}) as Record<string, GroupCursorRecord>;
	} catch {
		return {};
	}
}

export async function saveCursors(cwd: string, cursors: Record<string, GroupCursorRecord>): Promise<void> {
	await atomicWriteUtf8(cursorsJsonPath(cwd), JSON.stringify({ version: 1, groups: cursors }, null, 2));
}

export function computeUnreportedMessages(
	records: readonly EvidenceMessageRecord[],
	cursors: Record<string, GroupCursorRecord>,
	groupId?: string,
): EvidenceMessageRecord[] {
	const byGroup = new Map<string, EvidenceMessageRecord[]>();
	for (const rec of records) {
		if (groupId && rec.groupId !== groupId) continue;
		const list = byGroup.get(rec.groupId) ?? [];
		list.push(rec);
		byGroup.set(rec.groupId, list);
	}
	const unreported: EvidenceMessageRecord[] = [];
	for (const [gid, list] of byGroup) {
		const cursor = cursors[gid];
		const reportedId = cursor?.lastReportedSourceId;
		if (!reportedId) {
			unreported.push(...list);
			continue;
		}
		const idx = list.findIndex((item) => item.sourceId === reportedId);
		if (idx === -1) {
			unreported.push(...list);
		} else {
			unreported.push(...list.slice(idx + 1));
		}
	}
	return unreported;
}

export function refreshCursorStats(
	records: readonly EvidenceMessageRecord[],
	existingCursors: Record<string, GroupCursorRecord>,
	sourceFilesByGroup?: Map<string, Set<string>>,
): Record<string, GroupCursorRecord> {
	const byGroup = new Map<string, EvidenceMessageRecord[]>();
	for (const rec of records) {
		const list = byGroup.get(rec.groupId) ?? [];
		list.push(rec);
		byGroup.set(rec.groupId, list);
	}
	const next: Record<string, GroupCursorRecord> = { ...existingCursors };
	for (const [gid, list] of byGroup) {
		const prev = existingCursors[gid];
		const last = list[list.length - 1];
		const reportedId = prev?.lastReportedSourceId ?? null;
		let unreportedCount = list.length;
		if (reportedId) {
			const idx = list.findIndex((item) => item.sourceId === reportedId);
			unreportedCount = idx === -1 ? list.length : Math.max(0, list.length - 1 - idx);
		}
		const inferred = inferGroupMeta(last?.groupName ?? gid);
		const files = new Set<string>(prev?.sourceFiles ?? []);
		for (const f of sourceFilesByGroup?.get(gid) ?? []) files.add(f);
		next[gid] = {
			groupId: gid,
			groupName: prev?.groupName || last?.groupName || inferred.groupName,
			role: prev?.role || inferred.role,
			totalIngested: list.length,
			lastIngestedSourceId: last?.sourceId ?? null,
			lastIngestedTimestamp: last?.timestamp ? last.timestamp : null,
			lastReportedSourceId: reportedId,
			lastReportedAt: prev?.lastReportedAt ?? null,
			unreportedCount,
			sourceFiles: [...files].sort(),
		};
	}
	return next;
}

async function listCollectFiles(dir: string, relPrefix = ""): Promise<Array<{ absPath: string; relPath: string }>> {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const out: Array<{ absPath: string; relPath: string }> = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const absPath = join(dir, entry.name);
		const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...(await listCollectFiles(absPath, relPath)));
		} else if (entry.isFile()) {
			const ext = extname(entry.name).toLowerCase();
			if (ext === ".txt" || ext === ".json" || ext === ".jsonl") {
				out.push({ absPath, relPath });
			}
		}
	}
	return out;
}

export const DEFAULT_SOURCE_CONTEXT_WINDOW = 30;
export const MAX_SOURCE_CONTEXT_WINDOW = 10_000;
export const DEFAULT_EVIDENCE_SEARCH_LIMIT = 50;
export const MAX_EVIDENCE_SEARCH_LIMIT = 500;

function extractNtqqRowid(sourceId: string): number | null {
	const match = sourceId.match(/^qq-\d+-(\d+)(?:-\d+)?$/);
	if (!match?.[1]) return null;
	const num = Number.parseInt(match[1], 10);
	return Number.isFinite(num) ? num : null;
}

/**
 * 时间桶顺序（严格弱序）：
 * - 0: 无时间戳 `""` / 无法解析文本（保持原始写入顺序）
 * - 1: 纯时分秒 `HH:MM[:SS]`
 * - 2: 完整日期 `YYYY-MM-DD[ HH:MM:SS]`
 * 无日期记录排在完整日期记录之前，确保新到来的带日期消息永远落在队列尾部，
 * 绝不会被停留在无日期尾记录上的 `lastReportedSourceId` 吞掉。
 */
function timestampBucket(ts: string): number {
	if (FULL_DATE_TS_RE.test(ts)) return 2;
	if (TIME_ONLY_TS_RE.test(ts)) return 1;
	return 0;
}

function sortableTimestampKey(ts: string): string {
	if (DATE_ONLY_TS_RE.test(ts)) return `${ts} 00:00:00`;
	if (/^\d{2}:\d{2}$/.test(ts)) return `${ts}:00`;
	return ts;
}

function compareEvidenceTimestamps(a: string, b: string): number {
	const bucketA = timestampBucket(a);
	const bucketB = timestampBucket(b);
	if (bucketA !== bucketB) return bucketA - bucketB;
	if (bucketA === 0) return 0;
	const keyA = sortableTimestampKey(a);
	const keyB = sortableTimestampKey(b);
	if (keyA === keyB) return 0;
	return keyA < keyB ? -1 : 1;
}

function sortEvidenceChronologically(records: EvidenceMessageRecord[]): EvidenceMessageRecord[] {
	return records
		.map((rec, orderIdx) => ({ rec, orderIdx }))
		.sort((a, b) => {
			const tsCmp = compareEvidenceTimestamps(a.rec.timestamp, b.rec.timestamp);
			if (tsCmp !== 0) return tsCmp;
			if (a.rec.groupId === b.rec.groupId) {
				const rowA = extractNtqqRowid(a.rec.sourceId);
				const rowB = extractNtqqRowid(b.rec.sourceId);
				if (rowA !== null && rowB !== null && rowA !== rowB) return rowA - rowB;
			}
			return a.orderIdx - b.orderIdx;
		})
		.map(({ rec }, idx) => ({ ...rec, lineIndex: idx }));
}

function normalizeDateBound(raw: string | undefined, bound: "since" | "until"): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;

	const dateOnly = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
	if (dateOnly && dateOnly[1] && dateOnly[2] && dateOnly[3]) {
		const base = `${dateOnly[1]}-${pad2(dateOnly[2])}-${pad2(dateOnly[3])}`;
		return bound === "since" ? `${base} 00:00:00` : `${base} 23:59:59`;
	}

	const dateTimeNoSec = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+([01]?\d|2[0-3]):([0-5]\d)$/);
	if (dateTimeNoSec && dateTimeNoSec[1] && dateTimeNoSec[2] && dateTimeNoSec[3] && dateTimeNoSec[4] && dateTimeNoSec[5]) {
		const base = `${dateTimeNoSec[1]}-${pad2(dateTimeNoSec[2])}-${pad2(dateTimeNoSec[3])} ${pad2(dateTimeNoSec[4])}:${dateTimeNoSec[5]}`;
		return bound === "since" ? `${base}:00` : `${base}:59`;
	}

	const dateTimeWithSec = trimmed.match(
		/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z)?$/i,
	);
	if (
		dateTimeWithSec &&
		dateTimeWithSec[1] &&
		dateTimeWithSec[2] &&
		dateTimeWithSec[3] &&
		dateTimeWithSec[4] &&
		dateTimeWithSec[5] &&
		dateTimeWithSec[6]
	) {
		return `${dateTimeWithSec[1]}-${pad2(dateTimeWithSec[2])}-${pad2(dateTimeWithSec[3])} ${pad2(dateTimeWithSec[4])}:${dateTimeWithSec[5]}:${dateTimeWithSec[6]}`;
	}

	const timeNoSec = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
	if (timeNoSec && timeNoSec[1] && timeNoSec[2]) {
		const base = `${pad2(timeNoSec[1])}:${timeNoSec[2]}`;
		return bound === "since" ? `${base}:00` : `${base}:59`;
	}

	const timeWithSec = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/);
	if (timeWithSec && timeWithSec[1] && timeWithSec[2] && timeWithSec[3]) {
		return `${pad2(timeWithSec[1])}:${timeWithSec[2]}:${timeWithSec[3]}`;
	}

	return trimmed.replace("T", " ");
}

function matchesDateBound(timestamp: string, boundValue: string, kind: "since" | "until"): boolean {
	const normalized = normalizeEvidenceTimestamp(timestamp);
	if (!normalized) return false;
	if (FULL_DATE_TS_RE.test(boundValue)) {
		if (!FULL_DATE_TS_RE.test(normalized)) return false;
		const comparable = DATE_ONLY_TS_RE.test(normalized) ? `${normalized} 00:00:00` : normalized;
		return kind === "since" ? comparable >= boundValue : comparable <= boundValue;
	}
	if (TIME_ONLY_TS_RE.test(boundValue)) {
		let comparable = "";
		if (TIME_ONLY_TS_RE.test(normalized)) {
			comparable = normalized.length === 5 ? `${normalized}:00` : normalized;
		} else if (FULL_DATE_TS_RE.test(normalized) && !DATE_ONLY_TS_RE.test(normalized)) {
			comparable = normalized.slice(11);
		}
		if (!comparable) return false;
		return kind === "since" ? comparable >= boundValue : comparable <= boundValue;
	}
	return kind === "since" ? normalized >= boundValue : normalized <= boundValue;
}

/**
 * 将外部已解码的消息集合（如本机 NTQQ VFS 直读拉取结果）按统一指纹幂等合入 `.wenyou/evidence.jsonl` 并推进双游标。
 * 若回溯补抓了早于现有记录的历史消息，自动按时间线重排以保持上下文邻接与未汇报游标准确。
 */
export interface ExternalEvidenceMessageInput {
	sourceId?: string;
	groupId: string;
	groupName: string;
	role?: GroupRole;
	sender: string;
	senderId?: string;
	timestamp: string;
	text: string;
	sourceTag?: string;
}

export async function ingestExternalMessages(
	cwd: string,
	items: readonly ExternalEvidenceMessageInput[],
): Promise<{
	newlyIngested: number;
	skippedDuplicates: number;
	totalEvidenceCount: number;
	perGroupCounts: Record<string, { newlyIngested: number; skippedDuplicates: number }>;
	cursors: GroupCursorRecord[];
}> {
	const existing = await loadEvidenceRecords(cwd);
	const cursors = await loadCursors(cwd);
	const seenFp = new Set(existing.map((r) => r.fingerprint));
	const usedIds = new Set(existing.map((r) => r.sourceId));
	const lastExistingTsByGroup = new Map<string, string>();
	const lastExistingRowidByGroup = new Map<string, number>();
	let lastGlobalFullTs = "";
	for (const rec of existing) {
		if (!FULL_DATE_TS_RE.test(rec.timestamp)) continue;
		const key = sortableTimestampKey(rec.timestamp);
		if (!lastGlobalFullTs || key > lastGlobalFullTs) lastGlobalFullTs = key;
		const prevTs = lastExistingTsByGroup.get(rec.groupId);
		const rowid = extractNtqqRowid(rec.sourceId);
		if (!prevTs || key > prevTs) {
			lastExistingTsByGroup.set(rec.groupId, key);
			if (rowid !== null) lastExistingRowidByGroup.set(rec.groupId, rowid);
			else lastExistingRowidByGroup.delete(rec.groupId);
		} else if (key === prevTs && rowid !== null) {
			const prevRow = lastExistingRowidByGroup.get(rec.groupId);
			if (prevRow === undefined || rowid > prevRow) {
				lastExistingRowidByGroup.set(rec.groupId, rowid);
			}
		}
	}
	let merged: EvidenceMessageRecord[] = [...existing];
	const sourceFilesByGroup = new Map<string, Set<string>>();
	const perGroupCounts: Record<string, { newlyIngested: number; skippedDuplicates: number }> = {};

	let newlyIngested = 0;
	let skippedDuplicates = 0;
	let needsChronoSort = false;

	for (const raw of items) {
		const text = raw.text.trim();
		if (!text) continue;
		const groupId = raw.groupId.trim();
		if (!groupId) continue;
		const groupName = raw.groupName.trim() || groupId;
		const sender = raw.sender.trim() || "未知成员";
		const timestamp = normalizeEvidenceTimestamp(raw.timestamp);
		const fp = computeEvidenceFingerprint({ groupId, sender, timestamp, text });

		const tag = raw.sourceTag || `ntqq://group/${groupId}`;
		const files = sourceFilesByGroup.get(groupId) ?? new Set<string>();
		files.add(tag);
		sourceFilesByGroup.set(groupId, files);

		const counter = perGroupCounts[groupId] ?? { newlyIngested: 0, skippedDuplicates: 0 };
		perGroupCounts[groupId] = counter;

		const explicitSourceId = raw.sourceId?.trim() || "";
		if (explicitSourceId) {
			if (usedIds.has(explicitSourceId)) {
				skippedDuplicates += 1;
				counter.skippedDuplicates += 1;
				continue;
			}
		} else if (seenFp.has(fp)) {
			skippedDuplicates += 1;
			counter.skippedDuplicates += 1;
			continue;
		}
		let sourceId = explicitSourceId || `qq-${groupId}-${fp.slice(0, 8)}`;
		if (!explicitSourceId && usedIds.has(sourceId)) {
			let suffix = 2;
			while (usedIds.has(`${sourceId}-${suffix}`)) suffix += 1;
			sourceId = `${sourceId}-${suffix}`;
		}
		if (FULL_DATE_TS_RE.test(timestamp)) {
			const tsKey = sortableTimestampKey(timestamp);
			const prevGroupMaxTs = lastExistingTsByGroup.get(groupId);
			const rowid = extractNtqqRowid(sourceId);
			if (
				(prevGroupMaxTs && tsKey < prevGroupMaxTs) ||
				(lastGlobalFullTs && tsKey < lastGlobalFullTs)
			) {
				needsChronoSort = true;
			} else if (prevGroupMaxTs && tsKey === prevGroupMaxTs && rowid !== null) {
				const prevRow = lastExistingRowidByGroup.get(groupId);
				if (prevRow !== undefined && rowid < prevRow) {
					needsChronoSort = true;
				}
			}
			if (!lastGlobalFullTs || tsKey > lastGlobalFullTs) lastGlobalFullTs = tsKey;
			if (!prevGroupMaxTs || tsKey > prevGroupMaxTs) {
				lastExistingTsByGroup.set(groupId, tsKey);
				if (rowid !== null) lastExistingRowidByGroup.set(groupId, rowid);
				else lastExistingRowidByGroup.delete(groupId);
			} else if (tsKey === prevGroupMaxTs && rowid !== null) {
				const prevRow = lastExistingRowidByGroup.get(groupId);
				if (prevRow === undefined || rowid > prevRow) {
					lastExistingRowidByGroup.set(groupId, rowid);
				}
			}
		}
		seenFp.add(fp);
		usedIds.add(sourceId);
		merged.push({
			sourceId,
			groupId,
			groupName,
			sender,
			...(raw.senderId ? { senderId: raw.senderId } : {}),
			timestamp,
			text,
			fingerprint: fp,
			lineIndex: merged.length,
		});
		newlyIngested += 1;
		counter.newlyIngested += 1;
	}

	if (needsChronoSort) {
		merged = sortEvidenceChronologically(merged);
	}

	if (newlyIngested > 0 || !existsSync(evidenceJsonlPath(cwd))) {
		await saveEvidenceRecords(cwd, merged);
	}
	const updatedCursors = refreshCursorStats(merged, cursors, sourceFilesByGroup);
	for (const raw of items) {
		const gid = raw.groupId.trim();
		const cur = updatedCursors[gid];
		if (cur) {
			if (raw.groupName.trim()) cur.groupName = raw.groupName.trim();
			if (raw.role) cur.role = raw.role;
		}
	}
	await saveCursors(cwd, updatedCursors);

	return {
		newlyIngested,
		skippedDuplicates,
		totalEvidenceCount: merged.length,
		perGroupCounts,
		cursors: Object.values(updatedCursors).sort((a, b) => a.groupId.localeCompare(b.groupId)),
	};
}

/**
 * 扫描 `00-群聊收集/` 多群聊天文件并增量合入 `.wenyou/evidence.jsonl`：
 * - 支持 QQ 纯文本粘贴 `.txt`、QCE `.json`、`.jsonl`
 * - 按显式 sourceId（优先）与指纹幂等去重
 * - 严格区分总入库游标 (`lastIngestedSourceId`) 与上次简报已汇报游标 (`lastReportedSourceId`)
 */
export async function pullQqGroupsIncremental(cwd: string, groupIdFilter?: string): Promise<WenyouPullQqResult> {
	const existing = await loadEvidenceRecords(cwd);
	const cursors = await loadCursors(cwd);
	const seenFp = new Set(existing.map((r) => r.fingerprint));
	const usedIds = new Set(existing.map((r) => r.sourceId));
	const lastExistingTsByGroup = new Map<string, string>();
	let lastGlobalFullTs = "";
	for (const rec of existing) {
		if (!FULL_DATE_TS_RE.test(rec.timestamp)) continue;
		const key = sortableTimestampKey(rec.timestamp);
		if (!lastGlobalFullTs || key > lastGlobalFullTs) lastGlobalFullTs = key;
		const prevTs = lastExistingTsByGroup.get(rec.groupId);
		if (!prevTs || key > prevTs) lastExistingTsByGroup.set(rec.groupId, key);
	}
	let merged: EvidenceMessageRecord[] = [...existing];
	const sourceFilesByGroup = new Map<string, Set<string>>();

	let newlyIngested = 0;
	let skippedDuplicates = 0;
	let needsChronoSort = false;

	const collectDir = join(cwd, "00-群聊收集");
	const files = await listCollectFiles(collectDir);

	for (const file of files) {
		const meta = inferGroupMeta(file.relPath);
		if (groupIdFilter && meta.groupId !== groupIdFilter) continue;
		const ext = extname(file.absPath).toLowerCase();
		const content = await readFile(file.absPath, "utf8");
		let parsed: ParsedEvidenceCandidate[] = [];

		if (ext === ".txt") {
			parsed = parsePlainTextMessages(content, meta);
		} else if (ext === ".json") {
			try {
				const doc = JSON.parse(content) as
					| RawJsonMessage[]
					| {
							groupId?: string;
							groupName?: string;
							chatInfo?: { name?: string; uin?: string };
							messages?: RawJsonMessage[];
							records?: RawJsonMessage[];
					  };
				const effectiveMeta = { ...meta };
				if (!Array.isArray(doc) && doc && typeof doc === "object") {
					if (typeof doc.groupId === "string" && doc.groupId.trim()) effectiveMeta.groupId = doc.groupId.trim();
					if (typeof doc.groupName === "string" && doc.groupName.trim()) {
						effectiveMeta.groupName = doc.groupName.trim();
					} else if (typeof doc.chatInfo?.name === "string" && doc.chatInfo.name.trim()) {
						effectiveMeta.groupName = doc.chatInfo.name.trim();
					}
				}
				const items = Array.isArray(doc)
					? doc
					: Array.isArray(doc?.messages)
						? doc.messages
						: Array.isArray(doc?.records)
							? doc.records
							: [];
				parsed = normalizeRawJsonItems(items, effectiveMeta);
			} catch {
				parsed = [];
			}
		} else if (ext === ".jsonl") {
			const items: RawJsonMessage[] = [];
			for (const line of content.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					items.push(JSON.parse(trimmed) as RawJsonMessage);
				} catch {
					// skip bad line
				}
			}
			parsed = normalizeRawJsonItems(items, meta);
		}

		for (const candidate of parsed) {
			const item = candidate.record;
			const set = sourceFilesByGroup.get(item.groupId) ?? new Set<string>();
			set.add(`00-群聊收集/${file.relPath}`);
			sourceFilesByGroup.set(item.groupId, set);

			if (candidate.hasExplicitSourceId) {
				if (usedIds.has(item.sourceId)) {
					skippedDuplicates += 1;
					continue;
				}
			} else if (seenFp.has(item.fingerprint)) {
				skippedDuplicates += 1;
				continue;
			}
			let sourceId = item.sourceId;
			if (!candidate.hasExplicitSourceId && usedIds.has(sourceId)) {
				let suffix = 2;
				while (usedIds.has(`${sourceId}-${suffix}`)) suffix += 1;
				sourceId = `${sourceId}-${suffix}`;
			}
			if (FULL_DATE_TS_RE.test(item.timestamp)) {
				const tsKey = sortableTimestampKey(item.timestamp);
				const prevGroupMaxTs = lastExistingTsByGroup.get(item.groupId);
				if ((prevGroupMaxTs && tsKey < prevGroupMaxTs) || (lastGlobalFullTs && tsKey < lastGlobalFullTs)) {
					needsChronoSort = true;
				}
				if (!lastGlobalFullTs || tsKey > lastGlobalFullTs) lastGlobalFullTs = tsKey;
				if (!prevGroupMaxTs || tsKey > prevGroupMaxTs) lastExistingTsByGroup.set(item.groupId, tsKey);
			}
			seenFp.add(item.fingerprint);
			usedIds.add(sourceId);
			merged.push({ ...item, sourceId, lineIndex: merged.length });
			newlyIngested += 1;
		}
	}

	if (needsChronoSort) {
		merged = sortEvidenceChronologically(merged);
	}

	if (newlyIngested > 0 || !existsSync(evidenceJsonlPath(cwd))) {
		await saveEvidenceRecords(cwd, merged);
	}
	const updatedCursors = refreshCursorStats(merged, cursors, sourceFilesByGroup);
	await saveCursors(cwd, updatedCursors);

	const unreportedMessages = computeUnreportedMessages(merged, updatedCursors, groupIdFilter);
	return {
		cwd,
		newlyIngested,
		skippedDuplicates,
		totalEvidenceCount: merged.length,
		unreportedMessages,
		cursors: Object.values(updatedCursors).sort((a, b) => a.groupId.localeCompare(b.groupId)),
	};
}

/** 按 sourceId 回查同群前后 N（默认 30，最高支持 10,000 单侧即覆盖 20,000 条单群上限）条上下文 */
export async function lookupSourceContext(
	cwd: string,
	sourceId: string,
	windowSize = DEFAULT_SOURCE_CONTEXT_WINDOW,
): Promise<SourceContextWindow | null> {
	const all = await loadEvidenceRecords(cwd);
	const hit = all.find((rec) => rec.sourceId === sourceId);
	if (!hit) return null;
	const sameGroup = all.filter((rec) => rec.groupId === hit.groupId);
	const idx = sameGroup.findIndex((rec) => rec.sourceId === sourceId);
	if (idx === -1) return null;
	const win = Math.max(0, Math.min(MAX_SOURCE_CONTEXT_WINDOW, Math.floor(windowSize)));
	const start = Math.max(0, idx - win);
	const end = Math.min(sameGroup.length, idx + win + 1);
	return {
		targetSourceId: hit.sourceId,
		groupId: hit.groupId,
		groupName: hit.groupName,
		targetIndex: idx - start,
		messages: sameGroup.slice(start, end),
		windowSize: win,
		totalGroupMessages: sameGroup.length,
		beforeRemaining: start,
		afterRemaining: Math.max(0, sameGroup.length - end),
	};
}

export interface SearchEvidenceQuery {
	keyword?: string;
	sender?: string;
	groupId?: string;
	since?: string;
	until?: string;
	order?: "latest" | "earliest";
	limit?: number;
}

export interface SearchEvidenceResult {
	records: EvidenceMessageRecord[];
	totalScanned: number;
	totalMatched: number;
	order: "latest" | "earliest";
}

/** 按关键词/发言人/时间段全库检索 L0 证据库，返回全库扫描与命中统计，支持按最早或最近顺序回溯 */
export async function searchEvidenceWithStats(
	cwd: string,
	query: SearchEvidenceQuery,
): Promise<SearchEvidenceResult> {
	const all = await loadEvidenceRecords(cwd);
	const kw = query.keyword?.trim().toLowerCase();
	const senderKw = query.sender?.trim().toLowerCase();
	const sinceNorm = normalizeDateBound(query.since, "since");
	const untilNorm = normalizeDateBound(query.until, "until");
	const limit = Math.max(1, Math.min(MAX_EVIDENCE_SEARCH_LIMIT, Math.floor(query.limit ?? DEFAULT_EVIDENCE_SEARCH_LIMIT)));
	const order: "latest" | "earliest" = query.order === "earliest" ? "earliest" : "latest";
	const matched = all.filter((rec) => {
		if (query.groupId && rec.groupId !== query.groupId) return false;
		if (sinceNorm && !matchesDateBound(rec.timestamp, sinceNorm, "since")) return false;
		if (untilNorm && !matchesDateBound(rec.timestamp, untilNorm, "until")) return false;
		if (senderKw && !rec.sender.toLowerCase().includes(senderKw)) return false;
		if (kw && !rec.text.toLowerCase().includes(kw) && !rec.sender.toLowerCase().includes(kw)) return false;
		return true;
	});
	const records = order === "earliest" ? matched.slice(0, limit) : matched.slice(-limit);
	return {
		records,
		totalScanned: all.length,
		totalMatched: matched.length,
		order,
	};
}

/** 按关键词/发言人检索 L0 证据库 */
export async function searchEvidenceRecords(
	cwd: string,
	query: SearchEvidenceQuery,
): Promise<EvidenceMessageRecord[]> {
	const res = await searchEvidenceWithStats(cwd, query);
	return res.records;
}
