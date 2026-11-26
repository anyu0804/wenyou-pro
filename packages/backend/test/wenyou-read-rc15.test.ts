import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ASSETS_DIR = resolve(import.meta.dirname, "../../desktop/resources/ntqq-vfs");
const READER_SCRIPT = join(ASSETS_DIR, "wenyou_read.py");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

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
	throw new Error("No working Python 3 runtime with sqlite3 found for wenyou_read.py regression tests");
}

const PYTHON_BIN = resolvePythonBin();

function runPythonJson<T>(script: string, args: string[] = []): T {
	const res = spawnSync(PYTHON_BIN, ["-B", "-c", script, ASSETS_DIR, ...args], {
		encoding: "utf8",
		env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
	});
	if (res.status !== 0) {
		throw new Error(`Python failed (status=${res.status}): ${res.stderr || res.stdout}`);
	}
	const out = res.stdout.trim();
	return JSON.parse(out) as T;
}

function runReaderCli<T>(args: string[]): T {
	const res = spawnSync(PYTHON_BIN, ["-B", READER_SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
	});
	if (res.status !== 0) {
		throw new Error(`wenyou_read.py failed (status=${res.status}): ${res.stderr || res.stdout}`);
	}
	const resultLine = res.stdout
		.split(/\r?\n/)
		.find((line) => line.startsWith("__RESULT__"));
	if (!resultLine) {
		throw new Error(`Missing __RESULT__ line in stdout: ${res.stdout}`);
	}
	return JSON.parse(resultLine.slice("__RESULT__".length)) as T;
}

