# -*- coding: utf-8 -*-
"""On-demand per-group VFS incremental sync for dsh-wenyou.

Reads ONLY requested wenyou groups directly from encrypted NTQQ databases
(nt_msg.db + -wal, group_info.db + -wal) via ntqq_vfs.py and materializes them
into lightweight, clean standard SQLite databases (wenyou_msg_plain.db &
wenyou_group_plain.db) with full schema parity for downstream readers.

Design invariants:
- Never modifies or locks QQ's encrypted source databases (read-only VFS).
- Stores per-group sync progress (seeded, max_seq, last_src_sig) inside the
  target SQLite DB itself so read-only MCP bridges (WENYOU_STATE_READONLY=1)
  share exact incremental state with the main DSH host.
- Target DBs use PRAGMA journal_mode=DELETE so downstream ?immutable=1 readers
  immediately see every committed transaction with zero missing WAL frames.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
import time
from typing import Any

# Ensure sibling import works regardless of CWD
_ASSETS_DIR = os.path.dirname(os.path.abspath(__file__))
if _ASSETS_DIR not in sys.path:
    sys.path.insert(0, _ASSETS_DIR)

from ntqq_vfs import (  # noqa: E402
    load_key_map,
    read_ntqq_salt_hex,
    run_with_consistency_retry,
    stat_file_snapshot,
)

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

CST = datetime.timezone(datetime.timedelta(hours=8))


def cst_now_str() -> str:
    return datetime.datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    print(f"[wenyou-vfs-sync] {msg}", file=sys.stderr, flush=True)


def make_src_signature(src_path: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    main_st = stat_file_snapshot(src_path)
    wal_st = stat_file_snapshot(src_path + "-wal")
    sig = (
        f"{main_st['exists']}:{main_st['size']}:{main_st['mtimeNs']}|"
        f"{wal_st['exists']}:{wal_st['size']}:{wal_st['mtimeNs']}"
    )
    return sig, main_st, wal_st


def parse_groups_arg(raw: str) -> list[int]:
    if not raw:
        return []
    out: list[int] = []
    seen: set[int] = set()
    for part in str(raw).split(","):
        s = part.strip()
        if not s:
            continue
        if not s.isdigit():
            raise ValueError(f"非法群号：{s}")
        gid = int(s)
        if gid <= 0:
            raise ValueError(f"群号必须为正整数：{s}")
        if gid not in seen:
            seen.add(gid)
            out.append(gid)
    return out


def init_msg_target_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS group_msg_table (
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
        CREATE INDEX IF NOT EXISTS group_msg_table_idx40027_40050
            ON group_msg_table("40027", "40050", "40001");
        CREATE INDEX IF NOT EXISTS group_msg_table_idx40027_40003
            ON group_msg_table("40027", "40003");
        CREATE INDEX IF NOT EXISTS group_msg_table_idx40030_40050
            ON group_msg_table("40030", "40050", "40001");

        CREATE TABLE IF NOT EXISTS nt_uid_mapping_table (
            "48902" TEXT PRIMARY KEY,
            "1002" TEXT
        );

        CREATE TABLE IF NOT EXISTS wenyou_sync_meta (
            gid INTEGER PRIMARY KEY,
            max_seq INTEGER NOT NULL DEFAULT 0,
            max_rowid INTEGER NOT NULL DEFAULT 0,
            max_ts INTEGER NOT NULL DEFAULT 0,
            row_count INTEGER NOT NULL DEFAULT 0,
            seeded INTEGER NOT NULL DEFAULT 0,
            last_src_sig TEXT NOT NULL DEFAULT '',
            last_sync_at TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS wenyou_sync_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )


def init_group_target_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS group_list (
            "60001" INTEGER PRIMARY KEY,
            "60007" TEXT
        );
        CREATE TABLE IF NOT EXISTS wenyou_group_sync_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )


def get_kv(conn: sqlite3.Connection, table: str, key: str, default: str = "") -> str:
    row = conn.execute(f"SELECT value FROM {table} WHERE key=?", (key,)).fetchone()
    return str(row[0]) if row and row[0] is not None else default


def set_kv(conn: sqlite3.Connection, table: str, key: str, value: str) -> None:
    conn.execute(
        f"INSERT OR REPLACE INTO {table}(key, value) VALUES (?, ?)",
        (key, str(value)),
    )


def _select_exprs_for_source(src_cols: set[str]) -> tuple[str, bool, bool]:
    """Build column projection matching group_msg_table target schema."""
    has_40027 = "40027" in src_cols
    has_40003 = "40003" in src_cols
    col_40001 = '"40001"' if "40001" in src_cols else "rowid"
    col_40002 = '"40002"' if "40002" in src_cols else "NULL"
    col_40003 = '"40003"' if has_40003 else "NULL"
    col_40027 = '"40027"' if has_40027 else ('"40030"' if "40030" in src_cols else "NULL")
    col_40030 = '"40030"' if "40030" in src_cols else col_40027
    col_40033 = '"40033"' if "40033" in src_cols else "NULL"
    col_40050 = '"40050"' if "40050" in src_cols else "NULL"
    col_40058 = '"40058"' if "40058" in src_cols else "NULL"
    col_40800 = '"40800"' if "40800" in src_cols else "NULL"
    cols_sql = (
        f"{col_40001}, {col_40002}, {col_40003}, {col_40027}, "
        f"{col_40030}, {col_40033}, {col_40050}, {col_40058}, {col_40800}"
    )
    return cols_sql, has_40027, has_40003


def sync_msg_db(
    src_msg: str,
    out_msg: str,
    key_map: dict[str, str],
    groups: list[int],
    force: bool = False,
    max_retries: int = 5,
    preferred_backend: str = "",
) -> dict[str, Any]:
    t0 = time.perf_counter()
    if not os.path.isfile(src_msg):
        raise FileNotFoundError(f"找不到 QQ 消息库：{src_msg}")

    src_sig, main_st, wal_st = make_src_signature(src_msg)
    src_salt_hex = read_ntqq_salt_hex(src_msg)

    # Read existing sync metadata WITHOUT creating an empty shell DB beforehand.
    # If this is the first sync and VFS fetch fails, no empty DB file is left on disk.
    prev_salt = ""
    reset_reason = ""
    uid_map_src_sig = ""
    meta_by_gid: dict[int, dict[str, Any]] = {
        gid: {
            "max_seq": 0,
            "max_rowid": 0,
            "max_ts": 0,
            "row_count": 0,
            "seeded": False,
            "last_src_sig": "",
        }
        for gid in groups
    }

    if os.path.isfile(out_msg) and os.path.getsize(out_msg) > 0:
        ro_conn = sqlite3.connect(out_msg)
        try:
            tables = {
                str(r[0])
                for r in ro_conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if "wenyou_sync_kv" in tables:
                prev_salt = get_kv(ro_conn, "wenyou_sync_kv", "src_salt_hex", "")
                uid_map_src_sig = get_kv(ro_conn, "wenyou_sync_kv", "uid_map_src_sig", "")
            if prev_salt and prev_salt != src_salt_hex:
                reset_reason = "salt_changed"
                uid_map_src_sig = ""
            elif "wenyou_sync_meta" in tables:
                for gid in groups:
                    row = ro_conn.execute(
                        "SELECT max_seq, max_rowid, max_ts, row_count, seeded, last_src_sig "
                        "FROM wenyou_sync_meta WHERE gid=?",
                        (gid,),
                    ).fetchone()
                    if row:
                        meta_by_gid[gid] = {
                            "max_seq": int(row[0] or 0),
                            "max_rowid": int(row[1] or 0),
                            "max_ts": int(row[2] or 0),
                            "row_count": int(row[3] or 0),
                            "seeded": bool(row[4]),
                            "last_src_sig": str(row[5] or ""),
                        }
        finally:
            ro_conn.close()

    # Fast-path skip: if NOT force and every requested group is already seeded
    # at this exact source DB + WAL signature (and UID map already initialized)
    if (
        not force
        and not reset_reason
        and prev_salt == src_salt_hex
        and uid_map_src_sig != ""
        and (
            (len(groups) > 0 and all(meta_by_gid[g]["seeded"] and meta_by_gid[g]["last_src_sig"] == src_sig for g in groups))
            or (len(groups) == 0 and uid_map_src_sig == src_sig)
        )
    ):
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        return {
            "skipped": True,
            "mode": "vfs",
            "resetReason": "",
            "groups": groups,
            "fetchedRows": 0,
            "newRows": 0,
            "uidMapSynced": False,
            "uidMapRows": 0,
            "pagesDecrypted": 0,
            "pagesFromWal": 0,
            "totalPages": 0,
            "retries": 0,
            "elapsedMs": elapsed_ms,
            "backend": "",
            "main": main_st,
            "wal": wal_st,
            "perGroup": {},
        }

    # Determine which groups actually need syncing right now
    groups_to_sync = [
        g for g in groups
        if force or not meta_by_gid[g]["seeded"] or meta_by_gid[g]["last_src_sig"] != src_sig
    ]

    # Execute read-only VFS fetch with anti-torn-read retries BEFORE touching target DB
    def _vfs_fetch(src_conn: sqlite3.Connection, _enc_file) -> dict[str, Any]:
        src_cols = {
            str(r[1]) for r in src_conn.execute('PRAGMA table_info("group_msg_table")')
        }
        if not src_cols:
            raise RuntimeError("加密消息库缺少 group_msg_table 表")
        cols_sql, has_40027, has_40003 = _select_exprs_for_source(src_cols)
        has_40050 = "40050" in src_cols
        group_col = '"40027"' if has_40027 else '"40030"'
        pk_col = '"40001"' if "40001" in src_cols else "rowid"

        fetched_by_gid: dict[int, list[tuple[Any, ...]]] = {}
        sync_kind_by_gid: dict[int, str] = {}
        total_fetched = 0

        for gid in groups_to_sync:
            gm = meta_by_gid[gid]
            if not force and gm["seeded"] and has_40027 and has_40003 and gm["max_seq"] > 0:
                rows = src_conn.execute(
                    f'SELECT {cols_sql} FROM group_msg_table '
                    f'WHERE "40027"=? AND "40003">=? '
                    f'ORDER BY "40003" ASC, {pk_col} ASC',
                    (gid, gm["max_seq"]),
                ).fetchall()
                # 覆盖 "40003" IS NULL 与 "40003"=0 的本机发出消息，并用时间水位替代单调 max_rowid 避免双号段漏读
                if has_40050 and gm["max_ts"] > 0:
                    ts_floor = max(0, gm["max_ts"] - 60)
                    local_rows = src_conn.execute(
                        f'SELECT {cols_sql} FROM group_msg_table '
                        f'WHERE "40027"=? AND ("40003" IS NULL OR "40003"=0) '
                        f'AND ("40050" IS NULL OR "40050">=?) '
                        f'ORDER BY "40050" ASC, {pk_col} ASC',
                        (gid, ts_floor),
                    ).fetchall()
                else:
                    local_rows = src_conn.execute(
                        f'SELECT {cols_sql} FROM group_msg_table '
                        f'WHERE "40027"=? AND ("40003" IS NULL OR "40003"=0) '
                        f'ORDER BY {pk_col} ASC',
                        (gid,),
                    ).fetchall()
                if local_rows:
                    seen_pks = {r[0] for r in rows}
                    rows = list(rows) + [r for r in local_rows if r[0] not in seen_pks]
                sync_kind_by_gid[gid] = "incremental"
            elif not force and gm["seeded"] and not has_40003 and has_40050 and gm["max_ts"] > 0:
                ts_floor = max(0, gm["max_ts"] - 60)
                rows = src_conn.execute(
                    f'SELECT {cols_sql} FROM group_msg_table '
                    f'WHERE {group_col}=? AND ("40050" IS NULL OR "40050">=?) '
                    f'ORDER BY "40050" ASC, {pk_col} ASC',
                    (gid, ts_floor),
                ).fetchall()
                sync_kind_by_gid[gid] = "incremental_ts"
            elif not force and gm["seeded"] and not has_40003 and gm["max_rowid"] > 0:
                rows = src_conn.execute(
                    f"SELECT {cols_sql} FROM group_msg_table "
                    f"WHERE {group_col}=? AND {pk_col}>? ORDER BY {pk_col} ASC",
                    (gid, gm["max_rowid"]),
                ).fetchall()
                sync_kind_by_gid[gid] = "incremental_rowid"
            else:
                rows = src_conn.execute(
                    f"SELECT {cols_sql} FROM group_msg_table WHERE {group_col}=?",
                    (gid,),
                ).fetchall()
                sync_kind_by_gid[gid] = "force_full" if force else "seed"
            fetched_by_gid[gid] = rows
            total_fetched += len(rows)

        uid_rows: list[tuple[str, str]] | None = None
        need_uid_sync = (
            force
            or uid_map_src_sig == ""
            or (total_fetched > 0 and uid_map_src_sig != src_sig)
            or (len(groups_to_sync) == 0 and uid_map_src_sig != src_sig)
        )
        if need_uid_sync:
            has_uid_tbl = src_conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nt_uid_mapping_table'"
            ).fetchone()
            if has_uid_tbl:
                ucols = {
                    str(r[1])
                    for r in src_conn.execute('PRAGMA table_info("nt_uid_mapping_table")')
                }
                if "48902" in ucols and "1002" in ucols:
                    uid_rows = [
                        (str(r[0]), str(r[1]))
                        for r in src_conn.execute(
                            'SELECT "48902", "1002" FROM nt_uid_mapping_table '
                            'WHERE "48902" IS NOT NULL AND "1002" IS NOT NULL'
                        ).fetchall()
                    ]

        return {
            "fetched_by_gid": fetched_by_gid,
            "sync_kind_by_gid": sync_kind_by_gid,
            "uid_rows": uid_rows,
        }

    payload, vfs_meta = run_with_consistency_retry(
        src_msg,
        key_map,
        _vfs_fetch,
        max_attempts=max_retries,
        preferred_backend=preferred_backend,
    )

    # Build actual snapshot signature from the consistent VFS read
    snap_main = vfs_meta["main"]
    snap_wal = vfs_meta["wal"]
    actual_src_sig = (
        f"True:{snap_main['size']}:{snap_main['mtimeNs']}|"
        f"{snap_wal['exists']}:{snap_wal['size']}:{snap_wal['mtimeNs']}"
    )

    now_str = cst_now_str()
    per_group_report: dict[str, Any] = {}
    total_fetched_rows = 0
    total_new_rows = 0

    os.makedirs(os.path.dirname(os.path.abspath(out_msg)), exist_ok=True)
    out_conn = sqlite3.connect(out_msg)
    try:
        init_msg_target_db(out_conn)
        with out_conn:
            if reset_reason:
                out_conn.execute("DELETE FROM group_msg_table")
                out_conn.execute("DELETE FROM nt_uid_mapping_table")
                out_conn.execute("DELETE FROM wenyou_sync_meta")
                out_conn.execute("DELETE FROM wenyou_sync_kv")
            for gid in groups_to_sync:
                rows = payload["fetched_by_gid"][gid]
                kind = payload["sync_kind_by_gid"][gid]
                total_fetched_rows += len(rows)

                prev_count = 0 if reset_reason else meta_by_gid[gid]["row_count"]
                if kind == "force_full":
                    out_conn.execute(
                        'DELETE FROM group_msg_table WHERE "40027"=? OR "40030"=?',
                        (gid, gid),
                    )
                    prev_count = 0

                if rows:
                    out_conn.executemany(
                        'INSERT OR REPLACE INTO group_msg_table '
                        '("40001","40002","40003","40027","40030","40033","40050","40058","40800") '
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        rows,
                    )

                agg = out_conn.execute(
                    'SELECT COALESCE(MAX("40003"), 0), COALESCE(MAX("40001"), 0), '
                    'COALESCE(MAX("40050"), 0), COUNT(*) '
                    'FROM group_msg_table WHERE "40027"=?',
                    (gid,),
                ).fetchone()
                max_seq = int(agg[0] or 0)
                max_rowid = int(agg[1] or 0)
                max_ts = int(agg[2] or 0)
                row_count = int(agg[3] or 0)
                delta = max(0, row_count - prev_count)
                total_new_rows += delta

                out_conn.execute(
                    "INSERT OR REPLACE INTO wenyou_sync_meta "
                    "(gid, max_seq, max_rowid, max_ts, row_count, seeded, last_src_sig, last_sync_at) "
                    "VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                    (gid, max_seq, max_rowid, max_ts, row_count, actual_src_sig, now_str),
                )
                per_group_report[str(gid)] = {
                    "kind": kind,
                    "fetched": len(rows),
                    "newRows": delta,
                    "totalRows": row_count,
                    "maxSeq": max_seq,
                }

            uid_synced = False
            uid_count = 0
            if payload["uid_rows"] is not None:
                out_conn.executemany(
                    'INSERT OR REPLACE INTO nt_uid_mapping_table ("48902", "1002") VALUES (?, ?)',
                    payload["uid_rows"],
                )
                uid_synced = True
                uid_count = len(payload["uid_rows"])
                set_kv(out_conn, "wenyou_sync_kv", "uid_map_src_sig", actual_src_sig)
            elif uid_map_src_sig == "":
                set_kv(out_conn, "wenyou_sync_kv", "uid_map_src_sig", actual_src_sig)

            set_kv(out_conn, "wenyou_sync_kv", "src_path", os.path.abspath(src_msg))
            set_kv(out_conn, "wenyou_sync_kv", "src_salt_hex", vfs_meta["saltHex"])
            set_kv(out_conn, "wenyou_sync_kv", "last_sync_at", now_str)

        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        stats = vfs_meta["stats"]
        return {
            "skipped": False,
            "mode": "vfs",
            "resetReason": reset_reason,
            "groups": groups_to_sync,
            "fetchedRows": total_fetched_rows,
            "newRows": total_new_rows,
            "uidMapSynced": uid_synced,
            "uidMapRows": uid_count,
            "pagesDecrypted": int(stats["pages_decrypted"]),
            "pagesFromWal": int(stats["pages_from_wal"]),
            "totalPages": int(vfs_meta["totalPages"]),
            "retries": int(vfs_meta["retries"]),
            "elapsedMs": elapsed_ms,
            "backend": vfs_meta["backend"],
            "main": snap_main,
            "wal": snap_wal,
            "perGroup": per_group_report,
        }
    finally:
        out_conn.close()


def sync_group_db(
    src_group: str,
    out_group: str,
    key_map: dict[str, str],
    force: bool = False,
    max_retries: int = 5,
    preferred_backend: str = "",
) -> dict[str, Any]:
    t0 = time.perf_counter()
    if not os.path.isfile(src_group):
        raise FileNotFoundError(f"找不到 QQ 群资料库：{src_group}")

    src_sig, main_st, wal_st = make_src_signature(src_group)
    src_salt_hex = read_ntqq_salt_hex(src_group)

    prev_sig = ""
    prev_salt = ""
    if os.path.isfile(out_group) and os.path.getsize(out_group) > 0:
        ro_conn = sqlite3.connect(out_group)
        try:
            has_kv = ro_conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wenyou_group_sync_kv'"
            ).fetchone()
            if has_kv:
                prev_sig = get_kv(ro_conn, "wenyou_group_sync_kv", "last_src_sig", "")
                prev_salt = get_kv(ro_conn, "wenyou_group_sync_kv", "src_salt_hex", "")
        finally:
            ro_conn.close()

    if not force and prev_sig == src_sig and prev_salt == src_salt_hex:
        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        return {
            "skipped": True,
            "mode": "vfs",
            "rows": 0,
            "pagesDecrypted": 0,
            "pagesFromWal": 0,
            "totalPages": 0,
            "retries": 0,
            "elapsedMs": elapsed_ms,
            "backend": "",
            "main": main_st,
            "wal": wal_st,
        }

    def _fetch_groups(src_conn: sqlite3.Connection, _enc_file):
        return src_conn.execute(
            'SELECT "60001", "60007" FROM group_list WHERE "60001" IS NOT NULL'
        ).fetchall()

    rows, vfs_meta = run_with_consistency_retry(
        src_group,
        key_map,
        _fetch_groups,
        max_attempts=max_retries,
        preferred_backend=preferred_backend,
    )
    snap_main = vfs_meta["main"]
    snap_wal = vfs_meta["wal"]
    actual_src_sig = (
        f"True:{snap_main['size']}:{snap_main['mtimeNs']}|"
        f"{snap_wal['exists']}:{snap_wal['size']}:{snap_wal['mtimeNs']}"
    )
    now_str = cst_now_str()

    os.makedirs(os.path.dirname(os.path.abspath(out_group)), exist_ok=True)
    out_conn = sqlite3.connect(out_group)
    try:
        init_group_target_db(out_conn)
        with out_conn:
            out_conn.execute("DELETE FROM group_list")
            if rows:
                out_conn.executemany(
                    'INSERT OR REPLACE INTO group_list ("60001", "60007") VALUES (?, ?)',
                    rows,
                )
            set_kv(out_conn, "wenyou_group_sync_kv", "last_src_sig", actual_src_sig)
            set_kv(out_conn, "wenyou_group_sync_kv", "src_salt_hex", vfs_meta["saltHex"])
            set_kv(out_conn, "wenyou_group_sync_kv", "last_sync_at", now_str)

        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        stats = vfs_meta["stats"]
        return {
            "skipped": False,
            "mode": "vfs",
            "rows": len(rows),
            "pagesDecrypted": int(stats["pages_decrypted"]),
            "pagesFromWal": int(stats["pages_from_wal"]),
            "totalPages": int(vfs_meta["totalPages"]),
            "retries": int(vfs_meta["retries"]),
            "elapsedMs": elapsed_ms,
            "backend": vfs_meta["backend"],
            "main": snap_main,
            "wal": snap_wal,
        }
    finally:
        out_conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="dsh-wenyou per-group VFS incremental sync")
    parser.add_argument("--src-msg", required=True, help="Encrypted NTQQ nt_msg.db path")
    parser.add_argument("--out-msg", required=True, help="Output wenyou-only plain msg DB path")
    parser.add_argument("--src-group", default="", help="Encrypted NTQQ group_info.db path")
    parser.add_argument("--out-group", default="", help="Output wenyou plain group DB path")
    parser.add_argument("--key-map", required=True, help="key_map.json path")
    parser.add_argument("--groups", default="", help="Comma-separated target group IDs")
    parser.add_argument("--force", action="store_true", help="Force full re-sync of target groups")
    parser.add_argument("--max-retries", type=int, default=5, help="Max anti-torn-read retry attempts")
    parser.add_argument("--backend", default="", help="Optional AES backend override")
    args = parser.parse_args(argv)

    groups = parse_groups_arg(args.groups)
    key_map = load_key_map(args.key_map)

    msg_res = sync_msg_db(
        src_msg=args.src_msg,
        out_msg=args.out_msg,
        key_map=key_map,
        groups=groups,
        force=args.force,
        max_retries=args.max_retries,
        preferred_backend=args.backend,
    )

    group_res = None
    if args.src_group and args.out_group:
        group_res = sync_group_db(
            src_group=args.src_group,
            out_group=args.out_group,
            key_map=key_map,
            force=args.force,
            max_retries=args.max_retries,
            preferred_backend=args.backend,
        )

    result = {
        "ok": True,
        "mode": "vfs",
        "msg": msg_res,
        "group": group_res,
    }
    print(f"__SYNC_RESULT__{json.dumps(result, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"ERROR: {exc}")
        sys.exit(1)
