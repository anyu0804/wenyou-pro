# -*- coding: utf-8 -*-
"""Zero-dependency read-only SQLite VFS for on-demand page-level NTQQ decryption.

Implements NTQQ SQLCipher page decryption (matching assets/qq_decrypt.cjs):
- 1024-byte NTQQ header before page 1
- 4096-byte page size, 16-byte salt (page 1), 48-byte page reserve (IV + HMAC + pad)
- AES-256-CBC per-page random-access decryption
- In-memory WAL committed-frame parsing & overlay (no disk copy of main DB)
- Anti-torn-read consistency checks with bounded exponential-backoff retries

Crypto backends (auto-selected, zero third-party deps on Windows):
  1. win32-bcrypt (Windows CNG bcrypt.dll, hardware AES-NI, fastest cold start)
  2. cryptography (cryptography.hazmat)
  3. Cryptodome / Crypto (pycryptodomex / pycryptodome)
"""
from __future__ import annotations

import contextlib
import ctypes
import ctypes.util
import json
import os
import pathlib
import sqlite3
import struct
import sys
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

EXT_HEADER = 1024
PAGE_SIZE = 4096
SALT_SIZE = 16
RESERVE = 48  # IV(16) + HMAC_SHA1(20) + pad(12)
WAL_HEADER_SIZE = 32
WAL_FRAME_HEADER_SIZE = 24
MAGIC = b"SQLite format 3\x00"

DEFAULT_MAX_WAL_BYTES = 512 * 1024 * 1024

SQLITE_OK = 0
SQLITE_ERROR = 1
SQLITE_NOTFOUND = 12
SQLITE_CANTOPEN = 14
SQLITE_IOERR_READ = 266
SQLITE_IOERR_SHORT_READ = 522
SQLITE_IOCAP_IMMUTABLE = 0x00002000
SQLITE_OPEN_READONLY = 0x00000001


class TornSnapshotError(RuntimeError):
    """Raised when the encrypted source DB changes mid-read or WAL is resetting."""


def _max_wal_bytes() -> int:
    raw = os.environ.get("WENYOU_MAX_WAL_BYTES", "").strip()
    if raw:
        try:
            val = int(raw)
            if val > 0:
                return val
        except ValueError:
            pass
    return DEFAULT_MAX_WAL_BYTES


# ---------- AES-256-CBC Backends ----------

class _BcryptAesCbc:
    """Zero-dependency Windows CNG AES-256-CBC decryptor."""

    def __init__(self, key_bytes: bytes):
        if sys.platform != "win32":
            raise OSError("win32-bcrypt is only available on Windows")
        lib = ctypes.WinDLL("bcrypt.dll")
        lib.BCryptOpenAlgorithmProvider.argtypes = [
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.c_wchar_p,
            ctypes.c_wchar_p,
            ctypes.c_ulong,
        ]
        lib.BCryptOpenAlgorithmProvider.restype = ctypes.c_long

        lib.BCryptSetProperty.argtypes = [
            ctypes.c_void_p,
            ctypes.c_wchar_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_ulong,
        ]
        lib.BCryptSetProperty.restype = ctypes.c_long

        lib.BCryptGenerateSymmetricKey.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_ulong,
        ]
        lib.BCryptGenerateSymmetricKey.restype = ctypes.c_long

        lib.BCryptDecrypt.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.c_ulong,
        ]
        lib.BCryptDecrypt.restype = ctypes.c_long

        lib.BCryptDestroyKey.argtypes = [ctypes.c_void_p]
        lib.BCryptDestroyKey.restype = ctypes.c_long
        lib.BCryptCloseAlgorithmProvider.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.BCryptCloseAlgorithmProvider.restype = ctypes.c_long

        self._lib = lib
        self._h_alg = ctypes.c_void_p()
        self._h_key = ctypes.c_void_p()

        status = lib.BCryptOpenAlgorithmProvider(ctypes.byref(self._h_alg), "AES", None, 0)
        if status != 0:
            raise OSError(f"BCryptOpenAlgorithmProvider failed: 0x{status & 0xFFFFFFFF:08x}")
        try:
            mode = ctypes.create_unicode_buffer("ChainingModeCBC")
            status = lib.BCryptSetProperty(
                self._h_alg, "ChainingMode", mode, ctypes.sizeof(mode), 0
            )
            if status != 0:
                raise OSError(f"BCryptSetProperty(CBC) failed: 0x{status & 0xFFFFFFFF:08x}")
            key_buf = (ctypes.c_ubyte * len(key_bytes)).from_buffer_copy(key_bytes)
            status = lib.BCryptGenerateSymmetricKey(
                self._h_alg, ctypes.byref(self._h_key), None, 0, key_buf, len(key_bytes), 0
            )
            if status != 0:
                raise OSError(f"BCryptGenerateSymmetricKey failed: 0x{status & 0xFFFFFFFF:08x}")
        except Exception:
            self.close()
            raise

    def decrypt(self, ciphertext: bytes, iv: bytes) -> bytes:
        ct_len = len(ciphertext)
        iv_len = len(iv)
        ct_buf = (ctypes.c_ubyte * ct_len).from_buffer_copy(ciphertext)
        iv_buf = (ctypes.c_ubyte * iv_len).from_buffer_copy(iv)
        out_buf = ctypes.create_string_buffer(ct_len)
        out_len = ctypes.c_ulong(0)
        status = self._lib.BCryptDecrypt(
            self._h_key,
            ct_buf,
            ct_len,
            None,
            iv_buf,
            iv_len,
            out_buf,
            ct_len,
            ctypes.byref(out_len),
            0,
        )
        if status != 0:
            raise OSError(f"BCryptDecrypt failed: 0x{status & 0xFFFFFFFF:08x}")
        return out_buf.raw[: out_len.value]

    def close(self) -> None:
        if self._h_key:
            self._lib.BCryptDestroyKey(self._h_key)
            self._h_key = ctypes.c_void_p()
        if self._h_alg:
            self._lib.BCryptCloseAlgorithmProvider(self._h_alg, 0)
            self._h_alg = ctypes.c_void_p()


