import os
import boto3
from botocore.client import Config
from pathlib import Path
from typing import Optional

S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
S3_ENDPOINT_URL = os.getenv("S3_ENDPOINT_URL") # R2, MinIO vb. için isteğe bağlı uç nokta

_s3_client = None

def get_s3_client():
    """Boto3 S3 istemcisini singleton mantığıyla başlatır."""
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    if not S3_BUCKET_NAME or not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        return None
    try:
        session = boto3.Session(
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            region_name=AWS_REGION
        )
        # S3 Uyumlu özel uç noktalar (örn. Cloudflare R2, MinIO) için imzalama sürümü v4 zorlanır
        config = Config(signature_version='s3v4')
        _s3_client = session.client(
            's3',
            endpoint_url=S3_ENDPOINT_URL,
            config=config
        )
        return _s3_client
    except Exception as e:
        print(f"⚠️ S3 Bağlantı Hatası: {e}")
        return None

def is_s3_active() -> bool:
    """S3 çevre değişkenlerinin tanımlı ve bağlantının aktif olup olmadığını döner."""
    return get_s3_client() is not None

def upload_file_to_s3(local_path: Path, s3_key: str) -> bool:
    """Yerel bir dosyayı S3 bucket'ına yükler."""
    client = get_s3_client()
    if not client:
        return False
    try:
        client.upload_file(str(local_path), S3_BUCKET_NAME, s3_key)
        print(f"📤 Dosya S3'e yüklendi: {s3_key}")
        return True
    except Exception as e:
        print(f"❌ S3 Yükleme Hatası ({s3_key}): {e}")
        return False

def download_file_from_s3(local_path: Path, s3_key: str) -> bool:
    """S3'ten yerel diske dosya indirir."""
    client = get_s3_client()
    if not client:
        return False
    try:
        local_path.parent.mkdir(parents=True, exist_ok=True)
        client.download_file(S3_BUCKET_NAME, s3_key, str(local_path))
        print(f"📥 Dosya S3'ten indirildi: {s3_key}")
        return True
    except Exception as e:
        # Dosya S3'te yoksa bu durum hata değil, normal bir durum olabilir (yeni indexleme vb.)
        return False

def sync_faiss_to_s3(local_dir: Path, file_hash: str) -> None:
    """Yerel FAISS indeks dosyalarını S3'e yükler (yedekleme)."""
    if not is_s3_active():
        return
    for filename in ["index.faiss", "index.pkl", "integrity.sha256"]:
        local_file = local_dir / filename
        if local_file.exists():
            s3_key = f"faiss_cache/{file_hash}/{filename}"
            upload_file_to_s3(local_file, s3_key)

def sync_faiss_from_s3(local_dir: Path, file_hash: str) -> bool:
    """S3'teki FAISS indeks dosyalarını yerel diske indirir."""
    if not is_s3_active():
        return False
    downloaded = False
    for filename in ["index.faiss", "index.pkl", "integrity.sha256"]:
        local_file = local_dir / filename
        s3_key = f"faiss_cache/{file_hash}/{filename}"
        if download_file_from_s3(local_file, s3_key):
            downloaded = True
    return downloaded

def sync_ceviri_to_s3(local_file: Path, job_id: str, suffix: str) -> None:
    """Çevrilen döküman çıktılarını (pdf/json) S3'e yedekler."""
    if not is_s3_active():
        return
    s3_key = f"ceviri_cache/{job_id}.{suffix}"
    upload_file_to_s3(local_file, s3_key)

def sync_ceviri_from_s3(local_file: Path, job_id: str, suffix: str) -> bool:
    """Çevrilen döküman çıktılarını S3'ten yerel diske geri yükler."""
    if not is_s3_active():
        return False
    s3_key = f"ceviri_cache/{job_id}.{suffix}"
    return download_file_from_s3(local_file, s3_key)
