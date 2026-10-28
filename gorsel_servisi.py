"""
Wikimedia Commons üzerinden ücretsiz görsel çekme servisi.

Mimari:
- LLM cevabında <gorsel q="...">başlık</gorsel> etiketleri bırakır
- Bu modül etiketleri parse eder, Commons API'sini sorgular
- SQLite cache ile aynı sorgu tekrarlanmaz (Wikimedia rate-limit'i pratikte yok ama hız için)
- Etiketler markdown ![alt](url) syntax'ına dönüşür
"""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Optional, TypedDict

import httpx
from db_pool import get_gorsel_db

CACHE_DB_PATH = Path(__file__).parent / "gorsel_cache.db"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "LostickAI/1.0 (Educational; contact: sezereren44@gmail.com)"
REQUEST_TIMEOUT = 6.0
MAX_THUMB_WIDTH = 800

# Arapça, İbranice, Çince vs. dil varyantı dosya isimlerini elemek için suffix listesi
LANGUAGE_VARIANT_SUFFIXES = (
    "_ar.", "_he.", "_fa.", "_ur.", "_ru.", "_uk.", "_bg.",
    "_zh.", "_ja.", "_ko.", "_th.", "_hi.", "_bn.", "_ta.",
    "_el.", "_hy.", "_ka.", "_my.", "_km.", "_lo.",
    "-ar.", "-he.", "-fa.", "-zh.", "-ja.", "-ko.", "-ru.",
)

# LLM çıktısındaki etiket formatı:  <gorsel q="english query">Türkçe başlık</gorsel>
TAG_PATTERN = re.compile(
    r'<gorsel\s+q\s*=\s*["\']([^"\']+)["\']\s*>(.*?)</gorsel>',
    re.IGNORECASE | re.DOTALL,
)


class ImageResult(TypedDict):
    url: str
    title: str
    descriptionurl: str


def init_image_cache() -> None:
    """SQLite cache tablosunu oluştur (idempotent)."""
    with get_gorsel_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS image_cache (
                query TEXT PRIMARY KEY,
                url TEXT,
                title TEXT,
                descriptionurl TEXT,
                cached_at REAL
            )
            """
        )
        # Negatif sonuçlar için ayrı tablo (bulunamadı kaydı, 7 günde retry)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS image_misses (
                query TEXT PRIMARY KEY,
                missed_at REAL
            )
            """
        )
        conn.commit()


def _cache_get(query: str) -> Optional[ImageResult]:
    with get_gorsel_db() as conn:
        row = conn.execute(
            "SELECT url, title, descriptionurl FROM image_cache WHERE query = ?",
            (query.lower().strip(),),
        ).fetchone()
        if row:
            return {"url": row[0], "title": row[1], "descriptionurl": row[2]}

        miss = conn.execute(
            "SELECT missed_at FROM image_misses WHERE query = ?",
            (query.lower().strip(),),
        ).fetchone()
        if miss:
            # Son 7 gündeki miss'leri saygıyla tekrar deneme
            if time.time() - miss[0] < 7 * 24 * 3600:
                return None
        return None


def _cache_set(query: str, result: Optional[ImageResult]) -> None:
    with get_gorsel_db() as conn:
        normalized = query.lower().strip()
        now = time.time()
        if result is not None:
            conn.execute(
                "INSERT OR REPLACE INTO image_cache VALUES (?, ?, ?, ?, ?)",
                (
                    normalized,
                    result["url"],
                    result["title"],
                    result["descriptionurl"],
                    now,
                ),
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO image_misses VALUES (?, ?)",
                (normalized, now),
            )
        conn.commit()


def _is_acceptable_filename(filename: str) -> bool:
    """Arapça/İbranice/Çince vs. dil varyantı dosyalarını ele."""
    name = filename.replace("File:", "").lower()

    # Dil suffix'leri (örn: _ar.svg, -zh.png)
    for suffix in LANGUAGE_VARIANT_SUFFIXES:
        if suffix in name:
            return False

    # Non-ASCII karakterler (Arapça, Çince, Kiril vb.) içeren başlıkları reddet
    if any(ord(c) > 127 for c in name):
        return False

    # Yaygın resim uzantısı olmalı
    if not name.endswith((".jpg", ".jpeg", ".png", ".svg", ".gif", ".webp")):
        return False

    return True