def make_aes_decryptor(
    key_bytes: bytes, preferred_backend: str = ""
) -> tuple[str, Callable[[bytes, bytes], bytes], Callable[[], None]]:
    """Return (backend_name, decrypt_fn, close_fn) for AES-256-CBC without padding."""
    pref = (preferred_backend or os.environ.get("WENYOU_VFS_CRYPTO_BACKEND", "")).strip().lower()
    if pref == "bcrypt":
        pref = "win32-bcrypt"

    def _try_bcrypt():
        cng = _BcryptAesCbc(key_bytes)
        return "win32-bcrypt", cng.decrypt, cng.close

    def _try_cryptography():
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        alg = algorithms.AES(key_bytes)

        def _dec(ct: bytes, iv: bytes) -> bytes:
            dec = Cipher(alg, modes.CBC(iv)).decryptor()
            return dec.update(ct) + dec.finalize()

        return "cryptography", _dec, lambda: None

    def _try_cryptodome():
        try:
            from Cryptodome.Cipher import AES
        except ImportError:
            from Crypto.Cipher import AES  # type: ignore

        def _dec(ct: bytes, iv: bytes) -> bytes:
            return AES.new(key_bytes, AES.MODE_CBC, iv).decrypt(ct)

        return "Cryptodome", _dec, lambda: None

    order = [
        ("win32-bcrypt", _try_bcrypt),
        ("cryptography", _try_cryptography),
        ("cryptodome", _try_cryptodome),
    ]
    if pref:
        order = [item for item in order if item[0] == pref]
        if not order:
            raise ValueError(f"Unsupported crypto backend: {pref}")

    last_err: Exception | None = None
    for _name, factory in order:
        try:
            return factory()
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"No usable AES-256-CBC backend available: {last_err}") from last_err


# ---------- WAL Parsing (exact parity with assets/qq_decrypt.cjs) ----------

def wal_checksum(
    data: bytes | memoryview,
    start: int,
    end: int,
    big_endian: bool,
    s0: int = 0,
    s1: int = 0,
) -> tuple[int, int]:
    if (end - start) % 8 != 0:
        raise ValueError(f"WAL checksum input length must be multiple of 8: {end - start}")
    unpack = struct.Struct(">II" if big_endian else "<II").unpack_from
    for off in range(start, end, 8):
        x0, x1 = unpack(data, off)
        s0 = (s0 + x0 + s1) & 0xFFFFFFFF
        s1 = (s1 + x1 + s0) & 0xFFFFFFFF
    return s0, s1


