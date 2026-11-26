# -*- coding: utf-8 -*-
"""Wenyou Pro bridge over the zero-dependency read-only NTQQ VFS engine.

Subcommands:
  list-groups    Sync encrypted group_info.db read-only and list available QQ groups.
  pull-messages  Sync requested QQ groups incrementally via read-only VFS and export
                 decoded UTF-8 message records as structured JSON for Wenyou Pro L0.

Never writes to or locks QQ's encrypted source databases.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
from typing import Any

_ASSETS_DIR = os.path.dirname(os.path.abspath(__file__))
if _ASSETS_DIR not in sys.path:
    sys.path.insert(0, _ASSETS_DIR)

from ntqq_vfs import load_key_map  # noqa: E402
import wenyou_read  # noqa: E402
from wenyou_vfs_sync import sync_group_db, sync_msg_db  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

CST = datetime.timezone(datetime.timedelta(hours=8))


def _fmt_full_ts(ts: Any) -> str:
    try:
        return datetime.datetime.fromtimestamp(int(ts), CST).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "2026-01-01 00:00:00"


def _atomic_write_json(target_path: str, payload: Any) -> str:
    abs_path = os.path.abspath(target_path)
    parent = os.path.dirname(abs_path)
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".wenyou-ntqq-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp_path, abs_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    return abs_path


def _extract_body_from_entry(entry: dict[str, Any]) -> str:
    prefix = f"[{entry['time']}] [{entry['gname']}] {entry['sender']}: "
    parts: list[str] = []
    for seg in entry.get("parsed") or []:
        rendered = wenyou_read.line_for(entry, seg)
        if rendered.startswith(prefix):
            body = rendered[len(prefix):].strip()
        else:
            body = rendered.strip()
        if body:
            parts.append(body)
    return "\n".join(parts).strip()


def _parse_group_specs(raw: str) -> list[tuple[int, int, int]]:
    specs: list[tuple[int, int, int]] = []
    seen: set[int] = set()
    for token in str(raw or "").split(","):
        token = token.strip()
        if not token:
            continue
        parts = token.split(":")
        gid_s = parts[0].strip()
        if not gid_s.isdigit():
            raise ValueError(f"非法群号：{gid_s}")
        gid = int(gid_s)
        if gid <= 0:
            raise ValueError(f"群号必须为正整数：{gid_s}")
        if gid in seen:
            continue
        seen.add(gid)
        since_ts = int(parts[1]) if len(parts) > 1 and parts[1].strip().isdigit() else 0
        since_rowid = int(parts[2]) if len(parts) > 2 and parts[2].strip().isdigit() else 0
        specs.append((gid, since_ts, since_rowid))
    return specs


def cmd_list_groups(args: argparse.Namespace) -> int:
    key_map = load_key_map(args.key_map)
    group_res = sync_group_db(
        src_group=args.src_group,
        out_group=args.out_group,
        key_map=key_map,
        force=args.force,
        max_retries=args.max_retries,
        preferred_backend=args.backend,
    )
    groups: list[dict[str, Any]] = []
    if os.path.isfile(args.out_group):
        conn = wenyou_read.open_readonly(args.out_group)
        try:
            rows = conn.execute(
                'SELECT "60001", "60007" FROM group_list WHERE "60001" IS NOT NULL ORDER BY "60001"'
            ).fetchall()
            for gid, name in rows:
                gid_str = str(gid).strip()
                if not gid_str:
                    continue
                label = str(name).strip() if name else gid_str
                groups.append({"groupId": gid_str, "groupName": label})
        finally:
            conn.close()
    print(
        "__NTQQ_BRIDGE__"
        + json.dumps({"ok": True, "groups": groups, "sync": group_res}, ensure_ascii=False)
    )
    return 0


def cmd_pull_messages(args: argparse.Namespace) -> int:
    specs = _parse_group_specs(args.groups)
    if not specs:
        raise ValueError("未指定要同步的 QQ 群号")
    key_map = load_key_map(args.key_map)
    gids = [gid for gid, _, _ in specs]

    msg_res = sync_msg_db(
        src_msg=args.src_msg,
        out_msg=args.out_msg,
        key_map=key_map,
        groups=gids,
        force=args.force,
        max_retries=args.max_retries,
        preferred_backend=args.backend,
    )
    group_res = None
    if args.src_group and args.out_group and os.path.isfile(args.src_group):
        group_res = sync_group_db(
            src_group=args.src_group,
            out_group=args.out_group,
            key_map=key_map,
            force=args.force,
            max_retries=args.max_retries,
            preferred_backend=args.backend,
        )

    limit = max(1, min(int(args.limit), 20000))
    conn = wenyou_read.open_readonly(args.out_msg)
    messages: list[dict[str, Any]] = []
    per_group: list[dict[str, Any]] = []
    try:
        uid_map = wenyou_read.load_uid_map(conn)
        for gid, since_ts, since_rowid in specs:
            gname = wenyou_read.load_group_name(args.out_group, gid)
            truncated = False
            if since_ts > 0:
                scan_args = SimpleNamespace(
                    group=str(gid),
                    since=str(since_ts),
                    since_rowid=str(since_rowid),
                    max=str(limit),
                )
                rows, _, truncated = wenyou_read.scan(conn, scan_args)
            else:
                rows = wenyou_read.tail_query(conn, gid, limit)

            entries = wenyou_read.decode_entries(rows, uid_map, gname)
            exported_count = 0
            for entry in entries:
                body = _extract_body_from_entry(entry)
                if not body:
                    continue
                sender_raw = entry.get("sender")
                sender_name = str(sender_raw).strip() if sender_raw else str(entry.get("uid") or "未知成员")
                uid_str = str(entry.get("uid") or "").strip()
                messages.append(
                    {
                        "sourceId": f"qq-{gid}-{entry['rowid']}",
                        "groupId": str(gid),
                        "groupName": gname,
                        "sender": sender_name,
                        "senderId": uid_str if uid_str else None,
                        "timestamp": _fmt_full_ts(entry["ts"]),
                        "ts": int(entry["ts"]),
                        "rowid": int(entry["rowid"]),
                        "text": body,
                    }
                )
                exported_count += 1

            per_group.append(
                {
                    "groupId": str(gid),
                    "groupName": gname,
                    "fetchedRows": len(rows),
                    "exportedMessages": exported_count,
                    "lastTs": int(rows[-1][1]) if rows else since_ts,
                    "lastRowid": int(rows[-1][0]) if rows else since_rowid,
                    "truncated": bool(truncated),
                }
            )
    finally:
        conn.close()

    out_path = _atomic_write_json(args.out_json, {"version": 1, "messages": messages})
    print(
        "__NTQQ_BRIDGE__"
        + json.dumps(
            {
                "ok": True,
                "outJson": out_path,
                "totalExported": len(messages),
                "perGroup": per_group,
                "sync": {"msg": msg_res, "group": group_res},
            },
            ensure_ascii=False,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Wenyou Pro read-only NTQQ VFS bridge")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list-groups")
    p_list.add_argument("--src-group", required=True)
    p_list.add_argument("--out-group", required=True)
    p_list.add_argument("--key-map", required=True)
    p_list.add_argument("--max-retries", type=int, default=5)
    p_list.add_argument("--backend", default="")
    p_list.add_argument("--force", action="store_true")
    p_list.set_defaults(fn=cmd_list_groups)

    p_pull = sub.add_parser("pull-messages")
    p_pull.add_argument("--src-msg", required=True)
    p_pull.add_argument("--out-msg", required=True)
    p_pull.add_argument("--src-group", default="")
    p_pull.add_argument("--out-group", default="")
    p_pull.add_argument("--key-map", required=True)
    p_pull.add_argument("--groups", required=True)
    p_pull.add_argument("--out-json", required=True)
    p_pull.add_argument("--limit", type=int, default=500)
    p_pull.add_argument("--max-retries", type=int, default=5)
    p_pull.add_argument("--backend", default="")
    p_pull.add_argument("--force", action="store_true")
    p_pull.set_defaults(fn=cmd_pull_messages)

    args = parser.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"[wenyou-ntqq-bridge] ERROR: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
