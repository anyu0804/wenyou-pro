import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	CampaignNtqqGroupBinding,
	GroupRole,
	NtqqDetectedAccount,
	NtqqGroupSummary,
	NtqqLocalConfig,
	NtqqProbeStatus,
	NtqqStatusSnapshot,
	NtqqSyncCampaignResult,
	NtqqSyncGroupDetail,
} from "@percho/shared";
import { computeUnreportedMessages, ingestExternalMessages, loadCursors, loadEvidenceRecords } from "./qq-ingest";

const QQ_UIN_RE = /^\d{5,12}$/;
const GROUP_ID_RE = /^\d{5,15}$/;
const BRIDGE_PREFIX = "__NTQQ_BRIDGE__";
const KEY_EXTRACT_ATTEMPT_TIMEOUT_MS = 12_000;
const KEY_EXTRACT_POLL_INTERVAL_MS = 150;
const VFS_RUN_TIMEOUT_MS = 90_000;
const NTQQ_EXT_HEADER = 1024;
const NTQQ_PAGE_SIZE = 4096;
const NTQQ_SALT_SIZE = 16;
const HEX_SALT_RE = /^[0-9a-f]{32}$/;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

const FATAL_KEY_DUMP_PATTERNS: readonly RegExp[] = [
	/ERROR:\s*No keys recovered/i,
	/ERROR:\s*No QQ\.exe found/i,
	/Cannot open PID/i,
	/Failed to open (?:process|PID)/i,
	/ERROR:\s*DB dir not found/i,
];
const KEY_DUMP_WAITING_RE = /Waiting for QQ to exit|press Enter to proceed/i;
const KEY_DUMP_SAVED_RE = /Key map saved to/i;
const KEY_DUMP_ZERO_SALTS_RE = /\b0 salts matched\b/i;

const REQUIRED_BRIDGE_FILES = [
	"ntqq_vfs.py",
	"wenyou_vfs_sync.py",
	"wenyou_read.py",
	"wenyou_ntqq_bridge.py",
] as const;

interface CampaignNtqqSyncWatermark {
	lastTs: number;
	lastRowid: string;
	lastSyncedAt: string;
}

type CampaignNtqqSyncState = Record<string, CampaignNtqqSyncWatermark>;

interface BridgeExportedMessage {
	sourceId: string;
	groupId: string;
	groupName: string;
	sender: string;
	senderId?: string | null;
	timestamp: string;
	ts: number;
	rowid: string | number;
	text: string;
}

/** 将历史 number 或十进制字符串 rowid 无损规范化为十进制数字字符串，非法值回退 "0" */
function normalizeDecimalRowid(raw: unknown): string {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (/^\d+$/.test(trimmed)) {
			return BigInt(trimmed).toString(10);
		}
		return "0";
	}
	if (typeof raw === "number") {
		if (Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0) {
			return BigInt(raw).toString(10);
		}
		return "0";
	}
	if (typeof raw === "bigint" && raw >= 0n) {
		return raw.toString(10);
	}
	return "0";
}

export interface NtqqSyncServiceOptions {
	dataDir?: string;
	assetsDir?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	darwinPythonPaths?: readonly string[];
	/** 覆盖本机 QQ.exe 进程 PID 列表枚举（用于单元测试或自定义探测） */
	listQqPids?: () => Promise<number[]>;
	/** 覆盖密钥提取可执行命令（默认使用 assetsDir/qq_dump_db.exe） */
	keyDumpCommand?: { bin: string; prefixArgs?: string[] };
	/** 单次 PID 密钥提取尝试超时毫秒数（默认 12_000） */
	keyExtractAttemptTimeoutMs?: number;
	/** 临时 key_map 轮询间隔毫秒数（默认 150） */
	keyExtractPollIntervalMs?: number;
}

export interface AutoDetectNtqqDbDirOptions {
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}

export interface DetectPythonOptions extends AutoDetectNtqqDbDirOptions {
	/** macOS GUI 优先探测的完整 Python 路径（默认探测 Homebrew 与 Python.org Framework） */
	darwinPythonPaths?: readonly string[];
}

export interface KeyDumpAttemptResult {
	pid: number | null;
	entries: Record<string, string>;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	abortedReason: string | null;
}

function stripUtf8Bom(raw: string): string {
	return raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
}

function parseJsonWithBom<T>(raw: string): T {
	return JSON.parse(stripUtf8Bom(raw)) as T;
}

function pathContainsDirSegment(dirPath: string, segment: string): boolean {
	const parts = dirPath.split(/[\\/]+/).filter(Boolean);
	return parts.includes(segment);
}

function dbDirBelongsToDifferentQq(
	dbDir: string,
	targetQqUin: string,
	previousQqUin?: string | null,
): boolean {
	const parts = dbDir.split(/[\\/]+/).filter(Boolean);
	if (previousQqUin && previousQqUin !== targetQqUin && parts.includes(previousQqUin)) {
		return true;
	}
	for (let i = 0; i < parts.length - 1; i += 1) {
		const seg = parts[i];
		const next = parts[i + 1];
		if (seg && next && QQ_UIN_RE.test(seg) && next.toLowerCase() === "nt_qq" && seg !== targetQqUin) {
			return true;
		}
	}
	return false;
}

/** 纯只读读取 NTQQ 加密 SQLite 数据库偏移 1024 处的 16 字节盐值（小写 hex）；不足一页或不可读返回 null */
export async function readNtqqDbSaltHex(dbPath: string): Promise<string | null> {
	if (!dbPath || !existsSync(dbPath)) return null;
	let fh: FileHandle | null = null;
	try {
		fh = await open(dbPath, "r");
		const st = await fh.stat();
		if (st.size < NTQQ_EXT_HEADER + NTQQ_PAGE_SIZE) {
			return null;
		}
		const buf = Buffer.alloc(NTQQ_SALT_SIZE);
		let offset = 0;
		while (offset < NTQQ_SALT_SIZE) {
			const { bytesRead } = await fh.read(buf, offset, NTQQ_SALT_SIZE - offset, NTQQ_EXT_HEADER + offset);
			if (bytesRead <= 0) break;
			offset += bytesRead;
		}
		if (offset < NTQQ_SALT_SIZE) return null;
		return buf.toString("hex").toLowerCase();
	} catch {
		return null;
	} finally {
		if (fh) {
			await fh.close().catch(() => undefined);
		}
	}
}

/** 从解析后的 JSON 对象提取合法 hex 盐值-密钥表（兼容 { key_map: {...} } 与扁平 { salt: key }） */
export function parseKeyMapEntries(parsed: unknown): Record<string, string> {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const obj = parsed as Record<string, unknown>;
	let source: Record<string, unknown>;
	if ("key_map" in obj) {
		if (!obj.key_map || typeof obj.key_map !== "object" || Array.isArray(obj.key_map)) {
			return {};
		}
		source = obj.key_map as Record<string, unknown>;
	} else {
		source = obj;
	}
	const out: Record<string, string> = {};
	for (const [rawSalt, rawKey] of Object.entries(source)) {
		if (typeof rawKey !== "string") continue;
		const salt = rawSalt.trim().toLowerCase();
		const key = rawKey.trim().toLowerCase();
		if (HEX_SALT_RE.test(salt) && HEX_KEY_RE.test(key)) {
			out[salt] = key;
		}
	}
	return out;
}

/** 读取并解析本地 key_map.json（自动剥离 UTF-8 BOM，兼容嵌套与扁平结构，仅保留合法 hex 键值并转小写） */
export async function loadKeyMapEntries(filePath: string): Promise<Record<string, string>> {
	if (!filePath || !existsSync(filePath)) return {};
	try {
		const rawText = await readFile(filePath, "utf8");
		return parseKeyMapEntries(parseJsonWithBom<unknown>(rawText));
	} catch {
		return {};
	}
}

