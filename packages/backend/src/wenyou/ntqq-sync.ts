import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	CampaignNtqqGroupBinding,
	GroupRole,
	NtqqGroupSummary,
	NtqqLocalConfig,
	NtqqProbeStatus,
	NtqqStatusSnapshot,
	NtqqSyncCampaignResult,
	NtqqSyncGroupDetail,
	VisibilityLevel,
} from "@percho/shared";
import { computeUnreportedMessages, ingestExternalMessages, loadCursors, loadEvidenceRecords } from "./qq-ingest";

const QQ_UIN_RE = /^\d{5,12}$/;
const GROUP_ID_RE = /^\d{5,15}$/;
const BRIDGE_PREFIX = "__NTQQ_BRIDGE__";
const KEY_EXTRACT_TIMEOUT_MS = 35_000;
const VFS_RUN_TIMEOUT_MS = 90_000;

const REQUIRED_BRIDGE_FILES = [
	"ntqq_vfs.py",
	"wenyou_vfs_sync.py",
	"wenyou_read.py",
	"wenyou_ntqq_bridge.py",
] as const;

interface CampaignNtqqSyncWatermark {
	lastTs: number;
	lastRowid: number;
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
	rowid: number;
	text: string;
}

export interface NtqqSyncServiceOptions {
	dataDir?: string;
	assetsDir?: string;
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

/** 规范化用户手选目录：允许选到 <QQ号>、nt_qq 或 nt_db 任意一层，自动向下定位到 nt_db */
export function resolveCustomDbDirCandidate(rawDir: string): string {
	const trimmed = rawDir.trim();
	if (!trimmed) return trimmed;
	if (existsSync(join(trimmed, "nt_msg.db")) || existsSync(join(trimmed, "group_info.db"))) {
		return trimmed;
	}
	const underNtDb = join(trimmed, "nt_db");
	if (existsSync(join(underNtDb, "nt_msg.db")) || existsSync(join(underNtDb, "group_info.db"))) {
		return underNtDb;
	}
	const underNtQq = join(trimmed, "nt_qq", "nt_db");
	if (existsSync(join(underNtQq, "nt_msg.db")) || existsSync(join(underNtQq, "group_info.db"))) {
		return underNtQq;
	}
	return trimmed;
}

/** 只读解析 Windows QQ UserDataInfo.ini 中的自定义 Tencent Files 根目录（若存在） */
async function readQqUserDataRootsFromIni(): Promise<string[]> {
	if (process.platform !== "win32") return [];
	const iniCandidates = [
		join(process.env.PUBLIC || "C:\\Users\\Public", "Documents", "Tencent", "QQ", "UserDataInfo.ini"),
		join(homedir(), "Documents", "Tencent", "QQ", "UserDataInfo.ini"),
	];
	const roots: string[] = [];
	for (const iniPath of iniCandidates) {
		if (!existsSync(iniPath)) continue;
		try {
			const raw = await readFile(iniPath, "utf8");
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

async function autoDetectNtqqDbDir(qqUin: string): Promise<string | null> {
	const home = homedir();
	const iniRoots = await readQqUserDataRootsFromIni();
	const bases = [
		...iniRoots,
		join(home, "Documents", "Tencent Files"),
		join(home, "OneDrive", "Documents", "Tencent Files"),
	];
	const seen = new Set<string>();
	for (const base of bases) {
		const candidate = join(base, qqUin, "nt_qq", "nt_db");
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (existsSync(join(candidate, "nt_msg.db")) || existsSync(join(candidate, "group_info.db"))) {
			return candidate;
		}
	}
	// 默认位置兜底（即使目录尚未存在也给出清晰预期路径，方便用户核对）
	return join(home, "Documents", "Tencent Files", qqUin, "nt_qq", "nt_db");
}

function runCommandWithTimeout(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
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
				child.kill("SIGKILL");
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

async function detectPythonExecutable(preferred?: string | null): Promise<{ path: string; version: string } | null> {
	const candidates: Array<{ bin: string; prefixArgs: string[] }> = [];
	if (preferred?.trim()) candidates.push({ bin: preferred.trim(), prefixArgs: [] });
	const envPy = process.env.WENYOU_PYTHON?.trim();
	if (envPy) candidates.push({ bin: envPy, prefixArgs: [] });
	if (process.platform === "win32") {
		candidates.push({ bin: "python", prefixArgs: [] });
		candidates.push({ bin: "python3", prefixArgs: [] });
		const localPrograms = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "Python");
		for (const ver of ["Python314", "Python313", "Python312", "Python311", "Python310"]) {
			const exe = join(localPrograms, ver, "python.exe");
			if (existsSync(exe)) candidates.push({ bin: exe, prefixArgs: [] });
		}
	} else {
		candidates.push({ bin: "python3", prefixArgs: [] });
		candidates.push({ bin: "python", prefixArgs: [] });
	}

	const tried = new Set<string>();
	for (const candidate of candidates) {
		const key = candidate.bin.toLowerCase();
		if (tried.has(key)) continue;
		tried.add(key);
		try {
			const res = await runCommandWithTimeout(
				candidate.bin,
				[
					...candidate.prefixArgs,
					"-c",
					"import sys, sqlite3; print(sys.executable); print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
				],
				{ timeoutMs: 5000 },
			);
			if (res.exitCode === 0) {
				const lines = res.stdout
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter(Boolean);
				if (lines.length >= 2 && lines[0] && lines[1]) {
					return { path: lines[0], version: lines[1] };
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

function parseVisibility(raw: unknown, role: GroupRole): VisibilityLevel {
	if (raw === "gm" || raw === "public" || raw === "faction") return raw;
	return role === "cabinet" ? "gm" : "public";
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
	private queue: Promise<unknown> = Promise.resolve();
	private cachedPython: { path: string; version: string } | null | undefined;

	constructor(options?: NtqqSyncServiceOptions) {
		this.dataDir = options?.dataDir ? resolve(options.dataDir) : defaultNtqqDataDir();
		this.assetsDirOverride = options?.assetsDir ? resolve(options.assetsDir) : undefined;
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
			const raw = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<NtqqLocalConfig>;
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
		const next: NtqqLocalConfig = {
			qqUin: patch.qqUin !== undefined ? normalizeQqUin(patch.qqUin) : current.qqUin,
			dbDir:
				patch.dbDir !== undefined
					? patch.dbDir
						? resolveCustomDbDirCandidate(patch.dbDir)
						: null
					: current.dbDir,
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
			process.env.WENYOU_KEY_MAP?.trim() || null,
			this.defaultKeyMapPath,
			join(homedir(), ".dsh", "storages", "dsh-wenyou", "key_map.json"),
			join(homedir(), ".codex", "skills", "qq-chat-reader", "keys", "key_map.json"),
		].filter((p): p is string => Boolean(p));

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return { path: candidate, exists: true };
			}
		}
		return { path: config.keyMapPath ?? this.defaultKeyMapPath, exists: false };
	}

	private async resolvePython(config: NtqqLocalConfig): Promise<{ path: string; version: string } | null> {
		if (!config.pythonPath && this.cachedPython !== undefined) return this.cachedPython;
		const found = await detectPythonExecutable(config.pythonPath);
		if (!config.pythonPath) this.cachedPython = found;
		return found;
	}

	async getStatus(): Promise<NtqqStatusSnapshot> {
		const config = await this.loadConfig();
		const platformSupported = process.platform === "win32";
		const assetsDir = this.resolveAssetsDir();
		const assetsReady = Boolean(
			assetsDir && REQUIRED_BRIDGE_FILES.every((name) => existsSync(join(assetsDir, name))),
		);
		const dumpExe = assetsDir ? join(assetsDir, "qq_dump_db.exe") : null;
		const canExtractKey = Boolean(platformSupported && dumpExe && existsSync(dumpExe));

		let resolvedDbDir: string | null = null;
		let dbDirAutoDetected = false;
		if (config.dbDir) {
			resolvedDbDir = resolveCustomDbDirCandidate(config.dbDir);
		} else if (config.qqUin) {
			resolvedDbDir = await autoDetectNtqqDbDir(config.qqUin);
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
		const pythonInfo = await this.resolvePython(config);

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
			missingReasons.push("尚未准备解密密钥 key_map.json（可点「一键提取本机密钥」或手动导入）");
		}
		if (!pythonInfo) {
			missingReasons.push("本机未检测到 Python 3 运行时（VFS 只读解库依赖 Python 3）");
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
			canExtractKey,
			pythonPath: pythonInfo?.path ?? null,
			pythonVersion: pythonInfo?.version ?? null,
			assetsDir,
			assetsReady,
			ready: missingReasons.length === 0,
			missingReasons,
		};
		return { config, status };
	}

	async extractKey(qqUinOverride?: string): Promise<NtqqStatusSnapshot & { message: string }> {
		return this.enqueue(async () => {
			if (process.platform !== "win32") {
				throw new Error("自动提取 NTQQ 密钥目前仅支持 Windows 电脑版 QQ");
			}
			const current = await this.loadConfig();
			const qqUin = qqUinOverride !== undefined ? normalizeQqUin(qqUinOverride) : current.qqUin;
			if (!qqUin) {
				throw new Error("请先填写你的 QQ 号，再点击提取本机密钥");
			}
			if (qqUin !== current.qqUin) {
				await atomicWriteJson(this.configPath, { ...current, qqUin });
			}
			const assetsDir = this.resolveAssetsDir();
			const dumpExe = assetsDir ? join(assetsDir, "qq_dump_db.exe") : null;
			if (!dumpExe || !existsSync(dumpExe)) {
				throw new Error("未检测到密钥提取组件 qq_dump_db.exe，请手动导入已有 key_map.json");
			}
			await mkdir(this.dataDir, { recursive: true });
			const res = await runCommandWithTimeout(
				dumpExe,
				["--qq", qqUin, "--output", this.defaultKeyMapPath],
				{ cwd: this.dataDir, timeoutMs: KEY_EXTRACT_TIMEOUT_MS },
			);
			if (res.exitCode !== 0 || !existsSync(this.defaultKeyMapPath)) {
				const detail = (res.stderr || res.stdout).trim();
				throw new Error(
					`提取 NTQQ 密钥失败（请确认电脑版 NTQQ 已打开并登录 QQ ${qqUin}）：${detail || `exit=${res.exitCode}`}`,
				);
			}
			const st = await stat(this.defaultKeyMapPath);
			if (st.size === 0) {
				throw new Error("生成的 key_map.json 为空，请确认电脑版 NTQQ 已登录完成");
			}
			const snapshot = await this.getStatus();
			return {
				...snapshot,
				message: "已成功提取并保存本机 NTQQ 解密密钥",
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
				throw new Error("尚未准备 key_map.json，请先一键提取本机密钥或导入密钥文件");
			}
			if (!status.pythonPath || !status.assetsDir || !status.assetsReady) {
				throw new Error(status.missingReasons.join("；") || "NTQQ VFS 运行环境未就绪");
			}

			const bridgePy = join(status.assetsDir, "wenyou_ntqq_bridge.py");
			const srcGroup = join(status.resolvedDbDir, "group_info.db");
			const argv = [
				"-B",
				bridgePy,
				"list-groups",
				"--src-group",
				srcGroup,
				"--out-group",
				this.plainGroupDbPath,
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
			const raw = JSON.parse(await readFile(file, "utf8")) as
				| { groups?: unknown[] }
				| CampaignNtqqGroupBinding[];
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
					visibility: parseVisibility(rec.visibility, role),
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
				visibility: parseVisibility(item.visibility, role),
			});
		}
		await atomicWriteJson(this.campaignBindingsPath(cwd), { version: 1, groups: clean });
		return clean;
	}

	private async loadCampaignSyncState(cwd: string): Promise<CampaignNtqqSyncState> {
		const file = this.campaignSyncStatePath(cwd);
		if (!existsSync(file)) return {};
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, Partial<CampaignNtqqSyncWatermark>>;
			const out: CampaignNtqqSyncState = {};
			for (const [gid, entry] of Object.entries(raw)) {
				if (!GROUP_ID_RE.test(gid) || !entry || typeof entry !== "object") continue;
				out[gid] = {
					lastTs: Number.isFinite(Number(entry.lastTs)) ? Number(entry.lastTs) : 0,
					lastRowid: Number.isFinite(Number(entry.lastRowid)) ? Number(entry.lastRowid) : 0,
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
				return `${b.groupId}:${wm?.lastTs ?? 0}:${wm?.lastRowid ?? 0}`;
			});

			await mkdir(this.tmpDir, { recursive: true });
			const outJsonPath = join(this.tmpDir, `pull-${randomUUID().slice(0, 8)}.json`);
			const bridgePy = join(status.assetsDir, "wenyou_ntqq_bridge.py");
			const srcMsg = join(status.resolvedDbDir, "nt_msg.db");
			const srcGroup = join(status.resolvedDbDir, "group_info.db");
			const limit = Math.max(1, Math.min(options?.limit ?? 500, 20_000));

			const argv = [
				"-B",
				bridgePy,
				"pull-messages",
				"--src-msg",
				srcMsg,
				"--out-msg",
				this.plainMsgDbPath,
				"--src-group",
				srcGroup,
				"--out-group",
				this.plainGroupDbPath,
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
						lastRowid: number;
						truncated: boolean;
					}>;
					sync: {
						msg?: { elapsedMs?: number; backend?: string; pagesDecrypted?: number; pagesFromWal?: number };
					};
				}>(run.stdout);
				if (!parsed.ok) {
					throw new Error("NTQQ VFS 同步未返回成功状态");
				}

				const payload = JSON.parse(await readFile(outJsonPath, "utf8")) as {
					messages?: BridgeExportedMessage[];
				};
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
							visibility: binding?.visibility,
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
					if (g.lastTs > 0) {
						nextSyncState[g.groupId] = {
							lastTs: g.lastTs,
							lastRowid: g.lastRowid,
							lastSyncedAt: nowIso,
						};
					}
					const counts = ingestRes.perGroupCounts[g.groupId] ?? { newlyIngested: 0, skippedDuplicates: 0 };
					return {
						groupId: g.groupId,
						groupName: bindingByGid.get(g.groupId)?.groupName || g.groupName,
						fetchedRows: g.fetchedRows,
						exportedMessages: g.exportedMessages,
						newlyIngested: counts.newlyIngested,
						skippedDuplicates: counts.skippedDuplicates,
						lastTs: g.lastTs,
						lastRowid: g.lastRowid,
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
