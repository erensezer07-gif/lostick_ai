"""
E-posta gönderim servisi — transactional API'ler (SendGrid / Mailgun / AWS SES) +
SMTP (self-hosted) + dev için console fallback.

NEDEN SMTP TEK BAŞINA YETERSİZ?
  - Bulut sağlayıcıları (AWS, GCP, DigitalOcean, Vercel, Render…) Port 25'i ve çoğu
    zaman 465/587'yi de outbound'da bloklar (spam önleme).
  - SPF/DKIM/DMARC kayıtları doğru ayarlanmamışsa mailler Spam'e düşer ya da reddedilir.
  - Transactional API'ler (SendGrid vb.) HTTPS üstünden çalışır, bloklanmaz; ayrıca
    sağlayıcının kendi DKIM imzasını ekler → teslim oranı çok yüksektir.

PROVIDER SEÇİMİ:
  EMAIL_PROVIDER=sendgrid|mailgun|ses|smtp  → açık tanım kazanır
  Tanımsızsa env değişkenlerine bakıp otomatik tespit edilir:
    SENDGRID_API_KEY     → sendgrid
    MAILGUN_API_KEY + MAILGUN_DOMAIN → mailgun
    AWS_SES_REGION       → ses (boto3 IAM/env credentials'ı kullanır)
    SMTP_HOST + SMTP_USER + SMTP_PASS → smtp
    hiçbiri → console (dev fallback, kod terminale yazılır)

ENV (her provider için):
  # SendGrid
  EMAIL_PROVIDER=sendgrid
  SENDGRID_API_KEY=SG.xxxxxx

  # Mailgun
  EMAIL_PROVIDER=mailgun
  MAILGUN_API_KEY=key-xxxxxx
  MAILGUN_DOMAIN=mg.lostick.ai
  MAILGUN_REGION=us            # veya eu

  # AWS SES (boto3 ile)
  EMAIL_PROVIDER=ses
  AWS_SES_REGION=eu-central-1
  # AWS credentials: standart boto3 yöntemleri (IAM role / env / ~/.aws/credentials)

  # SMTP (self-hosted / Gmail App Password)
  EMAIL_PROVIDER=smtp
  SMTP_HOST=smtp.gmail.com
  SMTP_PORT=587
  SMTP_USER=...
  SMTP_PASS=...

ORTAK ENV:
  EMAIL_FROM=noreply@lostick.ai
  EMAIL_FROM_NAME=Lostick AI
  (Eski SMTP_FROM hâlâ desteklenir, geriye uyumluluk için)
"""

from __future__ import annotations

import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Optional

import httpx


# ─── Ortak gönderici kimliği ──────────────────────────────────────
EMAIL_FROM = (
    os.getenv("EMAIL_FROM", "").strip()
    or os.getenv("SMTP_FROM", "").strip()
    or os.getenv("SMTP_USER", "").strip()
    or "noreply@lostick.local"
)
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "Lostick AI").strip()


def _from_header() -> str:
    """RFC 5322 uyumlu From header'ı: 'Name <email>' veya sadece email."""
    if EMAIL_FROM_NAME:
        return f"{EMAIL_FROM_NAME} <{EMAIL_FROM}>"
    return EMAIL_FROM


# ─── Provider tespiti ─────────────────────────────────────────────
_VALID_PROVIDERS = ("sendgrid", "mailgun", "ses", "smtp", "console")


def _detect_provider() -> str:
    """Açık tanım > env tabanlı otomatik tespit > console fallback."""
    explicit = os.getenv("EMAIL_PROVIDER", "").strip().lower()
    if explicit:
        if explicit not in _VALID_PROVIDERS:
            print(f"⚠️  Email: bilinmeyen EMAIL_PROVIDER={explicit!r} — console fallback kullanılıyor.")
            return "console"
        return explicit
    if os.getenv("SENDGRID_API_KEY", "").strip():
        return "sendgrid"
    if os.getenv("MAILGUN_API_KEY", "").strip() and os.getenv("MAILGUN_DOMAIN", "").strip():
        return "mailgun"
    if os.getenv("AWS_SES_REGION", "").strip():
        return "ses"
    if (
        os.getenv("SMTP_HOST", "").strip()
        and os.getenv("SMTP_USER", "").strip()
        and os.getenv("SMTP_PASS", "")
    ):
        return "smtp"
    return "console"


# ─── Backend implementasyonları ───────────────────────────────────