/** 解析 Windows `tasklist /FI "IMAGENAME eq QQ.exe" /FO CSV /NH` 输出并按内存占用降序返回进程 PID */
export function parseWindowsTasklistCsv(stdout: string): Array<{ pid: number; memKb: number }> {
	const results: Array<{ pid: number; memKb: number }> = [];
	const seen = new Set<number>();
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith('"')) continue;
		const fields: string[] = [];
		const fieldRe = /"((?:[^"]|"")*)"/g;
		let match: RegExpExecArray | null = fieldRe.exec(line);
		while (match !== null) {
			fields.push((match[1] ?? "").replace(/""/g, '"'));
			match = fieldRe.exec(line);
		}
		if (fields.length < 2) continue;
		const pidStr = fields[1]?.trim() ?? "";
		if (!/^\d+$/.test(pidStr)) continue;
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
		seen.add(pid);
		const memDigits = (fields[4] ?? "").replace(/[^\d]/g, "");
		const memKb = memDigits ? Number.parseInt(memDigits, 10) : 0;
		results.push({ pid, memKb: Number.isFinite(memKb) ? memKb : 0 });
	}
	results.sort((a, b) => b.memKb - a.memKb || a.pid - b.pid);
	return results;
}

async function killProcessTree(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const pid = child.pid;
	const closePromise = new Promise<void>((res) => {
		const done = () => res();
		child.once("close", done);
		child.once("exit", done);
		setTimeout(done, 1500).unref?.();
	});
	try {
		if (process.platform === "win32" && pid) {
			await new Promise<void>((res) => {
				const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
					windowsHide: true,
					stdio: "ignore",
				});
				killer.once("error", () => {
					try {
						child.kill("SIGKILL");
					} catch {
						// ignore
					}
					res();
				});
				killer.once("close", () => res());
			});
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// ignore
		}
	}
	await closePromise;
}

const DEFAULT_DARWIN_PYTHON_PATHS = [
	"/opt/homebrew/bin/python3",
	"/usr/local/bin/python3",
	"/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
] as const;

function pathDedupKey(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? value.toLowerCase() : value;
}

function hasNtqqDbFiles(dir: string): boolean {
	return existsSync(join(dir, "nt_msg.db")) || existsSync(join(dir, "group_info.db"));
}

function defaultNtqqDataDir(): string {
	const envDir = process.env.WENYOU_NTQQ_DATA_DIR?.trim();
	if (envDir) return resolve(envDir);
	try {
		const agentDir = getAgentDir();
		if (agentDir) return join(dirname(agentDir), "ntqq");
	} catch {
		// fall back to homedir
	}
	return join(homedir(), ".wenyou-pro", "ntqq");
}

function defaultNtqqAssetsDir(): string | null {
	const envDir = process.env.WENYOU_NTQQ_ASSETS_DIR?.trim();
	if (envDir && existsSync(envDir)) return resolve(envDir);
	const candidates = [
		resolve(process.cwd(), "resources/ntqq-vfs"),
		resolve(process.cwd(), "packages/desktop/resources/ntqq-vfs"),
	];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "wenyou_ntqq_bridge.py"))) return candidate;
	}
	return null;
}

export function normalizeQqUin(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!QQ_UIN_RE.test(trimmed)) {
		throw new Error("QQ 号应为 5～12 位纯数字");
	}
	return trimmed;
}

function normalizeOptionalPath(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, filePath);
}

/** 规范化用户手选目录：允许选到 QQ 根目录、<QQ号>、nt_qq / nt_qq_<hash> 或 nt_db 任意一层，自动向下定位到 nt_db */
export function resolveCustomDbDirCandidate(rawDir: string): string {
	const trimmed = rawDir.trim();
	if (!trimmed) return trimmed;
	if (hasNtqqDbFiles(trimmed)) {
		return trimmed;
	}
	const underNtDb = join(trimmed, "nt_db");
	if (hasNtqqDbFiles(underNtDb)) {
		return underNtDb;
	}
	const underNtQq = join(trimmed, "nt_qq", "nt_db");
	if (hasNtqqDbFiles(underNtQq)) {
		return underNtQq;
	}
	// macOS / Linux 版 NTQQ 哈希目录结构：<dir>/nt_qq_<hash>/nt_db
	try {
		const entries = readdirSync(trimmed, { withFileTypes: true });
		const matches: Array<{ dir: string; hasMsgDb: boolean; mtimeMs: number; name: string }> = [];
		for (const entry of entries) {
			if (!entry.name.startsWith("nt_qq")) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const candidate = join(trimmed, entry.name, "nt_db");
			const msgDbPath = join(candidate, "nt_msg.db");
			const groupDbPath = join(candidate, "group_info.db");
			if (existsSync(msgDbPath)) {
				let mtimeMs = 0;
				try {
					mtimeMs = statSync(msgDbPath).mtimeMs;
				} catch {
					mtimeMs = 0;
				}
				matches.push({ dir: candidate, hasMsgDb: true, mtimeMs, name: entry.name });
			} else if (existsSync(groupDbPath)) {
				let mtimeMs = 0;
				try {
					mtimeMs = statSync(groupDbPath).mtimeMs;
				} catch {
					mtimeMs = 0;
				}
				matches.push({ dir: candidate, hasMsgDb: false, mtimeMs, name: entry.name });
			}
		}
		if (matches.length > 0) {
			matches.sort((a, b) => {
				if (a.hasMsgDb !== b.hasMsgDb) return a.hasMsgDb ? -1 : 1;
				if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
				return a.name.localeCompare(b.name);
			});
			return matches[0]!.dir;
		}
	} catch {
		// ignore unreadable dir and fall back to original path
	}
	return trimmed;
}

/** 解码 Windows QQ UserDataInfo.ini（支持 UTF-16LE BOM、UTF-8 BOM、UTF-8 与 GB18030） */
export function decodeIniBuffer(buf: Buffer): string {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
		return new TextDecoder("utf-16le").decode(buf.subarray(2));
	}
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return buf.subarray(3).toString("utf8");
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return new TextDecoder("gb18030").decode(buf);
	}
}

/** 只读解析 Windows QQ UserDataInfo.ini 中的自定义 Tencent Files 根目录（若存在） */
async function readQqUserDataRootsFromIni(
	platform: NodeJS.Platform,
	home: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	if (platform !== "win32") return [];
	const iniCandidates = [
		join(env.PUBLIC || "C:\\Users\\Public", "Documents", "Tencent", "QQ", "UserDataInfo.ini"),
		join(home, "Documents", "Tencent", "QQ", "UserDataInfo.ini"),
	];
	const roots: string[] = [];
	for (const iniPath of iniCandidates) {
		if (!existsSync(iniPath)) continue;
		try {
			const raw = decodeIniBuffer(await readFile(iniPath));
			for (const line of raw.split(/\r?\n/)) {
				const match = line.match(/^\s*UserDataSavePath\s*=\s*(.+?)\s*$/i);
				const val = match?.[1]?.trim();
				if (val && existsSync(val)) {
					roots.push(join(val, "Tencent Files"));
					roots.push(val);
				}
			}
		} catch {
			// ignore unreadable ini
		}
	}
	return roots;
}

