"""
Auth servisi: kullanıcı kaydı, giriş, oturum (access + refresh token) ve admin seed.

- Şifreler PBKDF2-HMAC-SHA256 + per-user random salt ile hash'lenir (stdlib, ek paket yok)
- Token'lar DB-backed opak (saf JWT değil) → merkezi iptal trivial: tek SQL UPDATE
- Access token: kısa ömürlü (15 dk), her API isteğinde kullanılır
- Refresh token: uzun ömürlü (30 gün), tek kullanımlık (rotated) — sadece /auth/refresh'te
- Refresh token replay tespiti: revoke edilmiş bir refresh'in tekrar sunulması =
  çalıntı → o kullanıcının TÜM oturumları iptal edilir (OWASP refresh rotation pattern)
- Startup'ta `ADMIN_USERNAME`/`ADMIN_PASSWORD` env'leri varsa admin hesabı oluşturulur
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Optional, TypedDict

from db_pool import get_db

CACHE_DB_PATH = Path(__file__).parent / "kullanim_cache.db"
ACCESS_TOKEN_TTL_SECONDS = 15 * 60          # 15 dakika
REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 gün
REVOKED_RETENTION_SECONDS = 7 * 24 * 3600   # iptal edilen oturumlar replay tespiti için 7 gün tutulur

# Geriye uyumluluk: eski sabit isim hâlâ kullanılıyorsa kırılmasın
SESSION_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS

PBKDF2_ITERATIONS = 100_000

DEFAULT_ADMIN_USERNAME = "admin"
# Güvenlik: kaynak kodda SABİT bir default şifre TUTMUYORUZ (public repo'da herkesçe
# bilinen admin kimliği = güvenlik açığı). ADMIN_PASSWORD env'i yoksa startup'ta
# rastgele güçlü bir şifre üretilir ve konsola BİR KEZ yazdırılır.


class User(TypedDict):
    id: int
    username: str
    email: Optional[str]
    role: str
    created_at: float


def init_auth() -> None:
    """Users + sessions + oauth_accounts tablolarını oluştur (idempotent) ve admin'i seed et."""
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                refresh_token TEXT UNIQUE,
                user_id INTEGER NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                refresh_expires_at REAL,
                revoked INTEGER NOT NULL DEFAULT 0,
                last_used_at REAL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)"
        )

        # Migration: eski sessions tablosunda refresh_token/revoked yoksa ekle ve
        # 30 günlük eski opak token'ları temizle (yeni 15dk + refresh modeline geçiş).
        # Index oluşturma migration SONRASINA alındı — yoksa eski şemada hata verir.
        session_cols = [row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()]
        if "refresh_token" not in session_cols:
            conn.execute("ALTER TABLE sessions ADD COLUMN refresh_token TEXT")
            conn.execute("ALTER TABLE sessions ADD COLUMN refresh_expires_at REAL")
            conn.execute("ALTER TABLE sessions ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0")
            conn.execute("ALTER TABLE sessions ADD COLUMN last_used_at REAL")
            # Eski uzun ömürlü access token'lar yeni güvenlik modeline uymuyor → temizle
            removed = conn.execute("DELETE FROM sessions").rowcount
            print(
                f"✅ Migration: sessions tablosuna refresh_token + revoked + last_used_at "
                f"eklendi ({removed} eski oturum temizlendi — kullanıcılar tekrar giriş yapacak)"
            )

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token)"
        )
        # OAuth (Google/GitHub) hesaplarını yerel users'a bağlayan tablo
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS oauth_accounts (
                provider TEXT NOT NULL,
                provider_user_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                email TEXT,
                created_at REAL NOT NULL,
                PRIMARY KEY (provider, provider_user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id)"
        )

        # E-posta doğrulama: 6 haneli kod, IP rate limit ile
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS email_verifications (
                user_id INTEGER PRIMARY KEY,
                code TEXT NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )

        # Şifre sıfırlama: 6 haneli kod
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS password_resets (
                user_id INTEGER PRIMARY KEY,
                code TEXT NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )

        # Migration: eski users tablosunda email_verified yoksa ekle, mevcutları verified say
        cols = [row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()]
        if "email_verified" not in cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0"
            )
            # Mevcut hesaplar (OAuth dahil) verified sayılır — bozulmasınlar
            conn.execute("UPDATE users SET email_verified = 1")
            print("✅ Migration: users.email_verified eklendi, mevcut hesaplar verified işaretlendi")

        conn.commit()

    _ensure_admin()


