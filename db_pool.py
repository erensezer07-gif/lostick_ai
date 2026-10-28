"""
Lostick AI - Thread-Safe Veritabanı Bağlantı Havuzu (SQLite & PostgreSQL).

Bu modül; yerel geliştirmede SQLite (WAL modu etkin) ile sıfır kurulumlu çalışmayı desteklerken,
canlıda (Production) tek bir 'DATABASE_URL' çevre değişkeni ile eşzamanlı kilitlenmeleri (DB Locking)
önleyen profesyonel bir PostgreSQL bağlantı havuzuna şeffaf ve dinamik geçiş sağlar.
"""

from __future__ import annotations

import os
import re
import queue
import sqlite3
import hashlib
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Any, Union

# PostgreSQL sürücülerini güvenle içe aktar (Canlı ortamda psycopg2 gereklidir)
try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.pool import SimpleConnectionPool
    HAS_POSTGRES = True
except ImportError:
    HAS_POSTGRES = False

# SQLite dosya yolları
CACHE_DB_PATH = Path(__file__).parent / "kullanim_cache.db"
GORSEL_DB_PATH = Path(__file__).parent / "gorsel_cache.db"

# Canlı ortam PostgreSQL bağlantı dizesi
DATABASE_URL = os.getenv("DATABASE_URL")


# ─── SQL SORGUSU ÇEVİRİ VE UYUMLULUK KATMANI ────────────────────────
def translate_sqlite_to_postgres(sql: str) -> str:
    """SQLite uyumlu SQL sorgularını PostgreSQL uyumlu hale getirir."""
    if not sql:
        return sql

    # 1. Yer tutucu dönüştürme: ? -> %s
    sql_translated = sql.replace("?", "%s")

    # 2. Otomatik Artış dönüştürme: AUTOINCREMENT -> SERIAL
    sql_translated = sql_translated.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")

    # 3. SQLite tablosu pragma sorgusu (PRAGMA table_info) -> Postgres information_schema
    pragma_match = re.search(r"PRAGMA\s+table_info\((\w+)\)", sql_translated, re.IGNORECASE)
    if pragma_match:
        table_name = pragma_match.group(1)
        return f"""
            SELECT 
                ordinal_position - 1 AS cid, 
                column_name AS name, 
                data_type AS type, 
                CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull, 
                column_default AS dflt_value, 
                0 AS pk
            FROM information_schema.columns 
            WHERE table_name = '{table_name}'
            ORDER BY ordinal_position;
        """

    # 4. SQLite INSERT OR REPLACE / IGNORE -> Postgres ON CONFLICT blokları
    sql_upper = sql_translated.strip().upper()

    if "INSERT OR REPLACE INTO EMAIL_VERIFICATIONS" in sql_upper:
        return """
            INSERT INTO email_verifications (user_id, code, created_at, expires_at, attempts)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET 
                code = EXCLUDED.code, 
                created_at = EXCLUDED.created_at, 
                expires_at = EXCLUDED.expires_at, 
                attempts = EXCLUDED.attempts
        """

    if "INSERT OR REPLACE INTO PASSWORD_RESETS" in sql_upper:
        return """
            INSERT INTO password_resets (user_id, code, created_at, expires_at, attempts)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET 
                code = EXCLUDED.code, 
                created_at = EXCLUDED.created_at, 
                expires_at = EXCLUDED.expires_at, 
                attempts = EXCLUDED.attempts
        """

    if "INSERT OR IGNORE INTO OAUTH_ACCOUNTS" in sql_upper:
        return sql_translated.replace("INSERT OR IGNORE INTO", "INSERT INTO") + " ON CONFLICT (provider, provider_user_id) DO NOTHING"

    # NOT: image_cache şeması (query PK, url, title, descriptionurl, cached_at) —
    # gorsel_servisi.py `INSERT OR REPLACE INTO image_cache VALUES (?,?,?,?,?)` ile
    # 5 parametre gönderir, kolon adı vermez. Aynı sırayı koru.
    if "INSERT OR REPLACE INTO IMAGE_CACHE" in sql_upper:
        return """
            INSERT INTO image_cache (query, url, title, descriptionurl, cached_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (query) DO UPDATE SET
                url = EXCLUDED.url,
                title = EXCLUDED.title,
                descriptionurl = EXCLUDED.descriptionurl,
                cached_at = EXCLUDED.cached_at
        """

    # image_misses şeması (query PK, missed_at). 2 parametre.
    if "INSERT OR REPLACE INTO IMAGE_MISSES" in sql_upper:
        return """
            INSERT INTO image_misses (query, missed_at)
            VALUES (%s, %s)
            ON CONFLICT (query) DO UPDATE SET
                missed_at = EXCLUDED.missed_at
        """

    if "INSERT OR REPLACE INTO LLM_CACHE" in sql_upper:
        return """
            INSERT INTO llm_cache (cache_key, response, cached_at)
            VALUES (%s, %s, %s)
            ON CONFLICT (cache_key) DO UPDATE SET 
                response = EXCLUDED.response, 
                cached_at = EXCLUDED.cached_at
        """

    if "INSERT OR IGNORE INTO USER_SESSIONS" in sql_upper:
        return sql_translated.replace("INSERT OR IGNORE INTO", "INSERT INTO") + " ON CONFLICT (session_key) DO NOTHING"

    if "INSERT OR REPLACE INTO USER_SESSIONS" in sql_upper:
        return """
            INSERT INTO user_sessions (session_key, current_pdf_hash, active_files, updated_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (session_key) DO UPDATE SET 
                current_pdf_hash = EXCLUDED.current_pdf_hash, 
                active_files = EXCLUDED.active_files, 
                updated_at = EXCLUDED.updated_at
        """

    return sql_translated


