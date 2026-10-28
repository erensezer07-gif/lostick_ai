"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { verifyEmail, resendVerification } from "@/lib/auth";

interface Props {
  userId: number;
  email: string;
  username: string;
  devMode?: boolean;
}

const CODE_LENGTH = 6;

/**
 * E-posta doğrulama adımı — register sonrası gösterilir.
 * 6 haneli kod kutusu (her hane ayrı input gibi görünür)
 * + "Yeniden gönder" CTA + 30 sn cooldown
 * Doğrulama başarılı olunca /login'e yönlenir.
 */
export default function EmailVerificationStep({
  userId,
  email,
  username,
  devMode,
}: Props) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(30);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Otomatik focus
  useEffect(() => {
    codeInputRef.current?.focus();
  }, []);

  // Cooldown sayacı
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  function maskedEmail(e: string): string {
    const [local, domain] = e.split("@");
    if (!local || !domain) return e;
    if (local.length <= 2) return `${local[0]}*@${domain}`;
    return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 3))}${local.slice(-1)}@${domain}`;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== CODE_LENGTH || loading) return;
    setError(null);
    setLoading(true);
    try {
      await verifyEmail(userId, code);
      setSuccess(true);
      // 1.2 sn sonra login'e yönlenip success param'ı ile karşıla
      setTimeout(() => {
        router.push(`/login?verified=${encodeURIComponent(username)}`);
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Doğrulama başarısız.");
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || loading) return;
    setError(null);
    setResendInfo(null);
    try {
      const result = await resendVerification(userId);
      setResendCooldown(30);
      setResendInfo(
        result.dev_mode
          ? "Yeni kod gönderildi. (DEV: sunucu konsolundan oku)"
          : "Yeni kod e-postana gönderildi.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Yeniden gönderim başarısız.");
    }
  }

  function handleCodeChange(value: string) {
    const digitsOnly = value.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digitsOnly);
    setError(null);
  }

  if (success) {
    return (
      <div className="w-full max-w-md bg-surface-container-high border border-surface-container-highest rounded-xl p-md ring-1 ring-white/5 text-center space-y-3">
        <div className="w-14 h-14 mx-auto rounded-full bg-primary-container/15 border-2 border-primary-container/40 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 32 }}>
            check_circle
          </span>
        </div>
        <h2 className="font-display text-2xl font-bold text-on-surface">Hesap Aktifleştirildi</h2>
        <p className="font-body text-body-md text-on-surface-variant">
          Şimdi giriş sayfasına yönlendiriliyorsun...
        </p>
        <div className="flex items-center justify-center gap-2 pt-2">
          <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
          <span className="font-mono text-label-sm text-on-surface-variant">Yönlendiriliyor</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-md">
        <div className="w-14 h-14 mx-auto rounded-lg bg-surface-container-high border border-surface-container-highest flex items-center justify-center mb-3">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: 28 }}>
            mark_email_unread
          </span>
        </div>
        <h1 className="font-display text-2xl md:text-3xl font-extrabold text-on-surface mb-2 tracking-tight">
          E-postanı Doğrula
        </h1>
        <p className="font-body text-body-md text-on-surface-variant">
          <strong className="text-on-surface">{maskedEmail(email)}</strong> adresine 6 haneli bir kod gönderdik
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-surface-container-high border border-surface-container-highest rounded-xl p-md space-y-md relative overflow-hidden ring-1 ring-white/5"
      >
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-surface-variant to-transparent opacity-50" />

        <div>
          <label
            htmlFor="verify-code"
            className="block font-mono text-label-sm text-on-surface-variant mb-xs font-medium tracking-wide uppercase"
          >
            Doğrulama Kodu
          </label>
          <input
            ref={codeInputRef}
            id="verify-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => handleCodeChange(e.target.value)}
            placeholder="••••••"
            maxLength={CODE_LENGTH}
            className="w-full bg-surface-container-low border border-surface-container-highest focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none rounded px-3 py-3 font-mono text-center text-2xl tracking-[0.5em] text-on-surface placeholder:text-on-surface-variant/30 transition-colors"
          />
          <p className="font-mono text-label-sm text-on-surface-variant/70 mt-1.5">
            Kod 15 dakika geçerli · Spam klasörünü kontrol etmeyi unutma
          </p>
        </div>

        {devMode && (
          <div className="bg-primary-container/10 border border-primary-container/40 rounded-lg p-2.5">
            <p className="font-mono text-label-sm text-primary [overflow-wrap:anywhere]">
              <strong>[DEV MODE]</strong> SMTP yapılandırılmamış. Kodu sunucu terminalinden oku.
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-error-container/15 border border-error/40 rounded-lg p-2.5">
            <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 16 }}>
              error
            </span>
            <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{error}</p>
          </div>
        )}

        {resendInfo && (
          <div className="flex items-start gap-2 bg-primary-container/10 border border-primary-container/30 rounded-lg p-2.5">
            <span className="material-symbols-outlined text-primary flex-shrink-0" style={{ fontSize: 16 }}>
              mail
            </span>
            <p className="font-mono text-label-sm text-primary [overflow-wrap:anywhere]">{resendInfo}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || code.length !== CODE_LENGTH}
          className="w-full bg-primary text-on-primary-container font-body text-body-md font-bold py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-primary-fixed-dim disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-primary/10 active:scale-[0.98]"
        >
          {loading ? (
            <>
              <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
              Doğrulanıyor
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                verified
              </span>
              <span className="font-bold uppercase tracking-wider">Doğrula</span>
            </>
          )}
        </button>

        <div className="text-center pt-1">
          <button
            type="button"
            onClick={handleResend}
            disabled={resendCooldown > 0 || loading}
            className="font-mono text-label-sm text-primary hover:text-primary-fixed-dim disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              refresh
            </span>
            {resendCooldown > 0
              ? `Yeniden gönder (${resendCooldown}s)`
              : "Kodu yeniden gönder"}
          </button>
        </div>
      </form>
    </div>
  );
}
