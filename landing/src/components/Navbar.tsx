"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hasUserApiKey, clearUserApiKey } from "@/lib/apiKey";
import { getAuthUser, logout, User } from "@/lib/auth";
import ApiKeyDialog from "@/components/settings/ApiKeyDialog";

const navLinks = [
  {
    label: "Lostick Akademi",
    href: "/",
    icon: "school",
    desc: "Ana sayfa, rehberler ve eğitim başlangıç paneli.",
  },
  {
    label: "Akıllı Konu Anlatımı",
    href: "/anlatim",
    icon: "menu_book",
    desc: "Yapay zeka ile dökümanlarınızdan akıllı konu anlatımı üretin.",
  },
  {
    label: "Soru Çözüm Asistanı",
    href: "/test",
    icon: "quiz",
    desc: "Dökümanlardan özelleştirilmiş deneme sınavları ve testler çözün.",
  },
  {
    label: "İnteraktif Öğrenme Kartları",
    href: "/kartlar",
    icon: "style",
    desc: "Kavramları flashcard formatında pratik şekilde ezberleyin.",
  },
  {
    label: "Kavram Kütüphanesi",
    href: "/kavram",
    icon: "library_books",
    desc: "Çalışma alanınızdaki tüm önemli kavramları ve terimleri inceleyin.",
  },
  {
    label: "Akıllı Doküman Çevirisi",
    href: "/ceviri",
    icon: "g_translate",
    desc: "Akademik dökümanlarınızı orijinal sayfa düzeniyle anında istediğiniz dile çevirin.",
  },
  {
    label: "Yapay Zeka Analizörü",
    href: "/ai-analizor",
    icon: "fingerprint",
    desc: "Dökümanlarınızdan yapay zeka tespiti ve semantik intihal taraması yapın.",
  },
  {
    label: "Sohbet",
    href: "/chat",
    icon: "forum",
    desc: "Dökümanlarınızla doğrudan soru-cevap sohbeti gerçekleştirin.",
  },
];

