"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  login,
  isAuthenticated,
  NotVerifiedError,
  type EmailNotVerifiedError,
} from "@/lib/auth";
import { setUserApiKey } from "@/lib/apiKey";
import SocialButtons from "./SocialButtons";
import EmailVerificationStep from "./EmailVerificationStep";

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Hesap + API key formu
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);

  // E-posta doğrulanmamış kullanıcı için pending state (login sırasında 403 gelirse)
  const [pendingVerification, setPendingVerification] = useState<EmailNotVerifiedError | null>(null);

  // Giriş yapmış kullanıcı /login'e düşerse (geri butonu vs.) anında ana sayfaya at —
  // login sayfasının geçmişte kalmasını ve geri tuşuyla ulaşılmasını engeller.
  useEffect(() => {
    if (isAuthenticated()) {
      router.replace("/");
    }
  }, [router]);

  // URL'de ?verified=username[&provider=google|github] varsa başarı banner'ı göster
  const verifiedUsername = searchParams?.get("verified");
  const verifiedProvider = searchParams?.get("provider"); // "google" | "github" | null (email)
  useEffect(() => {
    // E-posta doğrulama sonrası username'i auto-fill et (kullanıcı şifre + key yazsın)
    // OAuth register sonrası username dolu — sosyal sekmeyi öne çıkar
    if (verifiedUsername && !verifiedProvider) {
      setUsername(verifiedUsername);
    }
  }, [verifiedUsername, verifiedProvider]);

  async function handleAccountSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setAccountError(null);

    // API key zorunlu
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setAccountError("Gemini API key zorunludur. Aşağıdaki adımları takip ederek ücretsiz alabilirsin.");
      return;
    }
    if (!trimmedKey.startsWith("AIza")) {
      setAccountError("API key formatı hatalı — 'AIza' ile başlamalı.");
      return;
    }

    setAccountLoading(true);
    try {
      await login(username, password);
      setUserApiKey(trimmedKey);
      router.replace("/");
    } catch (err) {
      // E-postası doğrulanmamış → verification adımına geç
      if (err instanceof NotVerifiedError) {
        setPendingVerification(err.info);
        setAccountError(null);
      } else {
        setAccountError(err instanceof Error ? err.message : "Giriş başarısız.");
      }
    } finally {
      setAccountLoading(false);
    }
  }

  // Login sırasında 403 email_not_verified geldiyse verification adımına geç
  if (pendingVerification) {
    return (
      <EmailVerificationStep
        userId={pendingVerification.user_id}
        email={pendingVerification.email}
        username={username || "kullanıcı"}
      />
    );
  }

  const inputCls =
    "w-full bg-surface-container-low text-on-surface font-body text-body-md px-3 py-2.5 rounded border border-surface-container-highest focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-colors duration-200 placeholder:text-on-surface-variant/50";

  return (
    <div className="w-full max-w-[920px] flex flex-col lg:flex-row gap-lg items-center">
      {/* ── SOL TARAF: Bilgi alanı ── */}
      <div className="w-full lg:w-[380px] flex-shrink-0 text-center lg:text-left">
        <h1 className="font-display font-extrabold text-headline-md text-primary-container mb-2 tracking-tight">
          LOSTICK AI
        </h1>
        <h2 className="font-display text-3xl md:text-4xl font-extrabold text-on-surface mb-3 tracking-tight">
          Giriş Yap
        </h2>
        <p className="font-body text-body-md text-on-surface-variant mb-md">
          Hesabınla ve Gemini API key&apos;inle giriş yap
        </p>

        {/* Kısa platform bilgisi */}
        <div className="space-y-3 hidden lg:block">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-primary flex-shrink-0 mt-0.5" style={{ fontSize: 20 }}>
              smart_toy
            </span>
            <p className="font-body text-sm text-on-surface-variant">
              <strong className="text-on-surface">Yapay zeka destekli öğrenim.</strong>{" "}
              PDF&apos;lerini yükle, konuları sıfırdan anlat, sorularla pekiştir.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-primary flex-shrink-0 mt-0.5" style={{ fontSize: 20 }}>
              quiz
            </span>
            <p className="font-body text-sm text-on-surface-variant">
              <strong className="text-on-surface">Otomatik test üretimi.</strong>{" "}
              Ders notlarından çoktan seçmeli sınav hazırla, anında geri bildirim al.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-primary flex-shrink-0 mt-0.5" style={{ fontSize: 20 }}>
              menu_book
            </span>
            <p className="font-body text-sm text-on-surface-variant">
              <strong className="text-on-surface">Konu anlatım motoru.</strong>{" "}
              Mermaid diyagramları ve görsellerle zenginleştirilmiş detaylı anlatımlar.
            </p>
          </div>
        </div>
      </div>

      {/* ── SAĞ TARAF: Login kartı ── */}
      <div className="w-full lg:flex-1 max-w-md">
        {/* Content Card */}
        <div className="bg-surface-container-high rounded-xl p-md border border-surface-container-highest shadow-lg relative overflow-hidden ring-1 ring-white/5">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-surface-variant to-transparent opacity-50" />

          {/* Hesap aktive edildi banner'ı — register sonrası /login'e redirect */}
          {verifiedUsername && (
            <div className="flex items-start gap-2 bg-primary-container/10 border border-primary-container/40 rounded-lg p-2.5 mb-3">
              <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 18 }}>
                check_circle
              </span>
              <div className="flex-1">
                <p className="font-headline font-semibold text-on-surface text-sm">
                  {verifiedProvider === "google"
                    ? "Google hesabınla kayıt başarılı"
                    : verifiedProvider === "github"
                      ? "GitHub hesabınla kayıt başarılı"
                      : "Hesabın aktifleştirildi"}
                </p>
                <p className="font-mono text-label-sm text-on-surface-variant">
                  {verifiedProvider === "google"
                    ? "Aşağıdan Google ile devam et tuşuna basıp giriş yap."
                    : verifiedProvider === "github"
                      ? "Aşağıdan GitHub ile devam et tuşuna basıp giriş yap."
                      : "Şifren ve Gemini API key'inle giriş yapabilirsin."}
                </p>
              </div>
            </div>
          )}

          {/* ── Hesap + API Key giriş formu ── */}
          <form onSubmit={handleAccountSubmit} className="space-y-3">
              <div>
                <label htmlFor="username" className="block font-mono text-label-sm text-on-surface-variant mb-xs font-medium tracking-wide uppercase">
                  Kullanıcı Adı
                </label>
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ornegin: sezer"
                  className={inputCls}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-xs">
                  <label htmlFor="password" className="block font-mono text-label-sm text-on-surface-variant font-medium tracking-wide uppercase">
                    Şifre
                  </label>
                  <Link href="/forgot-password" className="font-mono text-xs text-primary hover:text-primary-fixed hover:underline transition-colors">
                    Şifremi unuttum?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••"
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

              {/* API Key alanı (zorunlu) */}
              <div>
                <label htmlFor="apikey" className="block font-mono text-label-sm text-on-surface-variant mb-xs font-medium tracking-wide uppercase">
                  Gemini API Key *
                </label>
                <div className="relative">
                  <input
                    id="apikey"
                    type={showApiKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className={`${inputCls} font-mono pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? "Key'i gizle" : "Key'i göster"}
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary-container transition-colors"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                      {showApiKey ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
              </div>

              {/* API Key Talimatı (açılır-kapanır) */}
              <details className="bg-surface-container-lowest border border-surface-container-highest rounded-lg">
                <summary className="cursor-pointer px-3 py-2.5 font-mono text-label-sm text-primary uppercase tracking-widest font-semibold flex items-center gap-1.5 select-none">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>key</span>
                  API Key Nasıl Alırım?
                </summary>
                <ol className="px-3 pb-2.5 font-body text-sm text-on-surface-variant list-decimal list-outside pl-8 space-y-1">
                  <li>
                    <Link href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary-fixed">
                      aistudio.google.com/apikey
                    </Link>{" "}adresine git
                  </li>
                  <li>Google hesabınla giriş yap</li>
                  <li>&quot;Create API key&quot; butonuna tıkla</li>
                  <li>Çıkan key&apos;i kopyala, yukarıdaki kutuya yapıştır</li>
                </ol>
              </details>

              {accountError && (
                <div className="flex items-start gap-2 bg-error-container/15 border border-error/40 rounded-lg p-2.5">
                  <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 16 }}>error</span>
                  <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{accountError}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={accountLoading || !username.trim() || !password}
                className="w-full bg-primary text-on-primary-container font-body text-body-md font-bold py-3 rounded-lg flex items-center justify-center gap-2 hover:bg-primary-fixed-dim disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all duration-300 shadow-lg shadow-primary/10 active:scale-[0.98]"
              >
                {accountLoading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                    Giriş yapılıyor
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>login</span>
                    <span className="font-bold uppercase tracking-wider">Giriş Yap</span>
                  </>
                )}
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-surface-container-highest" />
                <span className="font-mono text-label-sm text-on-surface-variant/60 uppercase tracking-widest">veya</span>
                <div className="flex-1 h-px bg-surface-container-highest" />
              </div>

              {/* Social — login mode: zaten kayıtlı OAuth hesapları kabul edilir */}
              <SocialButtons mode="login" />

              <p className="font-mono text-label-sm text-on-surface-variant text-center pt-1">
                Hesabın yok mu?{" "}
                <Link href="/register" className="text-primary hover:text-primary-fixed transition-colors duration-200 font-medium">
                  Kayıt Ol
                </Link>
              </p>
            </form>
        </div>
      </div>
    </div>
  );
}
