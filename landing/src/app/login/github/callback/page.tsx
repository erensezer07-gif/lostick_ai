"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { loginWithGithub, type OAuthMode } from "@/lib/auth";

function GithubCallbackContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<"loading" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get("code");
    const returnedState = params.get("state");
    const expectedState =
      typeof window !== "undefined"
        ? sessionStorage.getItem("github_oauth_state")
        : null;

    // GitHub'tan hata döndüyse direkt göster
    const ghError = params.get("error");
    if (ghError) {
      setErrorMsg(
        params.get("error_description") ||
          `GitHub OAuth hatası: ${ghError}`,
      );
      setStatus("error");
      return;
    }

    if (!code) {
      setErrorMsg("Code parametresi eksik. GitHub yönlendirmesi tamamlanmadı.");
      setStatus("error");
      return;
    }

    // CSRF koruması: state'i kontrol et
    if (expectedState && returnedState !== expectedState) {
      setErrorMsg("Güvenlik kontrolü başarısız (state mismatch).");
      setStatus("error");
      return;
    }
    sessionStorage.removeItem("github_oauth_state");

    // Mode: SocialButtons GitHub'a yönlenmeden önce sessionStorage'a yazmıştı
    const mode = (sessionStorage.getItem("github_oauth_mode") as OAuthMode) || "login";
    sessionStorage.removeItem("github_oauth_mode");

    (async () => {
      try {
        const result = await loginWithGithub(code, mode);
        // Mode'a göre yönlendir: register → /login (auto-login yok), login → ana sayfa
        if (mode === "register") {
          router.replace(
            `/login?verified=${encodeURIComponent(result.user.username)}&provider=github`,
          );
        } else {
          router.replace("/");
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "GitHub girişi başarısız.");
        setStatus("error");
      }
    })();
  }, [params, router]);

  return (
    <div
      className="min-h-screen flex items-center justify-center px-margin-mobile"
      style={{
        background:
          "radial-gradient(circle at top center, #1c1c1c 0%, #131313 100%)",
      }}
    >
      <div className="w-full max-w-md bg-surface-container-high border border-surface-container-highest rounded-xl p-md text-center">
        {status === "loading" && (
          <>
            <div className="w-12 h-12 mx-auto mb-md rounded-lg bg-surface-container border border-outline-variant/40 flex items-center justify-center">
              <span className="w-6 h-6 border-2 border-surface-variant border-t-primary rounded-full animate-spin" />
            </div>
            <h1 className="font-headline text-headline-md text-on-surface mb-2">
              GitHub ile giriş yapılıyor
            </h1>
            <p className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
              Token doğrulanıyor...
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <div className="w-12 h-12 mx-auto mb-md rounded-lg bg-error-container/15 border border-error/40 flex items-center justify-center">
              <span
                className="material-symbols-outlined text-error"
                style={{ fontSize: 28 }}
              >
                error
              </span>
            </div>
            <h1 className="font-headline text-headline-md text-on-surface mb-2">
              Giriş Yapılamadı
            </h1>
            <p className="font-mono text-label-sm text-error mb-md [overflow-wrap:anywhere]">
              {errorMsg}
            </p>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 bg-primary text-on-primary-container font-body text-body-md font-bold py-2.5 px-5 rounded-lg hover:bg-primary-fixed-dim transition-all"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                arrow_back
              </span>
              <span className="uppercase tracking-wider">Giriş Sayfasına Dön</span>
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function GithubCallbackPage() {
  return (
    <Suspense fallback={
      <div
        className="min-h-screen flex items-center justify-center bg-[#131313]"
        style={{
          background:
            "radial-gradient(circle at top center, #1c1c1c 0%, #131313 100%)",
        }}
      >
        <div className="w-8 h-8 border-2 border-surface-variant border-t-primary rounded-full animate-spin" />
      </div>
    }>
      <GithubCallbackContent />
    </Suspense>
  );
}
