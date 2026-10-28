"use client";

import { FormEvent, useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { forgotPassword, resetPassword, type ForgotPasswordResponse } from "@/lib/auth";

type Step = "request" | "reset";
const CODE_LENGTH = 6;

export default function ForgotPasswordForm() {
  const router = useRouter();
  
  // State
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Pending reset data
  const [resetData, setResetData] = useState<ForgotPasswordResponse | null>(null);
  const [success, setSuccess] = useState(false);
  
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus after step change
  useEffect(() => {
    if (step === "reset") {
      codeInputRef.current?.focus();
    }
  }, [step]);

  async function handleRequestSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || loading) return;
    
    setError(null);
    setLoading(true);
    
    try {
      const data = await forgotPassword(email);
      setResetData(data);
      setStep("reset");
    } catch (err) {
      setError(err instanceof Error ? err.message : "İşlem başarısız.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetSubmit(e: FormEvent) {
    e.preventDefault();
    if (code.length !== CODE_LENGTH || !newPassword || !resetData || loading) return;
    
    setError(null);
    setLoading(true);
    
    try {
      await resetPassword(resetData.user_id, code, newPassword);
      setSuccess(true);
      setTimeout(() => {
        router.push("/login");
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Şifre sıfırlama başarısız.");
      setLoading(false);
    }
  }

  function handleCodeChange(value: string) {
    const digitsOnly = value.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digitsOnly);
    setError(null);
  }

  const inputCls =
    "w-full bg-surface-container-low text-on-surface font-body text-body-md px-3 py-2.5 rounded border border-surface-container-highest focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-colors duration-200 placeholder:text-on-surface-variant/50";

  if (success) {
    return (
      <div className="w-full max-w-md bg-surface-container-high border border-surface-container-highest rounded-xl p-md ring-1 ring-white/5 text-center space-y-3 shadow-lg">
        <div className="w-14 h-14 mx-auto rounded-full bg-primary-container/15 border-2 border-primary-container/40 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 32 }}>
            check_circle
          </span>
        </div>
        <h2 className="font-display text-2xl font-bold text-on-surface">Şifreniz Sıfırlandı</h2>
        <p className="font-body text-body-md text-on-surface-variant">
          Yeni şifrenizle giriş yapabilirsiniz. Yönlendiriliyorsunuz...
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
        <div className="w-14 h-14 mx-auto rounded-lg bg-surface-container-high border border-surface-container-highest flex items-center justify-center mb-3 shadow-sm">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: 28 }}>
            lock_reset
          </span>
        </div>
        <h1 className="font-display text-2xl md:text-3xl font-extrabold text-on-surface mb-2 tracking-tight">
          Şifremi Unuttum
        </h1>
        <p className="font-body text-body-md text-on-surface-variant">
          {step === "request" 
            ? "Hesabınıza bağlı e-posta adresini girin."
            : `Hesabınıza ait e-posta adresine (${email}) gönderilen kodu girin.`
          }
        </p>
      </div>

      <div className="bg-surface-container-high border border-surface-container-highest rounded-xl p-md shadow-lg relative overflow-hidden ring-1 ring-white/5">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-surface-variant to-transparent opacity-50" />

        {step === "request" ? (
          <form onSubmit={handleRequestSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block font-mono text-label-sm text-on-surface-variant mb-xs font-medium tracking-wide uppercase">
                E-posta Adresi
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ornek@email.com"
                className={inputCls}
                disabled={loading}
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-error-container/15 border border-error/40 rounded-lg p-2.5">
                <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 16 }}>error</span>
                <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full bg-primary text-on-primary-container font-body text-body-md font-bold py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-primary-fixed-dim disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-primary/10 active:scale-[0.98]"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                  Gönderiliyor
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>send</span>
                  <span className="font-bold uppercase tracking-wider">Kodu Gönder</span>
                </>
              )}
            </button>
            
            <p className="font-mono text-label-sm text-on-surface-variant text-center pt-2">
              <Link href="/login" className="text-primary hover:text-primary-fixed hover:underline transition-colors duration-200">
                Giriş sayfasına dön
              </Link>
            </p>
          </form>
        ) : (
          <form onSubmit={handleResetSubmit} className="space-y-4">
            <div>
              <label htmlFor="reset-code" className="block font-mono text-label-sm text-on-surface-variant mb-xs font-medium tracking-wide uppercase">
                Doğrulama Kodu
              </label>
              <input
                ref={codeInputRef}
                id="reset-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => handleCodeChange(e.target.value)}
                placeholder="••••••"
                maxLength={CODE_LENGTH}
                className="w-full bg-surface-container-low border border-surface-container-highest focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none rounded px-3 py-3 font-mono text-center text-2xl tracking-[0.5em] text-on-surface placeholder:text-on-surface-variant/30 transition-colors"
                disabled={loading}
              />
              <p className="font-mono text-label-sm text-on-surface-variant/70 mt-1.5">
                Kod 15 dakika geçerli · Spam klasörünü kontrol edin
              </p>
            </div>
            
            {resetData?.dev_mode && (
              <div className="bg-primary-container/10 border border-primary-container/40 rounded-lg p-2.5">
                <p className="font-mono text-label-sm text-primary [overflow-wrap:anywhere]">
                  <strong>[DEV MODE]</strong> SMTP yapılandırılmamış. Kodu sunucu terminalinden oku.
                </p>
              </div>
            )}

            <div>
              <label htmlFor="new-password" className="block font-mono text-label-sm text-on-surface-variant mb-xs font-medium tracking-wide uppercase">
                Yeni Şifre
              </label>
              <div className="relative">
                <input
                  id="new-password"
                  type={showNewPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••"
                  className={`${inputCls} pr-10`}
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword((v) => !v)}
                  aria-label={showNewPassword ? "Şifreyi gizle" : "Şifreyi göster"}
                  tabIndex={-1}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary-container transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    {showNewPassword ? "visibility_off" : "visibility"}
                  </span>
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-error-container/15 border border-error/40 rounded-lg p-2.5">
                <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 16 }}>error</span>
                <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || code.length !== CODE_LENGTH || !newPassword}
              className="w-full bg-primary text-on-primary-container font-body text-body-md font-bold py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-primary-fixed-dim disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-primary/10 active:scale-[0.98]"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                  Sıfırlanıyor
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>key</span>
                  <span className="font-bold uppercase tracking-wider">Şifreyi Güncelle</span>
                </>
              )}
            </button>
            
            <p className="font-mono text-label-sm text-on-surface-variant text-center pt-2">
              Yanlış e-posta mı?{" "}
              <button 
                type="button" 
                onClick={() => setStep("request")} 
                className="text-primary hover:text-primary-fixed hover:underline transition-colors duration-200"
                disabled={loading}
              >
                Geri dön
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