# ─── POSTGRESQL UYUMLULUK VE SARMALAYICI SINIFLARI ──────────────────
class PGRowWrapper:
    """SQLite Row nesnesinin sözlük ve indeks tabanlı erişimini taklit eder."""
    def __init__(self, row_dict: dict):
        self.row_dict = row_dict
        self.row_tuple = tuple(row_dict.values())
        self.keys_list = list(row_dict.keys())

    def __getitem__(self, item: Union[int, str]) -> Any:
        if isinstance(item, int):
            return self.row_tuple[item]
        return self.row_dict[item]

    def keys(self) -> list[str]:
        return self.keys_list

    def __iter__(self):
        return iter(self.row_tuple)

    def __repr__(self) -> str:
        return repr(self.row_dict)


# Bu tablolar autoincrement bir `id` kolonuna sahip — INSERT sonrası lastrowid
# (Postgres'te RETURNING id) sadece bu tablolar için anlamlı. Diğer tablolarda
# (sessions, oauth_accounts, *cache, *resets …) körü körüne RETURNING id eklemek
# `column "id" does not exist` hatası verir. Yeni AUTOINCREMENT'li tablo
# eklenirse bu sete eklenmeli.
_TABLES_WITH_AUTOINCREMENT_ID = {
    "users",
    "kavram_klasorleri",
    "kavram_kartlari",
}

_INSERT_TABLE_RE = re.compile(
    r"^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE,
)


def _needs_returning_id(sql: str) -> bool:
    """INSERT ifadesi autoincrement-id'li bir tabloya mı gidiyor?"""
    m = _INSERT_TABLE_RE.match(sql)
    if not m:
        return False
    return m.group(1).lower() in _TABLES_WITH_AUTOINCREMENT_ID


class PGCursorWrapper:
    """FastAPI sqlite3.Cursor nesnesini PostgreSQL için sarmalar."""
    def __init__(self, pg_cursor):
        self.cursor = pg_cursor
        self._lastrowid = None

    def execute(self, sql: str, params: Optional[Union[tuple, list, dict]] = None) -> PGCursorWrapper:
        # Tablo adını dönüşümden ÖNCE belirle (ON CONFLICT rewrite'ı orijinal SQL
        # yapısını koruyor ama yine de güvenlik için orijinal SQL'e bakıyoruz).
        wants_returning_id = _needs_returning_id(sql)

        sql_translated = translate_sqlite_to_postgres(sql)

        # SQLite lastrowid emülasyonu: sadece autoincrement-id'li tablolarda RETURNING id ekle.
        # Diğer tablolar (sessions, oauth_accounts, *cache …) id kolonuna sahip değil,
        # körü körüne eklemek Postgres'te hata verir.
        if wants_returning_id and "RETURNING" not in sql_translated.upper():
            sql_translated = sql_translated.rstrip().rstrip(";") + " RETURNING id"

        if params is not None:
            self.cursor.execute(sql_translated, params)
        else:
            self.cursor.execute(sql_translated)

        # lastrowid kaydet
        if wants_returning_id and "RETURNING ID" in sql_translated.upper():
            try:
                row = self.cursor.fetchone()
                if row:
                    # RealDictCursor → dict; tuple-cursor → tuple. İkisini de destekle.
                    self._lastrowid = row["id"] if isinstance(row, dict) else row[0]
            except Exception:
                self._lastrowid = None
        else:
            self._lastrowid = None

        return self

    def fetchone(self) -> Optional[PGRowWrapper]:
        row = self.cursor.fetchone()
        if row is None:
            return None
        return PGRowWrapper(dict(row))

    def fetchall(self) -> list[PGRowWrapper]:
        rows = self.cursor.fetchall()
        return [PGRowWrapper(dict(r)) for r in rows]

    @property
    def lastrowid(self) -> Optional[int]:
        return self._lastrowid

    def close(self) -> None:
        self.cursor.close()