# ─── E-posta doğrulama ────────────────────────────────────────────

VERIFICATION_CODE_TTL_SECONDS = 15 * 60  # 15 dakika
VERIFICATION_MAX_ATTEMPTS = 5


def generate_verification_code() -> str:
    """6 haneli rastgele kod (kriptografik rand)."""
    return "".join(secrets.choice("0123456789") for _ in range(6))


def create_or_replace_verification(user_id: int) -> str:
    """Bir user için yeni doğrulama kodu üret, varsa eskisini sil."""
    code = generate_verification_code()
    now = time.time()
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO email_verifications (user_id, code, created_at, expires_at, attempts)
            VALUES (?, ?, ?, ?, 0)
            """,
            (user_id, code, now, now + VERIFICATION_CODE_TTL_SECONDS),
        )
        conn.commit()
        return code


def verify_email_code(user_id: int, code: str) -> tuple[bool, str]:
    """
    Kodu doğrula. Başarılı olursa users.email_verified=1 işaretlenir
    ve kayıt silinir.
    Returns: (ok, reason)
    """
    code = (code or "").strip()
    if not code or not code.isdigit() or len(code) != 6:
        return False, "Geçersiz kod formatı (6 haneli sayı olmalı)."

    now = time.time()
    with get_db() as conn:
        row = conn.execute(
            "SELECT code, expires_at, attempts FROM email_verifications WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if not row:
            return False, "Doğrulama kodu bulunamadı. Yeniden gönder."
        stored_code, expires_at, attempts = row
        if attempts >= VERIFICATION_MAX_ATTEMPTS:
            return False, "Çok fazla yanlış deneme. Yeni kod talep et."
        if expires_at < now:
            return False, "Kodun süresi doldu. Yeniden gönder."

        if not secrets.compare_digest(code, stored_code):
            conn.execute(
                "UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ?",
                (user_id,),
            )
            conn.commit()
            kalan = VERIFICATION_MAX_ATTEMPTS - attempts - 1
            return False, f"Kod yanlış. {kalan} hak kaldı."

        # Başarılı — verify işaretle, kaydı sil
        conn.execute(
            "UPDATE users SET email_verified = 1 WHERE id = ?",
            (user_id,),
        )
        conn.execute("DELETE FROM email_verifications WHERE user_id = ?", (user_id,))
        conn.commit()
        return True, "ok"


def is_email_verified(user_id: int) -> bool:
    with get_db() as conn:
        row = conn.execute(
            "SELECT email_verified FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return bool(row and row[0])


# ─── Şifre Sıfırlama ──────────────────────────────────────────────

def create_password_reset(user_id: int) -> str:
    """Bir user için yeni şifre sıfırlama kodu üret, varsa eskisini sil."""
    code = generate_verification_code()
    now = time.time()
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO password_resets (user_id, code, created_at, expires_at, attempts)
            VALUES (?, ?, ?, ?, 0)
            """,
            (user_id, code, now, now + VERIFICATION_CODE_TTL_SECONDS),
        )
        conn.commit()
        return code


def verify_and_execute_password_reset(user_id: int, code: str, new_password: str) -> tuple[bool, str]:
    """
    Kodu doğrula. Başarılı olursa kullanıcının şifresini yeni şifreyle değiştir.
    Returns: (ok, reason)
    """
    code = (code or "").strip()
    if not code or not code.isdigit() or len(code) != 6:
        return False, "Geçersiz kod formatı (6 haneli sayı olmalı)."

    if not new_password or len(new_password) < 6:
        return False, "Yeni şifre en az 6 karakter olmalı."

    now = time.time()
    with get_db() as conn:
        row = conn.execute(
            "SELECT code, expires_at, attempts FROM password_resets WHERE user_id = ?",
            (user_id,),
        ).fetchone()
        if not row:
            return False, "Şifre sıfırlama talebi bulunamadı. Yeniden talep et."
        stored_code, expires_at, attempts = row
        
        if attempts >= VERIFICATION_MAX_ATTEMPTS:
            return False, "Çok fazla yanlış deneme. Yeni kod talep et."
        if expires_at < now:
            return False, "Kodun süresi doldu. Yeniden gönder."

        if not secrets.compare_digest(code, stored_code):
            conn.execute(
                "UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?",
                (user_id,),
            )
            conn.commit()
            kalan = VERIFICATION_MAX_ATTEMPTS - attempts - 1
            return False, f"Kod yanlış. {kalan} hak kaldı."

        # Başarılı — yeni şifreyi ayarla, kaydı sil
        pwd_hash, pwd_salt = _hash_password(new_password)
        conn.execute(
            "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
            (pwd_hash, pwd_salt, user_id),
        )
        # Bütün açık oturumları kapatmak iyi bir pratiktir
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))
        conn.commit()
        return True, "ok"