export async function autoDetectNtqqDbDir(
	qqUin: string,
	options?: AutoDetectNtqqDbDirOptions,
): Promise<string | null> {
	const platform = options?.platform ?? process.platform;
	const home = options?.homeDir ?? homedir();
	const env = options?.env ?? process.env;
	const seen = new Set<string>();

	const probeCandidate = (candidate: string): string | null => {
		const key = pathDedupKey(candidate, platform);
		if (seen.has(key)) return null;
		seen.add(key);
		return hasNtqqDbFiles(candidate) ? candidate : null;
	};

	if (platform === "win32") {
		const iniRoots = await readQqUserDataRootsFromIni(platform, home, env);
		const bases = [
			...iniRoots,
			join(home, "Documents", "Tencent Files"),
			join(home, "OneDrive", "Documents", "Tencent Files"),
		];
		for (const base of bases) {
			const hit = probeCandidate(join(base, qqUin, "nt_qq", "nt_db"));
			if (hit) return hit;
		}
		// 默认位置兜底（即使目录尚未存在也给出清晰预期路径，方便用户核对）
		return join(home, "Documents", "Tencent Files", qqUin, "nt_qq", "nt_db");
	}

	if (platform === "darwin") {
		const containerBase = join(
			home,
			"Library",
			"Containers",
			"com.tencent.qq",
			"Data",
			"Library",
			"Application Support",
			"QQ",
		);
		const appSupportBase = join(home, "Library", "Application Support", "QQ");
		for (const base of [containerBase, appSupportBase]) {
			const byUin = probeCandidate(join(base, qqUin, "nt_qq", "nt_db"));
			if (byUin) return byUin;
			const resolved = resolveCustomDbDirCandidate(base);
			const byHash = probeCandidate(resolved);
			if (byHash) return byHash;
		}
		return containerBase;
	}

	const defaultLinuxBase = join(home, ".config", "QQ");
	const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
	const xdgBase = join(xdgConfigHome || join(home, ".config"), "QQ");
	for (const base of [xdgBase, defaultLinuxBase]) {
		const byUin = probeCandidate(join(base, qqUin, "nt_qq", "nt_db"));
		if (byUin) return byUin;
		const resolved = resolveCustomDbDirCandidate(base);
		const byHash = probeCandidate(resolved);
		if (byHash) return byHash;
	}
	return defaultLinuxBase;
}

async function getNtqqRootCandidates(
	platform: NodeJS.Platform,
	home: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	const rawBases: string[] = [];
	if (platform === "win32") {
		const iniRoots = await readQqUserDataRootsFromIni(platform, home, env);
		rawBases.push(
			...iniRoots,
			join(home, "Documents", "Tencent Files"),
			join(home, "OneDrive", "Documents", "Tencent Files"),
		);
	} else if (platform === "darwin") {
		rawBases.push(
			join(
				home,
				"Library",
				"Containers",
				"com.tencent.qq",
				"Data",
				"Library",
				"Application Support",
				"QQ",
			),
			join(home, "Library", "Application Support", "QQ"),
		);
	} else {
		const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
		rawBases.push(
			join(xdgConfigHome || join(home, ".config"), "QQ"),
			join(home, ".config", "QQ"),
		);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const base of rawBases) {
		const key = pathDedupKey(base, platform);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(base);
	}
	return out;
}

/** 扫描本机所有 NTQQ 账号数据目录（返回含 nt_msg.db 或 group_info.db 的账号列表，按 mtimeMs 降序排列） */
export async function detectNtqqAccounts(
	options?: AutoDetectNtqqDbDirOptions & { keyMapEntries?: Record<string, string> },
): Promise<NtqqDetectedAccount[]> {
	const platform = options?.platform ?? process.platform;
	const home = options?.homeDir ?? homedir();
	const env = options?.env ?? process.env;
	const keyMapEntries = options?.keyMapEntries ?? {};
	const bases = await getNtqqRootCandidates(platform, home, env);

	const seenDirs = new Set<string>();
	const byUin = new Map<string, NtqqDetectedAccount>();

	for (const base of bases) {
		if (!existsSync(base)) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (!QQ_UIN_RE.test(entry.name)) continue;
			const qqUin = entry.name;
			const dbDir = join(base, qqUin, "nt_qq", "nt_db");
			const dirKey = pathDedupKey(dbDir, platform);
			if (seenDirs.has(dirKey)) continue;
			seenDirs.add(dirKey);

			const msgDbPath = join(dbDir, "nt_msg.db");
			const groupDbPath = join(dbDir, "group_info.db");
			const msgDbExists = existsSync(msgDbPath);
			const groupDbExists = existsSync(groupDbPath);
			if (!msgDbExists && !groupDbExists) continue;

			let mtimeMs = 0;
			for (const p of [msgDbPath, `${msgDbPath}-wal`, groupDbPath, `${groupDbPath}-wal`]) {
				if (!existsSync(p)) continue;
				try {
					const st = await stat(p);
					if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
				} catch {
					// ignore stat errors
				}
			}

			const salts: string[] = [];
			if (msgDbExists) {
				const s = await readNtqqDbSaltHex(msgDbPath);
				if (s) salts.push(s);
			}
			if (groupDbExists) {
				const s = await readNtqqDbSaltHex(groupDbPath);
				if (s) salts.push(s);
			}
			const keyReady = salts.length > 0 && salts.every((s) => Boolean(keyMapEntries[s]));

			const candidate: NtqqDetectedAccount = {
				qqUin,
				dbDir,
				msgDbExists,
				groupDbExists,
				keyReady,
				mtimeMs,
			};
			const existing = byUin.get(qqUin);
			if (!existing || candidate.mtimeMs > existing.mtimeMs) {
				byUin.set(qqUin, candidate);
			}
		}
	}

	return Array.from(byUin.values()).sort(
		(a, b) => b.mtimeMs - a.mtimeMs || a.qqUin.localeCompare(b.qqUin),
	);
}

function runCommandWithTimeout(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...(options.env ?? process.env), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				if (process.platform === "win32" && child.pid) {
					const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
						windowsHide: true,
						stdio: "ignore",
					});
					killer.on("error", () => {
						try {
							child.kill("SIGKILL");
						} catch {
							// ignore
						}
					});
				} else {
					child.kill("SIGKILL");
				}
			} catch {
				// ignore
			}
			rejectPromise(new Error(`执行超时（${Math.round(options.timeoutMs / 1000)}s）：${command}`));
		}, options.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectPromise(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				exitCode: code ?? 1,
			});
		});
	});
}

export async function listWindowsQqProcessPids(env?: NodeJS.ProcessEnv): Promise<number[]> {
	try {
		const res = await runCommandWithTimeout(
			"tasklist",
			["/FI", "IMAGENAME eq QQ.exe", "/FO", "CSV", "/NH"],
			{ timeoutMs: 5000, env },
		);
		if (res.exitCode !== 0) return [];
		return parseWindowsTasklistCsv(res.stdout).map((item) => item.pid);
	} catch {
		return [];
	}
}

function resolveBundledPythonPath(
	assetsDir?: string | null,
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (!assetsDir) return null;
	const candidate =
		platform === "win32"
			? join(assetsDir, "python", "python.exe")
			: join(assetsDir, "python", "bin", "python3");
	return existsSync(candidate) ? candidate : null;
}

export function buildPythonCandidates(
	preferred?: string | null,
	assetsDir?: string | null,
	options?: DetectPythonOptions,
): Array<{ bin: string; prefixArgs: string[]; bundled: boolean }> {
	const platform = options?.platform ?? process.platform;
	const home = options?.homeDir ?? homedir();
	const env = options?.env ?? process.env;
	const candidates: Array<{ bin: string; prefixArgs: string[]; bundled: boolean }> = [];
	if (preferred?.trim()) candidates.push({ bin: preferred.trim(), prefixArgs: [], bundled: false });
	const envPy = env.WENYOU_PYTHON?.trim();
	if (envPy) candidates.push({ bin: envPy, prefixArgs: [], bundled: false });
	const bundledPy = resolveBundledPythonPath(assetsDir, platform);
	if (bundledPy) candidates.push({ bin: bundledPy, prefixArgs: [], bundled: true });
	if (platform === "win32") {
		candidates.push({ bin: "python", prefixArgs: [], bundled: false });
		candidates.push({ bin: "python3", prefixArgs: [], bundled: false });
		const localPrograms = join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Python");
		for (const ver of ["Python314", "Python313", "Python312", "Python311", "Python310"]) {
			const exe = join(localPrograms, ver, "python.exe");
			if (existsSync(exe)) candidates.push({ bin: exe, prefixArgs: [], bundled: false });
		}
	} else if (platform === "darwin") {
		// macOS GUI 进程默认 PATH 不含 Homebrew/Framework，且裸 python3 可能命中 /usr/bin/python3 Xcode CLT stub
		for (const exe of options?.darwinPythonPaths ?? DEFAULT_DARWIN_PYTHON_PATHS) {
			if (exe && existsSync(exe)) {
				candidates.push({ bin: exe, prefixArgs: [], bundled: false });
			}
		}
		candidates.push({ bin: "python3", prefixArgs: [], bundled: false });
		candidates.push({ bin: "python", prefixArgs: [], bundled: false });
	} else {
		candidates.push({ bin: "python3", prefixArgs: [], bundled: false });
		candidates.push({ bin: "python", prefixArgs: [], bundled: false });
	}
	return candidates;
}

