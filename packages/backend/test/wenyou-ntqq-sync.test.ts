import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decodeIniBuffer,
	NtqqSyncService,
	normalizeQqUin,
	resolveCustomDbDirCandidate,
	WenyouService,
} from "../src/wenyou";
import {
	autoDetectNtqqDbDir,
	buildPythonCandidates,
	detectNtqqAccounts,
	loadKeyMapEntries,
	parseWindowsTasklistCsv,
	readNtqqDbSaltHex,
} from "../src/wenyou/ntqq-sync";

const ASSETS_DIR = resolve(import.meta.dirname, "../../desktop/resources/ntqq-vfs");
const EXT_HEADER = 1024;
const PAGE_SIZE = 4096;
const SALT_SIZE = 16;
const RESERVE = 48;

function resolvePythonBin(): string {
	const candidates: string[] = [];
	if (process.platform === "win32") {
		const bundled = join(ASSETS_DIR, "python", "python.exe");
		if (existsSync(bundled)) {
			candidates.push(bundled);
		}
		candidates.push("python", "python3");
	} else {
		candidates.push("python3", "python");
	}

	for (const bin of candidates) {
		const probe = spawnSync(bin, ["-B", "-c", "import sqlite3; print(sqlite3.sqlite_version)"], {
			encoding: "utf8",
			env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
		});
		if (probe.status === 0) {
			return bin;
		}
	}
	throw new Error("No working Python 3 runtime with sqlite3 found for wenyou-ntqq-sync tests");
}

const PYTHON_BIN = resolvePythonBin();

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function encodeVarint(value: number): Buffer {
	const out: number[] = [];
	let v = value >>> 0;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v);
	return Buffer.from(out);
}

function encodeTag(fieldNo: number, wireType: number): Buffer {
	return encodeVarint(fieldNo * 8 + wireType);
}

function encodeNtqqTextBlob(text: string): Buffer {
	const textBytes = Buffer.from(text, "utf8");
	const inner = Buffer.concat([
		encodeTag(45002, 0),
		encodeVarint(1),
		encodeTag(45101, 2),
		encodeVarint(textBytes.length),
		textBytes,
	]);
	return Buffer.concat([encodeTag(40800, 2), encodeVarint(inner.length), inner]);
}

function encryptSqliteToNtqq(plainBytes: Buffer, key: Buffer, salt: Buffer): Buffer {
	expect(plainBytes.length % PAGE_SIZE).toBe(0);
	const pageCount = plainBytes.length / PAGE_SIZE;
	const header = Buffer.alloc(EXT_HEADER, 0);
	const encPages: Buffer[] = [header];

	for (let p = 0; p < pageCount; p += 1) {
		const page = Buffer.from(plainBytes.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE));
		const iv = randomBytes(16);
		const pad = Buffer.alloc(RESERVE - 16, 0);
		if (p === 0) {
			const encLen = PAGE_SIZE - SALT_SIZE - RESERVE;
			const cipher = createCipheriv("aes-256-cbc", key, iv);
			cipher.setAutoPadding(false);
			const ct = Buffer.concat([cipher.update(page.subarray(SALT_SIZE, SALT_SIZE + encLen)), cipher.final()]);
			encPages.push(Buffer.concat([salt, ct, iv, pad]));
		} else {
			const encLen = PAGE_SIZE - RESERVE;
			const cipher = createCipheriv("aes-256-cbc", key, iv);
			cipher.setAutoPadding(false);
			const ct = Buffer.concat([cipher.update(page.subarray(0, encLen)), cipher.final()]);
			encPages.push(Buffer.concat([ct, iv, pad]));
		}
	}
	return Buffer.concat(encPages);
}