def parse_committed_wal(data: bytes) -> dict[str, Any]:
    """Parse SQLite WAL bytes and return latest committed encrypted page frames."""
    if not data:
        return {
            "valid_frames": 0,
            "committed_frames": 0,
            "db_size_pages": 0,
            "latest_pages": {},
            "salt": (0, 0),
        }
    if len(data) < WAL_HEADER_SIZE:
        raise TornSnapshotError(f"WAL header incomplete: {len(data)} bytes")
    magic, _fmt, page_size, _ckpt, salt1, salt2, cksum1, cksum2 = struct.unpack_from(
        ">IIIIIIII", data, 0
    )
    if magic not in (0x377F0682, 0x377F0683):
        raise TornSnapshotError(f"Invalid WAL magic: 0x{magic:08x}")
    if page_size != PAGE_SIZE:
        raise ValueError(f"Unsupported WAL page size: {page_size} (expected {PAGE_SIZE})")
    big_endian = magic == 0x377F0683
    h0, h1 = wal_checksum(data, 0, 24, big_endian)
    if h0 != cksum1 or h1 != cksum2:
        raise TornSnapshotError("WAL header checksum mismatch (possibly resetting)")

    s0, s1 = h0, h1
    frame_size = WAL_FRAME_HEADER_SIZE + PAGE_SIZE
    frames: list[tuple[int, int]] = []
    last_commit_idx = -1
    db_size_pages = 0
    mv = memoryview(data)
    for off in range(WAL_HEADER_SIZE, len(data) - frame_size + 1, frame_size):
        page_no, commit_pages, fs1, fs2, fc1, fc2 = struct.unpack_from(">IIIIII", data, off)
        if fs1 != salt1 or fs2 != salt2:
            break
        n0, n1 = wal_checksum(mv, off, off + 8, big_endian, s0, s1)
        n0, n1 = wal_checksum(
            mv, off + WAL_FRAME_HEADER_SIZE, off + frame_size, big_endian, n0, n1
        )
        if n0 != fc1 or n1 != fc2:
            break
        s0, s1 = n0, n1
        if page_no < 1:
            raise TornSnapshotError("WAL frame contains illegal page number 0")
        frames.append((page_no, off + WAL_FRAME_HEADER_SIZE))
        if commit_pages > 0:
            last_commit_idx = len(frames) - 1
            db_size_pages = commit_pages

    latest_pages: dict[int, bytes] = {}
    if last_commit_idx >= 0:
        for page_no, page_off in frames[: last_commit_idx + 1]:
            latest_pages[page_no] = data[page_off : page_off + PAGE_SIZE]
    return {
        "valid_frames": len(frames),
        "committed_frames": last_commit_idx + 1,
        "db_size_pages": db_size_pages,
        "latest_pages": latest_pages,
        "salt": (salt1, salt2),
    }