async function detectPythonExecutable(
	preferred?: string | null,
	assetsDir?: string | null,
	options?: DetectPythonOptions,
): Promise<{ path: string; version: string; bundled: boolean } | null> {
	const platform = options?.platform ?? process.platform;
	const env = options?.env ?? process.env;
	const candidates = buildPythonCandidates(preferred, assetsDir, options);

	const tried = new Set<string>();
	for (const candidate of candidates) {
		const key = pathDedupKey(candidate.bin, platform);
		if (tried.has(key)) continue;
		tried.add(key);
		try {
			const res = await runCommandWithTimeout(
				candidate.bin,
				[
					...candidate.prefixArgs,
					"-B",
					"-c",
					"import sys, sqlite3; hasattr(sys.stdout, 'reconfigure') and sys.stdout.reconfigure(encoding='utf-8'); print(sys.executable); print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
				],
				{ timeoutMs: 5000, env },
			);
			if (res.exitCode === 0) {
				const lines = res.stdout
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter(Boolean);
				if (lines.length >= 2 && lines[0] && lines[1]) {
					return { path: lines[0], version: lines[1], bundled: candidate.bundled };
				}
			}
		} catch {
			// try next candidate
		}
	}
	return null;
}

function parseBridgePayload<T>(stdout: string): T {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim();
		if (!line?.startsWith(BRIDGE_PREFIX)) continue;
		return JSON.parse(line.slice(BRIDGE_PREFIX.length)) as T;
	}
	throw new Error("NTQQ VFS 桥接脚本未返回预期元数据");
}

function parseRole(raw: unknown): GroupRole {
	if (raw === "main" || raw === "dice" || raw === "cabinet" || raw === "diplomacy" || raw === "other") {
		return raw;
	}
	return "other";
}

/**
 * Wenyou Pro 本机 NTQQ 零依赖只读 VFS 解库与按群增量同步服务。
 * - 永远只读访问 QQ 源加密库（nt_msg.db / group_info.db + -wal），绝不写入或锁死源库
 * - QQ 号与 key_map.json 仅存于本机用户目录（~/.wenyou-pro/ntqq/），绝不进入任何战役目录
 * - 进程内串行队列防止并发读写专属明文库
 */
export class NtqqSyncService {
	private readonly dataDir: string;
	private readonly assetsDirOverride?: string;
	private readonly platformOverride?: NodeJS.Platform;
	private readonly homeDirOverride?: string;
	private readonly envOverride?: NodeJS.ProcessEnv;
	private readonly darwinPythonPathsOverride?: readonly string[];
	private readonly listQqPidsOverride?: () => Promise<number[]>;
	private readonly keyDumpCommandOverride?: { bin: string; prefixArgs?: string[] };
	private readonly keyExtractAttemptTimeoutMs: number;
	private readonly keyExtractPollIntervalMs: number;
	private queue: Promise<unknown> = Promise.resolve();
	private cachedPython: { path: string; version: string; bundled: boolean } | null | undefined;

	constructor(options?: NtqqSyncServiceOptions) {
		this.dataDir = options?.dataDir ? resolve(options.dataDir) : defaultNtqqDataDir();
		this.assetsDirOverride = options?.assetsDir ? resolve(options.assetsDir) : undefined;
		this.platformOverride = options?.platform;
		this.homeDirOverride = options?.homeDir;
		this.envOverride = options?.env;
		this.darwinPythonPathsOverride = options?.darwinPythonPaths;
		this.listQqPidsOverride = options?.listQqPids;
		this.keyDumpCommandOverride = options?.keyDumpCommand;
		this.keyExtractAttemptTimeoutMs = options?.keyExtractAttemptTimeoutMs ?? KEY_EXTRACT_ATTEMPT_TIMEOUT_MS;
		this.keyExtractPollIntervalMs = options?.keyExtractPollIntervalMs ?? KEY_EXTRACT_POLL_INTERVAL_MS;
	}

	private get currentPlatform(): NodeJS.Platform {
		return this.platformOverride ?? process.platform;
	}

	private get currentEnv(): NodeJS.ProcessEnv {
		return this.envOverride ?? process.env;
	}

	private get configPath(): string {
		return join(this.dataDir, "config.json");
	}

	private get defaultKeyMapPath(): string {
		return join(this.dataDir, "key_map.json");
	}

	private get plainMsgDbPath(): string {
		return join(this.dataDir, "plain", "wenyou_msg_plain.db");
	}

	private get plainGroupDbPath(): string {
		return join(this.dataDir, "plain", "wenyou_group_plain.db");
	}

	private get tmpDir(): string {
		return join(this.dataDir, "tmp");
	}

	private async resolvePlainDbPath(kind: "msg" | "group", srcDbPath: string): Promise<string> {
		const saltHex = await readNtqqDbSaltHex(srcDbPath);
		if (saltHex && HEX_SALT_RE.test(saltHex)) {
			const prefix = kind === "msg" ? "wenyou_msg" : "wenyou_group";
			return join(this.dataDir, "plain", `${prefix}_${saltHex.slice(0, 12)}.db`);
		}
		return kind === "msg" ? this.plainMsgDbPath : this.plainGroupDbPath;
	}