def get_user_by_id(user_id: int) -> Optional[User]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, username, email, role, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        return _row_to_user(row) if row else None


def _hash_password(password: str, salt: Optional[bytes] = None) -> tuple[str, str]:
    """PBKDF2-HMAC-SHA256 ile şifreyi hash'le. Returns: (hash_hex, salt_hex)."""
    if salt is None:
        salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return digest.hex(), salt.hex()


def _verify_password(password: str, stored_hash: str, stored_salt: str) -> bool:
    """Sabit-zamanlı şifre doğrulaması."""
    salt = bytes.fromhex(stored_salt)
    computed, _ = _hash_password(password, salt)
    return secrets.compare_digest(computed, stored_hash)


def _row_to_user(row) -> User:
    return {
        "id": row[0],
        "username": row[1],
        "email": row[2],
        "role": row[3],
        "created_at": row[4],
    }


def get_user_by_username(username: str) -> Optional[User]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, username, email, role, created_at FROM users WHERE username = ?",
            (username.strip().lower(),),
        ).fetchone()
        return _row_to_user(row) if row else None


def get_user_by_email(email: str) -> Optional[User]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT id, username, email, role, created_at FROM users WHERE email = ?",
            (email.strip().lower(),),
        ).fetchone()
        return _row_to_user(row) if row else None


def create_user(
    username: str,
    password: str,
    email: Optional[str] = None,
    role: str = "user",
) -> User:
    """Yeni kullanıcı oluşturur. UNIQUE çakışmasında ValueError."""
    username = username.strip().lower()
    if not username or len(username) < 3:
        raise ValueError("Kullanıcı adı en az 3 karakter olmalı.")
    if not password or len(password) < 6:
        raise ValueError("Şifre en az 6 karakter olmalı.")
    if email:
        email = email.strip().lower()

    pwd_hash, pwd_salt = _hash_password(password)
    with get_db() as conn:
        try:
            cur = conn.execute(
                """
                INSERT INTO users (username, email, password_hash, password_salt, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (username, email, pwd_hash, pwd_salt, role, time.time()),
            )
        except sqlite3.IntegrityError as e:
            msg = str(e).lower()
            if "username" in msg:
                raise ValueError("Bu kullanıcı adı zaten alınmış.") from e
            if "email" in msg:
                raise ValueError("Bu e-posta zaten kayıtlı.") from e
            raise
        conn.commit()
        user_id = cur.lastrowid
        return {
            "id": user_id,
            "username": username,
            "email": email,
            "role": role,
            "created_at": time.time(),
        }


def authenticate(username: str, password: str) -> Optional[User]:
    """Kullanıcı adı + şifre doğrulaması. None dönerse yanlış."""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT id, username, email, role, created_at, password_hash, password_salt
            FROM users WHERE username = ?
            """,
            (username.strip().lower(),),
        ).fetchone()
        if not row:
            return None
        if not _verify_password(password, row[5], row[6]):
            return None
        return _row_to_user(row)


class SessionTokens(TypedDict):
    access_token: str
    refresh_token: str
    expires_in: int            # access token saniye
    refresh_expires_in: int    # refresh token saniye


def create_session(user_id: int) -> SessionTokens:
    """Yeni access + refresh token ikilisi üret, DB'ye yaz ve döndür."""
    access_token = secrets.token_urlsafe(32)
    refresh_token = secrets.token_urlsafe(48)
    now = time.time()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO sessions
              (token, refresh_token, user_id, created_at,
               expires_at, refresh_expires_at, revoked, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                access_token,
                refresh_token,
                user_id,
                now,
                now + ACCESS_TOKEN_TTL_SECONDS,
                now + REFRESH_TOKEN_TTL_SECONDS,
                now,
            ),
        )
        conn.commit()
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        "refresh_expires_in": REFRESH_TOKEN_TTL_SECONDS,
    }


