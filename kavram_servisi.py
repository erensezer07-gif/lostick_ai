"""
Kavram Kütüphanesi servisi: kullanıcıya özel klasörler ve kavram kartları.

- Aynı SQLite DB (kullanim_cache.db) üzerinde iki tablo: klasörler + kartlar
- Her kayıt user_id taşır; kullanıcı silinince ON DELETE CASCADE ile temizlenir
- Klasör silinince içindeki kartlar da cascade silinir
- Tüm sorgular user_id ile filtrelenir → kullanıcı yalnızca kendi verisine erişir
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Optional

from db_pool import get_db

CACHE_DB_PATH = Path(__file__).parent / "kullanim_cache.db"


def init_kavram() -> None:
    """Klasör + kart tablolarını oluştur (idempotent)."""
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kavram_klasorleri (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ad TEXT NOT NULL,
                created_at REAL NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kavram_klasor_user ON kavram_klasorleri(user_id)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS kavram_kartlari (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                klasor_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                kavram TEXT NOT NULL,
                tanim TEXT NOT NULL,
                created_at REAL NOT NULL,
                FOREIGN KEY (klasor_id) REFERENCES kavram_klasorleri(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kavram_kart_klasor ON kavram_kartlari(klasor_id)"
        )
        conn.commit()


# ─── Klasörler ────────────────────────────────────────────────────

def klasor_listele(user_id: int) -> list[dict]:
    """Kullanıcının klasörlerini (kart sayılarıyla) en yeni → en eski döner."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT k.id, k.ad, k.created_at,
                   (SELECT COUNT(*) FROM kavram_kartlari kk WHERE kk.klasor_id = k.id) AS kart_sayisi
            FROM kavram_klasorleri k
            WHERE k.user_id = ?
            ORDER BY k.created_at DESC
            """,
            (user_id,),
        ).fetchall()
        return [
            {"id": r[0], "ad": r[1], "created_at": r[2], "kart_sayisi": r[3]}
            for r in rows
        ]


def klasor_olustur(user_id: int, ad: str) -> dict:
    ad = (ad or "").strip()
    if not ad:
        raise ValueError("Klasör adı boş olamaz.")
    if len(ad) > 80:
        ad = ad[:80]
    now = time.time()
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO kavram_klasorleri (user_id, ad, created_at) VALUES (?, ?, ?)",
            (user_id, ad, now),
        )
        conn.commit()
        return {"id": cur.lastrowid, "ad": ad, "created_at": now, "kart_sayisi": 0}


def klasor_sil(user_id: int, klasor_id: int) -> bool:
    """Klasörü (ve cascade ile kartlarını) siler. Sahibi değilse False."""
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM kavram_klasorleri WHERE id = ? AND user_id = ?",
            (klasor_id, user_id),
        )
        conn.commit()
        return cur.rowcount > 0


def klasor_sahibi_mi(user_id: int, klasor_id: int) -> bool:
    with get_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM kavram_klasorleri WHERE id = ? AND user_id = ?",
            (klasor_id, user_id),
        ).fetchone()
        return row is not None


# ─── Kartlar ──────────────────────────────────────────────────────

def kart_listele(user_id: int, klasor_id: int) -> list[dict]:
    """Bir klasördeki kartları en yeni → en eski döner (sadece sahibi için)."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, kavram, tanim, created_at
            FROM kavram_kartlari
            WHERE klasor_id = ? AND user_id = ?
            ORDER BY created_at DESC
            """,
            (klasor_id, user_id),
        ).fetchall()
        return [
            {"id": r[0], "kavram": r[1], "tanim": r[2], "created_at": r[3]}
            for r in rows
        ]


def kart_ekle(user_id: int, klasor_id: int, kavram: str, tanim: str) -> dict:
    kavram = (kavram or "").strip()
    tanim = (tanim or "").strip()
    now = time.time()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO kavram_kartlari (klasor_id, user_id, kavram, tanim, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (klasor_id, user_id, kavram, tanim, now),
        )
        conn.commit()
        return {"id": cur.lastrowid, "kavram": kavram, "tanim": tanim, "created_at": now}


def kart_sil(user_id: int, kart_id: int) -> bool:
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM kavram_kartlari WHERE id = ? AND user_id = ?",
            (kart_id, user_id),
        )
        conn.commit()
        return cur.rowcount > 0