def load_key_map(key_map_path: str) -> dict[str, str]:
    with open(key_map_path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    km = raw.get("key_map") if isinstance(raw, dict) else None
    if not isinstance(km, dict):
        raise ValueError(f"Invalid key_map.json structure: {key_map_path}")
    return {str(k).lower(): str(v) for k, v in km.items()}


def read_ntqq_salt_hex(db_path: str) -> str:
    """Read the 16-byte encryption salt at offset EXT_HEADER without decrypting."""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    fd = os.open(db_path, flags)
    try:
        st = os.fstat(fd)
        if st.st_size < EXT_HEADER + PAGE_SIZE:
            raise ValueError(f"File too small to be NTQQ encrypted DB: {st.st_size} bytes")
        os.lseek(fd, EXT_HEADER, os.SEEK_SET)
        buf = bytearray()
        while len(buf) < SALT_SIZE:
            chunk = os.read(fd, SALT_SIZE - len(buf))
            if not chunk:
                break
            buf.extend(chunk)
        if len(buf) != SALT_SIZE:
            raise EOFError("Failed to read 16-byte NTQQ salt")
        return bytes(buf).hex()
    finally:
        os.close(fd)


def stat_file_snapshot(path: str) -> dict[str, Any]:
    """Return normalized file snapshot dict for freshness comparison."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return {"exists": False, "size": 0, "mtimeNs": 0, "mtimeMs": 0.0}
    return {
        "exists": True,
        "size": int(st.st_size),
        "mtimeNs": int(st.st_mtime_ns),
        "mtimeMs": st.st_mtime_ns / 1_000_000.0,
    }


# ---------- On-Demand Encrypted Page Reader ----------

class NtqqEncryptedFile:
    """Read-only random-access page decryptor for a single NTQQ DB + optional WAL."""

    def __init__(
        self,
        db_path: str,
        key_map: dict[str, str],
        preferred_backend: str = "",
        cache_pages: int = 1024,
    ):
        self.db_path = os.path.abspath(db_path)
        self.wal_path = self.db_path + "-wal"
        open_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        self.fd: int | None = os.open(self.db_path, open_flags)
        self._close_backend: Callable[[], None] | None = None
        try:
            st = os.fstat(self.fd)
            self.main_stat_before = (int(st.st_size), int(st.st_mtime_ns))
            if st.st_size < EXT_HEADER + PAGE_SIZE:
                raise ValueError(
                    f"File too small or not an NTQQ encrypted DB: {st.st_size} bytes"
                )
            self.salt = self._pread_exact(EXT_HEADER, SALT_SIZE)
            self.salt_hex = self.salt.hex()
            key_hex = key_map.get(self.salt_hex)
            if not key_hex:
                raise KeyError(f"key_map 中未找到盐 {self.salt_hex} 对应的密钥")
            self.backend_name, self._decrypt_raw, self._close_backend = make_aes_decryptor(
                bytes.fromhex(key_hex), preferred_backend=preferred_backend
            )
            self.main_pages = (st.st_size - EXT_HEADER) // PAGE_SIZE

            # Read WAL snapshot into memory (typically <10 MB)
            self.wal_stat_before: tuple[int, int] | None = None
            wal_bytes = b""
            max_wal = _max_wal_bytes()
            try:
                wfd = os.open(self.wal_path, open_flags)
            except FileNotFoundError:
                wfd = None
            if wfd is not None:
                try:
                    wst = os.fstat(wfd)
                    if wst.st_size > max_wal:
                        raise ValueError(
                            f"WAL 过大（{wst.st_size} 字节，保护上限 {max_wal}）；请正常退出 QQ 让其 checkpoint 后重试"
                        )
                    self.wal_stat_before = (int(wst.st_size), int(wst.st_mtime_ns))
                    chunks: list[bytes] = []
                    remaining = wst.st_size
                    while remaining > 0:
                        chunk = os.read(wfd, min(remaining, 1024 * 1024))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        remaining -= len(chunk)
                    wal_bytes = b"".join(chunks)
                finally:
                    os.close(wfd)

            # Verify main DB did not checkpoint while we were reading WAL
            st_mid = os.fstat(self.fd)
            if (int(st_mid.st_size), int(st_mid.st_mtime_ns)) != self.main_stat_before:
                raise TornSnapshotError("QQ 主库在快照 WAL 期间发生变化")

            self.wal_info = parse_committed_wal(wal_bytes)
            wal_page1 = self.wal_info["latest_pages"].get(1)
            if wal_page1 is not None and wal_page1[:SALT_SIZE] != self.salt:
                raise TornSnapshotError("WAL 第 1 页的盐与主库不一致，可能发生了数据库轮换")

            if self.wal_info["committed_frames"] > 0 and self.wal_info["db_size_pages"] > 0:
                self.total_pages = int(self.wal_info["db_size_pages"])
            else:
                self.total_pages = int(self.main_pages)
            self.virtual_size = self.total_pages * PAGE_SIZE
            self._cache: OrderedDict[int, bytes] = OrderedDict()
            self._cache_limit = max(64, int(cache_pages))
            self.stats = {
                "pages_decrypted": 0,
                "pages_from_wal": 0,
                "pages_from_main": 0,
                "cache_hits": 0,
                "xread_calls": 0,
            }
        except Exception:
            self.close()
            raise

    def _pread_exact(self, offset: int, length: int) -> bytes:
        assert self.fd is not None
        os.lseek(self.fd, offset, os.SEEK_SET)
        buf = bytearray()
        while len(buf) < length:
            chunk = os.read(self.fd, length - len(buf))
            if not chunk:
                break
            buf.extend(chunk)
        if len(buf) != length:
            raise EOFError(f"读取文件时提前结束：需要 {length} 字节，实际 {len(buf)} 字节")
        return bytes(buf)

    def _decrypt_page(self, enc_page: bytes, page_no: int) -> bytes:
        out = bytearray(PAGE_SIZE)
        if page_no == 1:
            if enc_page[:SALT_SIZE] != self.salt:
                raise TornSnapshotError("第 1 页盐与主库不一致")
            out[0:SALT_SIZE] = MAGIC
            data = enc_page[SALT_SIZE:]
            enc_len = len(data) - RESERVE
            if enc_len <= 0 or enc_len % 16 != 0:
                raise ValueError(f"加密页长度非法：{len(enc_page)}")
            iv = data[enc_len : enc_len + SALT_SIZE]
            plain = self._decrypt_raw(data[:enc_len], iv)
            out[SALT_SIZE : SALT_SIZE + enc_len] = plain
        else:
            enc_len = len(enc_page) - RESERVE
            if enc_len <= 0 or enc_len % 16 != 0:
                raise ValueError(f"加密页长度非法：{len(enc_page)}")
            iv = enc_page[enc_len : enc_len + SALT_SIZE]
            plain = self._decrypt_raw(enc_page[:enc_len], iv)
            out[0:enc_len] = plain
        return bytes(out)

    def get_page(self, page_no: int) -> bytes:
        cached = self._cache.get(page_no)
        if cached is not None:
            self._cache.move_to_end(page_no)
            self.stats["cache_hits"] += 1
            return cached
        wal_page = self.wal_info["latest_pages"].get(page_no)
        if wal_page is not None:
            plain = self._decrypt_page(wal_page, page_no)
            self.stats["pages_from_wal"] += 1
        else:
            if page_no < 1 or page_no > self.main_pages:
                raise TornSnapshotError(
                    f"请求的页号 {page_no} 超出主库页数 {self.main_pages} 且不在 WAL 快照中"
                )
            enc = self._pread_exact(EXT_HEADER + (page_no - 1) * PAGE_SIZE, PAGE_SIZE)
            plain = self._decrypt_page(enc, page_no)
            self.stats["pages_from_main"] += 1
        self.stats["pages_decrypted"] += 1
        self._cache[page_no] = plain
        if len(self._cache) > self._cache_limit:
            self._cache.popitem(last=False)
        return plain

    def read_range(self, offset: int, amount: int) -> tuple[bytes, bool]:
        self.stats["xread_calls"] += 1
        if amount <= 0:
            return b"", False
        if offset >= self.virtual_size:
            return b"\x00" * amount, True
        avail = min(amount, self.virtual_size - offset)
        short = avail < amount
        out = bytearray(amount)
        pos = 0
        cur = offset
        while pos < avail:
            page_no = (cur // PAGE_SIZE) + 1
            page_off = cur % PAGE_SIZE
            take = min(PAGE_SIZE - page_off, avail - pos)
            page = self.get_page(page_no)
            out[pos : pos + take] = page[page_off : page_off + take]
            pos += take
            cur += take
        return bytes(out), short

    def check_consistent(self) -> bool:
        """Verify main DB did not mutate during our query.

        Because WAL is captured completely into memory before queries start (and
        verified against main_stat_before), subsequent appends to the on-disk WAL
        do not invalidate our in-memory WAL snapshot as long as main DB was not
        checkpointed/rewritten.
        """
        if self.fd is None:
            return False
        st = os.fstat(self.fd)
        return (int(st.st_size), int(st.st_mtime_ns)) == self.main_stat_before

    def snapshot_meta(self) -> dict[str, Any]:
        return {
            "saltHex": self.salt_hex,
            "backend": self.backend_name,
            "totalPages": self.total_pages,
            "main": {
                "size": self.main_stat_before[0],
                "mtimeNs": self.main_stat_before[1],
                "mtimeMs": self.main_stat_before[1] / 1_000_000.0,
            },
            "wal": {
                "exists": self.wal_stat_before is not None,
                "size": self.wal_stat_before[0] if self.wal_stat_before else 0,
                "mtimeNs": self.wal_stat_before[1] if self.wal_stat_before else 0,
                "mtimeMs": (self.wal_stat_before[1] / 1_000_000.0) if self.wal_stat_before else 0.0,
                "validFrames": int(self.wal_info["valid_frames"]),
                "committedFrames": int(self.wal_info["committed_frames"]),
                "dbSizePages": int(self.wal_info["db_size_pages"]),
            },
            "stats": dict(self.stats),
        }

    def close(self) -> None:
        if self.fd is not None:
            try:
                os.close(self.fd)
            finally:
                self.fd = None
        if self._close_backend is not None:
            try:
                self._close_backend()
            finally:
                self._close_backend = None


# ---------- ctypes SQLite VFS ABI (version 1) ----------

class _Sqlite3File(ctypes.Structure):
    _fields_ = [
        ("pMethods", ctypes.c_void_p),
        ("handle_id", ctypes.c_int64),
    ]


_X_CLOSE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File))
_X_READ = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_void_p, ctypes.c_int, ctypes.c_int64
)
_X_WRITE = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_void_p, ctypes.c_int, ctypes.c_int64
)
_X_TRUNCATE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_int64)
_X_SYNC = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_int)
_X_FILESIZE = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.POINTER(ctypes.c_int64)
)
_X_LOCK = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_int)
_X_UNLOCK = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_int)
_X_CHECK_RESERVED = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.POINTER(ctypes.c_int)
)
_X_FILECONTROL = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3File), ctypes.c_int, ctypes.c_void_p
)
_X_SECTORSIZE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File))
_X_DEVCHARS = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3File))


class _Sqlite3IoMethods(ctypes.Structure):
    _fields_ = [
        ("iVersion", ctypes.c_int),
        ("xClose", _X_CLOSE),
        ("xRead", _X_READ),
        ("xWrite", _X_WRITE),
        ("xTruncate", _X_TRUNCATE),
        ("xSync", _X_SYNC),
        ("xFileSize", _X_FILESIZE),
        ("xLock", _X_LOCK),
        ("xUnlock", _X_UNLOCK),
        ("xCheckReservedLock", _X_CHECK_RESERVED),
        ("xFileControl", _X_FILECONTROL),
        ("xSectorSize", _X_SECTORSIZE),
        ("xDeviceCharacteristics", _X_DEVCHARS),
    ]


class _Sqlite3Vfs(ctypes.Structure):
    pass


_X_OPEN = ctypes.CFUNCTYPE(
    ctypes.c_int,
    ctypes.POINTER(_Sqlite3Vfs),
    ctypes.c_char_p,
    ctypes.POINTER(_Sqlite3File),
    ctypes.c_int,
    ctypes.POINTER(ctypes.c_int),
)
_X_DELETE = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3Vfs), ctypes.c_char_p, ctypes.c_int)
_X_ACCESS = ctypes.CFUNCTYPE(
    ctypes.c_int,
    ctypes.POINTER(_Sqlite3Vfs),
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.POINTER(ctypes.c_int),
)
_X_FULLPATHNAME = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3Vfs), ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p
)
_X_RANDOMNESS = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3Vfs), ctypes.c_int, ctypes.c_void_p
)
_X_SLEEP = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Sqlite3Vfs), ctypes.c_int)
_X_CURRENTTIME = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3Vfs), ctypes.POINTER(ctypes.c_double)
)
_X_GETLASTERROR = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.POINTER(_Sqlite3Vfs), ctypes.c_int, ctypes.c_void_p
)

_Sqlite3Vfs._fields_ = [
    ("iVersion", ctypes.c_int),
    ("szOsFile", ctypes.c_int),
    ("mxPathname", ctypes.c_int),
    ("pNext", ctypes.POINTER(_Sqlite3Vfs)),
    ("zName", ctypes.c_char_p),
    ("pAppData", ctypes.c_void_p),
    ("xOpen", _X_OPEN),
    ("xDelete", _X_DELETE),
    ("xAccess", _X_ACCESS),
    ("xFullPathname", _X_FULLPATHNAME),
    ("xDlOpen", ctypes.c_void_p),
    ("xDlError", ctypes.c_void_p),
    ("xDlSym", ctypes.c_void_p),
    ("xDlClose", ctypes.c_void_p),
    ("xRandomness", _X_RANDOMNESS),
    ("xSleep", _X_SLEEP),
    ("xCurrentTime", _X_CURRENTTIME),
    ("xGetLastError", _X_GETLASTERROR),
]


def _load_sqlite3_cdll() -> ctypes.CDLL:
    """Resolve the exact sqlite3 shared library already loaded by Python's _sqlite3."""
    sqlite3.connect(":memory:").close()
    if sys.platform == "win32":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
        kernel32.GetModuleHandleW.restype = ctypes.c_void_p
        for name in ("sqlite3.dll", "sqlite3"):
            hmod = kernel32.GetModuleHandleW(name)
            if hmod:
                return ctypes.CDLL(name, handle=hmod)
        for candidate in (
            os.path.join(os.path.dirname(sys.executable), "DLLs", "sqlite3.dll"),
            os.path.join(os.path.dirname(sys.executable), "sqlite3.dll"),
        ):
            if os.path.exists(candidate):
                return ctypes.CDLL(candidate)
        found = ctypes.util.find_library("sqlite3")
        if found:
            return ctypes.CDLL(found)
        raise RuntimeError("Unable to locate sqlite3.dll loaded by Python")
    for candidate in (None, ctypes.util.find_library("sqlite3"), "libsqlite3.so.0", "libsqlite3.dylib"):
        if candidate is None:
            lib = ctypes.CDLL(None)
            if hasattr(lib, "sqlite3_vfs_register"):
                return lib
        elif candidate:
            try:
                lib = ctypes.CDLL(candidate)
                if hasattr(lib, "sqlite3_vfs_register"):
                    return lib
            except OSError:
                continue
    raise RuntimeError("Unable to locate libsqlite3 for VFS registration")


_VFS_SEQ_LOCK = threading.Lock()
_VFS_SEQ = 0


def _next_vfs_name() -> str:
    global _VFS_SEQ
    with _VFS_SEQ_LOCK:
        _VFS_SEQ += 1
        return f"ntqq_ro_{os.getpid()}_{_VFS_SEQ}"


class NtqqReadonlyVfs:
    """Registered read-only SQLite VFS instance for NTQQ encrypted databases."""

    def __init__(
        self,
        key_map: dict[str, str],
        vfs_name: str | None = None,
        preferred_backend: str = "",
        cache_pages: int = 1024,
    ):
        self.key_map = key_map
        self.vfs_name_str = vfs_name or _next_vfs_name()
        self.vfs_name = self.vfs_name_str.encode("ascii")
        self.preferred_backend = preferred_backend
        self.cache_pages = cache_pages
        self._handles: dict[int, NtqqEncryptedFile] = {}
        self._next_id = 1
        self._registered = False
        self.last_error: Exception | None = None
        self.active_file: NtqqEncryptedFile | None = None
        self.closed_snapshots: list[dict[str, Any]] = []

        self._lib = _load_sqlite3_cdll()
        self._lib.sqlite3_vfs_register.argtypes = [ctypes.POINTER(_Sqlite3Vfs), ctypes.c_int]
        self._lib.sqlite3_vfs_register.restype = ctypes.c_int
        self._lib.sqlite3_vfs_unregister.argtypes = [ctypes.POINTER(_Sqlite3Vfs)]
        self._lib.sqlite3_vfs_unregister.restype = ctypes.c_int

        self._io_methods = _Sqlite3IoMethods(
            iVersion=1,
            xClose=_X_CLOSE(self._x_close),
            xRead=_X_READ(self._x_read),
            xWrite=_X_WRITE(lambda f, b, n, o: SQLITE_ERROR),
            xTruncate=_X_TRUNCATE(lambda f, s: SQLITE_ERROR),
            xSync=_X_SYNC(lambda f, fl: SQLITE_OK),
            xFileSize=_X_FILESIZE(self._x_file_size),
            xLock=_X_LOCK(lambda f, l: SQLITE_OK),
            xUnlock=_X_UNLOCK(lambda f, l: SQLITE_OK),
            xCheckReservedLock=_X_CHECK_RESERVED(self._x_check_reserved),
            xFileControl=_X_FILECONTROL(lambda f, op, arg: SQLITE_NOTFOUND),
            xSectorSize=_X_SECTORSIZE(lambda f: PAGE_SIZE),
            xDeviceCharacteristics=_X_DEVCHARS(lambda f: SQLITE_IOCAP_IMMUTABLE),
        )
        self._vfs = _Sqlite3Vfs(
            iVersion=1,
            szOsFile=ctypes.sizeof(_Sqlite3File),
            mxPathname=2048,
            pNext=None,
            zName=self.vfs_name,
            pAppData=None,
            xOpen=_X_OPEN(self._x_open),
            xDelete=_X_DELETE(lambda v, z, s: SQLITE_ERROR),
            xAccess=_X_ACCESS(self._x_access),
            xFullPathname=_X_FULLPATHNAME(self._x_full_pathname),
            xDlOpen=None,
            xDlError=None,
            xDlSym=None,
            xDlClose=None,
            xRandomness=_X_RANDOMNESS(self._x_randomness),
            xSleep=_X_SLEEP(self._x_sleep),
            xCurrentTime=_X_CURRENTTIME(self._x_current_time),
            xGetLastError=_X_GETLASTERROR(lambda v, n, b: 0),
        )
        rc = self._lib.sqlite3_vfs_register(ctypes.byref(self._vfs), 0)
        if rc != SQLITE_OK:
            raise RuntimeError(f"sqlite3_vfs_register failed with rc={rc}")
        self._registered = True

    def _normalize_path(self, raw_bytes: bytes) -> str:
        raw = raw_bytes.decode("utf-8")
        if sys.platform == "win32" and len(raw) >= 3 and raw[0] == "/" and raw[2] == ":":
            raw = raw[1:]
        return os.path.abspath(raw)

    def _x_open(self, _p_vfs, z_name, p_file, _flags, p_out_flags) -> int:
        try:
            if not z_name:
                return SQLITE_CANTOPEN
            db_path = self._normalize_path(z_name)
            obj = NtqqEncryptedFile(
                db_path,
                self.key_map,
                preferred_backend=self.preferred_backend,
                cache_pages=self.cache_pages,
            )
            hid = self._next_id
            self._next_id += 1
            self._handles[hid] = obj
            self.active_file = obj
            p_file.contents.pMethods = ctypes.addressof(self._io_methods)
            p_file.contents.handle_id = hid
            if p_out_flags:
                p_out_flags.contents.value = SQLITE_OPEN_READONLY
            return SQLITE_OK
        except Exception as exc:
            self.last_error = exc
            return SQLITE_CANTOPEN

    def _x_close(self, p_file) -> int:
        hid = p_file.contents.handle_id
        obj = self._handles.pop(hid, None)
        if obj is not None:
            try:
                consistent = obj.check_consistent()
                meta = obj.snapshot_meta()
                meta["consistent"] = consistent
                self.closed_snapshots.append(meta)
            except Exception as exc:
                self.last_error = exc
            finally:
                if self.active_file is obj:
                    self.active_file = None
                obj.close()
        return SQLITE_OK

    def _x_read(self, p_file, z_buf, i_amt, i_ofst) -> int:
        obj = self._handles.get(p_file.contents.handle_id)
        if obj is None:
            return SQLITE_IOERR_READ
        try:
            data, short = obj.read_range(i_ofst, i_amt)
            if i_amt > 0:
                ctypes.memmove(z_buf, data, i_amt)
            return SQLITE_IOERR_SHORT_READ if short else SQLITE_OK
        except Exception as exc:
            self.last_error = exc
            return SQLITE_IOERR_READ

    def _x_file_size(self, p_file, p_size) -> int:
        obj = self._handles.get(p_file.contents.handle_id)
        if obj is None:
            return SQLITE_IOERR_READ
        p_size.contents.value = obj.virtual_size
        return SQLITE_OK

    def _x_check_reserved(self, _p_file, p_res) -> int:
        p_res.contents.value = 0
        return SQLITE_OK

    def _x_access(self, _p_vfs, z_name, _flags, p_res) -> int:
        if not z_name:
            p_res.contents.value = 0
            return SQLITE_OK
        path = self._normalize_path(z_name)
        if path.endswith(("-wal", "-shm", "-journal")):
            p_res.contents.value = 0
            return SQLITE_OK
        p_res.contents.value = 1 if os.path.exists(path) else 0
        return SQLITE_OK

    def _x_full_pathname(self, _p_vfs, z_name, n_out, z_out) -> int:
        try:
            full = self._normalize_path(z_name).encode("utf-8")
            if len(full) >= n_out:
                return SQLITE_CANTOPEN
            ctypes.memmove(z_out, full + b"\x00", len(full) + 1)
            return SQLITE_OK
        except Exception as exc:
            self.last_error = exc
            return SQLITE_CANTOPEN

    def _x_randomness(self, _p_vfs, n_byte, z_out) -> int:
        if n_byte > 0:
            buf = os.urandom(n_byte)
            ctypes.memmove(z_out, buf, n_byte)
        return n_byte

    def _x_sleep(self, _p_vfs, microseconds) -> int:
        if microseconds > 0:
            time.sleep(microseconds / 1_000_000.0)
        return microseconds

    def _x_current_time(self, _p_vfs, p_time) -> int:
        p_time.contents.value = time.time() / 86400.0 + 2440587.5
        return SQLITE_OK

    def connect(self, db_path: str) -> sqlite3.Connection:
        uri = pathlib.Path(os.path.abspath(db_path)).as_uri() + (
            f"?vfs={self.vfs_name_str}&mode=ro&immutable=1"
        )
        try:
            return sqlite3.connect(uri, uri=True)
        except Exception as exc:
            if self.last_error is not None:
                err = self.last_error
                self.last_error = None
                raise err from exc
            raise

    def close(self) -> None:
        for obj in list(self._handles.values()):
            obj.close()
        self._handles.clear()
        self.active_file = None
        if self._registered:
            self._lib.sqlite3_vfs_unregister(ctypes.byref(self._vfs))
            self._registered = False

    def __enter__(self) -> "NtqqReadonlyVfs":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()


@contextlib.contextmanager
def open_ntqq_readonly(
    db_path: str,
    key_map: dict[str, str],
    preferred_backend: str = "",
    cache_pages: int = 1024,
):
    """Context manager yielding (sqlite3.Connection, NtqqReadonlyVfs)."""
    with NtqqReadonlyVfs(
        key_map, preferred_backend=preferred_backend, cache_pages=cache_pages
    ) as vfs:
        conn = vfs.connect(db_path)
        try:
            yield conn, vfs
        finally:
            conn.close()


def run_with_consistency_retry(
    db_path: str,
    key_map: dict[str, str],
    fn: Callable[[sqlite3.Connection, NtqqEncryptedFile], Any],
    max_attempts: int = 5,
    base_backoff_sec: float = 0.1,
    preferred_backend: str = "",
    cache_pages: int = 1024,
) -> tuple[Any, dict[str, Any]]:
    """Run a read-only query against encrypted NTQQ DB with anti-torn-read retries.

    Returns (result, metadata_dict). Raises the last error if all attempts fail.
    """
    attempts = max(1, int(max_attempts))
    last_err: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with NtqqReadonlyVfs(
                key_map, preferred_backend=preferred_backend, cache_pages=cache_pages
            ) as vfs:
                conn = vfs.connect(db_path)
                try:
                    enc_file = vfs.active_file
                    if enc_file is None:
                        raise RuntimeError("VFS opened connection without active encrypted file handle")
                    result = fn(conn, enc_file)
                    consistent = enc_file.check_consistent()
                    meta = enc_file.snapshot_meta()
                finally:
                    conn.close()
                if vfs.last_error is not None:
                    raise vfs.last_error
                if not consistent:
                    raise TornSnapshotError(
                        f"QQ 主库在 VFS 查询期间发生 checkpoint 变化（第 {attempt}/{attempts} 次尝试）"
                    )
                meta["retries"] = attempt - 1
                meta["attempts"] = attempt
                return result, meta
        except (TornSnapshotError, EOFError, sqlite3.DatabaseError, sqlite3.OperationalError) as exc:
            last_err = exc
            if attempt >= attempts:
                break
            time.sleep(base_backoff_sec * (2 ** (attempt - 1)))
    assert last_err is not None
    raise last_err