def get_user_by_token(token: str) -> Optional[User]:
    """Access token'a karşılık gelen aktif kullanıcıyı döner (TTL + revoke kontrolü)."""
    if not token:
        return None
    now = time.time()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT u.id, u.username, u.email, u.role, u.created_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ? AND s.revoked = 0
            """,
            (token, now),
        ).fetchone()
        if not row:
            return None
        try:
            conn.execute(
                "UPDATE sessions SET last_used_at = ? WHERE token = ?",
                (now, token),
            )
            conn.commit()
        except Exception:
            pass
        return _row_to_user(row)


def refresh_session(refresh_token: str) -> Optional[SessionTokens]:
    """
    Refresh token doğrulaması + rotation.

    - Refresh tek kullanımlıktır: kullanılan satır revoked=1 olur, yeni ikili üretilir.
    - REPLAY DETECTION: revoke edilmiş bir refresh tekrar sunulursa = token çalıntı
      → o kullanıcının TÜM aktif oturumları iptal edilir (OWASP rotation pattern).
    - Refresh süresi dolmuşsa veya bilinmiyorsa None.
    """
    if not refresh_token:
        return None
    now = time.time()
    with get_db() as conn:
        row = conn.execute(
            "SELECT user_id, refresh_expires_at, revoked FROM sessions WHERE refresh_token = ?",
            (refresh_token,),
        ).fetchone()
        if not row:
            return None
        user_id, refresh_expires_at, revoked = row

        if revoked:
            # Çalınmış olabilir — kullanıcının tüm canlı oturumlarını kes
            cur = conn.execute(
                "UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0",
                (user_id,),
            )
            conn.commit()
            print(
                f"⚠️  GÜVENLİK: user_id={user_id} için iptal edilmiş refresh token "
                f"tekrar sunuldu. {cur.rowcount} aktif oturum kapatıldı."
            )
            return None

        if refresh_expires_at is None or refresh_expires_at < now:
            return None

        new_access = secrets.token_urlsafe(32)
        new_refresh = secrets.token_urlsafe(48)
        conn.execute(
            "UPDATE sessions SET revoked = 1 WHERE refresh_token = ?",
            (refresh_token,),
        )
        conn.execute(
            """
            INSERT INTO sessions
              (token, refresh_token, user_id, created_at,
               expires_at, refresh_expires_at, revoked, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                new_access,
                new_refresh,
                user_id,
                now,
                now + ACCESS_TOKEN_TTL_SECONDS,
                now + REFRESH_TOKEN_TTL_SECONDS,
                now,
            ),
        )
        conn.commit()

    return {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        "refresh_expires_in": REFRESH_TOKEN_TTL_SECONDS,
    }


def invalidate_session(token: str) -> None:
    """Bir access token'ı (ve eşleşen refresh'i) iptal eder. Logout için."""
    if not token:
        return
    with get_db() as conn:
        conn.execute(
            "UPDATE sessions SET revoked = 1 WHERE token = ?", (token,)
        )
        conn.commit()


def revoke_all_user_sessions(user_id: int) -> int:
    """
    Bir kullanıcının TÜM aktif oturumlarını iptal eder ("Tüm cihazlardan çıkış").
    Şifre değişimi, hesap ihlali şüphesi veya kullanıcı talebi için kullanılır.
    Etkilenen satır sayısını döner.
    """
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0",
            (user_id,),
        )
        conn.commit()
        return cur.rowcount


def _slugify_username(raw: str) -> str:
    """OAuth provider'dan gelen ismi geçerli bir username'e dönüştür."""
    if not raw:
        raw = "user"
    cleaned = "".join(
        c.lower() if c.isalnum() else "_" for c in raw
    ).strip("_")
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    if not cleaned or len(cleaned) < 3:
        cleaned = f"user_{secrets.token_hex(3)}"
    return cleaned[:32]


def _unique_username(base: str) -> str:
    """base'in çakışmayan varyantını üretir: base, base2, base3..."""
    candidate = base
    suffix = 2
    while get_user_by_username(candidate) is not None:
        candidate = f"{base}{suffix}"
        suffix += 1
        if suffix > 999:
            return f"user_{secrets.token_hex(4)}"
    return candidate