export default function Navbar() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [keyActive, setKeyActive] = useState(false);
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    setUser(getAuthUser());
    setKeyActive(hasUserApiKey());
    // Güvenlik ağı: Mermaid render hatasında body'ye sızıp sayfalar arası kalan
    // "Syntax error in text" bombası düğümlerini her sayfa açılışında temizle.
    if (typeof document !== "undefined") {
      document
        .querySelectorAll(
          'body > svg[id^="mermaid-"], body > svg[id^="dmermaid-"], body > div[id^="dmermaid-"], body > svg[aria-roledescription="error"]',
        )
        .forEach((el) => el.remove());
    }
    function onAuthChanged() {
      setUser(getAuthUser());
    }
    function onKeyChanged() {
      setKeyActive(hasUserApiKey());
    }
    function onSessionExpired() {
      // Refresh token süresi dolmuş / iptal edilmiş → kullanıcıyı uyar + login'e yönlendir
      window.dispatchEvent(
        new CustomEvent("lostick:toast", {
          detail: {
            message: "Oturumunuz sona erdi. Lütfen tekrar giriş yapın.",
            type: "warning",
          },
        }),
      );
      router.push("/login");
    }
    function onClickOutside(e: MouseEvent) {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    }
    window.addEventListener("lostick:auth-changed", onAuthChanged);
    window.addEventListener("lostick:api-key-changed", onKeyChanged);
    window.addEventListener("lostick:session-expired", onSessionExpired);
    window.addEventListener("mousedown", onClickOutside);
    return () => {
      window.removeEventListener("lostick:auth-changed", onAuthChanged);
      window.removeEventListener("lostick:api-key-changed", onKeyChanged);
      window.removeEventListener("lostick:session-expired", onSessionExpired);
      window.removeEventListener("mousedown", onClickOutside);
    };
  }, [router]);

  async function handleLogout() {
    setUserMenuOpen(false);
    clearUserApiKey(); // BYOK key'i de temizle ki çıkış sonrası geçerli olmasın
    await logout();
    router.push("/login");
  }

  function isActive(href: string) {
    if (href.startsWith("/#") || href === "#") return false;
    if (href === "/") return pathname === "/";
    return pathname === href || pathname?.startsWith(href + "/") || false;
  }

  return (
    <>
      {/* Üst Header: Son derece temiz ve modern */}
      <header className="bg-background/80 backdrop-blur-md sticky top-0 z-50 border-b border-outline-variant/30 w-full">
        <div className="w-full flex items-center gap-md px-4 md:px-6 py-3">
          
          {/* Sol Kısım: Hamburgers + Logo */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDrawerOpen(true)}
              className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-surface-variant/30 text-on-surface hover:text-primary transition-all duration-300 mr-1 group"
              aria-label="Panel Menüsünü Aç"
            >
              <span className="material-symbols-outlined group-hover:scale-110 transition-transform duration-300" style={{ fontSize: 24 }}>
                menu
              </span>
            </button>
            <Link href="/" className="flex items-center gap-2 flex-shrink-0">
              <span className="font-display font-extrabold text-headline-md text-primary-container tracking-tight">
                Lostick
              </span>
            </Link>
          </div>

          {/* Sağ Kısım: API Key + Kullanıcı Profili */}
          <div className="flex items-center gap-sm flex-shrink-0 ml-auto">
            {/* API Key durum göstergesi */}
            <div className="flex flex-col items-center mr-2">
              <span
                className={`material-symbols-outlined ${
                  keyActive ? "text-primary" : "text-on-surface-variant/30"
                }`}
                style={{ fontSize: 20 }}
              >
                key
              </span>
              <span className={`font-mono text-[10px] tracking-wide ${
                keyActive ? "text-primary" : "text-on-surface-variant/40"
              }`}>
                {keyActive ? "API Key Aktif" : "Sunucu Key"}
              </span>
            </div>

            {user ? (
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((v) => !v)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded border border-surface-variant hover:border-primary-container/60 transition-colors"
                >
                  <div className="w-7 h-7 rounded bg-primary-container/15 border border-primary-container/40 flex items-center justify-center">
                    <span
                      className="material-symbols-outlined text-primary-container"
                      style={{ fontSize: 16 }}
                    >
                      {user.role === "admin" ? "shield_person" : "person"}
                    </span>
                  </div>
                  <span className="font-mono text-label-sm text-on-surface hidden sm:inline">
                    {user.username}
                  </span>
                  {user.role === "admin" && (
                    <span className="hidden sm:inline-flex font-mono text-[10px] uppercase tracking-widest bg-primary-container/15 text-primary-container border border-primary-container/40 px-1.5 py-0.5 rounded">
                      admin
                    </span>
                  )}
                  <span
                    className="material-symbols-outlined text-on-surface-variant"
                    style={{ fontSize: 16 }}
                  >
                    expand_more
                  </span>
                </button>

                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 min-w-[200px] bg-surface-container-low border border-surface-variant rounded-lg overflow-hidden shadow-lg z-[55]">
                    <div className="px-3 py-2 border-b border-surface-variant">
                      <p className="font-body text-sm text-on-surface truncate">
                        {user.username}
                      </p>
                      {user.email && (
                        <p className="font-mono text-label-sm text-on-surface-variant/70 truncate">
                          {user.email}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setApiKeyDialogOpen(true);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 font-body text-body-md text-on-surface hover:bg-surface-container transition-colors text-left"
                    >
                      <span
                        className={`material-symbols-outlined ${keyActive ? "text-primary-container" : "text-on-surface-variant"}`}
                        style={{ fontSize: 16 }}
                      >
                        key
                      </span>
                      <span className="flex-1">API Key Ekle veya Değiştir</span>
                      {keyActive && (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-primary-container/70">
                          aktif
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-3 py-2 font-body text-body-md text-error hover:bg-error-container/10 transition-colors text-left border-t border-surface-variant"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                        logout
                      </span>
                      Çıkış Yap
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden sm:inline-flex font-mono text-label-sm text-on-surface-variant hover:text-primary-container transition-colors px-4 py-2"
                >
                  Giriş Yap
                </Link>
                <Link
                  href="/register"
                  className="font-mono text-label-sm bg-primary-container text-on-primary-container px-5 py-2 rounded hover:bg-primary transition-colors font-bold"
                >
                  Kayıt Ol
                </Link>
              </>
            )}
          </div>

        </div>
      </header>

      {/* ─── YENİ GÖRSEL YAN PANEL (SLIDE-OUT SIDEBAR DRAWER) ─── */}
      {/* 1) Backdrop (Karartma & Bulanıklık) */}
      <div 
        className={`fixed inset-0 bg-black/75 backdrop-blur-sm z-[100] transition-opacity duration-300 ${
          drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`} 
        onClick={() => setDrawerOpen(false)} 
      />

      {/* 2) Yan Panel Konteyner */}
      <div 
        className={`fixed top-0 left-0 bottom-0 w-80 max-w-[85vw] bg-surface-container-low/95 backdrop-blur-xl border-r border-outline-variant/20 shadow-2xl z-[101] flex flex-col transition-transform duration-300 ease-out ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Panel Üst Başlık ve Kapatma */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-outline-variant/20">
          <div className="flex items-center gap-2">
            <span className="font-display font-extrabold text-headline-sm text-primary tracking-tight">
              Lostick
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest bg-primary-container/15 text-primary border border-primary-container/30 px-1.5 py-0.5 rounded">
              Akademi
            </span>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-surface-variant/30 text-on-surface-variant hover:text-error transition-all duration-300"
            aria-label="Menüyü Kapat"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
              close
            </span>
          </button>
        </div>

        {/* Panel Menü Linkleri */}
        <nav className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-3">
          <p className="text-[10px] uppercase font-mono tracking-widest text-on-surface-variant/50 px-2 mb-1">
            Öğrenme Modülleri
          </p>
          {navLinks.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.label}
                href={link.href}
                onClick={(e) => {
                  if (link.href === "/ceviri") {
                    setDrawerOpen(false);
                    if (pathname === "/ceviri") {
                      window.dispatchEvent(new CustomEvent("lostick:open-ceviri"));
                    }
                  } else {
                    setDrawerOpen(false);
                  }
                }}
                className={`group flex items-start gap-4 p-3.5 rounded-xl border transition-all duration-300 ${
                  active
                    ? "bg-primary-container/10 border-primary/30 text-primary"
                    : "border-transparent hover:bg-surface-variant/20 hover:border-outline-variant/30 text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {/* İkon Kutusu */}
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors duration-300 ${
                  active 
                    ? "bg-primary text-on-primary shadow-lg shadow-primary/20" 
                    : "bg-surface-container border border-outline-variant/20 text-on-surface-variant group-hover:bg-primary-container/15 group-hover:text-primary group-hover:border-primary-container/40"
                }`}>
                  <span className="material-symbols-outlined" style={{ fontSize: 22 }}>
                    {link.icon}
                  </span>
                </div>
                
                {/* Metin Detayları */}
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className={`font-body text-body-md font-semibold tracking-wide transition-colors group-hover:text-primary ${
                    active ? "text-primary" : "text-on-surface"
                  }`}>
                    {link.label}
                  </span>
                  <span className="text-[11px] font-normal leading-snug text-on-surface-variant/70 group-hover:text-on-surface-variant/90 break-words line-clamp-2">
                    {link.desc}
                  </span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Panel Alt Bilgi Alanı */}
        <div className="p-4 border-t border-outline-variant/20 bg-surface-container-lowest/60">
          {user ? (
            <div className="flex items-center gap-3 p-2 rounded-lg bg-surface-variant/10 border border-outline-variant/10">
              <div className="w-8 h-8 rounded-full bg-primary-container/20 flex items-center justify-center text-primary-container font-bold text-sm">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-body-sm font-semibold text-on-surface truncate">
                  Hoş geldin, {user.username}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center p-2">
              <p className="text-label-sm text-on-surface-variant/70 mb-3">
                Çalışmalarınızı kaydetmek için giriş yapın.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href="/login"
                  onClick={() => setDrawerOpen(false)}
                  className="font-mono text-[11px] py-2 border border-outline-variant text-on-surface hover:bg-surface-variant/20 rounded transition-colors text-center"
                >
                  Giriş Yap
                </Link>
                <Link
                  href="/register"
                  onClick={() => setDrawerOpen(false)}
                  className="font-mono text-[11px] py-2 bg-primary text-on-primary hover:bg-primary-hover rounded transition-colors text-center font-bold"
                >
                  Kayıt Ol
                </Link>
              </div>
            </div>
          )}
          <p className="text-[9px] font-mono text-center text-on-surface-variant/40 mt-3 tracking-widest uppercase">
            Lostick v1.2.0 • AI Akademi
          </p>
        </div>

      </div>

      {/* API Key değiştirme dialogu */}
      <ApiKeyDialog
        open={apiKeyDialogOpen}
        onClose={() => setApiKeyDialogOpen(false)}
      />
    </>
  );
}
