import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	NtqqSyncService,
	normalizeQqUin,
	resolveCustomDbDirCandidate,
	WenyouService,
} from "../src/wenyou";

const ASSETS_DIR = resolve(import.meta.dirname, "../../desktop/resources/ntqq-vfs");
const EXT_HEADER = 1024;
const PAGE_SIZE = 4096;
const SALT_SIZE = 16;
const RESERVE = 48;

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
	messages: Array<{ rowid: number; ts: number; gid: number; uid: string; text: string }>,
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
for r in rows:
    c.execute(
      'INSERT INTO group_msg_table ("40001","40002","40003","40027","40030","40033","40050","40058","40800") VALUES (?,?,?,?,?,?,?,?,?)',
      (r["rowid"], 1, r["rowid"], r["gid"], r["gid"], r["uid"], r["ts"], 0, bytes.fromhex(r["blobHex"]))
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
	const res = spawnSync("python", ["-c", pyScript, plainMsg, plainGroup, JSON.stringify(encoded)], {
		encoding: "utf8",
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

		// 1. 保存本机 QQ 配置并验证完全与战役目录隔离
		const snap = await service.ntqq.saveConfig({ qqUin: "10001", dbDir, keyMapPath });
		expect(snap.status.ready).toBe(true);
		expect(snap.status.msgDbExists).toBe(true);
		expect(snap.status.groupDbExists).toBe(true);
		expect(existsSync(join(campaignDir, "config.json"))).toBe(false);

		// 2. 读取本机加密群列表
		const groupList = await service.ntqq.listGroups();
		expect(groupList.groups).toEqual([
			{ groupId: "900001", groupName: "河朔测试主群" },
			{ groupId: "900002", groupName: "河朔内阁密群" },
		]);

		// 3. 绑定两个群（主群 public + 内阁密群 gm）并首次全量增量同步
		const savedBindings = await service.ntqq.saveCampaignBindings(campaignDir, [
			{ groupId: "900001", groupName: "河朔测试主群", role: "main" },
			{ groupId: "900002", groupName: "河朔内阁密群", role: "cabinet" },
		]);
		expect(savedBindings[1]?.visibility).toBe("gm");

		const firstSync = await service.syncNtqqCampaign(campaignDir);
		expect(firstSync.newlyIngested).toBe(3);
		expect(firstSync.skippedDuplicates).toBe(0);
		expect(firstSync.totalEvidenceCount).toBe(3);

		// 验证 GM 与 public 视角隔离：public 看不到内阁密群消息
		const gmHits = await service.searchSources(campaignDir, { keyword: "精铁", viewer: "gm" });
		const pubHits = await service.searchSources(campaignDir, { keyword: "精铁", viewer: "public" });
		expect(gmHits.length).toBe(1);
		expect(pubHits.length).toBe(0);

		const mainHits = await service.searchSources(campaignDir, { keyword: "秋粮", viewer: "public" });
		expect(mainHits.length).toBe(1);
		expect(mainHits[0]?.sender).toBe("司历GM");
		expect(mainHits[0]?.kind).toBe("gm_ruling");

		// 4. 二次触发 pullQq（联动 NTQQ + 00-群聊收集/）：严格幂等 0 新增
		const secondPull = await service.pullQq(campaignDir);
		expect(secondPull.newlyIngested).toBe(0);
		expect(secondPull.ntqqWarning).toBeUndefined();
		expect(secondPull.totalEvidenceCount).toBe(3);

		// 5. 源加密库逐字节未改动（只读铁律）
		expect(sha256(encMsgPath)).toBe(origMsgHash);
		expect(sha256(encGrpPath)).toBe(origGrpHash);
	});

	it("非法群号绑定被严格拒绝", async () => {
		const work = makeTempDir("wenyou-ntqq-invalid-");
		const ntqq = new NtqqSyncService({ dataDir: join(work, "data"), assetsDir: ASSETS_DIR });
		await expect(
			ntqq.saveCampaignBindings(work, [{ groupId: "not-a-number", role: "main" }]),
		).rejects.toThrow(/非法 QQ 群号/);
	});
});
