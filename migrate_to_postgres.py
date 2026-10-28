"""
SQLite → PostgreSQL veri migration script'i.

KULLANIM:
    # 1) DATABASE_URL'ü .env'ye ekleyin (veya inline verin)
    DATABASE_URL=postgresql://user:pass@host:5432/lostick python migrate_to_postgres.py

NE YAPAR:
    1) PG hedef şemalarını oluşturur (init_auth + init_kavram + init_cache + init_image_cache)
    2) Yerel kullanim_cache.db + gorsel_cache.db'den her tabloyu okur
    3) PG'ye satır-satır INSERT ... ON CONFLICT DO NOTHING yapar (idempotent)
    4) Autoincrement tablolar için sequence'leri MAX(id)+1'e ayarlar
    5) Satır sayılarını raporlar

İDEMPOTENT: Aynı script'i defalarca çalıştırabilirsiniz. ON CONFLICT DO NOTHING ile
mevcut satırlar atlanır; sadece yeni satırlar yazılır. Migration sırasında veri
kaybetme riski yoktur.

DİKKAT:
    - DATABASE_URL hem migration sırasında hem de sunucu çalışırken tanımlı kalmalı.
    - translation_jobs tablosu sunucu boot'unda otomatik oluşur (ephemeral, migrate etmiyoruz).
    - Migration sırasında uygulama hâlâ SQLite'a yazıyorsa "ufak farklar" oluşabilir →
      en temizi: önce uygulamayı durdur → migration → DATABASE_URL ile yeniden başlat.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

# ───────────────────────────────────────────────────────────────────
# DATABASE_URL kontrolü — db_pool import'undan ÖNCE yapılmalı
# ───────────────────────────────────────────────────────────────────
if not os.getenv("DATABASE_URL", "").strip():
    print("❌ DATABASE_URL tanımsız. Migration için bunu set edin:")
    print("   export DATABASE_URL=postgresql://user:pass@host:5432/lostick")
    sys.exit(1)

try:
    import psycopg2  # noqa: F401
except ImportError:
    print("❌ psycopg2 kurulu değil. `pip install psycopg2-binary` çalıştırın.")
    sys.exit(1)


# db_pool DATABASE_URL'i import sırasında okur → bu noktadan sonra PG modunda
import db_pool  # noqa: F401
import psycopg2  # tekrar import — type checker mutlu olsun

# Servisler — init_* çağrıları PG'de şemaları yaratır
from auth_servisi import init_auth
from kavram_servisi import init_kavram
from kullanim_servisi import init_cache
from gorsel_servisi import init_image_cache


# ───────────────────────────────────────────────────────────────────
# Tablo manifest'leri — ON CONFLICT için PK kolonları
# ───────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent
SQLITE_KULLANIM = ROOT / "kullanim_cache.db"
SQLITE_GORSEL = ROOT / "gorsel_cache.db"

# (table_name, [pk_columns])
KULLANIM_TABLES: list[tuple[str, list[str]]] = [
    ("users", ["id"]),
    ("sessions", ["token"]),
    ("oauth_accounts", ["provider", "provider_user_id"]),
    ("email_verifications", ["user_id"]),
    ("password_resets", ["user_id"]),
    ("kavram_klasorleri", ["id"]),
    ("kavram_kartlari", ["id"]),
    ("llm_cache", ["cache_key"]),
    ("rate_limit", ["ip", "day"]),
    ("api_key_status", ["key_hash"]),
    ("user_sessions", ["session_key"]),
]

GORSEL_TABLES: list[tuple[str, list[str]]] = [
    ("image_cache", ["query"]),
    ("image_misses", ["query"]),
]

# SERIAL/AUTOINCREMENT PK'lı tablolar — migration sonrası sequence reset gerekir,
# yoksa next INSERT'te id çakışması olur ("duplicate key" hataları).
AUTOINC_TABLES: list[str] = ["users", "kavram_klasorleri", "kavram_kartlari"]


# ───────────────────────────────────────────────────────────────────
# Migration mantığı
# ───────────────────────────────────────────────────────────────────

# Toplu insert için sayfa boyutu — büyük tablolarda RAM verimliliği için
BATCH_SIZE = 500


def migrate_table(
    sqlite_path: Path,
    table: str,
    pk_cols: list[str],
    pg_conn,
) -> int:
    """SQLite tablodan tüm satırları PG'ye kopyalar.

    Returns: PG'ye yeni eklenen satır sayısı (çakışanlar atlanır).
    """
    if not sqlite_path.exists():
        return 0

    sconn = sqlite3.connect(sqlite_path)
    sconn.row_factory = sqlite3.Row
    try:
        # Tablo yoksa sessizce atla — bazı kurulumlar bazı tabloları kullanmamış olabilir
        chk = sconn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if not chk:
            print(f"  ⊘ {table}: SQLite'ta yok, atlandı")
            return 0

        # Kolon adlarını çek (PRAGMA daha güvenli ama SELECT * Row.keys() yeterli)
        cur = sconn.execute(f"SELECT * FROM {table}")
        rows = cur.fetchall()
        if not rows:
            print(f"  ⊘ {table}: boş, atlandı")
            return 0

        cols = list(rows[0].keys())
        placeholders = ", ".join(["%s"] * len(cols))
        col_list = ", ".join(f'"{c}"' for c in cols)
        pk_list = ", ".join(f'"{c}"' for c in pk_cols)
        sql = (
            f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders}) '
            f"ON CONFLICT ({pk_list}) DO NOTHING"
        )

        # Batch insert ile RAM verimliliği
        inserted = 0
        with pg_conn.cursor() as pcur:
            for i in range(0, len(rows), BATCH_SIZE):
                batch = rows[i : i + BATCH_SIZE]
                values = [tuple(row[c] for c in cols) for row in batch]
                # executemany ON CONFLICT ile çalışır
                pcur.executemany(sql, values)
                # rowcount executemany'de toplam etkilenen satır sayısıdır (driver'a bağlı)
                # ON CONFLICT DO NOTHING'de driver "skip" edilen satırları rowcount'a katmaz
                inserted += max(pcur.rowcount, 0)
        pg_conn.commit()
        skipped = len(rows) - inserted
        print(
            f"  ✓ {table}: {len(rows)} okundu → {inserted} eklendi, "
            f"{skipped} çakıştı/atlandı"
        )
        return inserted
    except Exception as e:
        pg_conn.rollback()
        print(f"  ❌ {table}: HATA — {e}")
        raise
    finally:
        sconn.close()


def reset_sequences(pg_conn) -> None:
    """SERIAL sequence'leri MAX(id)+1'e ayarla.

    SQLite'tan kopyalanan rows kendi id'leriyle insert edildi, ama PG sequence'i
    hâlâ 1'den başlıyor olabilir. Bunu düzeltmezsek bir sonraki INSERT
    "duplicate key" hatası verir.
    """
    print("\n🔢 Aşama 3/3: Sequence reset (autoincrement tablolar için)...")
    with pg_conn.cursor() as cur:
        for table in AUTOINC_TABLES:
            try:
                cur.execute(f'SELECT COALESCE(MAX(id), 0) + 1 FROM "{table}"')
                next_val = cur.fetchone()[0]
                # SERIAL → otomatik üretilen sequence ismi: "<table>_id_seq"
                # `is_called=false` parametresi ile bir sonraki nextval()
                # tam olarak next_val'i döner (next_val-1 değil)
                cur.execute(f"SELECT setval('{table}_id_seq', %s, false)", (next_val,))
                print(f"  ✓ {table}_id_seq → {next_val}")
            except Exception as e:
                print(f"  ⚠️  {table} sequence reset hatası (zarar yok, manuel reset edebilirsiniz): {e}")
                pg_conn.rollback()
                continue
    pg_conn.commit()


def main() -> None:
    db_url = os.getenv("DATABASE_URL", "")
    # Şifre kısmını gizleyerek logla
    safe = db_url.split("@")[-1] if "@" in db_url else db_url[:50]
    print(f"🚀 SQLite → PostgreSQL Migration")
    print(f"   Hedef: ...@{safe}")
    print(f"   Kaynaklar: {SQLITE_KULLANIM.name} + {SQLITE_GORSEL.name}")
    print()

    # 1) Şemalar
    print("📋 Aşama 1/3: PG'de hedef şemalar oluşturuluyor (idempotent)...")
    init_auth()
    init_kavram()
    init_cache()
    init_image_cache()
    print("  ✓ Tüm şemalar hazır")
    print()

    # 2) Veri kopyalama
    print("📦 Aşama 2/3: Veri kopyalama (ON CONFLICT DO NOTHING — idempotent)...")
    pg = psycopg2.connect(db_url)
    try:
        total = 0
        if SQLITE_KULLANIM.exists():
            print(f"  Kaynak: {SQLITE_KULLANIM.name}")
            for table, pk in KULLANIM_TABLES:
                total += migrate_table(SQLITE_KULLANIM, table, pk, pg)
        else:
            print(f"  ⚠️ {SQLITE_KULLANIM.name} bulunamadı — atlandı")

        if SQLITE_GORSEL.exists():
            print(f"  Kaynak: {SQLITE_GORSEL.name}")
            for table, pk in GORSEL_TABLES:
                total += migrate_table(SQLITE_GORSEL, table, pk, pg)
        else:
            print(f"  ⚠️ {SQLITE_GORSEL.name} bulunamadı — atlandı")

        # 3) Sequence reset
        reset_sequences(pg)

        print()
        print(f"✅ Migration tamamlandı — {total} yeni satır PG'ye yazıldı.")
        print("   • İdempotent: tekrar çalıştırabilirsiniz, çakışan satırlar atlanır.")
        print("   • translation_jobs tablosu sunucu boot'unda otomatik oluşur (ephemeral).")
        print("   • Şimdi uygulamayı DATABASE_URL ile yeniden başlatın.")
    finally:
        pg.close()


if __name__ == "__main__":
    main()