class PGConnectionWrapper:
    """FastAPI sqlite3.Connection nesnesini PostgreSQL için sarmalar."""
    def __init__(self, pg_conn):
        self.conn = pg_conn

    def cursor(self) -> PGCursorWrapper:
        return PGCursorWrapper(self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor))

    def execute(self, sql: str, params: Optional[Union[tuple, list, dict]] = None) -> PGCursorWrapper:
        cur = self.cursor()
        cur.execute(sql, params)
        return cur

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


# ─── POSTGRESQL BAĞLANTI HAVUZU (CONNECTION POOL) ──────────────────
class PGConnectionPool:
    def __init__(self, database_url: str, max_connections: int = 25):
        if not HAS_POSTGRES:
            raise ImportError("PostgreSQL bağlantısı için 'psycopg2' kurulu olmalıdır.")
        self.pool = SimpleConnectionPool(
            minconn=1,
            maxconn=max_connections,
            dsn=database_url
        )

    def get_connection(self) -> PGConnectionWrapper:
        conn = self.pool.getconn()
        return PGConnectionWrapper(conn)

    def return_connection(self, wrapper: PGConnectionWrapper) -> None:
        self.pool.putconn(wrapper.conn)

    def close_all(self) -> None:
        self.pool.closeall()


# ─── SQLITE BAĞLANTI HAVUZU (SQLite CONNECTION POOL) ────────────────
class SQLiteConnectionPool:
    def __init__(self, db_path: Path, max_connections: int = 15, timeout: float = 30.0):
        self.db_path = db_path
        self.max_connections = max_connections
        self.timeout = timeout
        self._pool = queue.Queue(maxsize=max_connections)
        self._lock = threading.Lock()
        self._allocated = 0

    def _create_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.db_path,
            timeout=self.timeout,
            check_same_thread=False
        )
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def get_connection(self) -> sqlite3.Connection:
        try:
            return self._pool.get_nowait()
        except queue.Empty:
            with self._lock:
                if self._allocated < self.max_connections:
                    conn = self._create_connection()
                    self._allocated += 1
                    return conn
            return self._pool.get(block=True, timeout=self.timeout)

    def return_connection(self, conn: sqlite3.Connection) -> None:
        try:
            self._pool.put_nowait(conn)
        except queue.Full:
            try:
                conn.close()
            except Exception:
                pass
            with self._lock:
                self._allocated -= 1

    def close_all(self) -> None:
        with self._lock:
            while not self._pool.empty():
                try:
                    conn = self._pool.get_nowait()
                    conn.close()
                except Exception:
                    pass
            self._allocated = 0


# ─── GLOBAL HAVUZ BAŞLATMA VE YÖNETİMİ ──────────────────────────────
if DATABASE_URL and HAS_POSTGRES:
    print("🚀 Canlı Ortam: PostgreSQL bağlantı havuzu aktif ediliyor...")
    db_pool = PGConnectionPool(DATABASE_URL, max_connections=30)
    gorsel_db_pool = PGConnectionPool(DATABASE_URL, max_connections=15)
else:
    if DATABASE_URL:
        print("⚠️ DATABASE_URL tanımlı ancak psycopg2 kütüphanesi eksik! SQLite moduna düşülüyor.")
    else:
        print("💾 Yerel Ortam: SQLite bağlantı havuzu (WAL modu) aktif ediliyor...")
    db_pool = SQLiteConnectionPool(CACHE_DB_PATH, max_connections=20)
    gorsel_db_pool = SQLiteConnectionPool(GORSEL_DB_PATH, max_connections=10)


@contextmanager
def get_db():
    """Bağlantı kiralayan ve işlem bitince havuza güvenle iade eden Context Manager."""
    conn = db_pool.get_connection()
    try:
        yield conn
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        db_pool.return_connection(conn)


@contextmanager
def get_gorsel_db():
    """Görsel önbellek veritabanı için bağlantı kiralayan ve havuza iade eden Context Manager."""
    conn = gorsel_db_pool.get_connection()
    try:
        yield conn
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        gorsel_db_pool.return_connection(conn)
