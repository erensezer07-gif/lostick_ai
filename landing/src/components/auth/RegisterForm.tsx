"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { register, type RegisterPendingResponse } from "@/lib/auth";
import SocialButtons from "./SocialButtons";
import EmailVerificationStep from "./EmailVerificationStep";

// E-posta format kontrolü (frontend tarafı — backend de ayrıca doğruluyor)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RegisterForm() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // YENİ: kayıt sonrası e-posta doğrulama adımı için pending state
  const [pending, setPending] = useState<RegisterPendingResponse | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (username.trim().length < 3) {
      setError("Kullanıcı adı en az 3 karakter olmalı.");
      return;
    }
    const emailTrimmed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(emailTrimmed)) {
      setError("Geçerli bir e-posta adresi gir (gmail, icloud, outlook, vb.).");
      return;
    }
    if (password.length < 6) {
      setError("Şifre en az 6 karakter olmalı.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("Şifreler birbirini tutmuyor.");
      return;
    }

    setLoading(true);
    try {
      const result = await register(username, password, emailTrimmed);
      // ÖNEMLİ: auto-login YOK. Kullanıcı 6 haneli kodu doğrulamak zorunda.
      setPending(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kayıt başarısız.");
    } finally {
      setLoading(false);
    }
  }

  // Pending state → verification step UI
  if (pending) {
    return (
      <EmailVerificationStep
        userId={pending.user_id}
        email={pending.email}
        username={pending.username}
        devMode={pending.dev_mode}
      />
    );
  }

  const inputCls =
    "w-full bg-surface-container-low border border-surface-container-highest focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none rounded px-3 py-2.5 font-body text-body-md text-on-surface placeholder:text-on-surface-variant/40 transition-colors";

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-md">
        <Link
          href="/"
          className="inline-block font-display font-extrabold text-headline-md text-primary-container tracking-tight mb-2"
        >
          Lostick
        </Link>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold text-on-surface mb-2 tracking-tight">
          Kayıt Ol
        </h1>
        <p className="font-body text-body-md text-on-surface-variant">
          Hesap aç, sohbet geçmişin ve PDF&apos;lerin senin olsun
        </p>
      </div>

      <div className="bg-surface-container-high border border-surface-container-highest rounded-xl p-md relative overflow-hidden ring-1 ring-white/5">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-surface-variant to-transparent opacity-50" />

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="reg-username" className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest block mb-xs">
              Kullanıcı Adı *
            </label>
            <input
              id="reg-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="en az 3 karakter"
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="reg-email" className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest block mb-xs">
              E-posta *
            </label>
            <input
              id="reg-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ad@gmail.com / ad@icloud.com / ad@outlook.com"
              className={inputCls}
            />
            <p className="font-mono text-label-sm text-on-surface-variant/70 mt-1">
              Hesabı aktive etmek için bu adrese 6 haneli kod gönderilir
            </p>
          </div>

          <div>
            <label htmlFor="reg-password" className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest block mb-xs">
              Şifre *
            </label>
            <div className="relative">
              <input
                id="reg-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="en az 6 karakter"
                className={`${inputCls} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
                tabIndex={-1}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary-container transition-colors"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {showPassword ? "visibility_off" : "visibility"}
                </span>
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="reg-password-confirm" className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest block mb-xs">
              Şifre Tekrar *
            </label>
            <div className="relative">
              <input
                id="reg-password-confirm"
                type={showPasswordConfirm ? "text" : "password"}
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                className={`${inputCls} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPasswordConfirm((v) => !v)}
                aria-label={showPasswordConfirm ? "Şifreyi gizle" : "Şifreyi göster"}
                tabIndex={-1}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary-container transition-colors"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {showPasswordConfirm ? "visibility_off" : "visibility"}
                </span>
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-error-container/15 border border-error/40 rounded-lg p-2.5 space-y-2">
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 16 }}>error</span>
                <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{error}</p>
              </div>
              {/zaten kay[ıi]t|zaten al[ıi]nm/i.test(error) && (
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1 font-mono text-label-sm text-primary hover:text-primary-fixed-dim transition-colors pl-6"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>login</span>
                  Giriş yapmak istiyorum
                </Link>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-on-primary-container font-body text-body-md font-bold py-3 rounded-lg hover:bg-primary-fixed-dim disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-primary/10 active:scale-[0.98] flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                Kayıt yapılıyor
              </>
            ) : (
              <>
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>person_add</span>
                <span className="font-bold uppercase tracking-wider">Hesap Oluştur</span>
              </>
            )}
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-surface-container-highest" />
            <span className="font-mono text-label-sm text-on-surface-variant/60 uppercase tracking-widest">veya</span>
            <div className="flex-1 h-px bg-surface-container-highest" />
          </div>

          {/* Social — register mode: yeni OAuth hesabı oluşturur */}
          <SocialButtons mode="register" />

          <p className="font-mono text-label-sm text-on-surface-variant text-center pt-1">
            Hesabın var mı?{" "}
            <Link href="/login" className="text-primary hover:text-primary-fixed transition-colors duration-200 font-medium">
              Giriş Yap
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