def _send_sendgrid(to: str, subject: str, plaintext: str, html: str) -> tuple[bool, str]:
    api_key = os.getenv("SENDGRID_API_KEY", "").strip()
    if not api_key:
        return False, "SENDGRID_API_KEY tanımsız."
    payload = {
        "personalizations": [{"to": [{"email": to}]}],
        "from": {"email": EMAIL_FROM, "name": EMAIL_FROM_NAME or EMAIL_FROM},
        "subject": subject,
        "content": [
            {"type": "text/plain", "value": plaintext},
            {"type": "text/html", "value": html},
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=15.0) as c:
            r = c.post(
                "https://api.sendgrid.com/v3/mail/send",
                json=payload,
                headers=headers,
            )
    except httpx.HTTPError as e:
        return False, f"SendGrid bağlantı hatası: {e}"
    if 200 <= r.status_code < 300:
        # SendGrid X-Message-Id header'ında dönebilir
        return True, f"sent_sendgrid:{r.headers.get('X-Message-Id', '?')}"
    # Hata mesajını taşıma — debug için kısalt
    return False, f"SendGrid {r.status_code}: {r.text[:200]}"


def _send_mailgun(to: str, subject: str, plaintext: str, html: str) -> tuple[bool, str]:
    api_key = os.getenv("MAILGUN_API_KEY", "").strip()
    domain = os.getenv("MAILGUN_DOMAIN", "").strip()
    region = os.getenv("MAILGUN_REGION", "us").strip().lower()
    if not api_key or not domain:
        return False, "MAILGUN_API_KEY veya MAILGUN_DOMAIN tanımsız."
    base = "https://api.eu.mailgun.net" if region == "eu" else "https://api.mailgun.net"
    url = f"{base}/v3/{domain}/messages"
    data = {
        "from": _from_header(),
        "to": to,
        "subject": subject,
        "text": plaintext,
        "html": html,
    }
    try:
        with httpx.Client(timeout=15.0) as c:
            r = c.post(url, data=data, auth=("api", api_key))
    except httpx.HTTPError as e:
        return False, f"Mailgun bağlantı hatası: {e}"
    if 200 <= r.status_code < 300:
        try:
            msg_id = r.json().get("id", "?")
        except Exception:
            msg_id = "?"
        return True, f"sent_mailgun:{msg_id}"
    return False, f"Mailgun {r.status_code}: {r.text[:200]}"


def _send_ses(to: str, subject: str, plaintext: str, html: str) -> tuple[bool, str]:
    region = os.getenv("AWS_SES_REGION", "").strip()
    if not region:
        return False, "AWS_SES_REGION tanımsız."
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError:
        return False, "boto3 kurulu değil (requirements.txt'te olmalı)."
    try:
        client = boto3.client("ses", region_name=region)
        response = client.send_email(
            Source=_from_header(),
            Destination={"ToAddresses": [to]},
            Message={
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {
                    "Text": {"Data": plaintext, "Charset": "UTF-8"},
                    "Html": {"Data": html, "Charset": "UTF-8"},
                },
            },
        )
        return True, f"sent_ses:{response.get('MessageId', '?')[:16]}"
    except (BotoCoreError, ClientError) as e:
        return False, f"SES hatası: {e}"


def _send_smtp(to: str, subject: str, plaintext: str, html: str) -> tuple[bool, str]:
    """Self-hosted veya Gmail App Password ile SMTP. Bulut sağlayıcılarda
    çoğunlukla outbound port'ları bloklu olduğu için ÜRETİMDE TERCİH EDİLMEZ."""
    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "587") or 587)
    user = os.getenv("SMTP_USER", "").strip()
    pwd = os.getenv("SMTP_PASS", "")
    if not host or not user or not pwd:
        return False, "SMTP_HOST/SMTP_USER/SMTP_PASS tanımsız."

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _from_header()
    msg["To"] = to
    msg.set_content(plaintext)
    msg.add_alternative(html, subtype="html")

    try:
        context = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as server:
                server.login(user, pwd)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(user, pwd)
                server.send_message(msg)
        return True, "sent_smtp"
    except smtplib.SMTPAuthenticationError:
        return False, "SMTP kimlik doğrulama başarısız — SMTP_USER/SMTP_PASS kontrol et."
    except smtplib.SMTPException as e:
        return False, f"SMTP hatası: {e}"
    except OSError as e:
        return False, f"SMTP bağlantı hatası (port bloklu olabilir): {e}"


def _send_console(
    to: str, subject: str, plaintext: str, html: str, *, code: Optional[str] = None
) -> tuple[bool, str]:
    """Dev fallback — provider tanımsızken kodu terminale basar."""
    print("\n" + "=" * 64)
    print("📧 [DEV] Email provider tanımsız — console fallback")
    print(f"   To:      {to}")
    print(f"   From:    {_from_header()}")
    print(f"   Subject: {subject}")
    if code:
        print(f"   CODE:    {code}")
    print(f"   (Body: {len(plaintext)} byte plaintext, {len(html)} byte HTML)")
    print("=" * 64 + "\n")
    return True, "dev_console"


# ─── Tek noktadan dispatch ────────────────────────────────────────