def get_user_by_oauth(provider: str, provider_user_id: str) -> Optional[User]:
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT u.id, u.username, u.email, u.role, u.created_at
            FROM oauth_accounts oa
            JOIN users u ON u.id = oa.user_id
            WHERE oa.provider = ? AND oa.provider_user_id = ?
            """,
            (provider, provider_user_id),
        ).fetchone()
        return _row_to_user(row) if row else None


def _link_oauth_account(
    user_id: int, provider: str, provider_user_id: str, email: Optional[str]
) -> None:
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO oauth_accounts
                (provider, provider_user_id, user_id, email, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (provider, provider_user_id, user_id, email, time.time()),
        )
        conn.commit()


def find_oauth_user(provider: str, provider_user_id: str) -> Optional[User]:
    """
    LOGIN için: bu OAuth bağı kayıtlı mı? Yoksa None döner — endpoint reddeder.
    Hiçbir koşulda yeni user yaratmaz.
    """
    return get_user_by_oauth(provider, provider_user_id)


def register_oauth_user(
    provider: str,
    provider_user_id: str,
    email: Optional[str],
    name: Optional[str],
) -> User:
    """
    REGISTER için: yeni OAuth kullanıcısı oluşturur.
    Çakışma durumlarında ValueError fırlatır (endpoint 400 olarak iletir):
    - Bu OAuth hesabı zaten kayıtlıysa
    - Email'i zaten farklı bir hesapla eşleşmişse (klasik şifreli veya farklı OAuth)
    """
    # 1) Aynı OAuth bağı zaten varsa — kayıt değil, login akışına gitmesi gerek
    if get_user_by_oauth(provider, provider_user_id) is not None:
        raise ValueError("Bu hesap zaten kayıtlı. Lütfen giriş yap.")

    # 2) Email çakışması — başka bir kullanıcı bu email'i kullanıyorsa reddet
    normalized_email = email.strip().lower() if email else None
    if normalized_email and get_user_by_email(normalized_email) is not None:
        raise ValueError(
            f"Bu e-posta ({normalized_email}) zaten kayıtlı bir hesaba ait. "
            "O hesabınla giriş yap."
        )

    # 3) Yeni user yarat
    base = _slugify_username(
        name or (normalized_email.split("@")[0] if normalized_email else provider)
    )
    username = _unique_username(base)
    # OAuth user için rastgele şifre — kimse bilmez, sadece OAuth ile girer
    random_password = secrets.token_urlsafe(24)
    user = create_user(
        username=username,
        password=random_password,
        email=normalized_email,
        role="user",
    )
    # OAuth sağlayıcı zaten e-posta sahipliğini onayladı — verified say
    with get_db() as conn:
        conn.execute(
            "UPDATE users SET email_verified = 1 WHERE id = ?", (user["id"],)
        )
        conn.commit()
    _link_oauth_account(user["id"], provider, provider_user_id, normalized_email)
    return user


def _ensure_admin() -> None:
    """Startup'ta admin yoksa env'lerden alıp veya defaults ile oluşturur."""
    admin_username = os.getenv("ADMIN_USERNAME", DEFAULT_ADMIN_USERNAME).strip().lower()
    admin_email = os.getenv("ADMIN_EMAIL", "admin@lostick.local")

    if get_user_by_username(admin_username):
        return

    # ADMIN_PASSWORD env'i verilmemişse SABİT default yerine rastgele güçlü şifre üret.
    env_password = os.getenv("ADMIN_PASSWORD")
    admin_password = env_password if env_password else secrets.token_urlsafe(18)

    try:
        create_user(
            username=admin_username,
            password=admin_password,
            email=admin_email,
            role="admin",
        )
        print(f"✅ Admin hesabı oluşturuldu: {admin_username}")
        if not env_password:
            print(
                "⚠️  ADMIN_PASSWORD env tanımlı değil — rastgele şifre üretildi.\n"
                f"    Kullanıcı adı: {admin_username}\n"
                f"    Şifre        : {admin_password}\n"
                "    Bu şifreyi GÜVENLE kaydedin (bir daha gösterilmez) ve ilk girişten sonra değiştirin."
            )
    except ValueError as e:
        print(f"❌ Admin oluşturulamadı: {e}")


def cleanup_expired_sessions() -> int:
    """
    Süresi dolmuş ve replay tespit penceresini aşmış oturumları siler:
      - refresh süresi geçmiş kayıtlar
      - revoked + REVOKED_RETENTION_SECONDS'tan eski kayıtlar (replay penceresi kapanmış)
    Silinen satır sayısını döner.
    """
    now = time.time()
    with get_db() as conn:
        cur = conn.execute(
            """
            DELETE FROM sessions
            WHERE (refresh_expires_at IS NOT NULL AND refresh_expires_at < ?)
               OR (revoked = 1 AND COALESCE(last_used_at, created_at) < ?)
            """,
            (now, now - REVOKED_RETENTION_SECONDS),
        )
        conn.commit()
        return cur.rowcount