	private resolveAssetsDir(): string | null {
		if (this.assetsDirOverride && existsSync(this.assetsDirOverride)) return this.assetsDirOverride;
		return defaultNtqqAssetsDir();
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async loadConfig(): Promise<NtqqLocalConfig> {
		if (!existsSync(this.configPath)) {
			return { qqUin: null, dbDir: null, keyMapPath: null, pythonPath: null };
		}
		try {
			const raw = parseJsonWithBom<Partial<NtqqLocalConfig>>(await readFile(this.configPath, "utf8"));
			return {
				qqUin: typeof raw.qqUin === "string" && QQ_UIN_RE.test(raw.qqUin.trim()) ? raw.qqUin.trim() : null,
				dbDir: normalizeOptionalPath(raw.dbDir),
				keyMapPath: normalizeOptionalPath(raw.keyMapPath),
				pythonPath: normalizeOptionalPath(raw.pythonPath),
			};
		} catch {
			return { qqUin: null, dbDir: null, keyMapPath: null, pythonPath: null };
		}
	}

	async saveConfig(patch: {
		qqUin?: string | null;
		dbDir?: string | null;
		keyMapPath?: string | null;
		pythonPath?: string | null;
	}): Promise<NtqqStatusSnapshot> {
		const current = await this.loadConfig();
		const nextQqUin = patch.qqUin !== undefined ? normalizeQqUin(patch.qqUin) : current.qqUin;
		let nextDbDir: string | null;
		if (patch.dbDir !== undefined) {
			nextDbDir = patch.dbDir ? resolveCustomDbDirCandidate(patch.dbDir) : null;
		} else if (
			patch.qqUin !== undefined &&
			current.qqUin &&
			nextQqUin !== current.qqUin &&
			current.dbDir &&
			pathContainsDirSegment(current.dbDir, current.qqUin)
		) {
			// 切换 QQ 号且未显式传入 dbDir 时，自动解绑旧 QQ 号专属目录以便重新定位新账号 nt_db
			nextDbDir = null;
		} else {
			nextDbDir = current.dbDir;
		}
		const next: NtqqLocalConfig = {
			qqUin: nextQqUin,
			dbDir: nextDbDir,
			keyMapPath: patch.keyMapPath !== undefined ? normalizeOptionalPath(patch.keyMapPath) : current.keyMapPath,
			pythonPath: patch.pythonPath !== undefined ? normalizeOptionalPath(patch.pythonPath) : current.pythonPath,
		};
		if (patch.pythonPath !== undefined) {
			this.cachedPython = undefined;
		}
		await atomicWriteJson(this.configPath, next);
		return this.getStatus();
	}

	private resolveKeyMapCandidate(config: NtqqLocalConfig): { path: string | null; exists: boolean } {
		const candidates = [
			config.keyMapPath,
			this.currentEnv.WENYOU_KEY_MAP?.trim() || null,
			this.defaultKeyMapPath,
		].filter((p): p is string => Boolean(p));

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return { path: candidate, exists: true };
			}
		}
		return { path: config.keyMapPath ?? this.defaultKeyMapPath, exists: false };
	}

	private async resolvePython(
		config: NtqqLocalConfig,
		assetsDir: string | null,
	): Promise<{ path: string; version: string; bundled: boolean } | null> {
		if (!config.pythonPath && this.cachedPython !== undefined) return this.cachedPython;
		const found = await detectPythonExecutable(config.pythonPath, assetsDir, {
			platform: this.currentPlatform,
			homeDir: this.homeDirOverride,
			env: this.envOverride,
			darwinPythonPaths: this.darwinPythonPathsOverride,
		});
		if (!config.pythonPath) this.cachedPython = found;
		return found;
	}

	async getStatus(): Promise<NtqqStatusSnapshot> {
		const config = await this.loadConfig();
		const platform = this.currentPlatform;
		const platformSupported = platform === "win32";
		const assetsDir = this.resolveAssetsDir();
		const assetsReady = Boolean(
			assetsDir && REQUIRED_BRIDGE_FILES.every((name) => existsSync(join(assetsDir, name))),
		);
		const dumpExe = assetsDir ? join(assetsDir, "qq_dump_db.exe") : null;
		const canExtractKey = Boolean(
			platformSupported && (this.keyDumpCommandOverride || (dumpExe && existsSync(dumpExe))),
		);

		let resolvedDbDir: string | null = null;
		let dbDirAutoDetected = false;
		if (config.dbDir) {
			resolvedDbDir = resolveCustomDbDirCandidate(config.dbDir);
		} else if (config.qqUin) {
			resolvedDbDir = await autoDetectNtqqDbDir(config.qqUin, {
				platform,
				homeDir: this.homeDirOverride,
				env: this.envOverride,
			});
			dbDirAutoDetected = true;
		}

		const msgDbPath = resolvedDbDir ? join(resolvedDbDir, "nt_msg.db") : null;
		const groupDbPath = resolvedDbDir ? join(resolvedDbDir, "group_info.db") : null;
		const msgDbExists = Boolean(msgDbPath && existsSync(msgDbPath));
		const groupDbExists = Boolean(groupDbPath && existsSync(groupDbPath));

		let walSizeBytes = 0;
		if (msgDbPath && existsSync(`${msgDbPath}-wal`)) {
			try {
				const st = await stat(`${msgDbPath}-wal`);
				walSizeBytes = st.size;
			} catch {
				walSizeBytes = 0;
			}
		}

		const keyMapInfo = this.resolveKeyMapCandidate(config);
		const keyMapEntries =
			keyMapInfo.exists && keyMapInfo.path ? await loadKeyMapEntries(keyMapInfo.path) : {};
		const [msgSalt, groupSalt] = await Promise.all([
			msgDbPath && msgDbExists ? readNtqqDbSaltHex(msgDbPath) : Promise.resolve(null),
			groupDbPath && groupDbExists ? readNtqqDbSaltHex(groupDbPath) : Promise.resolve(null),
		]);
		const requiredSalts = [msgSalt, groupSalt].filter((s): s is string => Boolean(s));
		const keyMatchedForCurrentDb =
			keyMapInfo.exists &&
			requiredSalts.length > 0 &&
			requiredSalts.every((salt) => Boolean(keyMapEntries[salt]));

		const detectedAccounts = await detectNtqqAccounts({
			platform,
			homeDir: this.homeDirOverride,
			env: this.envOverride,
			keyMapEntries,
		});
		const pythonInfo = await this.resolvePython(config, assetsDir);

		const missingReasons: string[] = [];
		if (!config.qqUin && !config.dbDir) {
			missingReasons.push("尚未填写本人 QQ 号");
		}
		if (!msgDbExists) {
			missingReasons.push("未找到本机 nt_msg.db（请确认 QQ 号或手动指定 nt_db 目录）");
		}
		if (!groupDbExists) {
			missingReasons.push("未找到本机 group_info.db");
		}
		if (!keyMapInfo.exists) {
			missingReasons.push(
				canExtractKey
					? "尚未准备解密密钥 key_map.json（可点「一键提取本机密钥」或手动导入）"
					: "尚未导入解密密钥 key_map.json（一键提取仅支持 Windows；macOS/Linux 可将导出的 .txt/.json 放入 00-群聊收集/，或手动导入 key_map.json）",
			);
		} else if (!keyMatchedForCurrentDb) {
			if (requiredSalts.length > 0) {
				missingReasons.push(
					canExtractKey
						? "当前 key_map.json 未包含此 QQ 账号消息库的解密密钥（多账号同时登录或切换账号后，请点击「一键提取密钥」补充）"
						: "当前 key_map.json 未包含此 QQ 账号消息库的解密密钥（多账号或切换账号后，请重新导入包含当前账号的 key_map.json）",
				);
			} else if (Object.keys(keyMapEntries).length === 0) {
				missingReasons.push(
					canExtractKey
						? "当前 key_map.json 内容为空或格式无效（请点击「一键提取密钥」或重新导入）"
						: "当前 key_map.json 内容为空或格式无效（请重新导入有效的 key_map.json）",
				);
			} else if (msgDbExists || groupDbExists) {
				missingReasons.push("未能读取当前 QQ 数据库头部盐值（文件可能尚未初始化或已损坏），无法校验密钥匹配状态");
			}
		}
		if (!pythonInfo) {
			missingReasons.push(
				platformSupported
					? "未找到可用的 Python 3 运行时（随包内置运行时缺失且本机未安装 Python 3）"
					: "未找到可用的 Python 3 运行时（可安装 Python 3，或直接使用 00-群聊收集/ 离线导入）",
			);
		}
		if (!assetsReady) {
			missingReasons.push("随包 NTQQ VFS 解库脚本缺失");
		}

		const status: NtqqProbeStatus = {
			platformSupported,
			qqUin: config.qqUin,
			resolvedDbDir,
			dbDirAutoDetected,
			msgDbExists,
			groupDbExists,
			walSizeBytes,
			resolvedKeyMapPath: keyMapInfo.exists ? keyMapInfo.path : null,
			keyMapExists: keyMapInfo.exists,
			keyMatchedForCurrentDb,
			detectedAccounts,
			canExtractKey,
			pythonPath: pythonInfo?.path ?? null,
			pythonVersion: pythonInfo?.version ?? null,
			pythonBundled: Boolean(pythonInfo?.bundled),
			assetsDir,
			assetsReady,
			ready: missingReasons.length === 0,
			missingReasons,
		};
		return { config, status };
	}

	private runKeyDumpForPid(params: {
		command: string;
		prefixArgs: string[];
		qqUin: string;
		resolvedDbDir: string | null;
		pid: number | null;
		tmpKeyMapPath: string;
		timeoutMs: number;
		pollIntervalMs: number;
	}): Promise<KeyDumpAttemptResult> {
		const args = [
			...params.prefixArgs,
			"--qq",
			params.qqUin,
			...(params.resolvedDbDir && existsSync(params.resolvedDbDir)
				? ["--db-dir", params.resolvedDbDir]
				: []),
			...(params.pid !== null ? ["--pid", String(params.pid)] : []),
			"--output",
			params.tmpKeyMapPath,
		];

		return new Promise<KeyDumpAttemptResult>((resolvePromise, rejectPromise) => {
			// 关键：保持 stdin 为打开的 pipe（严禁 "ignore"/EOF，也严禁写入回车），
			// 防止 qq_dump_db.exe 写出 key_map.json 后误以为收到回车而启动数 GB 全量原地解密！
			const child = spawn(params.command, args, {
				cwd: this.dataDir,
				env: this.currentEnv,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdin?.on("error", () => undefined);

			let stdout = "";
			let stderr = "";
			let settled = false;
			let inspecting = false;

			const finish = (result: KeyDumpAttemptResult) => {
				if (settled) return;
				settled = true;
				clearInterval(pollTimer);
				clearTimeout(timeoutTimer);
				void killProcessTree(child).finally(() => {
					resolvePromise(result);
				});
			};

			const tryReadTmpEntries = async (): Promise<Record<string, string>> => {
				if (!existsSync(params.tmpKeyMapPath)) return {};
				try {
					const st = await stat(params.tmpKeyMapPath);
					if (st.size <= 0) return {};
					return await loadKeyMapEntries(params.tmpKeyMapPath);
				} catch {
					return {};
				}
			};

			const inspectProgress = async () => {
				if (settled || inspecting) return;
				inspecting = true;
				try {
					const entries = await tryReadTmpEntries();
					if (settled) return;
					if (Object.keys(entries).length > 0) {
						finish({
							pid: params.pid,
							entries,
							stdout,
							stderr,
							exitCode: child.exitCode,
							timedOut: false,
							abortedReason: null,
						});
						return;
					}

					const combined = `${stdout}\n${stderr}`;
					for (const re of FATAL_KEY_DUMP_PATTERNS) {
						const match = combined.match(re);
						if (match) {
							finish({
								pid: params.pid,
								entries: {},
								stdout,
								stderr,
								exitCode: child.exitCode,
								timedOut: false,
								abortedReason: match[0],
							});
							return;
						}
					}

					if (KEY_DUMP_WAITING_RE.test(combined)) {
						let finalEntries = await tryReadTmpEntries();
						if (Object.keys(finalEntries).length === 0 && KEY_DUMP_SAVED_RE.test(combined)) {
							await new Promise((res) => setTimeout(res, 50));
							finalEntries = await tryReadTmpEntries();
						}
						if (settled) return;
						finish({
							pid: params.pid,
							entries: finalEntries,
							stdout,
							stderr,
							exitCode: child.exitCode,
							timedOut: false,
							abortedReason:
								Object.keys(finalEntries).length > 0
									? null
									: KEY_DUMP_ZERO_SALTS_RE.test(combined)
										? "0 salts matched"
										: "未提取到有效密钥",
						});
					}
				} finally {
					inspecting = false;
				}
			};

			const pollTimer = setInterval(() => {
				void inspectProgress();
			}, Math.max(20, params.pollIntervalMs));

			const timeoutTimer = setTimeout(() => {
				if (settled) return;
				void (async () => {
					const entries = await tryReadTmpEntries();
					finish({
						pid: params.pid,
						entries,
						stdout,
						stderr,
						exitCode: child.exitCode,
						timedOut: Object.keys(entries).length === 0,
						abortedReason:
							Object.keys(entries).length > 0
								? null
								: `单次进程扫描超时（${Math.round(params.timeoutMs / 1000)}s）`,
					});
				})();
			}, params.timeoutMs);

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
				if (
					KEY_DUMP_SAVED_RE.test(stdout) ||
					KEY_DUMP_WAITING_RE.test(stdout) ||
					FATAL_KEY_DUMP_PATTERNS.some((re) => re.test(stdout))
				) {
					void inspectProgress();
				}
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
				if (
					KEY_DUMP_WAITING_RE.test(stderr) ||
					FATAL_KEY_DUMP_PATTERNS.some((re) => re.test(stderr))
				) {
					void inspectProgress();
				}
			});

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearInterval(pollTimer);
				clearTimeout(timeoutTimer);
				rejectPromise(err);
			});

			child.on("close", (code) => {
				if (settled) return;
				void (async () => {
					const entries = await tryReadTmpEntries();
					finish({
						pid: params.pid,
						entries,
						stdout,
						stderr,
						exitCode: code ?? 1,
						timedOut: false,
						abortedReason:
							Object.keys(entries).length > 0
								? null
								: (stderr || stdout).trim().split(/\r?\n/).pop() || `exit=${code ?? 1}`,
					});
				})();
			});
		});
	}

	async extractKey(qqUinOverride?: string): Promise<NtqqStatusSnapshot & { message: string }> {
		return this.enqueue(async () => {
			if (this.currentPlatform !== "win32") {
				throw new Error("自动提取 NTQQ 密钥目前仅支持 Windows 电脑版 QQ");
			}
			const current = await this.loadConfig();
			const qqUin = qqUinOverride !== undefined ? normalizeQqUin(qqUinOverride) : current.qqUin;
			if (!qqUin) {
				throw new Error("请先填写你的 QQ 号，再点击提取本机密钥");
			}

			const dbDirPointsToOtherQq = Boolean(
				current.dbDir && dbDirBelongsToDifferentQq(current.dbDir, qqUin, current.qqUin),
			);
			const effectiveConfig: NtqqLocalConfig = {
				...current,
				qqUin,
				dbDir: dbDirPointsToOtherQq ? null : current.dbDir,
			};
			if (qqUin !== current.qqUin || dbDirPointsToOtherQq) {
				await atomicWriteJson(this.configPath, effectiveConfig);
			}

			let dumpCommand: { bin: string; prefixArgs: string[] };
			if (this.keyDumpCommandOverride) {
				dumpCommand = {
					bin: this.keyDumpCommandOverride.bin,
					prefixArgs: [...(this.keyDumpCommandOverride.prefixArgs ?? [])],
				};
			} else {
				const assetsDir = this.resolveAssetsDir();
				const dumpExe = assetsDir ? join(assetsDir, "qq_dump_db.exe") : null;
				if (!dumpExe || !existsSync(dumpExe)) {
					throw new Error("未检测到密钥提取组件 qq_dump_db.exe，请手动导入已有 key_map.json");
				}
				dumpCommand = { bin: dumpExe, prefixArgs: [] };
			}

			const resolvedDbDir = effectiveConfig.dbDir
				? resolveCustomDbDirCandidate(effectiveConfig.dbDir)
				: await autoDetectNtqqDbDir(qqUin, {
						platform: this.currentPlatform,
						homeDir: this.homeDirOverride,
						env: this.envOverride,
					});

			const targetSalts: string[] = [];
			if (resolvedDbDir && existsSync(resolvedDbDir)) {
				const [msgSalt, groupSalt] = await Promise.all([
					readNtqqDbSaltHex(join(resolvedDbDir, "nt_msg.db")),
					readNtqqDbSaltHex(join(resolvedDbDir, "group_info.db")),
				]);
				if (msgSalt) targetSalts.push(msgSalt);
				if (groupSalt && !targetSalts.includes(groupSalt)) targetSalts.push(groupSalt);
			}

			await mkdir(this.dataDir, { recursive: true });
			await mkdir(this.tmpDir, { recursive: true });

			const targetKeyMapPath = effectiveConfig.keyMapPath ?? this.defaultKeyMapPath;
			const existingEntries = await loadKeyMapEntries(targetKeyMapPath);

			const detectedPids = this.listQqPidsOverride
				? await this.listQqPidsOverride()
				: await listWindowsQqProcessPids(this.currentEnv);
			const uniquePids: number[] = [];
			const seenPid = new Set<number>();
			for (const pid of detectedPids) {
				if (Number.isInteger(pid) && pid > 0 && !seenPid.has(pid)) {
					seenPid.add(pid);
					uniquePids.push(pid);
				}
			}
			const candidatePids: Array<number | null> = [...uniquePids, null];

			const accumulatedRecovered: Record<string, string> = {};
			let scannedPidCount = 0;
			let lastDetail = "";
			let matched = false;

			for (const pid of candidatePids) {
				if (pid !== null) scannedPidCount += 1;
				const tmpKeyMapPath = join(this.tmpDir, `key-dump-${randomUUID().slice(0, 8)}.json`);
				try {
					const attempt = await this.runKeyDumpForPid({
						command: dumpCommand.bin,
						prefixArgs: dumpCommand.prefixArgs,
						qqUin,
						resolvedDbDir,
						pid,
						tmpKeyMapPath,
						timeoutMs: this.keyExtractAttemptTimeoutMs,
						pollIntervalMs: this.keyExtractPollIntervalMs,
					});
					Object.assign(accumulatedRecovered, attempt.entries);
					if (attempt.abortedReason) {
						lastDetail = attempt.abortedReason;
					} else if (attempt.stderr.trim() || attempt.stdout.trim()) {
						lastDetail = (attempt.stderr || attempt.stdout).trim().split(/\r?\n/).pop() ?? lastDetail;
					}

					if (targetSalts.length > 0) {
						if (targetSalts.every((salt) => Boolean(accumulatedRecovered[salt]))) {
							matched = true;
							break;
						}
					} else if (Object.keys(accumulatedRecovered).length > 0) {
						matched = true;
						break;
					}
				} finally {
					await rm(tmpKeyMapPath, { force: true }).catch(() => undefined);
				}
			}

			if (
				!matched &&
				targetSalts.length > 0 &&
				targetSalts.some((salt) => Boolean(accumulatedRecovered[salt])) &&
				targetSalts.every((salt) => Boolean(existingEntries[salt] || accumulatedRecovered[salt]))
			) {
				matched = true;
			}

			if (!matched) {
				if (targetSalts.length > 0) {
					const scannedHint =
						scannedPidCount > 0
							? `已扫描 ${scannedPidCount} 个 QQ.exe 进程，均未匹配到 QQ ${qqUin} 的数据库解密密钥`
							: `未检测到运行中的 QQ.exe 进程，且默认提取未匹配到 QQ ${qqUin} 的数据库解密密钥`;
					throw new Error(
						`${scannedHint}（请确认该账号已在电脑版 NTQQ 登录完成${lastDetail ? `；详情：${lastDetail}` : ""}）`,
					);
				}
				throw new Error(
					`提取 NTQQ 密钥失败（已扫描 ${scannedPidCount} 个 QQ.exe 进程，请确认电脑版 NTQQ 已打开并登录 QQ ${qqUin}）：${lastDetail || "未提取到有效密钥"}`,
				);
			}

			const mergedKeyMap: Record<string, string> = {
				...existingEntries,
				...accumulatedRecovered,
			};
			await atomicWriteJson(targetKeyMapPath, { key_map: mergedKeyMap });

			const snapshot = await this.getStatus();
			return {
				...snapshot,
				message:
					Object.keys(existingEntries).length > 0
						? `已成功提取 QQ ${qqUin} 的解密密钥并合并保存（当前共保留 ${Object.keys(mergedKeyMap).length} 组库密钥）`
						: "已成功提取并保存本机 NTQQ 解密密钥",
			};
		});
	}

	async listGroups(options?: { force?: boolean }): Promise<{ groups: NtqqGroupSummary[]; elapsedMs: number }> {
		return this.enqueue(async () => {
			const { status } = await this.getStatus();
			if (!status.groupDbExists || !status.resolvedDbDir) {
				throw new Error("未找到本机 QQ 群资料库 group_info.db，请先确认 QQ 号或指定 nt_db 目录");
			}
			if (!status.keyMapExists || !status.resolvedKeyMapPath) {
				throw new Error(
					status.canExtractKey
						? "尚未准备 key_map.json，请先一键提取本机密钥或导入密钥文件"
						: "尚未导入解密密钥 key_map.json（一键提取仅支持 Windows；可手动导入 key_map.json，或将聊天记录放入 00-群聊收集/ 离线导入）",
				);
			}
			if (!status.pythonPath || !status.assetsDir || !status.assetsReady) {
				throw new Error(status.missingReasons.join("；") || "NTQQ VFS 运行环境未就绪");
			}

			const bridgePy = join(status.assetsDir, "wenyou_ntqq_bridge.py");
			const srcGroup = join(status.resolvedDbDir, "group_info.db");
			const groupSalt = await readNtqqDbSaltHex(srcGroup);
			if (groupSalt) {
				const keyMapEntries = await loadKeyMapEntries(status.resolvedKeyMapPath);
				if (!keyMapEntries[groupSalt]) {
					throw new Error(
						status.canExtractKey
							? "当前 key_map.json 未包含此 QQ 账号群资料库（group_info.db）的解密密钥（多账号同时登录或切换账号后，请点击「一键提取密钥」补充）"
							: "当前 key_map.json 未包含此 QQ 账号群资料库（group_info.db）的解密密钥（请重新导入包含当前账号的 key_map.json）",
					);
				}
			}
			const outGroup = await this.resolvePlainDbPath("group", srcGroup);
			const argv = [
				"-B",
				bridgePy,
				"list-groups",
				"--src-group",
				srcGroup,
				"--out-group",
				outGroup,
				"--key-map",
				status.resolvedKeyMapPath,
			];
			if (options?.force) argv.push("--force");

			const t0 = Date.now();
			const run = await runCommandWithTimeout(status.pythonPath, argv, {
				cwd: status.assetsDir,
				timeoutMs: VFS_RUN_TIMEOUT_MS,
			});
			if (run.exitCode !== 0) {
				throw new Error(`读取本机 QQ 群列表失败：${(run.stderr || run.stdout).trim() || `exit=${run.exitCode}`}`);
			}
			const parsed = parseBridgePayload<{
				ok: boolean;
				groups?: NtqqGroupSummary[];
				sync?: { elapsedMs?: number };
			}>(run.stdout);
			if (!parsed.ok || !Array.isArray(parsed.groups)) {
				throw new Error("读取本机 QQ 群列表返回结构异常");
			}
			return {
				groups: parsed.groups,
				elapsedMs: Number(parsed.sync?.elapsedMs ?? Date.now() - t0),
			};
		});
	}

	private campaignBindingsPath(cwd: string): string {
		return join(cwd, ".wenyou", "ntqq-groups.json");
	}

	private campaignSyncStatePath(cwd: string): string {
		return join(cwd, ".wenyou", "ntqq-sync-state.json");
	}

	async getCampaignBindings(cwd: string): Promise<CampaignNtqqGroupBinding[]> {
		const file = this.campaignBindingsPath(cwd);
		if (!existsSync(file)) return [];
		try {
			const raw = parseJsonWithBom<{ groups?: unknown[] } | CampaignNtqqGroupBinding[]>(
				await readFile(file, "utf8"),
			);
			const list = Array.isArray(raw) ? raw : Array.isArray(raw?.groups) ? raw.groups : [];
			const out: CampaignNtqqGroupBinding[] = [];
			const seen = new Set<string>();
			for (const item of list) {
				if (!item || typeof item !== "object") continue;
				const rec = item as Record<string, unknown>;
				const gid = typeof rec.groupId === "string" ? rec.groupId.trim() : "";
				if (!GROUP_ID_RE.test(gid) || seen.has(gid)) continue;
				seen.add(gid);
				const role = parseRole(rec.role);
				out.push({
					groupId: gid,
					...(typeof rec.groupName === "string" && rec.groupName.trim()
						? { groupName: rec.groupName.trim() }
						: {}),
					role,
				});
			}
			return out;
		} catch {
			return [];
		}
	}

	async saveCampaignBindings(
		cwd: string,
		bindings: readonly CampaignNtqqGroupBinding[],
	): Promise<CampaignNtqqGroupBinding[]> {
		const clean: CampaignNtqqGroupBinding[] = [];
		const seen = new Set<string>();
		for (const item of bindings) {
			const gid = String(item.groupId ?? "").trim();
			if (!GROUP_ID_RE.test(gid)) {
				throw new Error(`非法 QQ 群号：${gid || "空"}（应为 5～15 位数字）`);
			}
			if (seen.has(gid)) continue;
			seen.add(gid);
			const role = parseRole(item.role);
			clean.push({
				groupId: gid,
				...(item.groupName?.trim() ? { groupName: item.groupName.trim() } : {}),
				role,
			});
		}
		await atomicWriteJson(this.campaignBindingsPath(cwd), { version: 1, groups: clean });
		return clean;
	}

	private async loadCampaignSyncState(cwd: string): Promise<CampaignNtqqSyncState> {
		const file = this.campaignSyncStatePath(cwd);
		if (!existsSync(file)) return {};
		try {
			const raw = parseJsonWithBom<Record<string, Partial<CampaignNtqqSyncWatermark>>>(
				await readFile(file, "utf8"),
			);
			const out: CampaignNtqqSyncState = {};
			for (const [gid, entry] of Object.entries(raw)) {
				if (!GROUP_ID_RE.test(gid) || !entry || typeof entry !== "object") continue;
				const parsedTs = Number(entry.lastTs);
				out[gid] = {
					lastTs: Number.isFinite(parsedTs) && parsedTs >= 0 ? Math.trunc(parsedTs) : 0,
					lastRowid: normalizeDecimalRowid(entry.lastRowid),
					lastSyncedAt: typeof entry.lastSyncedAt === "string" ? entry.lastSyncedAt : "",
				};
			}
			return out;
		} catch {
			return {};
		}
	}

	async syncCampaign(
		cwd: string,
		options?: { groupId?: string; limit?: number; force?: boolean },
	): Promise<NtqqSyncCampaignResult> {
		return this.enqueue(async () => {
			const bindings = await this.getCampaignBindings(cwd);
			const targetBindings = options?.groupId
				? bindings.filter((b) => b.groupId === options.groupId?.trim())
				: bindings;
			if (targetBindings.length === 0) {
				throw new Error(
					options?.groupId
						? `当前战役未绑定 QQ 群 ${options.groupId}`
						: "当前战役尚未绑定任何本机 QQ 群，请先在「局势书与台账」点击「绑定 QQ 群」选择要同步的群",
				);
			}

			const { status } = await this.getStatus();
			if (!status.ready || !status.resolvedDbDir || !status.resolvedKeyMapPath || !status.pythonPath || !status.assetsDir) {
				throw new Error(`本机 NTQQ 只读环境未就绪：${status.missingReasons.join("；")}`);
			}

			const syncState = await this.loadCampaignSyncState(cwd);
			const specs = targetBindings.map((b) => {
				const wm = options?.force ? undefined : syncState[b.groupId];
				return `${b.groupId}:${wm?.lastTs ?? 0}:${wm ? normalizeDecimalRowid(wm.lastRowid) : "0"}`;
			});

			await mkdir(this.tmpDir, { recursive: true });
			const outJsonPath = join(this.tmpDir, `pull-${randomUUID().slice(0, 8)}.json`);
			const bridgePy = join(status.assetsDir, "wenyou_ntqq_bridge.py");
			const srcMsg = join(status.resolvedDbDir, "nt_msg.db");
			const srcGroup = join(status.resolvedDbDir, "group_info.db");
			const [outMsg, outGroup] = await Promise.all([
				this.resolvePlainDbPath("msg", srcMsg),
				this.resolvePlainDbPath("group", srcGroup),
			]);
			const limit = Math.max(1, Math.min(options?.limit ?? 500, 20_000));

			const argv = [
				"-B",
				bridgePy,
				"pull-messages",
				"--src-msg",
				srcMsg,
				"--out-msg",
				outMsg,
				"--src-group",
				srcGroup,
				"--out-group",
				outGroup,
				"--key-map",
				status.resolvedKeyMapPath,
				"--groups",
				specs.join(","),
				"--out-json",
				outJsonPath,
				"--limit",
				String(limit),
			];
			if (options?.force) argv.push("--force");

			try {
				const run = await runCommandWithTimeout(status.pythonPath, argv, {
					cwd: status.assetsDir,
					timeoutMs: VFS_RUN_TIMEOUT_MS,
				});
				if (run.exitCode !== 0) {
					throw new Error(`NTQQ VFS 同步失败：${(run.stderr || run.stdout).trim() || `exit=${run.exitCode}`}`);
				}
				const parsed = parseBridgePayload<{
					ok: boolean;
					totalExported: number;
					perGroup: Array<{
						groupId: string;
						groupName: string;
						fetchedRows: number;
						exportedMessages: number;
						lastTs: number;
						lastRowid: string | number;
						truncated: boolean;
					}>;
					sync: {
						msg?: { elapsedMs?: number; backend?: string; pagesDecrypted?: number; pagesFromWal?: number };
					};
				}>(run.stdout);
				if (!parsed.ok) {
					throw new Error("NTQQ VFS 同步未返回成功状态");
				}

				const payload = parseJsonWithBom<{ messages?: BridgeExportedMessage[] }>(
					await readFile(outJsonPath, "utf8"),
				);
				const exported = Array.isArray(payload.messages) ? payload.messages : [];
				const bindingByGid = new Map(targetBindings.map((b) => [b.groupId, b]));

				const ingestRes = await ingestExternalMessages(
					cwd,
					exported.map((msg) => {
						const binding = bindingByGid.get(msg.groupId);
						return {
							sourceId: msg.sourceId,
							groupId: msg.groupId,
							groupName: binding?.groupName || msg.groupName || msg.groupId,
							role: binding?.role,
							sender: msg.sender,
							...(msg.senderId ? { senderId: msg.senderId } : {}),
							timestamp: msg.timestamp,
							text: msg.text,
							sourceTag: `ntqq://group/${msg.groupId}`,
						};
					}),
				);

				const nowIso = new Date().toISOString();
				const nextSyncState: CampaignNtqqSyncState = { ...syncState };
				const groupDetails: NtqqSyncGroupDetail[] = parsed.perGroup.map((g) => {
					const nextLastTs = Number.isFinite(Number(g.lastTs)) && Number(g.lastTs) > 0 ? Math.trunc(Number(g.lastTs)) : 0;
					const nextLastRowid = normalizeDecimalRowid(g.lastRowid);
					if (nextLastTs > 0) {
						const prev = nextSyncState[g.groupId];
						const prevRowid = prev ? normalizeDecimalRowid(prev.lastRowid) : "0";
						const shouldAdvance =
							!prev ||
							nextLastTs > prev.lastTs ||
							(nextLastTs === prev.lastTs && BigInt(nextLastRowid) >= BigInt(prevRowid));
						if (shouldAdvance) {
							nextSyncState[g.groupId] = {
								lastTs: nextLastTs,
								lastRowid: nextLastRowid,
								lastSyncedAt: nowIso,
							};
						}
					}
					const counts = ingestRes.perGroupCounts[g.groupId] ?? { newlyIngested: 0, skippedDuplicates: 0 };
					return {
						groupId: g.groupId,
						groupName: bindingByGid.get(g.groupId)?.groupName || g.groupName,
						fetchedRows: g.fetchedRows,
						exportedMessages: g.exportedMessages,
						newlyIngested: counts.newlyIngested,
						skippedDuplicates: counts.skippedDuplicates,
						lastTs: nextLastTs,
						lastRowid: nextLastRowid,
						truncated: g.truncated,
					};
				});
				await atomicWriteJson(this.campaignSyncStatePath(cwd), nextSyncState);

				const allEvidence = await loadEvidenceRecords(cwd);
				const cursors = await loadCursors(cwd);
				const unreported = computeUnreportedMessages(allEvidence, cursors);

				return {
					cwd,
					newlyIngested: ingestRes.newlyIngested,
					skippedDuplicates: ingestRes.skippedDuplicates,
					totalEvidenceCount: ingestRes.totalEvidenceCount,
					unreportedCount: unreported.length,
					elapsedMs: Number(parsed.sync?.msg?.elapsedMs ?? 0),
					backend: parsed.sync?.msg?.backend ?? "",
					pagesDecrypted: Number(parsed.sync?.msg?.pagesDecrypted ?? 0),
					pagesFromWal: Number(parsed.sync?.msg?.pagesFromWal ?? 0),
					groups: groupDetails,
				};
			} finally {
				await rm(outJsonPath, { force: true }).catch(() => undefined);
			}
		});
	}
}