function sha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createPlainSqliteFixtures(
	dir: string,
	messages: Array<{
		rowid: number | string;
		ts: number;
		gid: number;
		col40003?: number | string | null;
		col40030?: number | null;
		uid: string | number | null;
		text: string;
	}>,
): { plainMsg: string; plainGroup: string } {
	const plainMsg = join(dir, "plain_msg.db");
	const plainGroup = join(dir, "plain_group.db");
	const pyScript = `
import json, pathlib, sqlite3, struct, sys
msg_db, grp_db, rows_json = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.loads(rows_json)

def init_reserved(db_path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA page_size=4096")
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("CREATE TABLE _init(x INTEGER)")
    conn.execute("DROP TABLE _init")
    conn.commit()
    conn.close()
    raw = bytearray(pathlib.Path(db_path).read_bytes())
    raw[20] = 48
    struct.pack_into(">H", raw, 105, 4096 - 48)
    pathlib.Path(db_path).write_bytes(bytes(raw))

init_reserved(msg_db)
c = sqlite3.connect(msg_db)
c.executescript('''
CREATE TABLE group_msg_table (
  "40001" INTEGER PRIMARY KEY,
  "40002" INTEGER,
  "40003" INTEGER,
  "40027" INTEGER,
  "40030" INTEGER,
  "40033" INTEGER,
  "40050" INTEGER,
  "40058" INTEGER,
  "40800" BLOB
);
CREATE INDEX group_msg_table_idx40027_40003 ON group_msg_table("40027", "40003");
CREATE TABLE nt_uid_mapping_table ("48902" TEXT PRIMARY KEY, "1002" TEXT);
''')
c.execute('INSERT INTO nt_uid_mapping_table ("48902", "1002") VALUES (?, ?)', ("u_gm", "司历GM"))
c.execute('INSERT INTO nt_uid_mapping_table ("48902", "1002") VALUES (?, ?)', ("u_player", "北周参谋"))
c.execute('INSERT INTO nt_uid_mapping_table ("48902", "1002") VALUES (?, ?)', ("u_self", "测试玩家"))
for r in rows:
    c40030 = r["col40030"] if "col40030" in r else r["gid"]
    rid = int(r["rowid"])
    c40003 = int(r["col40003"]) if "col40003" in r and r["col40003"] is not None else rid
    c.execute(
      'INSERT INTO group_msg_table ("40001","40002","40003","40027","40030","40033","40050","40058","40800") VALUES (?,?,?,?,?,?,?,?,?)',
      (rid, 1, c40003, r["gid"], c40030, r["uid"], r["ts"], 0, bytes.fromhex(r["blobHex"]))
    )
c.commit()
c.close()

init_reserved(grp_db)
g = sqlite3.connect(grp_db)
g.execute('CREATE TABLE group_list ("60001" INTEGER PRIMARY KEY, "60007" TEXT)')
g.execute('INSERT INTO group_list ("60001", "60007") VALUES (?, ?)', (900001, "河朔测试主群"))
g.execute('INSERT INTO group_list ("60001", "60007") VALUES (?, ?)', (900002, "河朔内阁密群"))
g.commit()
g.close()
`;
	const encoded = messages.map((m) => ({
		...m,
		blobHex: encodeNtqqTextBlob(m.text).toString("hex"),
	}));
	const res = spawnSync(PYTHON_BIN, ["-B", "-c", pyScript, plainMsg, plainGroup, JSON.stringify(encoded)], {
		encoding: "utf8",
		env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
	});
	if (res.status !== 0) {
		throw new Error(`Python fixture build failed: ${res.stderr || res.stdout}`);
	}
	return { plainMsg, plainGroup };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("Wenyou NTQQ 只读解库与配置隔离", () => {
	it("QQ 号校验与 nt_db 多层级路径自动归位", () => {
		expect(normalizeQqUin(" 10001 ")).toBe("10001");
		expect(normalizeQqUin("")).toBeNull();
		expect(normalizeQqUin(null)).toBeNull();
		expect(() => normalizeQqUin("123")).toThrow(/5～12/);
		expect(() => normalizeQqUin("abc12345")).toThrow(/5～12/);

		const root = makeTempDir("wenyou-ntqq-dir-");
		const ntDb = join(root, "10001", "nt_qq", "nt_db");
		mkdirSync(ntDb, { recursive: true });
		writeFileSync(join(ntDb, "nt_msg.db"), "stub");

		expect(resolveCustomDbDirCandidate(ntDb)).toBe(ntDb);
		expect(resolveCustomDbDirCandidate(join(root, "10001", "nt_qq"))).toBe(ntDb);
		expect(resolveCustomDbDirCandidate(join(root, "10001"))).toBe(ntDb);
	});

	it("端到端只读 VFS 解密合成加密库：列出群、绑定群、增量扒库入 L0、二次幂等且源加密库逐字节未改", async () => {
		const work = makeTempDir("wenyou-ntqq-e2e-");
		const dataDir = join(work, "ntqq-data");
		const dbDir = join(work, "fake-nt-db");
		const campaignDir = join(work, "campaign");
		mkdirSync(dbDir, { recursive: true });
		mkdirSync(campaignDir, { recursive: true });

		const keyMsg = randomBytes(32);
		const saltMsg = randomBytes(16);
		const keyGrp = randomBytes(32);
		const saltGrp = randomBytes(16);

		const { plainMsg, plainGroup } = createPlainSqliteFixtures(work, [
			{ rowid: 101, ts: 1764000100, gid: 900001, uid: "u_gm", text: "【裁定】北周清源城秋粮入仓完毕" },
			{ rowid: 102, ts: 1764000200, gid: 900001, uid: "u_player", text: "收到，我方下回合遣使通好西凉" },
			// 回归：NTQQ 中本人发出消息 40027=群号、40030=0，绝不可被漏掉
			{
				rowid: 103,
				ts: 1764000250,
				gid: 900001,
				col40030: 0,
				uid: "u_self",
				text: "本人回复：已核实西凉使节路线",
			},
			{ rowid: 201, ts: 1764000300, gid: 900002, uid: "u_player", text: "内阁密议：预留三成精铁待春汛" },
		]);

		const encMsgPath = join(dbDir, "nt_msg.db");
		const encGrpPath = join(dbDir, "group_info.db");
		writeFileSync(encMsgPath, encryptSqliteToNtqq(readFileSync(plainMsg), keyMsg, saltMsg));
		writeFileSync(encGrpPath, encryptSqliteToNtqq(readFileSync(plainGroup), keyGrp, saltGrp));

		const origMsgHash = sha256(encMsgPath);
		const origGrpHash = sha256(encGrpPath);

		const keyMapPath = join(dataDir, "key_map.json");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[saltMsg.toString("hex")]: keyMsg.toString("hex"),
					[saltGrp.toString("hex")]: keyGrp.toString("hex"),
				},
			}),
		);

		const service = new WenyouService(undefined, { dataDir, assetsDir: ASSETS_DIR });
		await service.initCampaign(campaignDir, { worldTitle: "测试战役", currentEra: "第一回合" });

		// 1. 保存本机 QQ 配置并验证完全与战役目录隔离，且优先命中随包内置嵌入式 Python
		const snap = await service.ntqq.saveConfig({ qqUin: "10001", dbDir, keyMapPath });
		expect(snap.status.ready).toBe(true);
		expect(snap.status.msgDbExists).toBe(true);
		expect(snap.status.groupDbExists).toBe(true);
		if (process.platform === "win32" && existsSync(join(ASSETS_DIR, "python", "python.exe"))) {
			expect(snap.status.pythonBundled).toBe(true);
			expect(snap.status.pythonPath?.toLowerCase()).toContain("ntqq-vfs\\python\\python.exe");
		}
		expect(existsSync(join(campaignDir, "config.json"))).toBe(false);

		// 2. 读取本机加密群列表
		const groupList = await service.ntqq.listGroups();
		expect(groupList.groups).toEqual([
			{ groupId: "900001", groupName: "河朔测试主群" },
			{ groupId: "900002", groupName: "河朔内阁密群" },
		]);

		// 3. 绑定两个群并首次全量增量同步
		const savedBindings = await service.ntqq.saveCampaignBindings(campaignDir, [
			{ groupId: "900001", groupName: "河朔测试主群", role: "main" },
			{ groupId: "900002", groupName: "河朔内阁密群", role: "cabinet" },
		]);
		expect(savedBindings).toEqual([
			{ groupId: "900001", groupName: "河朔测试主群", role: "main" },
			{ groupId: "900002", groupName: "河朔内阁密群", role: "cabinet" },
		]);

		const firstSync = await service.syncNtqqCampaign(campaignDir);
		expect(firstSync.newlyIngested).toBe(4);
		expect(firstSync.skippedDuplicates).toBe(0);
		expect(firstSync.totalEvidenceCount).toBe(4);

		// 验证本人发出消息（40030=0）与上下文完整保留
		const selfHits = await service.searchSources(campaignDir, { keyword: "西凉使节路线" });
		expect(selfHits.length).toBe(1);
		expect(selfHits[0]?.sender).toBe("测试玩家");
		expect(selfHits[0]?.sourceId).toBe("qq-900001-103");
		expect("kind" in selfHits[0]!).toBe(false);
		expect("visibility" in selfHits[0]!).toBe(false);
		const ctxWin = await service.lookupSource(campaignDir, "qq-900001-103", 5);
		expect(ctxWin?.messages.map((m) => m.sourceId)).toEqual([
			"qq-900001-101",
			"qq-900001-102",
			"qq-900001-103",
		]);

		const cabinetHits = await service.searchSources(campaignDir, { keyword: "精铁" });
		expect(cabinetHits.length).toBe(1);

		const mainHits = await service.searchSources(campaignDir, { keyword: "秋粮" });
		expect(mainHits.length).toBe(1);
		expect(mainHits[0]?.sender).toBe("司历GM");

		// 4. 二次触发 pullQq（联动 NTQQ + 00-群聊收集/）：严格幂等 0 新增
		const secondPull = await service.pullQq(campaignDir);
		expect(secondPull.newlyIngested).toBe(0);
		expect(secondPull.ntqqWarning).toBeUndefined();
		expect(secondPull.totalEvidenceCount).toBe(4);

		// 5. 源加密库逐字节未改动（只读铁律）
		expect(sha256(encMsgPath)).toBe(origMsgHash);
		expect(sha256(encGrpPath)).toBe(origGrpHash);
	});

	it("增量 scan 路径与回退分页路径同样保留 40030=0 的本人发出消息", async () => {
		const work = makeTempDir("wenyou-ntqq-self-inc-");
		const dataDir = join(work, "ntqq-data");
		const dbDir = join(work, "fake-nt-db");
		const campaignDir = join(work, "campaign");
		mkdirSync(dbDir, { recursive: true });
		mkdirSync(campaignDir, { recursive: true });

		const keyMsg = randomBytes(32);
		const saltMsg = randomBytes(16);
		const keyGrp = randomBytes(32);
		const saltGrp = randomBytes(16);

		let fixtureStep = 0;
		const writeEncryptedPair = (
			rows: Array<{ rowid: number; ts: number; gid: number; col40030?: number; uid: string; text: string }>,
		) => {
			fixtureStep += 1;
			const stepDir = join(work, `fixture-${fixtureStep}`);
			mkdirSync(stepDir, { recursive: true });
			const { plainMsg, plainGroup } = createPlainSqliteFixtures(stepDir, rows);
			writeFileSync(join(dbDir, "nt_msg.db"), encryptSqliteToNtqq(readFileSync(plainMsg), keyMsg, saltMsg));
			writeFileSync(
				join(dbDir, "group_info.db"),
				encryptSqliteToNtqq(readFileSync(plainGroup), keyGrp, saltGrp),
			);
		};

		writeEncryptedPair([{ rowid: 101, ts: 1764001000, gid: 900001, uid: "u_gm", text: "首条群消息" }]);

		const keyMapPath = join(dataDir, "key_map.json");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[saltMsg.toString("hex")]: keyMsg.toString("hex"),
					[saltGrp.toString("hex")]: keyGrp.toString("hex"),
				},
			}),
		);

		const service = new WenyouService(undefined, { dataDir, assetsDir: ASSETS_DIR });
		await service.initCampaign(campaignDir, { worldTitle: "增量本人消息回归", currentEra: "T1" });
		await service.ntqq.saveConfig({ qqUin: "10001", dbDir, keyMapPath });
		await service.ntqq.saveCampaignBindings(campaignDir, [
			{ groupId: "900001", groupName: "河朔测试主群", role: "main" },
		]);

		const sync1 = await service.syncNtqqCampaign(campaignDir);
		expect(sync1.newlyIngested).toBe(1);

		// 追加本人发出消息（40030=0），走增量 scan -> fast_query 路径
		writeEncryptedPair([
			{ rowid: 101, ts: 1764001000, gid: 900001, uid: "u_gm", text: "首条群消息" },
			{ rowid: 102, ts: 1764001100, gid: 900001, col40030: 0, uid: "u_self", text: "本人增量回复：确认无误" },
		]);

		const sync2 = await service.syncNtqqCampaign(campaignDir);
		expect(sync2.newlyIngested).toBe(1);
		expect(sync2.totalEvidenceCount).toBe(2);
		const found = await service.searchSources(campaignDir, { keyword: "本人增量回复" });
		expect(found).toHaveLength(1);
		expect(found[0]?.sender).toBe("测试玩家");
	});

	it("非法群号绑定被严格拒绝", async () => {
		const work = makeTempDir("wenyou-ntqq-invalid-");
		const ntqq = new NtqqSyncService({ dataDir: join(work, "data"), assetsDir: ASSETS_DIR });
		await expect(
			ntqq.saveCampaignBindings(work, [{ groupId: "not-a-number", role: "main" }]),
		).rejects.toThrow(/非法 QQ 群号/);
	});

	it("decodeIniBuffer 兼容 UTF-16LE BOM、UTF-8 BOM 与 GB18030 中文路径", () => {
		const sample = "UserDataSavePath=D:\\文档\\腾讯数据";
		const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample, "utf16le")]);
		expect(decodeIniBuffer(utf16le)).toBe(sample);

		const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample, "utf8")]);
		expect(decodeIniBuffer(utf8Bom)).toBe(sample);

		// GB18030 编码「中文」字节为 D6 D0 CE C4
		const gbkBuf = Buffer.concat([
			Buffer.from("UserDataSavePath=D:\\", "ascii"),
			Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
		]);
		expect(decodeIniBuffer(gbkBuf)).toBe("UserDataSavePath=D:\\中文");
	});

	it("NTQQ 双号段 rowid + 40003=0 本机发言增量不漏读，且剔除 40030=0 & 40033=0 系统灰条", async () => {
		const work = makeTempDir("wenyou-ntqq-dual-rowid-");
		const dataDir = join(work, "ntqq-data");
		const dbDir = join(work, "fake-nt-db");
		const campaignDir = join(work, "campaign");
		mkdirSync(dbDir, { recursive: true });
		mkdirSync(campaignDir, { recursive: true });

		const keyMsg = randomBytes(32);
		const saltMsg = randomBytes(16);
		const keyGrp = randomBytes(32);
		const saltGrp = randomBytes(16);

		let step = 0;
		const writeEnc = (
			rows: Array<{
				rowid: number;
				ts: number;
				gid: number;
				col40003?: number | null;
				col40030?: number | null;
				uid: string | number | null;
				text: string;
			}>,
		) => {
			step += 1;
			const stepDir = join(work, `step-${step}`);
			mkdirSync(stepDir, { recursive: true });
			const { plainMsg, plainGroup } = createPlainSqliteFixtures(stepDir, rows);
			writeFileSync(join(dbDir, "nt_msg.db"), encryptSqliteToNtqq(readFileSync(plainMsg), keyMsg, saltMsg));
			writeFileSync(
				join(dbDir, "group_info.db"),
				encryptSqliteToNtqq(readFileSync(plainGroup), keyGrp, saltGrp),
			);
			return plainMsg;
		};

		// 初始同步：高号段消息 rowid=100000 + 一条系统灰条（40030=0, 40033=0）
		writeEnc([
			{ rowid: 100000, ts: 1764002000, gid: 900001, col40003: 500, uid: "u_gm", text: "高号段首条裁定" },
			{
				rowid: 100001,
				ts: 1764002010,
				gid: 900001,
				col40003: 501,
				col40030: 0,
				uid: 0,
				text: "系统灰条：某人撤回了一条消息",
			},
		]);

		const keyMapPath = join(dataDir, "key_map.json");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[saltMsg.toString("hex")]: keyMsg.toString("hex"),
					[saltGrp.toString("hex")]: keyGrp.toString("hex"),
				},
			}),
		);

		const service = new WenyouService(undefined, { dataDir, assetsDir: ASSETS_DIR });
		await service.initCampaign(campaignDir, { worldTitle: "双号段测试", currentEra: "T1" });
		await service.ntqq.saveConfig({ qqUin: "10001", dbDir, keyMapPath });
		await service.ntqq.saveCampaignBindings(campaignDir, [
			{ groupId: "900001", groupName: "河朔测试主群", role: "main" },
		]);

		const s1 = await service.syncNtqqCampaign(campaignDir);
		expect(s1.newlyIngested).toBe(1);
		expect((await service.searchSources(campaignDir, { keyword: "系统灰条" })).length).toBe(0);

		// 增量写入：本机 PC 端发出低号段 rowid=50、40003=0、40030=0、40033="u_self" 的新消息 + 另一条空 UID 系统灰条
		const latestPlainMsg = writeEnc([
			{ rowid: 100000, ts: 1764002000, gid: 900001, col40003: 500, uid: "u_gm", text: "高号段首条裁定" },
			{
				rowid: 100001,
				ts: 1764002010,
				gid: 900001,
				col40003: 501,
				col40030: 0,
				uid: 0,
				text: "系统灰条：某人撤回了一条消息",
			},
			{
				rowid: 50,
				ts: 1764002100,
				gid: 900001,
				col40003: 0,
				col40030: 0,
				uid: "u_self",
				text: "低号段本机发出：已部署河阳防线",
			},
			{
				rowid: 51,
				ts: 1764002110,
				gid: 900001,
				col40003: 0,
				col40030: 0,
				uid: "",
				text: "系统灰条：空UID拍一拍",
			},
		]);

		const s2 = await service.syncNtqqCampaign(campaignDir);
		expect(s2.newlyIngested).toBe(1);
		const selfMsg = await service.searchSources(campaignDir, { keyword: "已部署河阳防线" });
		expect(selfMsg).toHaveLength(1);
		expect(selfMsg[0]?.sender).toBe("测试玩家");
		expect((await service.searchSources(campaignDir, { keyword: "系统灰条" })).length).toBe(0);

		// 直接验证 wenyou_read.py 的 paged_query 在双号段 rowid（since_rowid=100000, since_ts=1764002000）下绝不跳漏 rowid=50 且过滤系统灰条
		const pyCheck = `
import json, sys
sys.path.insert(0, sys.argv[1])
import wenyou_read
conn = wenyou_read.open_readonly(sys.argv[2])
try:
    rows = wenyou_read.paged_query(conn, "group_msg_table", 900001, 1764002000, 100000, 10)
    print(json.dumps([(r[0], r[1], r[3]) for r in rows]))
finally:
    conn.close()
`;
		const pyRes = spawnSync(PYTHON_BIN, ["-B", "-c", pyCheck, ASSETS_DIR, latestPlainMsg], {
			encoding: "utf8",
			env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
		});
		expect(pyRes.status).toBe(0);
		expect(JSON.parse(pyRes.stdout.trim())).toEqual([[50, 1764002100, "u_self"]]);
	});

	it("resolveCustomDbDirCandidate 识别 nt_qq_<hash>/nt_db 且多目录按 nt_msg.db mtime 降序取最新", () => {
		const root = makeTempDir("wenyou-ntqq-hash-dir-");
		const qqRoot = join(root, "QQ");
		const olderDbDir = join(qqRoot, "nt_qq_aaa111", "nt_db");
		const newerDbDir = join(qqRoot, "nt_qq_zzz999", "nt_db");
		mkdirSync(olderDbDir, { recursive: true });
		mkdirSync(newerDbDir, { recursive: true });

		const olderMsg = join(olderDbDir, "nt_msg.db");
		const newerMsg = join(newerDbDir, "nt_msg.db");
		writeFileSync(olderMsg, "old-db");
		writeFileSync(newerMsg, "new-db");

		const t1 = new Date(1_700_000_000_000);
		const t2 = new Date(1_700_003_600_000);
		const t3 = new Date(1_700_007_200_000);
		utimesSync(olderMsg, t1, t1);
		utimesSync(newerMsg, t2, t2);
		expect(resolveCustomDbDirCandidate(qqRoot)).toBe(newerDbDir);

		// 翻转 mtime，验证并非依赖字母序而是真实按 mtimeMs 降序选取
		utimesSync(olderMsg, t3, t3);
		expect(resolveCustomDbDirCandidate(qqRoot)).toBe(olderDbDir);

		// 不存在的目录静默回退原值且不抛错
		const missingDir = join(root, "not-existing-qq-dir");
		expect(resolveCustomDbDirCandidate(missingDir)).toBe(missingDir);
	});

	it("autoDetectNtqqDbDir 在 darwin 平台探测沙盒与非沙盒 nt_qq_* 目录，未命中返回 macOS 默认路径", async () => {
		const emptyHome = makeTempDir("wenyou-ntqq-mac-empty-");
		const defaultMacDir = await autoDetectNtqqDbDir("10001", {
			platform: "darwin",
			homeDir: emptyHome,
			env: {},
		});
		const expectedDefault = join(
			emptyHome,
			"Library",
			"Containers",
			"com.tencent.qq",
			"Data",
			"Library",
			"Application Support",
			"QQ",
		);
		expect(defaultMacDir).toBe(expectedDefault);
		expect(defaultMacDir).not.toContain("Tencent Files");

		// 沙盒容器内存在多个 nt_qq_* 目录时，自动命中 mtime 最新的 nt_db
		const macHome = makeTempDir("wenyou-ntqq-mac-container-");
		const containerBase = join(
			macHome,
			"Library",
			"Containers",
			"com.tencent.qq",
			"Data",
			"Library",
			"Application Support",
			"QQ",
		);
		const hashOld = join(containerBase, "nt_qq_old000", "nt_db");
		const hashNew = join(containerBase, "nt_qq_abc123", "nt_db");
		mkdirSync(hashOld, { recursive: true });
		mkdirSync(hashNew, { recursive: true });
		const oldMsg = join(hashOld, "nt_msg.db");
		const newMsg = join(hashNew, "nt_msg.db");
		writeFileSync(oldMsg, "old");
		writeFileSync(newMsg, "new");
		utimesSync(oldMsg, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
		utimesSync(newMsg, new Date(1_700_010_000_000), new Date(1_700_010_000_000));

		expect(await autoDetectNtqqDbDir("10001", { platform: "darwin", homeDir: macHome, env: {} })).toBe(
			hashNew,
		);

		// 容器为空时回退到 Library/Application Support/QQ
		const fallbackHome = makeTempDir("wenyou-ntqq-mac-fallback-");
		const appSupportHash = join(fallbackHome, "Library", "Application Support", "QQ", "nt_qq_fb42", "nt_db");
		mkdirSync(appSupportHash, { recursive: true });
		writeFileSync(join(appSupportHash, "nt_msg.db"), "fallback");

		expect(await autoDetectNtqqDbDir("10001", { platform: "darwin", homeDir: fallbackHome, env: {} })).toBe(
			appSupportHash,
		);
	});

	it("autoDetectNtqqDbDir 在 linux 平台探测 .config/QQ 与 XDG_CONFIG_HOME，并保持 win32 默认语义不变", async () => {
		const emptyLinuxHome = makeTempDir("wenyou-ntqq-linux-empty-");
		expect(await autoDetectNtqqDbDir("10001", { platform: "linux", homeDir: emptyLinuxHome, env: {} })).toBe(
			join(emptyLinuxHome, ".config", "QQ"),
		);

		const linuxHome = makeTempDir("wenyou-ntqq-linux-hit-");
		const dotConfigDb = join(linuxHome, ".config", "QQ", "nt_qq_xyz", "nt_db");
		mkdirSync(dotConfigDb, { recursive: true });
		writeFileSync(join(dotConfigDb, "nt_msg.db"), "linux-db");
		expect(await autoDetectNtqqDbDir("10001", { platform: "linux", homeDir: linuxHome, env: {} })).toBe(
			dotConfigDb,
		);

		// XDG_CONFIG_HOME 存在有效库时优先命中 XDG_CONFIG_HOME
		const xdgRoot = makeTempDir("wenyou-ntqq-linux-xdg-");
		const xdgDb = join(xdgRoot, "QQ", "nt_qq_xdg99", "nt_db");
		mkdirSync(xdgDb, { recursive: true });
		writeFileSync(join(xdgDb, "nt_msg.db"), "xdg-db");
		expect(
			await autoDetectNtqqDbDir("10001", {
				platform: "linux",
				homeDir: linuxHome,
				env: { XDG_CONFIG_HOME: xdgRoot },
			}),
		).toBe(xdgDb);

		// Windows 默认回退路径保持不变
		const winHome = makeTempDir("wenyou-ntqq-win-default-");
		expect(
			await autoDetectNtqqDbDir("10001", {
				platform: "win32",
				homeDir: winHome,
				env: { PUBLIC: join(winHome, "Public") },
			}),
		).toBe(join(winHome, "Documents", "Tencent Files", "10001", "nt_qq", "nt_db"));
	});

	it("非 win32 平台 getStatus 诊断文案准确反映密钥与 Python 限制，不误导一键提取", async () => {
		const work = makeTempDir("wenyou-ntqq-nonwin-status-");
		const dataDir = join(work, "ntqq-data");
		const fakeHome = join(work, "home");
		mkdirSync(fakeHome, { recursive: true });

		for (const plat of ["darwin", "linux"] as const) {
			const service = new NtqqSyncService({
				dataDir: join(dataDir, plat),
				assetsDir: ASSETS_DIR,
				platform: plat,
				homeDir: fakeHome,
				env: { PATH: "" },
				darwinPythonPaths: [],
			});
			const { status } = await service.getStatus();
			expect(status.platformSupported).toBe(false);
			expect(status.canExtractKey).toBe(false);
			expect(status.keyMapExists).toBe(false);
			expect(status.missingReasons).toContain(
				"尚未导入解密密钥 key_map.json（一键提取仅支持 Windows；macOS/Linux 可将导出的 .txt/.json 放入 00-群聊收集/，或手动导入 key_map.json）",
			);
			expect(status.missingReasons.some((r) => r.includes("可点「一键提取本机密钥」"))).toBe(false);
			expect(status.pythonPath).toBeNull();
			expect(status.missingReasons).toContain(
				"未找到可用的 Python 3 运行时（可安装 Python 3，或直接使用 00-群聊收集/ 离线导入）",
			);
			expect(status.missingReasons.some((r) => r.includes("随包内置运行时缺失"))).toBe(false);
			await expect(service.extractKey("10001")).rejects.toThrow(/仅支持 Windows/);
		}

		// 对照：Windows 且存在 qq_dump_db.exe 时保留一键提取提示
		if (existsSync(join(ASSETS_DIR, "qq_dump_db.exe"))) {
			const winService = new NtqqSyncService({
				dataDir: join(dataDir, "win32"),
				assetsDir: ASSETS_DIR,
				platform: "win32",
				homeDir: fakeHome,
				env: { PATH: "", LOCALAPPDATA: join(work, "empty-localappdata") },
			});
			const { status: winStatus } = await winService.getStatus();
			expect(winStatus.platformSupported).toBe(true);
			expect(winStatus.canExtractKey).toBe(true);
			expect(winStatus.missingReasons).toContain(
				"尚未准备解密密钥 key_map.json（可点「一键提取本机密钥」或手动导入）",
			);
		}
	});

	it("darwin 平台优先探测真实完整 Python 路径避开 Xcode stub，且 listGroups 缺密钥提示按平台区分", async () => {
		const work = makeTempDir("wenyou-ntqq-mac-py-");
		const hbPy = join(work, "opt", "homebrew", "bin", "python3");
		const missingLocalPy = join(work, "usr", "local", "bin", "python3");
		const fwPy = join(
			work,
			"Library",
			"Frameworks",
			"Python.framework",
			"Versions",
			"Current",
			"bin",
			"python3",
		);
		mkdirSync(join(work, "opt", "homebrew", "bin"), { recursive: true });
		mkdirSync(join(work, "Library", "Frameworks", "Python.framework", "Versions", "Current", "bin"), {
			recursive: true,
		});
		writeFileSync(hbPy, "stub");
		writeFileSync(fwPy, "stub");

		// 1. 仅存在的 macOS 完整路径被排在裸 python3 / python 之前
		const darwinCandidates = buildPythonCandidates(null, null, {
			platform: "darwin",
			env: {},
			darwinPythonPaths: [hbPy, missingLocalPy, fwPy],
		});
		expect(darwinCandidates.map((c) => c.bin)).toEqual([hbPy, fwPy, "python3", "python"]);

		// linux 不会混入 darwin 专属路径
		const linuxCandidates = buildPythonCandidates(null, null, {
			platform: "linux",
			env: {},
			darwinPythonPaths: [hbPy, fwPy],
		});
		expect(linuxCandidates.map((c) => c.bin)).toEqual(["python3", "python"]);

		// 2. 端到端实测：PATH 为空时仍能通过 darwinPythonPaths 命中真实 Python 可执行文件
		const pyExeRes = spawnSync(PYTHON_BIN, ["-B", "-c", "import sys; print(sys.executable)"], {
			encoding: "utf8",
			env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
		});
		expect(pyExeRes.status).toBe(0);
		const realPythonExe = pyExeRes.stdout.trim();
		expect(existsSync(realPythonExe)).toBe(true);

		const dbDir = join(work, "nt_db");
		mkdirSync(dbDir, { recursive: true });
		writeFileSync(join(dbDir, "group_info.db"), "stub-group-db");

		const macService = new NtqqSyncService({
			dataDir: join(work, "data-mac"),
			assetsDir: ASSETS_DIR,
			platform: "darwin",
			homeDir: work,
			env: { PATH: "" },
			darwinPythonPaths: [missingLocalPy, realPythonExe],
		});
		const snap = await macService.saveConfig({ dbDir });
		expect(snap.status.pythonPath).toBeTruthy();
		expect(snap.status.pythonVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(snap.status.pythonBundled).toBe(false);

		// 3. 非 Windows 下 listGroups 缺密钥时提示手动导入或 00-群聊收集/，不再误导点击一键提取
		await expect(macService.listGroups()).rejects.toThrow(/00-群聊收集\//);
		await expect(macService.listGroups()).rejects.not.toThrow(/请先一键提取本机密钥/);

		// 对照：Windows 且具备 qq_dump_db.exe 时保留一键提取提示
		if (existsSync(join(ASSETS_DIR, "qq_dump_db.exe"))) {
			const winService = new NtqqSyncService({
				dataDir: join(work, "data-win"),
				assetsDir: ASSETS_DIR,
				platform: "win32",
				homeDir: work,
			});
			await winService.saveConfig({ dbDir });
			await expect(winService.listGroups()).rejects.toThrow(/请先一键提取本机密钥/);
		}
	});

	it("19 位雪花 rowid 全链路无损字符串传输、BigInt 同秒精确排序，且首轮/补抓如实返回 truncated", async () => {
		const work = makeTempDir("wenyou-ntqq-snowflake-");
		const dataDir = join(work, "ntqq-data");
		const dbDir = join(work, "fake-nt-db");
		const campaignDir = join(work, "campaign");
		mkdirSync(dbDir, { recursive: true });
		mkdirSync(campaignDir, { recursive: true });

		const keyMsg = randomBytes(32);
		const saltMsg = randomBytes(16);
		const keyGrp = randomBytes(32);
		const saltGrp = randomBytes(16);

		let step = 0;
		const writeEnc = (rows: Array<{ rowid: string; ts: number; gid: number; uid: string; text: string }>) => {
			step += 1;
			const stepDir = join(work, `sf-${step}`);
			mkdirSync(stepDir, { recursive: true });
			const { plainMsg, plainGroup } = createPlainSqliteFixtures(stepDir, rows);
			writeFileSync(join(dbDir, "nt_msg.db"), encryptSqliteToNtqq(readFileSync(plainMsg), keyMsg, saltMsg));
			writeFileSync(
				join(dbDir, "group_info.db"),
				encryptSqliteToNtqq(readFileSync(plainGroup), keyGrp, saltGrp),
			);
		};

		// 3 条同秒 19 位雪花 rowid（IEEE-754 double 下会全部舍入成同一浮点数）
		writeEnc([
			{ rowid: "7786000000000000001", ts: 1764005000, gid: 900001, uid: "u_gm", text: "同秒雪花第一条" },
			{ rowid: "7786000000000000002", ts: 1764005000, gid: 900001, uid: "u_player", text: "同秒雪花第二条" },
			{ rowid: "7786000000000000003", ts: 1764005000, gid: 900001, uid: "u_self", text: "同秒雪花第三条" },
		]);

		const keyMapPath = join(dataDir, "key_map.json");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[saltMsg.toString("hex")]: keyMsg.toString("hex"),
					[saltGrp.toString("hex")]: keyGrp.toString("hex"),
				},
			}),
		);

		const service = new WenyouService(undefined, { dataDir, assetsDir: ASSETS_DIR });
		await service.initCampaign(campaignDir, { worldTitle: "雪花精度测试", currentEra: "T1" });
		await service.ntqq.saveConfig({ qqUin: "10001", dbDir, keyMapPath });
		await service.ntqq.saveCampaignBindings(campaignDir, [
			{ groupId: "900001", groupName: "河朔测试主群", role: "main" },
		]);

		// 1. 首轮 limit=2（库里有 3 条）：必须如实返回 truncated=true，且 lastRowid 保留精确 19 位十进制字符串
		const first = await service.syncNtqqCampaign(campaignDir, { limit: 2 });
		expect(first.newlyIngested).toBe(2);
		expect(first.groups[0]?.truncated).toBe(true);
		expect(first.groups[0]?.lastRowid).toBe("7786000000000000003");

		const stateOnDisk = JSON.parse(
			readFileSync(join(campaignDir, ".wenyou", "ntqq-sync-state.json"), "utf8"),
		) as Record<string, { lastRowid: unknown }>;
		expect(stateOnDisk["900001"]?.lastRowid).toBe("7786000000000000003");

		// 2. 同秒新增第 4 条（7786...004）：借助精确 19 位字符串水位，增量同步准确抓取第 4 条，且不重复拉取第 3 条
		writeEnc([
			{ rowid: "7786000000000000001", ts: 1764005000, gid: 900001, uid: "u_gm", text: "同秒雪花第一条" },
			{ rowid: "7786000000000000002", ts: 1764005000, gid: 900001, uid: "u_player", text: "同秒雪花第二条" },
			{ rowid: "7786000000000000003", ts: 1764005000, gid: 900001, uid: "u_self", text: "同秒雪花第三条" },
			{ rowid: "7786000000000000004", ts: 1764005000, gid: 900001, uid: "u_gm", text: "同秒雪花第四条" },
		]);
		const second = await service.syncNtqqCampaign(campaignDir, { limit: 10 });
		expect(second.newlyIngested).toBe(1);
		expect(second.groups[0]?.fetchedRows).toBe(1);
		expect(second.groups[0]?.truncated).toBe(false);
		expect(second.groups[0]?.lastRowid).toBe("7786000000000000004");

		// 3. force=true 补抓 limit=2（库里有 4 条）-> truncated=true；limit=10 -> truncated=false 且把第 1 条按 BigInt 精准排到最前
		const backfillPartial = await service.syncNtqqCampaign(campaignDir, { force: true, limit: 2 });
		expect(backfillPartial.groups[0]?.truncated).toBe(true);

		const backfillFull = await service.syncNtqqCampaign(campaignDir, { force: true, limit: 10 });
		expect(backfillFull.groups[0]?.truncated).toBe(false);
		expect(backfillFull.newlyIngested).toBe(1); // 仅补齐首轮未拉的 7786...001
		const ctxWin = await service.lookupSource(campaignDir, "qq-900001-7786000000000000002", 10);
		expect(ctxWin?.messages.map((m) => m.sourceId)).toEqual([
			"qq-900001-7786000000000000001",
			"qq-900001-7786000000000000002",
			"qq-900001-7786000000000000003",
			"qq-900001-7786000000000000004",
		]);
	});

	it("双账号探测 detectedAccounts 按 mtime 降序排列，且 getStatus 精准校验当前库盐值防止假绿", async () => {
		const work = makeTempDir("wenyou-ntqq-dual-detect-");
		const fakeHome = join(work, "home");
		const dataDir = join(work, "ntqq-data");
		const publicDir = join(work, "Public");
		const dbDirA = join(fakeHome, "Documents", "Tencent Files", "10001", "nt_qq", "nt_db");
		const dbDirB = join(fakeHome, "Documents", "Tencent Files", "20002", "nt_qq", "nt_db");
		mkdirSync(dbDirA, { recursive: true });
		mkdirSync(dbDirB, { recursive: true });
		mkdirSync(dataDir, { recursive: true });

		const keyMsgA = randomBytes(32);
		const saltMsgA = randomBytes(16);
		const keyGrpA = randomBytes(32);
		const saltGrpA = randomBytes(16);
		const keyMsgB = randomBytes(32);
		const saltMsgB = randomBytes(16);
		const keyGrpB = randomBytes(32);
		const saltGrpB = randomBytes(16);

		const { plainMsg, plainGroup } = createPlainSqliteFixtures(work, [
			{ rowid: 1, ts: 1764010000, gid: 900001, uid: "u_gm", text: "双账号盐值探测消息" },
		]);
		const plainMsgBytes = readFileSync(plainMsg);
		const plainGrpBytes = readFileSync(plainGroup);

		writeFileSync(join(dbDirA, "nt_msg.db"), encryptSqliteToNtqq(plainMsgBytes, keyMsgA, saltMsgA));
		writeFileSync(join(dbDirA, "group_info.db"), encryptSqliteToNtqq(plainGrpBytes, keyGrpA, saltGrpA));
		writeFileSync(join(dbDirB, "nt_msg.db"), encryptSqliteToNtqq(plainMsgBytes, keyMsgB, saltMsgB));
		writeFileSync(join(dbDirB, "group_info.db"), encryptSqliteToNtqq(plainGrpBytes, keyGrpB, saltGrpB));

		const older = new Date(1_700_000_000_000);
		const newer = new Date(1_700_050_000_000);
		utimesSync(join(dbDirA, "nt_msg.db"), older, older);
		utimesSync(join(dbDirA, "group_info.db"), older, older);
		utimesSync(join(dbDirB, "nt_msg.db"), newer, newer);
		utimesSync(join(dbDirB, "group_info.db"), newer, newer);

		expect(await readNtqqDbSaltHex(join(dbDirA, "nt_msg.db"))).toBe(saltMsgA.toString("hex"));
		expect(await readNtqqDbSaltHex(join(dbDirB, "nt_msg.db"))).toBe(saltMsgB.toString("hex"));

		// key_map.json 仅包含账号 A 的密钥，不包含账号 B 的密钥
		const keyMapPath = join(dataDir, "key_map.json");
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[saltMsgA.toString("hex")]: keyMsgA.toString("hex"),
					[saltGrpA.toString("hex")]: keyGrpA.toString("hex"),
				},
			}),
		);

		const service = new NtqqSyncService({
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: { ...process.env, PUBLIC: publicDir },
		});

		// 切到账号 A：ready=true 且 keyMatchedForCurrentDb=true，detectedAccounts 含两个账号且 B 排在前
		const snapA = await service.saveConfig({ qqUin: "10001", keyMapPath });
		expect(snapA.status.keyMapExists).toBe(true);
		expect(snapA.status.keyMatchedForCurrentDb).toBe(true);
		expect(snapA.status.ready).toBe(true);
		expect(snapA.status.detectedAccounts?.map((a) => a.qqUin)).toEqual(["20002", "10001"]);
		expect(snapA.status.detectedAccounts?.[0]).toMatchObject({
			qqUin: "20002",
			dbDir: dbDirB,
			msgDbExists: true,
			groupDbExists: true,
			keyReady: false,
		});
		expect(snapA.status.detectedAccounts?.[1]).toMatchObject({
			qqUin: "10001",
			dbDir: dbDirA,
			msgDbExists: true,
			groupDbExists: true,
			keyReady: true,
		});

		// 切到账号 B：key_map.json 存在但缺少账号 B 的盐值，绝不能假绿！
		const snapB = await service.saveConfig({ qqUin: "20002" });
		expect(snapB.status.resolvedDbDir).toBe(dbDirB);
		expect(snapB.status.keyMapExists).toBe(true);
		expect(snapB.status.keyMatchedForCurrentDb).toBe(false);
		expect(snapB.status.ready).toBe(false);
		expect(snapB.status.missingReasons.some((r) => r.includes("未包含此 QQ 账号消息库的解密密钥"))).toBe(
			true,
		);
		await expect(service.listGroups()).rejects.toThrow(/未包含此 QQ 账号群资料库/);

		// 单独验证 detectNtqqAccounts 支持空 keyMap 探测
		const rawAccounts = await detectNtqqAccounts({
			platform: "win32",
			homeDir: fakeHome,
			env: { PUBLIC: publicDir },
		});
		expect(rawAccounts.map((a) => a.qqUin)).toEqual(["20002", "10001"]);
		expect(rawAccounts.every((a) => a.keyReady === false)).toBe(true);
	});

	it("双账号多 PID 提取巡检：跳过不匹配 PID、命中后毫秒级早停强杀挂起子进程并无损合并 key_map.json", async () => {
		const work = makeTempDir("wenyou-ntqq-multi-pid-");
		const fakeHome = join(work, "home");
		const dataDir = join(work, "ntqq-data");
		const publicDir = join(work, "Public");
		const dbDirA = join(fakeHome, "Documents", "Tencent Files", "10001", "nt_qq", "nt_db");
		const dbDirB = join(fakeHome, "Documents", "Tencent Files", "20002", "nt_qq", "nt_db");
		mkdirSync(dbDirA, { recursive: true });
		mkdirSync(dbDirB, { recursive: true });
		mkdirSync(dataDir, { recursive: true });

		const keyMsgA = randomBytes(32).toString("hex");
		const saltMsgA = randomBytes(16);
		const keyGrpA = randomBytes(32).toString("hex");
		const saltGrpA = randomBytes(16);
		const keyMsgB = randomBytes(32).toString("hex");
		const saltMsgB = randomBytes(16);
		const keyGrpB = randomBytes(32).toString("hex");
		const saltGrpB = randomBytes(16);

		const { plainMsg, plainGroup } = createPlainSqliteFixtures(work, [
			{ rowid: 1, ts: 1764020000, gid: 900001, uid: "u_gm", text: "多PID提取测试消息" },
		]);
		const plainMsgBytes = readFileSync(plainMsg);
		const plainGrpBytes = readFileSync(plainGroup);

		writeFileSync(
			join(dbDirA, "nt_msg.db"),
			encryptSqliteToNtqq(plainMsgBytes, Buffer.from(keyMsgA, "hex"), saltMsgA),
		);
		writeFileSync(
			join(dbDirA, "group_info.db"),
			encryptSqliteToNtqq(plainGrpBytes, Buffer.from(keyGrpA, "hex"), saltGrpA),
		);
		writeFileSync(
			join(dbDirB, "nt_msg.db"),
			encryptSqliteToNtqq(plainMsgBytes, Buffer.from(keyMsgB, "hex"), saltMsgB),
		);
		writeFileSync(
			join(dbDirB, "group_info.db"),
			encryptSqliteToNtqq(plainGrpBytes, Buffer.from(keyGrpB, "hex"), saltGrpB),
		);

		// 先有账号 A 的 key_map.json（含 UTF-8 BOM 以顺带验证合并时保留旧账号密钥）
		const keyMapPath = join(dataDir, "key_map.json");
		writeFileSync(
			keyMapPath,
			`\uFEFF${JSON.stringify({
				key_map: {
					[saltMsgA.toString("hex")]: keyMsgA,
					[saltGrpA.toString("hex")]: keyGrpA,
				},
			})}`,
			"utf8",
		);

		const callsLogPath = join(work, "dumper-calls.jsonl");
		const stdinClosedFlagPath = join(work, "stdin-closed.flag");
		const mockDumperPath = join(work, "mock-dumper.mjs");
		writeFileSync(
			mockDumperPath,
			`
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const getArg = (flag) => {
	const idx = args.indexOf(flag);
	return idx >= 0 ? args[idx + 1] : null;
};
const qq = getArg("--qq");
const pid = getArg("--pid");
const dbDir = getArg("--db-dir");
const outPath = getArg("--output");
const callsLog = process.env.MOCK_CALLS_LOG;
const stdinFlag = process.env.MOCK_STDIN_FLAG;

// 如果宿主把 stdin 设为 ignore/EOF 或往 stdin 写了回车，立刻留证以便测试 fail
process.stdin.resume();
process.stdin.on("end", () => writeFileSync(stdinFlag, "eof"));
process.stdin.on("data", () => writeFileSync(stdinFlag, "data"));

appendFileSync(callsLog, JSON.stringify({ qq, pid, dbDir, outPath }) + "\\n");

if (pid === "1111") {
	// 模拟 PID 1 是另一个已登录账号 A：返回账号 A 的密钥并挂起等待 QQ 退出
	writeFileSync(outPath, JSON.stringify({
		key_map: {
			${JSON.stringify(saltMsgA.toString("hex"))}: ${JSON.stringify(keyMsgA)},
			${JSON.stringify(saltGrpA.toString("hex"))}: ${JSON.stringify(keyGrpA)},
		},
	}));
	process.stdout.write("Key map saved to " + outPath + "\\nWaiting for QQ to exit ... (or press Enter to proceed)\\n");
	setInterval(() => {}, 60_000);
} else if (pid === "2222") {
	// 模拟 PID 2 无法打开或无密钥
	process.stdout.write("0 salts matched\\nERROR: No keys recovered\\n");
	setInterval(() => {}, 60_000);
} else if (pid === "3333") {
	// 模拟 PID 3 命中目标账号 B：写出 key_map 后同样挂起不退出
	writeFileSync(outPath, JSON.stringify({
		key_map: {
			${JSON.stringify(saltMsgB.toString("hex"))}: ${JSON.stringify(keyMsgB)},
			${JSON.stringify(saltGrpB.toString("hex"))}: ${JSON.stringify(keyGrpB)},
		},
	}));
	process.stdout.write("Key map saved to " + outPath + "\\nWaiting for QQ to exit ... (or press Enter to proceed)\\n");
	setInterval(() => {}, 60_000);
} else {
	process.stderr.write("ERROR: No keys recovered\\n");
	process.exit(1);
}
`,
			"utf8",
		);

		// 验证 tasklist CSV 解析按内存降序排序并去重
		const parsedTasklist = parseWindowsTasklistCsv(
			[
				"INFO: ignore non-csv line",
				'"QQ.exe","2222","Console","1","45,120 K"',
				'"QQ.exe","3333","Console","1","512,800 K"',
				'"QQ.exe","1111","Console","1","180,000 K"',
				'"QQ.exe","3333","Console","1","512,800 K"',
			].join("\r\n"),
		);
		expect(parsedTasklist.map((p) => p.pid)).toEqual([3333, 1111, 2222]);

		const service = new NtqqSyncService({
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: {
				...process.env,
				PUBLIC: publicDir,
				MOCK_CALLS_LOG: callsLogPath,
				MOCK_STDIN_FLAG: stdinClosedFlagPath,
			},
			listQqPids: async () => [1111, 2222, 3333, 4444],
			keyDumpCommand: { bin: process.execPath, prefixArgs: [mockDumperPath] },
			keyExtractAttemptTimeoutMs: 6_000,
			keyExtractPollIntervalMs: 30,
		});

		// 先配置账号 A 且显式绑定账号 A 目录，再对账号 B 发起 extractKey("20002")
		await service.saveConfig({ qqUin: "10001", dbDir: dbDirA });

		const t0 = Date.now();
		const result = await service.extractKey("20002");
		const elapsedMs = Date.now() - t0;

		// 1. 即使 PID 1111/2222/3333 都会永久挂起，也必须在远小于单次 6s 超时的时间内早停并完成
		expect(elapsedMs).toBeLessThan(5_000);
		// 2. 绝未触发 stdin EOF 或写入回车
		expect(existsSync(stdinClosedFlagPath)).toBe(false);
		// 3. 依次扫描了 1111 -> 2222 -> 3333，命中后立刻停止（不继续扫 4444 或 null 兜底），且传入了账号 B 的 --db-dir
		const calls = readFileSync(callsLogPath, "utf8")
			.trim()
			.split(/\r?\n/)
			.map(
				(line) =>
					JSON.parse(line) as { qq: string; pid: string | null; dbDir: string | null; outPath: string },
			);
		expect(calls.map((c) => c.pid)).toEqual(["1111", "2222", "3333"]);
		expect(calls.every((c) => c.qq === "20002" && c.dbDir === dbDirB)).toBe(true);
		// 4. 临时文件已清理，目标 key_map.json 无损合并保留账号 A 与账号 B 全部 4 组密钥
		for (const call of calls) {
			expect(existsSync(call.outPath)).toBe(false);
		}
		const mergedEntries = await loadKeyMapEntries(keyMapPath);
		expect(mergedEntries[saltMsgA.toString("hex")]).toBe(keyMsgA);
		expect(mergedEntries[saltGrpA.toString("hex")]).toBe(keyGrpA);
		expect(mergedEntries[saltMsgB.toString("hex")]).toBe(keyMsgB);
		expect(mergedEntries[saltGrpB.toString("hex")]).toBe(keyGrpB);
		expect(result.status.qqUin).toBe("20002");
		expect(result.status.resolvedDbDir).toBe(dbDirB);
		expect(result.status.keyMatchedForCurrentDb).toBe(true);
		expect(result.status.ready).toBe(true);

		// 5. 所有 PID 均未命中目标账号时抛出明确中文错误且不破坏既有 key_map.json
		const failService = new NtqqSyncService({
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: {
				...process.env,
				PUBLIC: publicDir,
				MOCK_CALLS_LOG: callsLogPath,
				MOCK_STDIN_FLAG: stdinClosedFlagPath,
			},
			listQqPids: async () => [1111, 2222],
			keyDumpCommand: { bin: process.execPath, prefixArgs: [mockDumperPath] },
			keyExtractAttemptTimeoutMs: 4_000,
			keyExtractPollIntervalMs: 30,
		});
		await expect(failService.extractKey("20002")).rejects.toThrow(/已扫描 2 个 QQ\.exe 进程.*QQ 20002/);
		expect(Object.keys(await loadKeyMapEntries(keyMapPath))).toHaveLength(4);
	});

	it("saveConfig 切换 qqUin 时自动解绑旧账号专属 dbDir，但保留非旧账号专属自定义路径", async () => {
		const work = makeTempDir("wenyou-ntqq-switch-uin-");
		const fakeHome = join(work, "home");
		const dataDir = join(work, "ntqq-data");
		const publicDir = join(work, "Public");
		const dbDirA = join(fakeHome, "Documents", "Tencent Files", "10001", "nt_qq", "nt_db");
		const dbDirB = join(fakeHome, "Documents", "Tencent Files", "20002", "nt_qq", "nt_db");
		const customNeutralDir = join(work, "custom-shared-nt-db");
		mkdirSync(dbDirA, { recursive: true });
		mkdirSync(dbDirB, { recursive: true });
		mkdirSync(customNeutralDir, { recursive: true });
		writeFileSync(join(dbDirA, "nt_msg.db"), "stub-a");
		writeFileSync(join(dbDirB, "nt_msg.db"), "stub-b");
		writeFileSync(join(customNeutralDir, "nt_msg.db"), "stub-custom");

		const service = new NtqqSyncService({
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: { ...process.env, PUBLIC: publicDir },
		});

		// 手动选过账号 A 的目录后，仅传入新 qqUin=20002（未传 dbDir）-> 自动解绑并定位到账号 B
		await service.saveConfig({ qqUin: "10001", dbDir: dbDirA });
		const switched = await service.saveConfig({ qqUin: "20002" });
		expect(switched.config.qqUin).toBe("20002");
		expect(switched.config.dbDir).toBeNull();
		expect(switched.status.resolvedDbDir).toBe(dbDirB);
		expect(switched.status.dbDirAutoDetected).toBe(true);

		// 若旧 dbDir 不包含旧 qqUin 目录段（如自定义中立目录），切换 qqUin 时保留原 dbDir
		await service.saveConfig({ qqUin: "20002", dbDir: customNeutralDir });
		const keepCustom = await service.saveConfig({ qqUin: "10001" });
		expect(keepCustom.config.dbDir).toBe(customNeutralDir);
		expect(keepCustom.status.resolvedDbDir).toBe(customNeutralDir);

		// 先手选账号 A 的目录（此时尚未填 qqUin），再填账号 B 的 qqUin -> 复用 dbDirBelongsToDifferentQq 自动解绑
		await service.saveConfig({ qqUin: null, dbDir: dbDirA });
		const fromUnsetUin = await service.saveConfig({ qqUin: "20002" });
		expect(fromUnsetUin.config.dbDir).toBeNull();
		expect(fromUnsetUin.status.resolvedDbDir).toBe(dbDirB);

		// 清空 qqUin 时同样解绑旧账号专属目录
		await service.saveConfig({ qqUin: "10001", dbDir: dbDirA });
		const cleared = await service.saveConfig({ qqUin: null });
		expect(cleared.config.qqUin).toBeNull();
		expect(cleared.config.dbDir).toBeNull();
	});

	it("无本地库文件但存在有效 key_map.json 时 keyMatchedForCurrentDb 为 undefined，且不误报缺密钥", async () => {
		const work = makeTempDir("wenyou-ntqq-nodb-keymap-");
		const fakeHome = join(work, "home");
		const dataDir = join(work, "ntqq-data");
		const publicDir = join(work, "Public");
		mkdirSync(fakeHome, { recursive: true });
		mkdirSync(dataDir, { recursive: true });

		const keyMapPath = join(dataDir, "key_map.json");
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[randomBytes(16).toString("hex")]: randomBytes(32).toString("hex"),
				},
			}),
		);

		const service = new NtqqSyncService({
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: { ...process.env, PUBLIC: publicDir },
		});

		const snap = await service.saveConfig({ qqUin: "30003", keyMapPath });
		expect(snap.status.msgDbExists).toBe(false);
		expect(snap.status.groupDbExists).toBe(false);
		expect(snap.status.keyMapExists).toBe(true);
		expect(snap.status.keyMatchedForCurrentDb).toBeUndefined();
		expect(snap.status.ready).toBe(false);
		expect(snap.status.missingReasons.some((r) => r.includes("未找到本机 nt_msg.db"))).toBe(true);
		expect(snap.status.missingReasons.some((r) => r.includes("未包含此 QQ 账号消息库的解密密钥"))).toBe(
			false,
		);
	});

	it("分批落盘不提前早杀子进程、WENYOU_KEY_MAP 读写路径对齐且 saveConfig 与 extractKey 串行无丢写", async () => {
		const work = makeTempDir("wenyou-ntqq-partial-envkm-");
		const fakeHome = join(work, "home");
		const dataDir = join(work, "ntqq-data");
		const publicDir = join(work, "Public");
		const dbDirB = join(fakeHome, "Documents", "Tencent Files", "20002", "nt_qq", "nt_db");
		mkdirSync(dbDirB, { recursive: true });
		mkdirSync(dataDir, { recursive: true });

		const keyMsgA = randomBytes(32).toString("hex");
		const saltMsgA = randomBytes(16).toString("hex");
		const keyMsgB = randomBytes(32).toString("hex");
		const saltMsgB = randomBytes(16);
		const keyGrpB = randomBytes(32).toString("hex");
		const saltGrpB = randomBytes(16);

		const { plainMsg, plainGroup } = createPlainSqliteFixtures(work, [
			{ rowid: 1, ts: 1764025000, gid: 900001, uid: "u_gm", text: "分批落盘验证消息" },
		]);
		writeFileSync(
			join(dbDirB, "nt_msg.db"),
			encryptSqliteToNtqq(readFileSync(plainMsg), Buffer.from(keyMsgB, "hex"), saltMsgB),
		);
		writeFileSync(
			join(dbDirB, "group_info.db"),
			encryptSqliteToNtqq(readFileSync(plainGroup), Buffer.from(keyGrpB, "hex"), saltGrpB),
		);

		// 通过 WENYOU_KEY_MAP 指定外部密钥文件（内含账号 A 密钥），config.keyMapPath 留空
		const envKeyMapPath = join(work, "external-env-key-map.json");
		writeFileSync(envKeyMapPath, JSON.stringify({ key_map: { [saltMsgA]: keyMsgA } }));

		// 模拟先落盘 1 个盐值、150ms 后再落盘全部 2 个盐值并挂起等待退出的 dumper
		const stagedDumperPath = join(work, "staged-dumper.mjs");
		writeFileSync(
			stagedDumperPath,
			`
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outPath = args[args.indexOf("--output") + 1];
process.stdin.resume();
// 第 1 阶段仅写出 nt_msg.db 的盐值且尚未打印 Key map saved to，验证不会被 30ms 轮询提前早杀
writeFileSync(outPath, JSON.stringify({
	key_map: {
		${JSON.stringify(saltMsgB.toString("hex"))}: ${JSON.stringify(keyMsgB)},
	},
}));
setTimeout(() => {
	writeFileSync(outPath, JSON.stringify({
		key_map: {
			${JSON.stringify(saltMsgB.toString("hex"))}: ${JSON.stringify(keyMsgB)},
			${JSON.stringify(saltGrpB.toString("hex"))}: ${JSON.stringify(keyGrpB)},
		},
	}));
	process.stdout.write("Key map saved to " + outPath + "\\nWaiting for QQ to exit ...\\n");
}, 150);
setInterval(() => {}, 60_000);
`,
			"utf8",
		);

		const service = new NtqqSyncService({
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: { ...process.env, PUBLIC: publicDir, WENYOU_KEY_MAP: envKeyMapPath },
			listQqPids: async () => [5555],
			keyDumpCommand: { bin: process.execPath, prefixArgs: [stagedDumperPath] },
			keyExtractAttemptTimeoutMs: 5_000,
			keyExtractPollIntervalMs: 30,
		});

		// 并发触发 extractKey("20002") 与 saveConfig({ pythonPath })，验证串行队列不会互相覆盖 config.json
		const [extractRes, saveRes] = await Promise.all([
			service.extractKey("20002"),
			service.saveConfig({ pythonPath: PYTHON_BIN }),
		]);

		expect(extractRes.status.resolvedKeyMapPath).toBe(envKeyMapPath);
		expect(extractRes.status.keyMatchedForCurrentDb).toBe(true);
		expect(extractRes.status.ready).toBe(true);
		expect(existsSync(join(dataDir, "key_map.json"))).toBe(false);

		const mergedEnvEntries = await loadKeyMapEntries(envKeyMapPath);
		expect(mergedEnvEntries[saltMsgA]).toBe(keyMsgA);
		expect(mergedEnvEntries[saltMsgB.toString("hex")]).toBe(keyMsgB);
		expect(mergedEnvEntries[saltGrpB.toString("hex")]).toBe(keyGrpB);

		expect(saveRes.config.qqUin).toBe("20002");
		expect(saveRes.config.pythonPath).toBe(PYTHON_BIN);
	});

	it("UTF-8 BOM config.json 与扁平/嵌套 key_map.json 在 TS 与 Python VFS 侧均可正常解析", async () => {
		const work = makeTempDir("wenyou-ntqq-bom-");
		const dataDir = join(work, "ntqq-data");
		const dbDir = join(work, "fake-nt-db");
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(dbDir, { recursive: true });

		const keyMsg = randomBytes(32);
		const saltMsg = randomBytes(16);
		const keyGrp = randomBytes(32);
		const saltGrp = randomBytes(16);

		const { plainMsg, plainGroup } = createPlainSqliteFixtures(work, [
			{ rowid: 1, ts: 1764030000, gid: 900001, uid: "u_gm", text: "BOM 兼容测试消息" },
		]);
		writeFileSync(join(dbDir, "nt_msg.db"), encryptSqliteToNtqq(readFileSync(plainMsg), keyMsg, saltMsg));
		writeFileSync(
			join(dbDir, "group_info.db"),
			encryptSqliteToNtqq(readFileSync(plainGroup), keyGrp, saltGrp),
		);

		// 写入带 UTF-8 BOM 的 config.json 和带 UTF-8 BOM 的扁平格式（含大写 hex）key_map.json
		const keyMapPath = join(dataDir, "key_map.json");
		writeFileSync(
			join(dataDir, "config.json"),
			`\uFEFF${JSON.stringify({ qqUin: "10001", dbDir, keyMapPath, pythonPath: null })}`,
			"utf8",
		);
		writeFileSync(
			keyMapPath,
			`\uFEFF${JSON.stringify({
				[saltMsg.toString("hex").toUpperCase()]: keyMsg.toString("hex").toUpperCase(),
				[saltGrp.toString("hex").toUpperCase()]: keyGrp.toString("hex").toUpperCase(),
				ignored_meta: "not-hex",
			})}`,
			"utf8",
		);

		const entries = await loadKeyMapEntries(keyMapPath);
		expect(entries).toEqual({
			[saltMsg.toString("hex")]: keyMsg.toString("hex"),
			[saltGrp.toString("hex")]: keyGrp.toString("hex"),
		});

		const service = new NtqqSyncService({ dataDir, assetsDir: ASSETS_DIR });
		const snap = await service.getStatus();
		expect(snap.config.qqUin).toBe("10001");
		expect(snap.status.keyMatchedForCurrentDb).toBe(true);
		expect(snap.status.ready).toBe(true);

		// 验证 Python ntqq_vfs.load_key_map 端到端读取 BOM + 扁平 key_map.json 成功列出群
		const groups = await service.listGroups();
		expect(groups.groups).toEqual([
			{ groupId: "900001", groupName: "河朔测试主群" },
			{ groupId: "900002", groupName: "河朔内阁密群" },
		]);
	});

	it("双账号不同盐值按 salt 前 12 位隔离明文缓存库，来回切号同步互不覆盖且命中各自缓存", async () => {
		const work = makeTempDir("wenyou-ntqq-salt-cache-");
		const fakeHome = join(work, "home");
		const dataDir = join(work, "ntqq-data");
		const publicDir = join(work, "Public");
		const campaignA = join(work, "campaign-a");
		const campaignB = join(work, "campaign-b");
		const dbDirA = join(fakeHome, "Documents", "Tencent Files", "10001", "nt_qq", "nt_db");
		const dbDirB = join(fakeHome, "Documents", "Tencent Files", "20002", "nt_qq", "nt_db");
		mkdirSync(dbDirA, { recursive: true });
		mkdirSync(dbDirB, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
		mkdirSync(campaignA, { recursive: true });
		mkdirSync(campaignB, { recursive: true });

		const keyMsgA = randomBytes(32);
		const saltMsgA = randomBytes(16);
		const keyGrpA = randomBytes(32);
		const saltGrpA = randomBytes(16);
		const keyMsgB = randomBytes(32);
		const saltMsgB = randomBytes(16);
		const keyGrpB = randomBytes(32);
		const saltGrpB = randomBytes(16);

		const fixADir = join(work, "fix-a");
		const fixBDir = join(work, "fix-b");
		mkdirSync(fixADir, { recursive: true });
		mkdirSync(fixBDir, { recursive: true });
		const fixA = createPlainSqliteFixtures(fixADir, [
			{ rowid: 101, ts: 1764040100, gid: 900001, uid: "u_gm", text: "账号A专属情报：幽州粮道畅通" },
		]);
		const fixB = createPlainSqliteFixtures(fixBDir, [
			{ rowid: 201, ts: 1764040200, gid: 900002, uid: "u_player", text: "账号B专属密电：河西兵马已集结" },
		]);
		writeFileSync(
			join(dbDirA, "nt_msg.db"),
			encryptSqliteToNtqq(readFileSync(fixA.plainMsg), keyMsgA, saltMsgA),
		);
		writeFileSync(
			join(dbDirA, "group_info.db"),
			encryptSqliteToNtqq(readFileSync(fixA.plainGroup), keyGrpA, saltGrpA),
		);
		writeFileSync(
			join(dbDirB, "nt_msg.db"),
			encryptSqliteToNtqq(readFileSync(fixB.plainMsg), keyMsgB, saltMsgB),
		);
		writeFileSync(
			join(dbDirB, "group_info.db"),
			encryptSqliteToNtqq(readFileSync(fixB.plainGroup), keyGrpB, saltGrpB),
		);

		const keyMapPath = join(dataDir, "key_map.json");
		writeFileSync(
			keyMapPath,
			JSON.stringify({
				key_map: {
					[saltMsgA.toString("hex")]: keyMsgA.toString("hex"),
					[saltGrpA.toString("hex")]: keyGrpA.toString("hex"),
					[saltMsgB.toString("hex")]: keyMsgB.toString("hex"),
					[saltGrpB.toString("hex")]: keyGrpB.toString("hex"),
				},
			}),
		);

		const service = new WenyouService(undefined, {
			dataDir,
			assetsDir: ASSETS_DIR,
			platform: "win32",
			homeDir: fakeHome,
			env: { ...process.env, PUBLIC: publicDir },
		});
		await service.initCampaign(campaignA, { worldTitle: "战役A", currentEra: "T1" });
		await service.initCampaign(campaignB, { worldTitle: "战役B", currentEra: "T1" });

		// 1. 同步账号 A
		await service.ntqq.saveConfig({ qqUin: "10001", keyMapPath });
		await service.ntqq.saveCampaignBindings(campaignA, [{ groupId: "900001", role: "main" }]);
		const syncA1 = await service.syncNtqqCampaign(campaignA);
		expect(syncA1.newlyIngested).toBe(1);

		const plainMsgA = join(dataDir, "plain", `wenyou_msg_${saltMsgA.toString("hex").slice(0, 12)}.db`);
		const plainGrpA = join(dataDir, "plain", `wenyou_group_${saltGrpA.toString("hex").slice(0, 12)}.db`);
		expect(existsSync(plainMsgA)).toBe(true);
		expect(existsSync(plainGrpA)).toBe(true);
		const hashMsgABefore = sha256(plainMsgA);
		const hashGrpABefore = sha256(plainGrpA);

		// 2. 切到账号 B 同步
		await service.ntqq.saveConfig({ qqUin: "20002" });
		await service.ntqq.saveCampaignBindings(campaignB, [{ groupId: "900002", role: "cabinet" }]);
		const syncB1 = await service.syncNtqqCampaign(campaignB);
		expect(syncB1.newlyIngested).toBe(1);

		const plainMsgB = join(dataDir, "plain", `wenyou_msg_${saltMsgB.toString("hex").slice(0, 12)}.db`);
		const plainGrpB = join(dataDir, "plain", `wenyou_group_${saltGrpB.toString("hex").slice(0, 12)}.db`);
		expect(existsSync(plainMsgB)).toBe(true);
		expect(existsSync(plainGrpB)).toBe(true);
		expect(plainMsgB).not.toBe(plainMsgA);
		expect(plainGrpB).not.toBe(plainGrpA);
		// 账号 A 的明文缓存完好无损，未被清空或踩踏
		expect(sha256(plainMsgA)).toBe(hashMsgABefore);
		expect(sha256(plainGrpA)).toBe(hashGrpABefore);

		// 3. 切回账号 A 再次同步：直接命中各自独立明文缓存，0 页重新解密
		await service.ntqq.saveConfig({ qqUin: "10001" });
		const syncA2 = await service.syncNtqqCampaign(campaignA);
		expect(syncA2.newlyIngested).toBe(0);
		expect(syncA2.pagesDecrypted).toBe(0);
	});
});
