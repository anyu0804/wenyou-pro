# -*- coding: utf-8 -*-
"""dsh-wenyou 的 Python 侧执行器（基于 NTQQ 离线数据库协议逆向解析）。

子命令:
  check --db <明文nt_msg.db> --group <群号> --since <起始秒> [--max N]
  pull  --db <明文nt_msg.db> --group-db <明文group_info.db> --group <群号>
        --since <起始秒> --out-jsonl <jsonl> --out-txt <txt> [--max N]

约定:
  - 明文库由 assets/qq_decrypt.js 解密得到；本脚本只读，不做解密。
  - 列名是数字，SQL 中必须加引号："40050"=时间(秒,CST)、"40030"=群号、
    "40033"=发送者UID、"40800"=protobuf；"40027" 是有索引的群号镜像列，
    查询时同时校验 40027/40030，rowid 仅作同秒游标参考。
  - 优先走 群号+时间 查询；数据库损坏时自动退回 rowid 分页扫描。
  - 最终把一行 __RESULT__ + JSON 打到 stdout，日志全部走 stderr。
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 保证 stdout/stderr 始终输出 UTF-8，Node 侧按 UTF-8 收集。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

CST = timezone(timedelta(hours=8))
TCOL, GCOL, SCOL, BCOL = "40050", "40030", "40033", "40800"
INDEXED_GCOL = "40027"
MAX_ROWS_LIMIT = 200_000
PEEK_ROWS_LIMIT = 5000
PEEK_TIMELINE_LIMIT = 10000


def log(msg):
    print(f"[wenyou] {msg}", file=sys.stderr, flush=True)


def open_readonly(path):
    """以 immutable URI 方式只读打开明文库。

    QQ 的解密库头部是 WAL 模式，普通 connect 可能因为 -shm/-wal 或权限问题
    报 unable to open database file；immutable 打开与旧 decode 脚本一致。

    打开后立即做一次「真库探针」：必须是有效 SQLite，且至少含一张表。
    没有这道检查时，任何非空的伪库（测试 mock、占位文本）都会被当成"空结果"，
    让调用方拿到 count=0 而不是错误 —— 2026-09-18 的静默假零事故即由此而来。
    E-046 复核：合法库（含带损坏页的 QQ 活体库）schema 页必可读，故只拦伪库。
    """
    uri = Path(os.path.abspath(path)).as_uri() + "?immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    try:
        tables = conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
    except sqlite3.Error as exc:
        conn.close()
        raise sqlite3.DatabaseError(
            f"明文库不可读（不是有效的 SQLite 数据库）：{path} — {exc}") from exc
    if not tables:
        conn.close()
        raise sqlite3.DatabaseError(
            f"明文库不可读（没有任何表，疑似空壳/伪库）：{path}")
    return conn


def safe_rollback(conn):
    try:
        conn.rollback()
    except Exception:
        pass


def bounded_count(value, limit, label):
    """命令行侧也执行上限，避免绕过 Node 入口直接拖垮数据库。"""
    try:
        n = int(value)
    except Exception as exc:
        raise ValueError(f"{label} 必须是整数") from exc
    if n < 1 or n > limit:
        raise ValueError(f"{label} 需在 1~{limit} 之间")
    return n


def atomic_write_text(path, text):
    """先写同目录临时文件，再原子替换；失败时保留上一份正式文件。"""
    target = os.path.abspath(path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, target)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    return target


def atomic_write_jsonl(path, records):
    """流式写临时 JSONL，避免 20 万条导出时再拼一份巨型内存字符串。"""
    target = os.path.abspath(path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = f"{target}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(rec, ensure_ascii=False))
                f.write("\n")
        os.replace(tmp, target)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    return target


def group_predicate(conn, table, group):
    """优先借用 NTQQ 的 40027 群号索引，同时保留 40030 语义校验。

    旧版/测试库没有 40027 时自动退回原查询，不牺牲兼容性。
    """
    try:
        columns = {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
    except Exception:
        columns = set()
    if INDEXED_GCOL in columns:
        return f'"{INDEXED_GCOL}"=? AND "{GCOL}"=?', (group, group)
    return f'"{GCOL}"=?', (group,)


def parse_time_spec(val, is_until=False):
    """解析时间戳输入，支持整数时间戳或 CST 日期/时间格式字符串。返回非负整数秒或 0。"""
    if val is None or val == "":
        return 0
    if isinstance(val, (int, float)):
        ival = int(val)
        if ival < 0:
            raise ValueError(f"时间戳不能为负数: {val}")
        return ival
    val_str = str(val).strip()
    if not val_str or val_str == "0":
        return 0
    try:
        ival = int(val_str)
        if ival < 0:
            raise ValueError(f"时间戳不能为负数: {val}")
        return ival
    except ValueError as exc:
        if "负数" in str(exc):
            raise
    # 尝试按常见 CST 日期时间格式解析
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"):
        try:
            dt = datetime.strptime(val_str, fmt).replace(tzinfo=CST)
            return int(dt.timestamp())
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            dt = datetime.strptime(val_str, fmt).replace(tzinfo=CST)
            if is_until:
                dt = dt.replace(hour=23, minute=59, second=59)
            return int(dt.timestamp())
        except ValueError:
            pass
    # 尝试月日格式（跨年/闰日回退；is_until 纯日期默认延至 23:59:59 且同日未来不倒退一年）
    now_cst = datetime.now(CST)
    m = re.match(r"^(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$", val_str)
    if m:
        mo, d = int(m.group(1)), int(m.group(2))
        has_time = m.group(3) is not None
        h = int(m.group(3)) if has_time else (23 if is_until else 0)
        mi = int(m.group(4)) if has_time else (59 if is_until else 0)
        sec = int(m.group(5)) if m.group(5) is not None else (0 if has_time else (59 if is_until else 0))
        if not (1 <= mo <= 12 and 1 <= d <= 31 and 0 <= h <= 23 and 0 <= mi <= 59 and 0 <= sec <= 59):
            raise ValueError(f"无法识别的时间格式: {val}")
        same_or_past_day = (mo, d) <= (now_cst.month, now_cst.day)
        if is_until and same_or_past_day:
            try:
                return int(datetime(now_cst.year, mo, d, h, mi, sec, tzinfo=CST).timestamp())
            except ValueError:
                pass
        for y in range(now_cst.year, now_cst.year - 9, -1):
            try:
                dt = datetime(y, mo, d, h, mi, sec, tzinfo=CST)
            except ValueError:
                continue
            if dt <= now_cst:
                return int(dt.timestamp())
    raise ValueError(f"无法识别的时间格式: {val}")


def fast_query(conn, table, group, since_ts, since_rowid, max_rows, until_ts=0):
    """群号+时间查询，数据库损坏时抛异常交给调用方退回分页扫描。

    复合游标防漏：`(time > since_ts) OR (time = since_ts AND rowid > since_rowid)`。
    since_rowid 为 None/0 时退化为 `time > since_ts`（兼容旧游标）。
    若指定 until_ts > 0，增加 `time <= until_ts` 约束。
    """
    since_rowid = int(since_rowid) if since_rowid else 0
    group_sql, group_params = group_predicate(conn, table, group)
    conds = [group_sql]
    params = list(group_params)
    if since_rowid:
        conds.append(f'(("{TCOL}">?) OR ("{TCOL}"=? AND rowid>?))')
        params.extend([since_ts, since_ts, since_rowid])
    elif since_ts:
        conds.append(f'"{TCOL}">?')
        params.append(since_ts)
    if until_ts:
        conds.append(f'"{TCOL}"<=?')
        params.append(until_ts)
    where_clause = " AND ".join(conds)
    sql = (f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
           f'FROM {table} WHERE {where_clause} '
           f'ORDER BY "{TCOL}", rowid LIMIT ?')
    params.append(max_rows)
    return conn.execute(sql, params).fetchall()


def fast_query_desc(conn, table, group, until_ts=0, until_rowid=0, since_ts=0, limit=PEEK_ROWS_LIMIT):
    """群号+时间倒序查询（用于最新消息扫描或反向窗口扫描）。

    如果 until_rowid 和 until_ts 均指定：`(time < until_ts) OR (time = until_ts AND rowid < until_rowid)`。
    若仅指定 until_ts：`time <= until_ts`。
    若指定 since_ts：`time > since_ts`。
    """
    group_sql, group_params = group_predicate(conn, table, group)
    conds = [group_sql, f'"{TCOL}" IS NOT NULL']
    params = list(group_params)
    until_rowid = int(until_rowid) if until_rowid else 0
    if until_rowid:
        conds.append(f'(("{TCOL}"<?) OR ("{TCOL}"=? AND rowid<?))')
        params.extend([until_ts, until_ts, until_rowid])
    elif until_ts:
        conds.append(f'"{TCOL}"<=?')
        params.append(until_ts)
    if since_ts:
        conds.append(f'"{TCOL}">?')
        params.append(since_ts)
    where_clause = " AND ".join(conds)
    sql = (f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
           f'FROM {table} WHERE {where_clause} '
           f'ORDER BY "{TCOL}" DESC, rowid DESC LIMIT ?')
    params.append(limit)
    return conn.execute(sql, params).fetchall()


def paged_query(conn, table, group, since_ts, since_rowid, max_rows, until_ts=0):
    """rowid 分页 + 自动跳过损坏页；只保留目标群、since_ts 之后（同秒按 rowid）的消息。"""
    out = []
    # 分页从 since_rowid 之后开始扫，兼顾同秒撞车。
    last = int(since_rowid) if since_rowid else 0
    batch = 2000
    guard = 0
    fail_streak = 0
    while len(out) < max_rows:
        guard += 1
        if guard > 4_000_000:
            log("分页扫描超过保护上限，停止")
            break
        try:
            rows = conn.execute(
                f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
                f"FROM {table} WHERE rowid > ? ORDER BY rowid LIMIT ?",
                (last, batch),
            ).fetchall()
        except Exception:
            safe_rollback(conn)
            fail_streak += 1
            if fail_streak >= 5000 and not out:
                raise sqlite3.DatabaseError(
                    f"明文库不可读：连续 {fail_streak} 次读页失败且无任何产出，已中止扫描")
            if batch == 1:
                last += 1
            else:
                batch = max(1, batch // 4)
            continue
        fail_streak = 0
        if not rows:
            break
        last = rows[-1][0]
        for row in rows:
            if row[2] != group or row[1] is None:
                continue
            if until_ts and row[1] > until_ts:
                continue
            if row[1] > since_ts or (row[1] == since_ts and row[0] > int(since_rowid or 0)):
                out.append(row)
                if len(out) >= max_rows:
                    break
        batch = min(2000, batch * 2)
    out.sort(key=lambda r: (r[1], r[0]))
    return out


def paged_query_desc(conn, table, group, until_ts=0, until_rowid=0, since_ts=0, limit=PEEK_ROWS_LIMIT):
    """反向 rowid 分页 + 自动跳过损坏页；返回按 (ts, rowid) 降序排列的至多 limit 条匹配行。"""
    out = []
    until_rowid = int(until_rowid) if until_rowid else 0
    last = None
    try:
        cur = conn.execute(f"SELECT MAX(rowid) FROM {table}")
        row = cur.fetchone()
        if row and row[0] is not None:
            last = int(row[0])
    except Exception as exc:
        safe_rollback(conn)
        raise sqlite3.DatabaseError(f"无法读取 MAX(rowid)：{exc}") from exc
    if last is None:
        return out
    batch = 2048
    guard = 0
    fail_streak = 0
    while len(out) < limit and last >= 1:
        guard += 1
        if guard > 4_000_000:
            log("反向分页扫描超过保护上限，停止")
            break
        try:
            rows = conn.execute(
                f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
                f"FROM {table} WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?",
                (last, batch),
            ).fetchall()
        except Exception:
            safe_rollback(conn)
            fail_streak += 1
            if fail_streak >= 5000:
                if not out:
                    raise sqlite3.DatabaseError(
                        f"明文库不可读：连续 {fail_streak} 次反向读页失败且无任何产出，已中止扫描")
                log(f"反向分页连续 {fail_streak} 次读页失败，保留已收集 {len(out)} 条结果并中止")
                break
            last -= batch
            batch = max(8, batch // 2)
            continue
        fail_streak = 0
        if not rows:
            break
        last = rows[-1][0] - 1
        for row in rows:
            if row[2] != group or row[1] is None:
                continue
            ts = row[1]
            rid = row[0]
            if since_ts and ts <= since_ts:
                continue
            if until_rowid:
                if not (ts < until_ts or (ts == until_ts and rid < until_rowid)):
                    continue
            elif until_ts:
                if ts > until_ts:
                    continue
            out.append(row)
            if len(out) >= limit:
                break
        batch = min(2048, batch * 2)
    out.sort(key=lambda r: (r[1], r[0]), reverse=True)
    return out


def read_varint(b, i):
    shift = 0
    val = 0
    while True:
        x = b[i]
        i += 1
        val |= (x & 0x7F) << shift
        if not (x & 0x80):
            break
        shift += 7
    return val, i


# 已知原始负载字段（文本 45101、图片 45402、表情 47602 等），保持原始字节，不进行递归 protobuf 解析
RAW_PAYLOAD_FIELDS = {45101, 45402, 47602}


def walk(b, depth=0, maxdepth=12):
    i = 0
    out = []
    while i < len(b):
        try:
            key, i = read_varint(b, i)
        except Exception:
            break
        field = key >> 3
        wt = key & 7
        if wt == 0:
            try:
                v, i = read_varint(b, i)
            except Exception:
                break
            out.append((field, v))
        elif wt == 2:
            try:
                ln, i = read_varint(b, i)
            except Exception:
                break
            if i + ln > len(b):
                break
            sub = b[i:i + ln]
            i += ln
            if field not in RAW_PAYLOAD_FIELDS and depth < maxdepth and ln >= 2:
                try:
                    inner = walk(sub, depth + 1, maxdepth)
                    if inner:
                        out.append((field, inner))
                        continue
                except Exception:
                    pass
            out.append((field, sub))
        elif wt == 1:
            out.append((field, b[i:i + 8]))
            i += 8
        elif wt == 5:
            out.append((field, b[i:i + 4]))
            i += 4
        else:
            break
    return out


# 常见 QQ 群消息类型数字 → 可读中文标签（展示用；未知类型仍显示数字，不编造）
TYPE_NAMES = {
    1: "文本",
    2: "图片",
    3: "语音",
    4: "视频",
    5: "视频",
    6: "表情",
    7: "文件",
    8: "引用",
    9: "合并转发",
    10: "位置",
    11: "小程序",
    12: "掷骰子",
    13: "猜拳",
    14: "拍一拍",
    15: "撤回",
    16: "系统消息",
    17: "链接",
    18: "名片",
    19: "红包",
    20: "转账",
}


def type_label(t):
    """类型 → 中文标签；未识别时保留数字。"""
    if t is None:
        return None
    try:
        n = int(t)
    except Exception:
        return str(t)
    return TYPE_NAMES.get(n, f"类型{n}")


def collect_strings(v, out):
    if isinstance(v, list):
        for _f, x in v:
            collect_strings(x, out)
    elif isinstance(v, bytes):
        try:
            s = v.decode("utf-8")
            if s and all(ch.isprintable() or ch in "\n\r\t" for ch in s):
                out.append(s)
        except Exception:
            pass


def parse_blob(blob):
    """把一个 protobuf 消息解析成 [(type, text/image/sticker)]。"""
    tree = walk(bytes.fromhex(blob))
    msgs = []
    for f, v in tree:
        if f != 40800 or not isinstance(v, list):
            continue
        info = {"type": None, "text": None, "image": None, "sticker": None, "ats": []}
        for sf, sv in v:
            if sf == 45002:
                info["type"] = sv
            elif sf == 45101:
                if isinstance(sv, bytes):
                    try:
                        info["text"] = sv.decode("utf-8")
                    except Exception:
                        info["text"] = None
                elif isinstance(sv, list):
                    fragments = []
                    # 深度优先保序收集可打印片段（8/@/链接等富文本都在里面）
                    collect_strings(sv, fragments)
                    info["text"] = "".join(fragments) if fragments else None
            elif sf == 45402 and isinstance(sv, bytes):
                try:
                    info["image"] = sv.decode("utf-8")
                except Exception:
                    pass
            elif sf == 47602 and isinstance(sv, bytes):
                try:
                    info["sticker"] = sv.decode("utf-8")
                except Exception:
                    pass
            elif sf == 45117 and isinstance(sv, list):
                # @ 成员：出现在文本 list 里，收集其中的可读串
                ats = []
                collect_strings(sv, ats)
                if ats:
                    info["ats"] = ats
        msgs.append(info)
    return msgs


def line_for(entry, parsed):
    time_s = entry["time"]
    gname = entry["gname"]
    sender = entry["sender"]
    label = type_label(parsed["type"])
    prefix = f"[{label}] " if label else ""
    if parsed["type"] == 1 or parsed["type"] is None:
        txt = parsed["text"] or ""
        if parsed.get("ats"):
            # 把 @ 标志拼到文本后，方便 AI 看到引用了谁
            if txt:
                txt += " " + " ".join(f"@{a}" for a in parsed["ats"][:5])
        if parsed["type"] == 1 and txt:
            return f"[{time_s}] [{gname}] {sender}: {txt}"
        if not txt:
            return f"[{time_s}] [{gname}] {sender}: {prefix or '[文本]'}（空）"
        return f"[{time_s}] [{gname}] {sender}: {prefix}{txt}"
    if parsed["type"] == 2:
        return f"[{time_s}] [{gname}] {sender}: [图片] {parsed['image']}"
    if parsed["type"] == 6:
        return f"[{time_s}] [{gname}] {sender}: [表情] {parsed['sticker']}"
    # 其它类型：优先给可读文本，其次给类型标签
    txt = parsed["text"]
    if parsed["image"]:
        txt = txt or ""
        txt = f"{txt} [图片] {parsed['image']}".strip()
    if parsed["sticker"]:
        txt = txt or ""
        txt = f"{txt} [表情] {parsed['sticker']}".strip()
    if not txt:
        txt = label or f"[类型{parsed['type']}]"
    else:
        txt = f"{label} {txt}".strip() if label else txt
    return f"[{time_s}] [{gname}] {sender}: {txt}"


def fmt_ts(ts):
    try:
        return datetime.fromtimestamp(ts, CST).strftime("%m-%d %H:%M:%S")
    except Exception:
        return str(ts)


def decode_entries(rows, uid_map, gname):
    entries = []
    for rowid, ts, _gid, uid, blob in rows:
        sender = uid_map.get(uid, uid)
        blob_hex = blob.hex() if isinstance(blob, (bytes, bytearray)) else blob
        parsed = []
        parse_status = "empty"
        parse_error = None
        if blob_hex:
            try:
                parsed = parse_blob(blob_hex)
                parse_status = "parsed" if parsed else "unrecognized"
            except Exception as exc:
                # Keep the legacy parsed=[] fallback, but do not erase the
                # distinction between an unsupported payload and parser failure.
                parse_status = "error"
                # Record only the exception class. Some decoder exceptions can
                # echo payload fragments, which must not leak into summaries.
                parse_error = type(exc).__name__[:80]
                parsed = []
        entries.append({
            "rowid": rowid,
            "ts": ts,
            "time": fmt_ts(ts),
            "gname": gname,
            "uid": uid,
            "sender": sender,
            "blob": blob_hex,
            "parsed": parsed,
            "parse_status": parse_status,
            "parse_error": parse_error,
        })
    return entries


def parse_keyword_query(keyword):
    """对齐 evidence-search.js：支持英文 "..." 与中文 “...” 精确短语，其余空白分词做 AND 匹配。"""
    if keyword is None:
        return {"active": False, "empty_quoted": False, "phrases": [], "terms": []}
    raw = str(keyword).strip()
    if not raw:
        return {"active": False, "empty_quoted": False, "phrases": [], "terms": []}
    phrases = []

    def _collect(m):
        inner = (m.group(1) if m.group(1) is not None else m.group(2) or "").strip().lower()
        if inner:
            phrases.append(inner)
        return " "

    stripped = re.sub(r'"([^"]*)"|“([^”]*)”', _collect, raw)
    terms = [t for t in re.sub(r'["“”]', " ", stripped).strip().lower().split() if t]
    if not phrases and not terms:
        return {"active": True, "empty_quoted": True, "phrases": [], "terms": []}
    return {"active": True, "empty_quoted": False, "phrases": phrases, "terms": terms}


def match_filter(entry, keyword, sender):
    """根据 keyword 与 sender 过滤 entry。
    sender: 匹配稳定身份（原始 UID 或映射后的昵称，不区分大小写，支持相等或包含）。
    keyword: 对齐 L0 检索口径，支持双引号精确短语与空格分隔多词 AND 匹配（含 @ 文本）。
    """
    if sender:
        s_target = sender.strip().lower()
        raw_sender = entry.get("sender")
        s_sender = ("" if raw_sender is None else str(raw_sender)).lower()
        s_uid = str(entry.get("uid") or "").lower()
        if not (s_target == s_sender or s_target == s_uid or s_target in s_sender):
            return False
    kw = parse_keyword_query(keyword)
    if kw["active"]:
        if kw["empty_quoted"]:
            return False
        parts = []
        for m in entry.get("parsed") or []:
            txt = m.get("text")
            if txt:
                parts.append(str(txt))
            if m.get("ats"):
                parts.append(" ".join(f"@{a}" for a in m["ats"]))
        combined = " ".join(parts).lower()
        if not combined:
            return False
        if not all(p in combined for p in kw["phrases"]):
            return False
        if not all(t in combined for t in kw["terms"]):
            return False
    return True


def parse_report(entries):
    """Return bounded parser-health metadata without changing legacy output."""
    counts = {"parsed": 0, "unrecognized": 0, "empty": 0, "error": 0}
    failures = []
    for entry in entries:
        status = entry.get("parse_status", "unrecognized")
        counts[status] = counts.get(status, 0) + 1
        if status == "error" and len(failures) < 3:
            failures.append({
                "rowid": str(entry.get("rowid")),
                "error": entry.get("parse_error"),
            })
    return {**counts, "failures": failures}


def export_record(entry, group):
    rec = {
        "rowid": entry["rowid"], "ts": entry["ts"],
        "group": group, "sender": entry["sender"],
        "parseStatus": entry["parse_status"],
    }
    if entry["blob"]:
        rec["blob"] = entry["blob"]
    if entry["parse_error"]:
        rec["parseError"] = entry["parse_error"]
    return rec


def build_sample(entries, n=5):
    sample = []
    for e in entries[-n:]:
        for m in e["parsed"][-1:] if e["parsed"] else [{"type": None}]:
            if m.get("type") is None:
                continue
            sample.append({"time": e["time"], "sender": e["sender"], "text": line_for(e, m)})
    return sample[-n:]


def load_uid_map(conn):
    try:
        return dict(conn.execute('SELECT "48902", "1002" FROM nt_uid_mapping_table'))
    except Exception:
        safe_rollback(conn)
        return {}


def load_group_name(group_db, group):
    if not group_db or not os.path.isfile(group_db):
        return str(group)
    conn = None
    try:
        conn = open_readonly(group_db)
        row = conn.execute(
            'SELECT "60007" FROM group_list WHERE "60001"=?', (group,)).fetchone()
        return row[0] if row and row[0] else str(group)
    except Exception:
        return str(group)
    finally:
        if conn:
            conn.close()


def scan(conn, args):
    group = int(args.group)
    since = int(args.since)
    since_rowid = getattr(args, "since_rowid", 0) or 0
    until = getattr(args, "until", 0) or 0
    max_rows = bounded_count(args.max, MAX_ROWS_LIMIT, "max")
    probe_rows = max_rows + 1
    rows = None
    try:
        rows = fast_query(conn, "group_msg_table", group, since, since_rowid, probe_rows, until_ts=until)
    except Exception as exc:
        log(f"常规查询失败（{exc}），改用 rowid 分页扫描")
        conn.rollback()
        rows = paged_query(conn, "group_msg_table", group, since, since_rowid, probe_rows, until_ts=until)
    truncated = len(rows) > max_rows
    if truncated:
        rows = rows[:max_rows]
    return rows, since_rowid, truncated


def cmd_check(args):
    if not os.path.isfile(args.db):
        sys.exit(f"明文库不存在: {args.db}")
    gname = load_group_name(args.group_db, args.group)
    conn = open_readonly(args.db)
    try:
        rows, since_rowid, truncated = scan(conn, args)
        uid_map = load_uid_map(conn) if rows else {}
        entries = decode_entries(rows, uid_map, gname)
        result = {
            "ok": True,
            "mode": "check",
            "group": int(args.group),
            "groupName": gname,
            "since": int(args.since),
            "sinceRowid": since_rowid,
            "count": len(rows),
            "truncated": truncated,
            "firstTs": rows[0][1] if rows else None,
            "lastTs": rows[-1][1] if rows else None,
            "lastRowid": str(rows[-1][0]) if rows else None,
            "firstAt": fmt_ts(rows[0][1]) if rows else None,
            "lastAt": fmt_ts(rows[-1][1]) if rows else None,
            "sample": build_sample(entries, 5),
            "parse": parse_report(entries),
        }
        print("__RESULT__" + json.dumps(result, ensure_ascii=False))
    finally:
        conn.close()


def tail_query(conn, group, n):
    """返回某群按时间升序的最近 n 条消息（用于初次建立游标/回看尾巴）。"""
    group_sql, group_params = group_predicate(conn, "group_msg_table", group)
    try:
        rows = conn.execute(
            f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
            f'FROM group_msg_table WHERE {group_sql} AND "{TCOL}" IS NOT NULL '
            f'ORDER BY "{TCOL}" DESC, rowid DESC LIMIT ?', (*group_params, n)).fetchall()
    except Exception:
        safe_rollback(conn)
        # 倒退：用 rowid 倒序扫
        rows = conn.execute(
            f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
            f'FROM group_msg_table WHERE {group_sql} AND "{TCOL}" IS NOT NULL '
            f'ORDER BY rowid DESC LIMIT ?', (*group_params, n)).fetchall()
    return list(reversed(rows))


def cmd_tail(args):
    if not os.path.isfile(args.db):
        sys.exit(f"明文库不存在: {args.db}")
    gname = load_group_name(args.group_db, args.group)
    conn = open_readonly(args.db)
    try:
        n = bounded_count(args.n, MAX_ROWS_LIMIT, "n")
        rows = tail_query(conn, int(args.group), n)
        uid_map = load_uid_map(conn) if rows else {}
        entries = decode_entries(rows, uid_map, gname)
        out_jsonl = None
        out_txt = None
        if entries and args.out_jsonl:
            records = []
            for e in entries:
                records.append(export_record(e, int(args.group)))
            out_jsonl = atomic_write_jsonl(args.out_jsonl, records)
        lines = []
        for e in entries:
            for m in e["parsed"]:
                lines.append(line_for(e, m))
        if entries and args.out_txt:
            out_txt = atomic_write_text(args.out_txt, "\n".join(lines) + ("\n" if lines else ""))
        result = {
            "ok": True,
            "mode": "tail",
            "group": int(args.group),
            "groupName": gname,
            "count": len(rows),
            "firstTs": rows[0][1] if rows else None,
            "lastTs": rows[-1][1] if rows else None,
            "lastRowid": str(rows[-1][0]) if rows else None,
            "firstAt": fmt_ts(rows[0][1]) if rows else None,
            "lastAt": fmt_ts(rows[-1][1]) if rows else None,
            "outJsonl": out_jsonl,
            "outTxt": out_txt,
            "lines": len(lines),
            "sample": build_sample(entries, 5),
            "parse": parse_report(entries),
        }
        print("__RESULT__" + json.dumps(result, ensure_ascii=False))
    finally:
        conn.close()


def cmd_pull(args):
    if not os.path.isfile(args.db):
        sys.exit(f"明文库不存在: {args.db}")
    gname = load_group_name(args.group_db, args.group)
    conn = open_readonly(args.db)
    try:
        rows, since_rowid, truncated = scan(conn, args)
        uid_map = load_uid_map(conn) if rows else {}
        entries = decode_entries(rows, uid_map, gname)
        records = []
        for e in entries:
            records.append(export_record(e, int(args.group)))
        lines = []
        for e in entries:
            for m in e["parsed"]:
                lines.append(line_for(e, m))
        out_jsonl = atomic_write_jsonl(args.out_jsonl, records) if entries else None
        out_txt = atomic_write_text(args.out_txt, "\n".join(lines) + ("\n" if lines else "")) if entries else None
        result = {
            "ok": True,
            "mode": "pull",
            "group": int(args.group),
            "groupName": gname,
            "since": int(args.since),
            "sinceRowid": since_rowid,
            "count": len(rows),
            "truncated": truncated,
            "firstTs": rows[0][1] if rows else None,
            "lastTs": rows[-1][1] if rows else None,
            "lastRowid": str(rows[-1][0]) if rows else None,
            "firstAt": fmt_ts(rows[0][1]) if rows else None,
            "lastAt": fmt_ts(rows[-1][1]) if rows else None,
            "outJsonl": out_jsonl,
            "outTxt": out_txt,
            "lines": len(lines),
            "sample": build_sample(entries, 5),
            "parse": parse_report(entries),
        }
        print("__RESULT__" + json.dumps(result, ensure_ascii=False))
    finally:
        conn.close()


def cmd_pullall(args):
    """多群增量导出 + 按时间升序合并成一份合订 chatlog。

    --groups "gid1:since1:rowid1,gid2:since2:rowid2,..."
    --out-dir <目录>   （per-group 文件与会话里需用到的字段从这里写）
    --max N           （单群配额上限，兼容既有调用）
    --total-max N     （全局总配额，启用空闲群剩余额度向密集群转移的再分配机制）
    """
    if not os.path.isfile(args.db):
        sys.exit(f"明文库不存在: {args.db}")
    os.makedirs(args.out_dir, exist_ok=True)
    conn = open_readonly(args.db)
    uid_map = None
    specs = [s.strip() for s in args.groups.split(",") if s.strip()]

    total_max_raw = getattr(args, "total_max", None)
    use_total_reallocation = total_max_raw is not None and str(total_max_raw).strip() != ""

    parsed_groups = []
    for spec in specs:
        parts = spec.split(":")
        gid = int(parts[0])
        since = int(parts[1]) if len(parts) > 1 and parts[1] else 0
        since_rowid = int(parts[2]) if len(parts) > 2 and parts[2] else 0
        gname = load_group_name(args.group_db, gid)
        parsed_groups.append({
            "gid": gid,
            "since": since,
            "since_rowid": since_rowid,
            "name": gname,
            "rows": [],
            "truncated": False,
        })

    if use_total_reallocation:
        total_budget = bounded_count(total_max_raw, MAX_ROWS_LIMIT, "total-max")
        num_groups = len(parsed_groups)
        base_quota = total_budget // num_groups if num_groups else total_budget
        surplus = total_budget % num_groups if num_groups else 0

        # 第一轮：按 base_quota 均分拉取各群
        truncated_items = []
        for g in parsed_groups:
            try:
                rows = fast_query(conn, "group_msg_table", g["gid"], g["since"], g["since_rowid"], base_quota + 1)
            except Exception:
                safe_rollback(conn)
                rows = paged_query(conn, "group_msg_table", g["gid"], g["since"], g["since_rowid"], base_quota + 1)
            if len(rows) > base_quota:
                g["rows"] = rows[:base_quota]
                g["truncated"] = True
                truncated_items.append(g)
            else:
                g["rows"] = rows
                g["truncated"] = False
                surplus += (base_quota - len(rows))

        # 第二轮：剩余额度向截断密集群动态转移
        while surplus > 0 and truncated_items:
            extra_per = surplus // len(truncated_items)
            rem = surplus % len(truncated_items)
            if extra_per == 0 and rem == 0:
                break
            next_truncated = []
            new_surplus = 0
            for idx, g in enumerate(truncated_items):
                cur_extra = extra_per + (1 if idx < rem else 0)
                if cur_extra <= 0:
                    next_truncated.append(g)
                    continue
                if g["rows"]:
                    last_row = g["rows"][-1]
                    last_rowid = last_row[0]
                    last_ts = last_row[1]
                else:
                    last_rowid = g["since_rowid"]
                    last_ts = g["since"]
                try:
                    more_rows = fast_query(conn, "group_msg_table", g["gid"], last_ts, last_rowid, cur_extra + 1)
                except Exception:
                    safe_rollback(conn)
                    more_rows = paged_query(conn, "group_msg_table", g["gid"], last_ts, last_rowid, cur_extra + 1)
                if len(more_rows) > cur_extra:
                    g["rows"].extend(more_rows[:cur_extra])
                    g["truncated"] = True
                    next_truncated.append(g)
                else:
                    g["rows"].extend(more_rows)
                    g["truncated"] = False
                    new_surplus += (cur_extra - len(more_rows))
            surplus = new_surplus
            truncated_items = next_truncated
            if extra_per == 0:
                break
    else:
        # 兼容原有单群 max 逻辑
        max_per = bounded_count(args.max, MAX_ROWS_LIMIT, "max")
        for g in parsed_groups:
            try:
                rows = fast_query(conn, "group_msg_table", g["gid"], g["since"], g["since_rowid"], max_per + 1)
            except Exception:
                safe_rollback(conn)
                rows = paged_query(conn, "group_msg_table", g["gid"], g["since"], g["since_rowid"], max_per + 1)
            truncated = len(rows) > max_per
            if truncated:
                rows = rows[:max_per]
            g["rows"] = rows
            g["truncated"] = truncated

    combined_entries = []
    per = []
    for g in parsed_groups:
        rows = g["rows"]
        if rows and uid_map is None:
            uid_map = load_uid_map(conn)
        entries = decode_entries(rows, uid_map or {}, g["name"])
        out_jsonl = os.path.join(args.out_dir, f"msgs_增量_{g['gid']}.jsonl")
        out_txt = os.path.join(args.out_dir, f"chatlog_增量_{g['gid']}.txt")
        lines = []
        records = []
        for e in entries:
            records.append(export_record(e, g["gid"]))
            for m in e["parsed"]:
                lines.append(line_for(e, m))
        actual_jsonl = atomic_write_jsonl(out_jsonl, records) if entries else None
        actual_txt = atomic_write_text(out_txt, "\n".join(lines) + ("\n" if lines else "")) if entries else None
        # 合订用：只合并「完整导出」的群，避免截断群游标未推进、下次重导造成重复。
        if not g["truncated"]:
            for e in entries:
                for m in e["parsed"]:
                    base = line_for(e, m)
                    combined_entries.append((e["ts"], base, e["sender"], g["name"]))
        per.append({
            "gid": g["gid"], "name": g["name"], "count": len(entries),
            "truncated": g["truncated"],
            "lastTs": entries[-1]["ts"] if entries else None,
            "lastRowid": str(entries[-1]["rowid"]) if entries else None,
            "sinceRowid": g["since_rowid"],
            "lastAt": fmt_ts(entries[-1]["ts"]) if entries else None,
            "outJsonl": actual_jsonl,
            "outTxt": actual_txt,
            "parse": parse_report(entries),
        })
    combined_entries.sort(key=lambda x: x[0])
    combined_lines = []
    combined_txt = None
    if combined_entries:
        stamp = datetime.fromtimestamp(combined_entries[-1][0], CST).strftime("%m%d-%H%M")
        combined_txt = os.path.join(args.out_dir, f"chatlog_增量_合订_{stamp}.txt")
        for _ts, base, _sender, _tag in combined_entries:
            combined_lines.append(base)
        combined_txt = atomic_write_text(
            combined_txt,
            "\n".join(combined_lines) + ("\n" if combined_lines else ""),
        )
    result = {
        "ok": True,
        "mode": "pullall",
        "perGroup": per,
        "combinedTxt": combined_txt,
        "combinedCount": len(combined_lines),
        "totalCount": sum(int(p.get("count", 0)) for p in per),
        "firstAt": fmt_ts(combined_entries[0][0]) if combined_entries else None,
        "lastAt": fmt_ts(combined_entries[-1][0]) if combined_entries else None,
    }
    print("__RESULT__" + json.dumps(result, ensure_ascii=False))
    conn.close()


def cmd_names(args):
    """只读群资料库批量取群名（不打开 2.3GB 消息库，成本≈0）。"""
    gids = []
    for token in str(args.groups).split(","):
        token = token.strip()
        if not token:
            continue
        try:
            gids.append(int(token))
        except ValueError:
            continue
    names = {}
    conn = None
    try:
        if args.group_db and os.path.isfile(args.group_db):
            conn = open_readonly(args.group_db)
        for gid in gids:
            label = str(gid)
            if conn is not None:
                try:
                    row = conn.execute(
                        'SELECT "60007" FROM group_list WHERE "60001"=?', (gid,)).fetchone()
                    if row and row[0]:
                        label = row[0]
                except Exception:
                    pass
            names[str(gid)] = label
    finally:
        if conn is not None:
            conn.close()
    print("__RESULT__" + json.dumps(
        {"ok": True, "mode": "names", "names": names}, ensure_ascii=False))


def cmd_verify(args):
    """快速校验新解密库：必须能读取 schema，且包含预期核心表。"""
    if not os.path.isfile(args.db):
        print("__RESULT__" + json.dumps({
            "ok": False, "mode": "verify", "error": "missing", "db": os.path.abspath(args.db),
        }, ensure_ascii=False))
        return
    conn = open_readonly(args.db)
    try:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        tables = {str(row[0]) for row in rows if row and row[0]}
        expected = str(args.table or "").strip()
        ok = bool(tables) and (not expected or expected in tables)
        print("__RESULT__" + json.dumps({
            "ok": ok,
            "mode": "verify",
            "db": os.path.abspath(args.db),
            "expectedTable": expected or None,
            "tableCount": len(tables),
            "error": None if ok else f"缺少预期表 {expected}",
        }, ensure_ascii=False))
    finally:
        conn.close()


def peek_query(conn, group, n):
    """临时阅读：取某群最近 n 条。优先走索引查询路径，异常时退回反向扫描。"""
    try:
        rows = tail_query(conn, group, n)
        return rows, 0
    except Exception:
        safe_rollback(conn)

    out = []
    last = None
    batch = 2048
    guard = 0
    skipped = 0
    fail_streak = 0
    try:
        cur = conn.execute("SELECT MAX(rowid) FROM group_msg_table")
        row = cur.fetchone()
        if row and row[0] is not None:
            last = int(row[0])
    except Exception as exc:
        safe_rollback(conn)
        raise sqlite3.DatabaseError(f"无法读取 MAX(rowid)：{exc}") from exc
    if last is None:
        return out, 0
    while len(out) < n and last >= 1:
        guard += 1
        if guard > 200000:
            log("peek 扫描超过保护上限，停止")
            break
        try:
            rows = conn.execute(
                f'SELECT rowid, "{TCOL}", "{GCOL}", "{SCOL}", "{BCOL}" '
                f"FROM group_msg_table WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?",
                (last, batch)).fetchall()
        except Exception:
            safe_rollback(conn)
            skipped += 1
            fail_streak += 1
            if fail_streak >= 5000:
                if not out:
                    raise sqlite3.DatabaseError(
                        f"明文库不可读：连续 {fail_streak} 次反向读页失败且无任何产出，已中止扫描")
                log(f"peek 扫描连续 {fail_streak} 次读页失败，保留已收集 {len(out)} 条结果并中止")
                break
            # 这一批不可读：整体跳过它，前推 last 并减半批次（不逐行磨）
            last -= batch
            batch = max(8, batch // 2)
            continue
        fail_streak = 0
        if not rows:
            # 已经扫到表头
            break
        last = rows[-1][0] - 1
        for row in rows:
            if row[2] == group and row[1] is not None:
                out.append(row)
                if len(out) >= n:
                    break
        batch = min(2048, batch * 2)
    out.sort(key=lambda r: (r[1], r[0]))
    return out, skipped


def cmd_peek(args):
    """临时阅读：只看某群消息（升序），不建游标、不登记监测、不改任何状态。

    用法说明：
      · --group <群号> (必填)
      · --n <数量> (必填，单次结果上限，最高 5000)
      · --since <起始秒或CST时间> (可选，默认 0)
      · --until <截止秒或CST时间> (可选，默认 0)
      · --keyword <关键词> (可选，匹配解析后的消息正文)
      · --sender <发送者> (可选，匹配稳定身份：映射昵称或原始UID)
      · --scan-limit <扫描上限> (可选，批次扫描行数保护上限，默认 20000)
    """
    if not os.path.isfile(args.db):
        sys.exit(f"明文库不存在: {args.db}")
    gname = load_group_name(args.group_db, args.group)
    conn = open_readonly(args.db)
    try:
        n = bounded_count(args.n, PEEK_ROWS_LIMIT, "n")
        since_ts = parse_time_spec(getattr(args, "since", 0))
        until_ts = parse_time_spec(getattr(args, "until", 0), is_until=True)
        keyword = (getattr(args, "keyword", "") or "").strip()
        sender = (getattr(args, "sender", "") or "").strip()
        scan_limit = bounded_count(getattr(args, "scan_limit", 20000), MAX_ROWS_LIMIT, "scan-limit")

        cursor = getattr(args, "cursor", "")
        since_rowid = until_rowid = 0
        forward = since_ts > 0
        if cursor:
            direction, ts, rowid = cursor.split(":")
            ts, rowid = int(ts), int(rowid)
            if direction not in ("after", "before") or ts < 1 or rowid < 1:
                raise ValueError("无效的续读位置")
            if (since_ts and ts < since_ts) or (until_ts and ts > until_ts):
                raise ValueError("续读位置不在指定时间范围内")
            forward = direction == "after"
            if forward:
                since_ts, since_rowid = ts, rowid
            else:
                until_ts, until_rowid = ts, rowid

        has_filter = bool(keyword or sender)
        uid_map = load_uid_map(conn)

        fallback_used = False
        query_error = None
        hit_scan_limit = False
        truncated = False
        scanned_count = 0
        matched_entries = []
        last_scanned = None

        if since_ts > 0 and until_ts > 0 and (since_ts > until_ts or (since_ts == until_ts and not since_rowid)):
            result = {
                "ok": True,
                "mode": "peek",
                "group": int(args.group),
                "groupName": gname,
                "since": since_ts,
                "until": until_ts,
                "keyword": keyword or None,
                "sender": sender or None,
                "count": 0,
                "scanned": 0,
                "truncated": False,
                "hitScanLimit": False,
                "firstTs": None,
                "lastTs": None,
                "firstAt": None,
                "lastAt": None,
                "outTxt": None,
                "fallback": False,
                "warning": "起始时间 (since) 大于或等于截止时间 (until)，未查到消息。",
                "sample": [],
                "parse": {"parsed": 0, "unrecognized": 0, "empty": 0, "error": 0, "failures": []},
            }
            print("__RESULT__" + json.dumps(result, ensure_ascii=False))
            return

        if not has_filter:
            if forward:
                fake = type("A", (), {
                    "group": args.group,
                    "since": str(since_ts),
                    "since_rowid": str(since_rowid),
                    "until": until_ts,
                    "max": str(n)
                })()
                try:
                    rows, _, truncated = scan(conn, fake)
                    scanned_count = len(rows)
                    matched_entries = decode_entries(rows, uid_map, gname)
                except Exception as exc:
                    safe_rollback(conn)
                    query_error = str(exc)
            else:
                try:
                    if until_ts > 0:
                        try:
                            rows = fast_query_desc(conn, "group_msg_table", int(args.group), until_ts=until_ts, until_rowid=until_rowid, since_ts=since_ts, limit=n + 1)
                            skipped = 0
                        except Exception:
                            safe_rollback(conn)
                            rows = paged_query_desc(conn, "group_msg_table", int(args.group), until_ts=until_ts, until_rowid=until_rowid, since_ts=since_ts, limit=n + 1)
                            skipped = 1
                    else:
                        rows, skipped = peek_query(conn, int(args.group), n + 1)
                    fallback_used = skipped > 0
                    scanned_count = len(rows)
                    rows.sort(key=lambda r: (r[1], r[0]), reverse=True)
                    truncated = len(rows) > n
                    if truncated:
                        rows = rows[:n]
                    rows.sort(key=lambda r: (r[1], r[0]))
                    matched_entries = decode_entries(rows, uid_map, gname)
                except Exception as exc:
                    safe_rollback(conn)
                    query_error = str(exc)
        else:
            batch_size = 500
            if forward:
                cur_since_ts = since_ts
                cur_since_rowid = since_rowid
                while scanned_count < scan_limit and len(matched_entries) <= n:
                    cur_limit = min(batch_size, scan_limit - scanned_count)
                    try:
                        batch_rows = fast_query(conn, "group_msg_table", int(args.group),
                                                cur_since_ts, cur_since_rowid, cur_limit, until_ts=until_ts)
                    except Exception:
                        safe_rollback(conn)
                        fallback_used = True
                        batch_rows = paged_query(conn, "group_msg_table", int(args.group),
                                                 cur_since_ts, cur_since_rowid, cur_limit, until_ts=until_ts)
                    if not batch_rows:
                        break
                    scanned_count += len(batch_rows)
                    cur_since_ts = batch_rows[-1][1]
                    cur_since_rowid = batch_rows[-1][0]
                    last_scanned = (cur_since_ts, cur_since_rowid)
                    batch_entries = decode_entries(batch_rows, uid_map, gname)
                    for entry in batch_entries:
                        if match_filter(entry, keyword, sender):
                            matched_entries.append(entry)
                            if len(matched_entries) > n:
                                truncated = True
                                break
                    if len(batch_rows) < cur_limit:
                        break
            else:
                cur_until_ts = until_ts
                cur_until_rowid = until_rowid
                raw_matched = []
                while scanned_count < scan_limit and len(raw_matched) <= n:
                    cur_limit = min(batch_size, scan_limit - scanned_count)
                    try:
                        batch_rows = fast_query_desc(conn, "group_msg_table", int(args.group),
                                                     until_ts=cur_until_ts, until_rowid=cur_until_rowid, since_ts=since_ts, limit=cur_limit)
                    except sqlite3.DatabaseError as exc:
                        safe_rollback(conn)
                        query_error = str(exc)
                        break
                    if not batch_rows:
                        break
                    scanned_count += len(batch_rows)
                    cur_until_ts = batch_rows[-1][1]
                    cur_until_rowid = batch_rows[-1][0]
                    last_scanned = (cur_until_ts, cur_until_rowid)
                    batch_entries = decode_entries(batch_rows, uid_map, gname)
                    for entry in batch_entries:
                        if match_filter(entry, keyword, sender):
                            raw_matched.append(entry)
                            if len(raw_matched) > n:
                                truncated = True
                                break
                    if len(batch_rows) < cur_limit:
                        break
                raw_matched.reverse()
                matched_entries = raw_matched

            if scanned_count >= scan_limit and not truncated:
                hit_scan_limit = True

        next_cursor = None
        if truncated:
            matched_entries = matched_entries[:n] if forward else matched_entries[-n:]
            edge = matched_entries[-1] if forward else matched_entries[0]
            next_cursor = f"{'after' if forward else 'before'}:{edge['ts']}:{edge['rowid']}"
        elif hit_scan_limit and last_scanned:
            next_cursor = f"{'after' if forward else 'before'}:{last_scanned[0]}:{last_scanned[1]}"

        if query_error:
            print("__RESULT__" + json.dumps({
                "ok": False,
                "mode": "peek",
                "group": int(args.group),
                "error": "query_failed",
                "detail": f"读取群 {args.group} 时数据库查询失败：{query_error}。可尝试 force=true 重新解密。",
            }, ensure_ascii=False))
            return

        out_txt = None
        if matched_entries and getattr(args, "out_txt", ""):
            lines = []
            for e in matched_entries:
                for m in e["parsed"]:
                    lines.append(line_for(e, m))
            out_txt = atomic_write_text(args.out_txt, "\n".join(lines) + ("\n" if lines else ""))

        warning = None
        if not matched_entries and fallback_used:
            warning = "数据库有不可读区域，且没有在其余可读区域找到匹配消息。"
        elif hit_scan_limit:
            if not matched_entries:
                warning = f"已达到最大扫描行数保护上限({scan_limit})，在已扫描的范围内未找到匹配消息。"
            else:
                warning = f"已达到最大扫描行数保护上限({scan_limit})，在已扫描的范围内找到 {len(matched_entries)} 条匹配消息。"
        elif not matched_entries:
            warning = "所选群、时间范围或过滤条件下没有查到匹配消息。"

        result = {
            "ok": True,
            "mode": "peek",
            "group": int(args.group),
            "groupName": gname,
            "since": since_ts,
            "until": until_ts,
            "keyword": keyword or None,
            "sender": sender or None,
            "count": len(matched_entries),
            "nextCursor": next_cursor,
            "scanned": scanned_count,
            "truncated": truncated,
            "hitScanLimit": hit_scan_limit,
            "firstTs": matched_entries[0]["ts"] if matched_entries else None,
            "lastTs": matched_entries[-1]["ts"] if matched_entries else None,
            "firstAt": fmt_ts(matched_entries[0]["ts"]) if matched_entries else None,
            "lastAt": fmt_ts(matched_entries[-1]["ts"]) if matched_entries else None,
            "outTxt": out_txt,
            "fallback": fallback_used,
            "warning": warning,
            "sample": build_sample(matched_entries, 5),
            "parse": parse_report(matched_entries),
        }
        print("__RESULT__" + json.dumps(result, ensure_ascii=False))
    finally:
        conn.close()


def cmd_peek_timeline(args):
    """跨群只读时间线合订：把多个群在指定时间窗与过滤条件下的消息按时间戳升序合订输出，不改任何状态或游标。"""
    if not os.path.isfile(args.db):
        sys.exit(f"明文库不存在: {args.db}")
    raw_groups = [s.strip() for s in str(getattr(args, "groups", "") or "").split(",") if s.strip()]
    gids = []
    seen = set()
    for token in raw_groups:
        gid = int(token)
        if gid <= 0:
            raise ValueError(f"非法群号: {token}")
        if gid not in seen:
            seen.add(gid)
            gids.append(gid)
    if not gids:
        raise ValueError("groups 不能为空")

    n = bounded_count(args.n, PEEK_TIMELINE_LIMIT, "n")
    since_ts = parse_time_spec(getattr(args, "since", 0))
    until_ts = parse_time_spec(getattr(args, "until", 0), is_until=True)
    keyword = (getattr(args, "keyword", "") or "").strip()
    sender = (getattr(args, "sender", "") or "").strip()
    scan_limit = bounded_count(getattr(args, "scan_limit", 50000), MAX_ROWS_LIMIT, "scan-limit")

    if since_ts > 0 and until_ts > 0 and since_ts > until_ts:
        result = {
            "ok": True,
            "mode": "peek-timeline",
            "groups": [{"gid": gid, "name": load_group_name(args.group_db, gid), "count": 0, "scanned": 0} for gid in gids],
            "since": since_ts,
            "until": until_ts,
            "keyword": keyword or None,
            "sender": sender or None,
            "count": 0,
            "scanned": 0,
            "truncated": False,
            "hitScanLimit": False,
            "firstTs": None,
            "lastTs": None,
            "firstAt": None,
            "lastAt": None,
            "outTxt": None,
            "warning": "起始时间 (since) 大于截止时间 (until)，未查到消息。",
            "sample": [],
            "parse": {"parsed": 0, "unrecognized": 0, "empty": 0, "error": 0, "failures": []},
        }
        print("__RESULT__" + json.dumps(result, ensure_ascii=False))
        return

    conn = open_readonly(args.db)
    try:
        uid_map = load_uid_map(conn)
        has_filter = bool(keyword or sender)
        forward = since_ts > 0
        per_group_limit = max(1, min(MAX_ROWS_LIMIT, n + 1))
        per_group_scan_budget = max(500, scan_limit // max(1, len(gids)))
        all_entries = []
        per_group_stats = []
        group_errors = []
        total_scanned = 0
        hit_scan_limit = False

        for gid in gids:
            gname = load_group_name(args.group_db, gid)
            g_scanned = 0
            g_entries = []
            g_hit_limit = False
            g_error = None
            if not has_filter:
                if forward:
                    try:
                        try:
                            rows = fast_query(conn, "group_msg_table", gid, since_ts, 0, per_group_limit, until_ts=until_ts)
                        except Exception:
                            safe_rollback(conn)
                            rows = paged_query(conn, "group_msg_table", gid, since_ts, 0, per_group_limit, until_ts=until_ts)
                        g_scanned = len(rows)
                        g_entries = decode_entries(rows, uid_map, gname)
                    except Exception as exc:
                        safe_rollback(conn)
                        log(f"群 {gid} 正向扫描异常（{exc}），已跳过该群")
                        g_error = f"{gid}: {exc}"
                else:
                    if until_ts > 0:
                        try:
                            rows = fast_query_desc(conn, "group_msg_table", gid, until_ts=until_ts, until_rowid=0, since_ts=since_ts, limit=per_group_limit)
                        except Exception:
                            safe_rollback(conn)
                            try:
                                rows = paged_query_desc(conn, "group_msg_table", gid, until_ts=until_ts, until_rowid=0, since_ts=since_ts, limit=per_group_limit)
                            except Exception as exc:
                                log(f"群 {gid} 反向扫描异常（{exc}），已跳过该群")
                                g_error = f"{gid}: {exc}"
                                rows = []
                    else:
                        try:
                            rows, _ = peek_query(conn, gid, per_group_limit)
                        except Exception as exc:
                            safe_rollback(conn)
                            log(f"群 {gid} peek_query 异常（{exc}），已跳过该群")
                            g_error = f"{gid}: {exc}"
                            rows = []
                    g_scanned = len(rows)
                    rows.sort(key=lambda r: (r[1], r[0]))
                    g_entries = decode_entries(rows, uid_map, gname)
            else:
                batch_size = 500
                if forward:
                    cur_since_ts = since_ts
                    cur_since_rowid = 0
                    while g_scanned < per_group_scan_budget and len(g_entries) < per_group_limit:
                        cur_limit = min(batch_size, per_group_scan_budget - g_scanned)
                        try:
                            try:
                                batch_rows = fast_query(conn, "group_msg_table", gid, cur_since_ts, cur_since_rowid, cur_limit, until_ts=until_ts)
                            except Exception:
                                safe_rollback(conn)
                                batch_rows = paged_query(conn, "group_msg_table", gid, cur_since_ts, cur_since_rowid, cur_limit, until_ts=until_ts)
                        except Exception as exc:
                            safe_rollback(conn)
                            log(f"群 {gid} 过滤正向扫描异常（{exc}），已跳过该群剩余部分")
                            g_error = f"{gid}: {exc}"
                            break
                        if not batch_rows:
                            break
                        g_scanned += len(batch_rows)
                        cur_since_ts = batch_rows[-1][1]
                        cur_since_rowid = batch_rows[-1][0]
                        for entry in decode_entries(batch_rows, uid_map, gname):
                            if match_filter(entry, keyword, sender):
                                g_entries.append(entry)
                                if len(g_entries) >= per_group_limit:
                                    break
                        if len(batch_rows) < cur_limit:
                            break
                    if g_scanned >= per_group_scan_budget and len(g_entries) < per_group_limit:
                        g_hit_limit = True
                else:
                    cur_until_ts = until_ts
                    cur_until_rowid = 0
                    raw_matched = []
                    while g_scanned < per_group_scan_budget and len(raw_matched) < per_group_limit:
                        cur_limit = min(batch_size, per_group_scan_budget - g_scanned)
                        try:
                            batch_rows = fast_query_desc(conn, "group_msg_table", gid, until_ts=cur_until_ts, until_rowid=cur_until_rowid, since_ts=since_ts, limit=cur_limit)
                        except Exception:
                            safe_rollback(conn)
                            try:
                                batch_rows = paged_query_desc(conn, "group_msg_table", gid, until_ts=cur_until_ts, until_rowid=cur_until_rowid, since_ts=since_ts, limit=cur_limit)
                            except Exception as exc:
                                log(f"群 {gid} 过滤反向扫描异常（{exc}），已跳过该群剩余部分")
                                g_error = f"{gid}: {exc}"
                                break
                        if not batch_rows:
                            break
                        g_scanned += len(batch_rows)
                        cur_until_ts = batch_rows[-1][1]
                        cur_until_rowid = batch_rows[-1][0]
                        for entry in decode_entries(batch_rows, uid_map, gname):
                            if match_filter(entry, keyword, sender):
                                raw_matched.append(entry)
                                if len(raw_matched) >= per_group_limit:
                                    break
                        if len(batch_rows) < cur_limit:
                            break
                    if g_scanned >= per_group_scan_budget and len(raw_matched) < per_group_limit:
                        g_hit_limit = True
                    raw_matched.reverse()
                    g_entries = raw_matched

            if g_error:
                group_errors.append(g_error)
            total_scanned += g_scanned
            if g_hit_limit:
                hit_scan_limit = True
            for e in g_entries:
                e["gid"] = gid
                all_entries.append(e)
            per_group_stats.append({
                "gid": gid,
                "name": gname,
                "matchedRaw": len(g_entries),
                "scanned": g_scanned,
                "hitScanLimit": g_hit_limit,
                **({"error": g_error} if g_error else {}),
            })

        if len(group_errors) == len(gids) and not all_entries:
            print("__RESULT__" + json.dumps({
                "ok": False,
                "mode": "peek-timeline",
                "groups": per_group_stats,
                "error": "query_failed",
                "detail": f"跨群查询全部失败：{'；'.join(group_errors)}",
            }, ensure_ascii=False))
            return

        all_entries.sort(key=lambda e: (e["ts"], int(e["gid"]), int(e["rowid"])))
        truncated = len(all_entries) > n
        if truncated:
            all_entries = all_entries[:n] if forward else all_entries[-n:]

        kept_by_gid = {}
        for e in all_entries:
            kept_by_gid[e["gid"]] = kept_by_gid.get(e["gid"], 0) + 1
        for stat in per_group_stats:
            stat["count"] = kept_by_gid.get(stat["gid"], 0)

        out_txt = None
        if all_entries and getattr(args, "out_txt", ""):
            lines = []
            for e in all_entries:
                for m in e["parsed"]:
                    lines.append(line_for(e, m))
            out_txt = atomic_write_text(args.out_txt, "\n".join(lines) + ("\n" if lines else ""))

        warning = None
        if group_errors:
            warning = f"部分群查询异常已跳过（{'；'.join(group_errors)}）。"
        elif not all_entries and hit_scan_limit:
            warning = f"各群累计扫描 {total_scanned} 条后达到扫描保护上限，在已扫描范围内未找到匹配消息。"
        elif not all_entries:
            warning = "所选群、时间范围或过滤条件下没有查到匹配消息。"

        result = {
            "ok": True,
            "mode": "peek-timeline",
            "groups": per_group_stats,
            "since": since_ts,
            "until": until_ts,
            "keyword": keyword or None,
            "sender": sender or None,
            "count": len(all_entries),
            "scanned": total_scanned,
            "truncated": truncated,
            "hitScanLimit": hit_scan_limit,
            "firstTs": all_entries[0]["ts"] if all_entries else None,
            "lastTs": all_entries[-1]["ts"] if all_entries else None,
            "firstAt": fmt_ts(all_entries[0]["ts"]) if all_entries else None,
            "lastAt": fmt_ts(all_entries[-1]["ts"]) if all_entries else None,
            "outTxt": out_txt,
            "warning": warning,
            "sample": build_sample(all_entries, 8),
            "parse": parse_report(all_entries),
        }
        print("__RESULT__" + json.dumps(result, ensure_ascii=False))
    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("check", cmd_check), ("pull", cmd_pull)):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True)
        p.add_argument("--group", required=True)
        p.add_argument("--since", required=True)
        p.add_argument("--since-rowid", default=0)
        p.add_argument("--max", default=20000)
        p.add_argument("--group-db", default="")
        p.add_argument("--out-jsonl", default="")
        p.add_argument("--out-txt", default="")
        p.set_defaults(fn=fn)
    p = sub.add_parser("tail")
    p.add_argument("--db", required=True)
    p.add_argument("--group", required=True)
    p.add_argument("--n", required=True)
    p.add_argument("--group-db", default="")
    p.add_argument("--out-jsonl", default="")
    p.add_argument("--out-txt", default="")
    p.set_defaults(fn=cmd_tail)
    p = sub.add_parser("pullall")
    p.add_argument("--db", required=True)
    p.add_argument("--groups", required=True)
    p.add_argument("--group-db", default="")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--max", default=20000)
    p.add_argument("--total-max", default=None)
    p.set_defaults(fn=cmd_pullall)
    p = sub.add_parser("peek")
    p.add_argument("--db", required=True)
    p.add_argument("--group", required=True)
    p.add_argument("--n", required=True)
    p.add_argument("--since", default=0)
    p.add_argument("--cursor", default="")
    p.add_argument("--until", default=0)
    p.add_argument("--keyword", default="")
    p.add_argument("--sender", default="")
    p.add_argument("--scan-limit", default=20000)
    p.add_argument("--group-db", default="")
    p.add_argument("--out-txt", default="")
    p.set_defaults(fn=cmd_peek)
    p = sub.add_parser("peek-timeline")
    p.add_argument("--db", required=True)
    p.add_argument("--groups", required=True)
    p.add_argument("--n", default=1000)
    p.add_argument("--since", default=0)
    p.add_argument("--until", default=0)
    p.add_argument("--keyword", default="")
    p.add_argument("--sender", default="")
    p.add_argument("--scan-limit", default=50000)
    p.add_argument("--group-db", default="")
    p.add_argument("--out-txt", default="")
    p.set_defaults(fn=cmd_peek_timeline)
    p = sub.add_parser("names")
    p.add_argument("--group-db", default="")
    p.add_argument("--groups", required=True)
    p.set_defaults(fn=cmd_names)
    p = sub.add_parser("verify")
    p.add_argument("--db", required=True)
    p.add_argument("--table", default="")
    p.set_defaults(fn=cmd_verify)
    args = ap.parse_args()
    try:
        args.fn(args)
    except BrokenPipeError:
        pass


if __name__ == "__main__":
    main()