const SEED_MODERN_DB_PY = `
import contextlib, sqlite3, sys

def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    return bytes(result) + bytes([value])

def text_blob(text):
    data = text.encode("utf-8")
    inner = varint(45002 << 3) + b"\\x01" + varint((45101 << 3) | 2) + varint(len(data)) + data
    return varint((40800 << 3) | 2) + varint(len(inner)) + inner

def graytip_blob():
    inner = varint(45002 << 3) + b"\\x08"
    return varint((40800 << 3) | 2) + varint(len(inner)) + inner

def seed_modern_db(db_path):
    with contextlib.closing(sqlite3.connect(db_path)) as conn:
        conn.executescript('''
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
            CREATE INDEX group_msg_table_idx40027_40050
                ON group_msg_table("40027", "40050", "40001");
            CREATE TABLE nt_uid_mapping_table (
                "48902" TEXT PRIMARY KEY,
                "1002" TEXT
            );
        ''')
        rows = [
            # Received message in low-prefix rowid range (7712...)
            (7712000000000000001, 1, 1, 10001, 10001, 20001, 1795670010, 1795651200, text_blob("他人消息1")),
            # PC self-sent message in high-prefix rowid range (7786...): 40027=10001, 40030=0, 40033=sender
            (7786000000000000002, 2, 2, 10001, 0, 100000001, 1795670020, 1795651200, text_blob("本机发出消息2")),
            # System graytips (40030=0 & 40033 in {0, '0', '', '   ', None}) -> must be filtered
            (7786000000000000003, 0, 3, 10001, 0, 0, 1795670025, 1795651200, graytip_blob()),
            (7786000000000000004, 0, 4, 10001, 0, "0", 1795670026, 1795651200, graytip_blob()),
            (7786000000000000005, 0, 5, 10001, 0, "", 1795670027, 1795651200, graytip_blob()),
            (7786000000000000006, 0, 6, 10001, 0, "   ", 1795670028, 1795651200, graytip_blob()),
            (7786000000000000007, 0, 7, 10001, 0, None, 1795670029, 1795651200, graytip_blob()),
            # PC self-sent message with NULL 40030 & string UID -> must be kept
            (7786000000000000008, 3, 8, 10001, None, "u_self_str", 1795670030, 1795651200, text_blob("本机NULL群列消息3")),
            # Cross-group dirty row (40027=10001, 40030=999999) -> must be rejected
            (7786000000000000009, 4, 9, 10001, 999999, 20001, 1795670035, 1795651200, text_blob("跨群错配脏行")),
            # Later received message back in low-prefix rowid range (7712...)
            (7712000000000000010, 5, 10, 10001, 10001, 20002, 1795670040, 1795651200, text_blob("他人后续消息4")),
            # Unrelated group self-sent message
            (7786000000000000011, 6, 1, 888888, 0, 100000001, 1795670050, 1795651200, text_blob("其他群本机消息")),
        ]
        conn.executemany(
            'INSERT INTO group_msg_table ("40001","40002","40003","40027","40030","40033","40050","40058","40800") '
            'VALUES (?,?,?,?,?,?,?,?,?)',
            rows,
        )
        conn.execute('INSERT INTO nt_uid_mapping_table ("48902", "1002") VALUES ("u_self_str", "100000001")')
        conn.commit()
`;

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("wenyou_read.py rc.15 NTQQ 读取层与降级扫描回归", () => {
	it("全 6 条查询与降级路径保留本机发出消息（群号归正）、过滤灰条与跨群脏行，并命中 40027 索引", () => {
		const dir = makeTempDir("wenyou-rc15-paths-");
		const dbPath = join(dir, "msg.db");

		const summary = runPythonJson<{
			fastAscIds: string[];
			fastAscGids: number[];
			fastDescIds: string[];
			fastDescGids: number[];
			tailIds: string[];
			tailGids: number[];
			pagedAscIds: string[];
			pagedAscGids: number[];
			pagedDescIds: string[];
			pagedDescGids: number[];
			peekFbIds: string[];
			peekFbGids: number[];
			peekSkipped: number;
			planText: string;
		}>(
			`
import contextlib, json, sqlite3, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import wenyou_read as reader
${SEED_MODERN_DB_PY}

db = sys.argv[2]
seed_modern_db(db)
with contextlib.closing(reader.open_readonly(db)) as conn:
    fast_asc = reader.fast_query(conn, "group_msg_table", 10001, 0, 0, 50)
    fast_desc = reader.fast_query_desc(conn, "group_msg_table", 10001, limit=50)
    tail_rows = reader.tail_query(conn, 10001, 50)
    paged_asc = reader.paged_query(conn, "group_msg_table", 10001, 0, 0, 50)
    paged_desc = reader.paged_query_desc(conn, "group_msg_table", 10001, limit=50)
    with patch.object(reader, "tail_query", side_effect=sqlite3.DatabaseError("simulated corrupt index")):
        peek_fb, peek_skipped = reader.peek_query(conn, 10001, 50)
    group_sql, group_params = reader.group_predicate(conn, "group_msg_table", 10001)
    plan = conn.execute(
        f'EXPLAIN QUERY PLAN SELECT rowid FROM group_msg_table '
        f'WHERE {group_sql} AND "40050">? ORDER BY "40050", rowid LIMIT 10',
        (*group_params, 1795670000),
    ).fetchall()

print(json.dumps({
    "fastAscIds": [str(r[0]) for r in fast_asc],
    "fastAscGids": [int(r[2]) for r in fast_asc],
    "fastDescIds": [str(r[0]) for r in fast_desc],
    "fastDescGids": [int(r[2]) for r in fast_desc],
    "tailIds": [str(r[0]) for r in tail_rows],
    "tailGids": [int(r[2]) for r in tail_rows],
    "pagedAscIds": [str(r[0]) for r in paged_asc],
    "pagedAscGids": [int(r[2]) for r in paged_asc],
    "pagedDescIds": [str(r[0]) for r in paged_desc],
    "pagedDescGids": [int(r[2]) for r in paged_desc],
    "peekFbIds": [str(r[0]) for r in peek_fb],
    "peekFbGids": [int(r[2]) for r in peek_fb],
    "peekSkipped": peek_skipped,
    "planText": " ".join(str(r[-1]) for r in plan),
}))
`,
			[dbPath],
		);

		const expectedAsc = [
			"7712000000000000001",
			"7786000000000000002",
			"7786000000000000008",
			"7712000000000000010",
		];
		const expectedDesc = [...expectedAsc].reverse();
		const expectedGids = [10001, 10001, 10001, 10001];

		expect(summary.fastAscIds).toEqual(expectedAsc);
		expect(summary.fastAscGids).toEqual(expectedGids);
		expect(summary.fastDescIds).toEqual(expectedDesc);
		expect(summary.fastDescGids).toEqual(expectedGids);
		expect(summary.tailIds).toEqual(expectedAsc);
		expect(summary.tailGids).toEqual(expectedGids);
		expect(summary.pagedAscIds).toEqual(expectedAsc);
		expect(summary.pagedAscGids).toEqual(expectedGids);
		expect(summary.pagedDescIds).toEqual(expectedDesc);
		expect(summary.pagedDescGids).toEqual(expectedGids);
		expect(summary.peekFbIds).toEqual(expectedAsc);
		expect(summary.peekFbGids).toEqual(expectedGids);
		expect(summary.peekSkipped).toBe(0);
		expect(summary.planText).toContain("group_msg_table_idx40027_40050");
	});

	it("双号段高位 since_rowid（7786...）在正常路径、损坏库 paged_query 降级与限流截断下均不跳漏后续低位接收消息（7712...）", () => {
		const dir = makeTempDir("wenyou-rc15-dual-cursor-");
		const dbPath = join(dir, "msg.db");

		const res = runPythonJson<{
			fastIds: string[];
			pagedIds: string[];
			pagedGids: number[];
			pagedMax1Ids: string[];
			scanFallbackIds: string[];
			scanFallbackGids: number[];
			corruptPageIds: string[];
			corruptPageGids: number[];
		}>(
			`
import contextlib, json, sqlite3, sys
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import wenyou_read as reader
${SEED_MODERN_DB_PY}

db = sys.argv[2]
seed_modern_db(db)

class CorruptPageConn:
    """Wrap a real SQLite connection and simulate a corrupt page around rowid 7786000000000000003."""
    def __init__(self, inner):
        self._inner = inner
        self._corrupt_rid = 7786000000000000003

    def execute(self, sql, params=()):
        if "WHERE rowid > ?" in sql:
            last, batch = params
            rows = self._inner.execute(sql, params).fetchall()
            if any(r[0] == self._corrupt_rid for r in rows):
                raise sqlite3.DatabaseError("database disk image is malformed")
            class _Cur:
                def fetchall(self_cur):
                    return rows
            return _Cur()
        return self._inner.execute(sql, params)

    def rollback(self):
        return self._inner.rollback()

since_ts = 1795670020
since_rowid = 7786000000000000002

with contextlib.closing(reader.open_readonly(db)) as conn:
    fast_rows = reader.fast_query(conn, "group_msg_table", 10001, since_ts, since_rowid, 50)
    paged_rows = reader.paged_query(conn, "group_msg_table", 10001, since_ts, since_rowid, 50)
    paged_max1 = reader.paged_query(conn, "group_msg_table", 10001, since_ts, since_rowid, 1)

    with patch.object(reader, "fast_query", side_effect=sqlite3.DatabaseError("database disk image is malformed")):
        scan_rows, _, _ = reader.scan(conn, SimpleNamespace(
            group="10001", since=str(since_ts), since_rowid=str(since_rowid), max="50", until=0,
        ))

    corrupt_conn = CorruptPageConn(conn)
    corrupt_rows = reader.paged_query(corrupt_conn, "group_msg_table", 10001, since_ts, since_rowid, 50)

print(json.dumps({
    "fastIds": [str(r[0]) for r in fast_rows],
    "pagedIds": [str(r[0]) for r in paged_rows],
    "pagedGids": [int(r[2]) for r in paged_rows],
    "pagedMax1Ids": [str(r[0]) for r in paged_max1],
    "scanFallbackIds": [str(r[0]) for r in scan_rows],
    "scanFallbackGids": [int(r[2]) for r in scan_rows],
    "corruptPageIds": [str(r[0]) for r in corrupt_rows],
    "corruptPageGids": [int(r[2]) for r in corrupt_rows],
}))
`,
			[dbPath],
		);

		const expected = ["7786000000000000008", "7712000000000000010"];
		expect(res.fastIds).toEqual(expected);
		expect(res.pagedIds).toEqual(expected);
		expect(res.pagedGids).toEqual([10001, 10001]);
		// Bounded max-heap preserves exact chronological earliest row even when max_rows=1 across dual rowid ranges
		expect(res.pagedMax1Ids).toEqual(["7786000000000000008"]);
		expect(res.scanFallbackIds).toEqual(expected);
		expect(res.scanFallbackGids).toEqual([10001, 10001]);
		expect(res.corruptPageIds).toEqual(expected);
		expect(res.corruptPageGids).toEqual([10001, 10001]);
	});

	it("CLI 子命令（check/pull/pullall/tail/peek/peek-timeline）完整输出本机消息并屏蔽灰条与跨群脏行", () => {
		const dir = makeTempDir("wenyou-rc15-cli-");
		const dbPath = join(dir, "msg.db");
		runPythonJson<{ ok: boolean }>(
			`
import json, sys
${SEED_MODERN_DB_PY}
seed_modern_db(sys.argv[2])
print(json.dumps({"ok": True}))
`,
			[dbPath],
		);

		const peekTxt = join(dir, "peek.txt");
		const peekRes = runReaderCli<{ ok: boolean; count: number }>([
			"peek", "--db", dbPath, "--group", "10001", "--n", "20", "--out-txt", peekTxt,
		]);
		expect(peekRes.ok).toBe(true);
		expect(peekRes.count).toBe(4);
		const peekBody = readFileSync(peekTxt, "utf8");
		expect(peekBody).toContain("本机发出消息2");
		expect(peekBody).toContain("本机NULL群列消息3");
		expect(peekBody).toContain("他人后续消息4");
		expect(peekBody).not.toContain("跨群错配脏行");
		expect(peekBody).not.toContain("其他群本机消息");
		expect(peekBody).not.toContain("0: 引用");

		const senderRes = runReaderCli<{ ok: boolean; count: number }>([
			"peek", "--db", dbPath, "--group", "10001", "--n", "20", "--sender", "100000001",
		]);
		expect(senderRes.ok).toBe(true);
		expect(senderRes.count).toBe(2);

		const checkRes = runReaderCli<{ ok: boolean; count: number; lastRowid: string }>([
			"check",
			"--db", dbPath,
			"--group", "10001",
			"--since", "1795670010",
			"--since-rowid", "7712000000000000001",
			"--max", "50",
		]);
		expect(checkRes.ok).toBe(true);
		expect(checkRes.count).toBe(3);
		expect(checkRes.lastRowid).toBe("7712000000000000010");

		const pullJsonl = join(dir, "pull.jsonl");
		const pullTxt = join(dir, "pull.txt");
		const pullRes = runReaderCli<{ ok: boolean; count: number }>([
			"pull",
			"--db", dbPath,
			"--group", "10001",
			"--since", "0",
			"--max", "50",
			"--out-jsonl", pullJsonl,
			"--out-txt", pullTxt,
		]);
		expect(pullRes.ok).toBe(true);
		expect(pullRes.count).toBe(4);
		expect(readFileSync(pullTxt, "utf8")).toContain("本机发出消息2");

		const tailRes = runReaderCli<{ ok: boolean; count: number }>([
			"tail", "--db", dbPath, "--group", "10001", "--n", "10",
		]);
		expect(tailRes.ok).toBe(true);
		expect(tailRes.count).toBe(4);

		const pullallDir = join(dir, "pullall");
		const pullallRes = runReaderCli<{ ok: boolean; totalCount: number }>([
			"pullall",
			"--db", dbPath,
			"--groups", "10001:0:0,888888:0:0",
			"--out-dir", pullallDir,
			"--max", "50",
		]);
		expect(pullallRes.ok).toBe(true);
		expect(pullallRes.totalCount).toBe(5);

		const timelineTxt = join(dir, "timeline.txt");
		const timelineRes = runReaderCli<{ ok: boolean; count: number }>([
			"peek-timeline",
			"--db", dbPath,
			"--groups", "10001,888888",
			"--n", "50",
			"--out-txt", timelineTxt,
		]);
		expect(timelineRes.ok).toBe(true);
		expect(timelineRes.count).toBe(5);
		const tlBody = readFileSync(timelineTxt, "utf8");
		expect(tlBody).toContain("本机发出消息2");
		expect(tlBody).toContain("其他群本机消息");
	});

	it("无 40027 列的旧版数据库自动回退 40030=? 查询，不破坏历史兼容性", () => {
		const dir = makeTempDir("wenyou-rc15-legacy-");
		const dbPath = join(dir, "legacy.db");

		const counts = runPythonJson<{
			predicateSql: string;
			fastAsc: number;
			fastDesc: number;
			tail: number;
			pagedAsc: number;
			pagedDesc: number;
			peekFb: number;
		}>(
			`
import contextlib, json, sqlite3, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import wenyou_read as reader
${SEED_MODERN_DB_PY}

db = sys.argv[2]
with contextlib.closing(sqlite3.connect(db)) as conn:
    conn.execute('CREATE TABLE group_msg_table ("40050" INTEGER, "40030" INTEGER, "40033" TEXT, "40800" BLOB)')
    conn.execute('INSERT INTO group_msg_table VALUES (1795670010, 555, "u1", ?)', (text_blob("旧库消息"),))
    conn.execute('INSERT INTO group_msg_table VALUES (1795670020, 0, "u1", ?)', (text_blob("旧库零群号"),))
    conn.commit()

with contextlib.closing(reader.open_readonly(db)) as conn:
    pred_sql, _ = reader.group_predicate(conn, "group_msg_table", 555)
    fast_asc = reader.fast_query(conn, "group_msg_table", 555, 0, 0, 10)
    fast_desc = reader.fast_query_desc(conn, "group_msg_table", 555, limit=10)
    tail_rows = reader.tail_query(conn, 555, 10)
    paged_asc = reader.paged_query(conn, "group_msg_table", 555, 0, 0, 10)
    paged_desc = reader.paged_query_desc(conn, "group_msg_table", 555, limit=10)
    with patch.object(reader, "tail_query", side_effect=sqlite3.DatabaseError("simulated corrupt index")):
        peek_fb, _ = reader.peek_query(conn, 555, 10)

print(json.dumps({
    "predicateSql": pred_sql,
    "fastAsc": len(fast_asc),
    "fastDesc": len(fast_desc),
    "tail": len(tail_rows),
    "pagedAsc": len(paged_asc),
    "pagedDesc": len(paged_desc),
    "peekFb": len(peek_fb),
}))
`,
			[dbPath],
		);

		expect(counts.predicateSql).toBe('"40030"=?');
		expect(counts.fastAsc).toBe(1);
		expect(counts.fastDesc).toBe(1);
		expect(counts.tail).toBe(1);
		expect(counts.pagedAsc).toBe(1);
		expect(counts.pagedDesc).toBe(1);
		expect(counts.peekFb).toBe(1);
	});
});