async def _wikipedia_article_image(
    query: str, client: httpx.AsyncClient
) -> Optional[ImageResult]:
    """
    İngilizce Wikipedia'da konuyla ilgili makaleyi bulup ana görselini (infobox image)
    döndürür. Bu yaklaşım kanonik İngilizce diyagramları getirir — dil varyantı yok.
    """
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": query,
        "gsrlimit": "3",
        "gsrnamespace": "0",  # Article namespace (ana makaleler)
        "prop": "pageimages|info",
        "piprop": "thumbnail|original",
        "pithumbsize": str(MAX_THUMB_WIDTH),
        "inprop": "url",
    }
    try:
        resp = await client.get(
            WIKIPEDIA_API, params=params, timeout=REQUEST_TIMEOUT
        )
        resp.raise_for_status()
    except (httpx.HTTPError, httpx.TimeoutException):
        return None

    pages = resp.json().get("query", {}).get("pages", {})
    if not pages:
        return None

    # Arama sıralamasına göre sırala (index düşük = daha alakalı)
    candidates = list(pages.values())
    candidates.sort(key=lambda p: p.get("index", 999))

    for page in candidates:
        thumbnail = page.get("thumbnail")
        if not thumbnail or not thumbnail.get("source"):
            continue
        # Wikipedia infobox görseli — büyük ihtimalle İngilizce ve kalite yüksek
        return {
            "url": thumbnail["source"],
            "title": page.get("title", ""),
            "descriptionurl": page.get("fullurl") or page.get("canonicalurl") or "",
        }
    return None


async def _commons_file_search(
    query: str, client: httpx.AsyncClient
) -> Optional[ImageResult]:
    """Wikipedia makalesinde uygun görsel bulunamazsa Commons file search fallback."""
    search_params = {
        "action": "query",
        "format": "json",
        "list": "search",
        "srsearch": f"{query} filetype:bitmap|drawing",
        "srnamespace": "6",  # File: namespace
        "srlimit": "10",  # Dil filtresine takılanları atlayabilmek için fazla iste
    }
    try:
        search_resp = await client.get(
            COMMONS_API, params=search_params, timeout=REQUEST_TIMEOUT
        )
        search_resp.raise_for_status()
    except (httpx.HTTPError, httpx.TimeoutException):
        return None

    results = search_resp.json().get("query", {}).get("search", [])
    if not results:
        return None

    # Dil varyantlarını ele, ilk uygun dosyayı seç
    title: Optional[str] = None
    for item in results:
        candidate = item.get("title", "")
        if _is_acceptable_filename(candidate):
            title = candidate
            break
    if title is None:
        return None

    # Thumbnail çek
    info_params = {
        "action": "query",
        "format": "json",
        "titles": title,
        "prop": "imageinfo",
        "iiprop": "url|size",
        "iiurlwidth": str(MAX_THUMB_WIDTH),
    }
    try:
        info_resp = await client.get(
            COMMONS_API, params=info_params, timeout=REQUEST_TIMEOUT
        )
        info_resp.raise_for_status()
    except (httpx.HTTPError, httpx.TimeoutException):
        return None

    pages = info_resp.json().get("query", {}).get("pages", {})
    for _page_id, page_data in pages.items():
        imageinfo = page_data.get("imageinfo", [])
        if not imageinfo:
            continue
        info = imageinfo[0]
        url = info.get("thumburl") or info.get("url")
        if not url:
            continue
        return {
            "url": url,
            "title": title.replace("File:", "").replace("_", " "),
            "descriptionurl": info.get("descriptionurl", ""),
        }
    return None


async def _wikimedia_lookup(
    query: str, client: httpx.AsyncClient
) -> Optional[ImageResult]:
    """
    İki aşamalı arama:
    1) Önce İngilizce Wikipedia makale infobox görseli (en doğrusu)
    2) Bulunamazsa Commons file search'e fallback (dil filtreli)
    """
    article_image = await _wikipedia_article_image(query, client)
    if article_image is not None:
        return article_image
    return await _commons_file_search(query, client)


async def _search_with_cache(
    query: str, client: httpx.AsyncClient
) -> Optional[ImageResult]:
    cached = _cache_get(query)
    if cached is not None:
        return cached
    result = await _wikimedia_lookup(query, client)
    _cache_set(query, result)
    return result


def _format_markdown(
    caption: str, result: Optional[ImageResult]
) -> str:
    """Etiketi markdown image+caption blokuna dönüştür."""
    if result is None or not result.get("url"):
        return ""  # Bulunamadıysa etiketi sessizce sil
    url = result["url"]
    desc_url = result.get("descriptionurl", "")
    attribution = f" · [Kaynak: Wikimedia Commons]({desc_url})" if desc_url else ""
    # Boş satırlarla çevreliyoruz ki markdown paragraf akışı bozulmasın
    return (
        f"\n\n![{caption}]({url})\n\n"
        f"*{caption}{attribution}*\n\n"
    )


async def replace_image_tags(text: str) -> str:
    """LLM metnindeki <gorsel q="...">başlık</gorsel> etiketlerini paralel olarak çözer."""
    matches = list(TAG_PATTERN.finditer(text))
    if not matches:
        return text

    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    ) as client:
        queries = [m.group(1).strip() for m in matches]
        results = await asyncio.gather(
            *[_search_with_cache(q, client) for q in queries],
            return_exceptions=True,
        )

    parts: list[str] = []
    last_end = 0
    for match, result in zip(matches, results):
        parts.append(text[last_end:match.start()])
        caption = match.group(2).strip()
        if isinstance(result, dict):
            parts.append(_format_markdown(caption, result))
        # Exception veya None → etiket sessizce yok edilir
        last_end = match.end()
    parts.append(text[last_end:])
    return "".join(parts)