def _dispatch(
    to: str,
    subject: str,
    plaintext: str,
    html: str,
    *,
    dev_code: Optional[str] = None,
) -> tuple[bool, str]:
    """Provider'a göre uygun backend'i çağırır. ok=True/False, info=mesaj."""
    if not to or "@" not in to:
        return False, "Geçersiz alıcı e-postası."

    provider = _detect_provider()
    if provider == "sendgrid":
        return _send_sendgrid(to, subject, plaintext, html)
    if provider == "mailgun":
        return _send_mailgun(to, subject, plaintext, html)
    if provider == "ses":
        return _send_ses(to, subject, plaintext, html)
    if provider == "smtp":
        return _send_smtp(to, subject, plaintext, html)
    return _send_console(to, subject, plaintext, html, code=dev_code)


# ─── Şablon: doğrulama kodu ───────────────────────────────────────


def _build_code_email(
    *,
    title: str,
    heading: str,
    intro: str,
    outro: str,
    code: str,
    username: Optional[str],
) -> tuple[str, str]:
    """Doğrulama + şifre sıfırlama için ortak şablon. (plaintext, html) döner."""
    greeting = f"Merhaba {username}," if username else "Merhaba,"

    plaintext = f"""\
{greeting}

{intro}

Kodun: {code}

Kod 15 dakika içinde geçerliliğini yitirir.

{outro}

— Lostick AI
"""

    html = f"""\
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>Lostick AI - {title}</title>
</head>
<body style="margin:0;padding:24px;background:#131313;font-family:Inter,Arial,sans-serif;color:#e5e2e1;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
    <tr><td style="padding:24px 0;">
      <h1 style="margin:0;font-family:'Hanken Grotesk',Arial,sans-serif;font-weight:800;font-size:24px;color:#ffc107;letter-spacing:-0.01em;">
        Lostick AI
      </h1>
    </td></tr>
    <tr><td style="background:#201f1f;border:1px solid #353534;border-radius:8px;padding:32px;">
      <h2 style="margin:0 0 16px;font-family:'Hanken Grotesk',Arial,sans-serif;font-weight:700;font-size:20px;color:#e5e2e1;">
        {heading}
      </h2>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#d4c5ab;">
        {greeting}<br>{intro}
      </p>
      <div style="background:#0e0e0e;border:1px solid #fabd00;border-radius:8px;padding:24px;text-align:center;margin:0 0 24px;">
        <div style="font-family:'JetBrains Mono',Consolas,monospace;font-weight:700;font-size:32px;letter-spacing:0.4em;color:#ffc107;">
          {code}
        </div>
      </div>
      <p style="margin:0 0 8px;font-size:13px;color:#9c8f78;">
        Kod 15 dakika içinde geçerliliğini yitirir.
      </p>
      <p style="margin:0;font-size:13px;color:#9c8f78;">
        {outro}
      </p>
    </td></tr>
    <tr><td style="padding:24px 0;text-align:center;color:#4f4632;font-size:12px;font-family:'JetBrains Mono',Consolas,monospace;letter-spacing:0.05em;text-transform:uppercase;">
      Lostick AI · Otomatik gönderildi
    </td></tr>
  </table>
</body>
</html>
"""
    return plaintext, html


# ─── Public API (geriye uyumlu) ───────────────────────────────────


def send_verification_email(
    to_email: str, code: str, username: Optional[str] = None
) -> tuple[bool, str]:
    """E-posta doğrulama kodu gönder. Returns: (ok, info)."""
    plaintext, html = _build_code_email(
        title="Doğrulama Kodu",
        heading="E-posta Doğrulama",
        intro="Lostick AI hesabını tamamlamak için aşağıdaki 6 haneli kodu kayıt sayfasında ilgili kutuya gir.",
        outro="Bu isteği sen yapmadıysan bu e-postayı yok say — hesap aktive edilmediği sürece güvendesin.",
        code=code,
        username=username,
    )
    return _dispatch(
        to_email,
        "Lostick AI — E-posta Doğrulama Kodu",
        plaintext,
        html,
        dev_code=code,
    )


def send_password_reset_email(
    to_email: str, code: str, username: Optional[str] = None
) -> tuple[bool, str]:
    """Şifre sıfırlama kodu gönder. Returns: (ok, info)."""
    plaintext, html = _build_code_email(
        title="Şifre Sıfırlama",
        heading="Şifre Sıfırlama Talebi",
        intro="Hesap şifreni sıfırlamak için aşağıdaki 6 haneli kodu ilgili sayfaya gir.",
        outro="Bu isteği sen yapmadıysan, bu e-postayı güvenle yok sayabilirsin. Şifren değişmeyecektir.",
        code=code,
        username=username,
    )
    return _dispatch(
        to_email,
        "Lostick AI — Şifre Sıfırlama Kodu",
        plaintext,
        html,
        dev_code=code,
    )


# main.py dev_console kontrolü info == "dev_console" string eşitliği yapıyor.
# Yeni provider'lar farklı info string'leri döndürür ama eski "dev_console" anahtarı
# console fallback için aynen korundu, böylece frontend dev hint'i bozulmaz.
