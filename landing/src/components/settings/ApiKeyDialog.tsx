"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  getUserApiKey,
  setUserApiKey,
  clearUserApiKey,
  hasUserApiKey,
  getUserApiKeys,
  setUserApiKeys,
  addUserApiKey,
  removeUserApiKey,
  fetchKeysStatus,
  apiFetch,
  ApiKeyStatus,
  ApiKeysStatusResponse
} from "@/lib/apiKey";

interface ApiKeyDialogProps {
  open: boolean;
  onClose: () => void;
  /** Quota dolduğunda açıldıysa, başlıkta uyarı göstermek için */
  triggeredByQuota?: boolean;
  quotaMessage?: string;
}

export default function ApiKeyDialog({
  open,
  onClose,
  triggeredByQuota = false,
  quotaMessage,
}: ApiKeyDialogProps) {
  const [input, setInput] = useState("");
  const [keysList, setKeysList] = useState<string[]>([]);
  const [showFullIndex, setShowFullIndex] = useState<number | null>(null);
  const [showInput, setShowInput] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [statuses, setStatuses] = useState<ApiKeysStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  async function loadStatuses() {
    setLoading(true);
    const data = await fetchKeysStatus();
    if (data) {
      setStatuses(data);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (open) {
      setKeysList(getUserApiKeys());
      setInput("");
      setShowFullIndex(null);
      setShowInput(false);
      loadStatuses();
    }
  }, [open]);

  if (!open || !mounted) return null;

  async function handleAddKey() {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (keysList.includes(trimmed)) {
      window.dispatchEvent(
        new CustomEvent("lostick:toast", {
          detail: { message: "Bu API anahtarı zaten ekli.", type: "warning" }
        })
      );
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch("/api/keys/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });

      const data = await res.json();
      if (res.ok && data.valid) {
        addUserApiKey(trimmed);
        setKeysList(getUserApiKeys());
        setInput("");
        loadStatuses();
      } else {
        const errorMsg = data.message || "API anahtarı doğrulaması başarısız oldu.";
        window.dispatchEvent(
          new CustomEvent("lostick:toast", {
            detail: { message: errorMsg, type: "error" }
          })
        );
      }
    } catch (e) {
      console.error(e);
      window.dispatchEvent(
        new CustomEvent("lostick:toast", {
          detail: { message: "Anahtar doğrulanırken bağlantı hatası oluştu.", type: "error" }
        })
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveKey(key: string) {
    removeUserApiKey(key);
    setKeysList(getUserApiKeys());
    loadStatuses();
  }

  function handleClearAll() {
    clearUserApiKey();
    setKeysList([]);
    setStatuses(null);
  }

  function maskKey(key: string): string {
    if (key.length <= 8) return "•".repeat(key.length);
    return `${key.slice(0, 4)}${"•".repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
  }

  function renderBadge(statusObj?: ApiKeyStatus) {
    if (!statusObj) return null;
    
    const { status, daily_count, cooldown_until } = statusObj;
    
    if (status === 'active') {
      return (
        <span className="font-mono text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded font-bold flex items-center gap-1 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          Aktif {daily_count > 0 ? `(Bugün: ${daily_count})` : ''}
        </span>
      );
    }
    
    if (status === 'cooldown') {
      const remaining = Math.max(0, Math.round(cooldown_until - Date.now() / 1000));
      return (
        <span className="font-mono text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-bold flex-shrink-0">
          Soğumada {remaining > 0 ? `(${remaining}s)` : ''}
        </span>
      );
    }
    
    if (status === 'exhausted') {
      return (
        <span className="font-mono text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded font-bold flex-shrink-0">
          Kotası Bitti (429)
        </span>
      );
    }

    if (status === 'invalid') {
      return (
        <span className="font-mono text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2 py-0.5 rounded font-bold flex-shrink-0">
          Geçersiz Anahtar
        </span>
      );
    }
    
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-md flex items-center justify-center p-margin-mobile"
      style={{ zIndex: 9998 }}
    >
      <div
        className="w-full max-w-xl bg-surface-container-low border border-surface-variant rounded-xl overflow-hidden flex flex-col"
        style={{ maxHeight: "calc(100vh - 2rem)" }}
      >
        <div className="flex items-start justify-between gap-3 p-md border-b border-surface-variant">
          <div className="min-w-0">
            <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest mb-1">
              {triggeredByQuota ? "Günlük Limit Doldu" : "API Key Ayarları"}
            </p>
            <h2 className="font-headline text-headline-md text-on-surface">
              {triggeredByQuota
                ? "Kendi API Key'inizi Ekleyin"
                : "Gemini API Key Havuzunuz"}
            </h2>
            <p className="font-body text-body-md text-on-surface-variant mt-1">
              Kullanmaya başlamak için kendi Google Gemini API key'inizi eklemelisiniz. Birden fazla key ekleyerek otomatik rotasyonlu bir kota havuzu oluşturabilirsiniz!
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              close
            </span>
          </button>
        </div>

        <div className="p-md space-y-md overflow-y-auto">
          {triggeredByQuota && quotaMessage && (
            <div className="flex items-start gap-2 bg-error-container/15 border border-error/40 rounded-lg p-3">
              <span
                className="material-symbols-outlined text-error flex-shrink-0"
                style={{ fontSize: 18 }}
              >
                hourglass_disabled
              </span>
              <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">
                {quotaMessage}
              </p>
            </div>
          )}

          {/* Kayıtlı API Anahtarları Listesi */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest font-semibold flex items-center gap-2">
                Kayıtlı Anahtarlarınız ({keysList.length})
                {loading && (
                  <span className="font-mono text-[10px] text-primary-container animate-pulse lowercase font-normal">(kontrol ediliyor...)</span>
                )}
              </p>
              {keysList.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="font-mono text-label-sm text-error hover:text-error/80 transition-colors"
                >
                  Tümünü Kaldır
                </button>
              )}
            </div>
            
            {keysList.length > 0 ? (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {keysList.map((key, idx) => {
                  const sObj = statuses?.user_keys?.find(uk => uk.key === key);
                  return (
                    <div key={idx} className="flex items-center gap-2 bg-primary-container/10 border border-primary-container/30 rounded-lg px-3 py-2">
                      <span
                        className="material-symbols-outlined text-primary-container flex-shrink-0"
                        style={{ fontSize: 18 }}
                      >
                        vpn_key
                      </span>
                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
                        <code className="font-mono text-label-sm text-on-surface truncate">
                          {showFullIndex === idx ? key : maskKey(key)}
                        </code>
                        {renderBadge(sObj)}
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowFullIndex(showFullIndex === idx ? null : idx)}
                        className="font-mono text-label-sm text-on-surface-variant hover:text-primary-container px-2 py-1 rounded hover:bg-surface-container-high transition-colors"
                      >
                        {showFullIndex === idx ? "Gizle" : "Göster"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveKey(key)}
                        className="w-8 h-8 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
                        title="Anahtarı Kaldır"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                          delete
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-surface-container-lowest border border-surface-variant rounded-lg px-3 py-3">
                <span
                  className="material-symbols-outlined text-on-surface-variant flex-shrink-0"
                  style={{ fontSize: 18 }}
                >
                  key_off
                </span>
                <p className="font-mono text-label-sm text-on-surface-variant">
                  Kayıtlı key yok — kullanmaya başlamak için lütfen en az bir anahtar ekleyin.
                </p>
              </div>
            )}
          </div>

          {/* Yeni key girişi */}
          <div className="space-y-2">
            <label
              htmlFor="api-key-input"
              className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest block font-semibold"
            >
              Yeni API Key Ekle
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  id="api-key-input"
                  type={showInput ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="AIzaSy..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={loading}
                  className="w-full bg-surface-container-lowest border border-surface-variant focus:border-primary-container focus:outline-none rounded-lg px-3 py-2 pr-10 font-mono text-body-md text-on-surface placeholder:text-on-surface-variant/40 transition-colors disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => setShowInput((v) => !v)}
                  aria-label={showInput ? "Key'i gizle" : "Key'i göster"}
                  tabIndex={-1}
                  disabled={loading}
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded text-on-surface-variant hover:text-primary-container transition-colors disabled:opacity-50"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    {showInput ? "visibility_off" : "visibility"}
                  </span>
                </button>
              </div>
              <button
                type="button"
                onClick={handleAddKey}
                disabled={!input.trim() || loading}
                className="bg-primary-container text-on-primary-container font-mono text-label-sm px-4 py-2 rounded-lg hover:bg-primary disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {loading ? "progress_activity" : "add"}
                </span>
                {loading ? "Doğrulanıyor..." : "Ekle"}
              </button>
            </div>
            <p className="font-mono text-label-sm text-on-surface-variant/70 leading-relaxed">
              Kendi Google AI Studio hesabınızdan alacağınız tamamen ücretsiz API anahtarlarını buraya ekleyebilirsiniz. Birden fazla anahtar eklediğinizde sistemimiz, siz çalışırken anahtarlarınız arasında otomatik ve akıllı geçiş yaparak kotalara takılmanızı tamamen engeller!
            </p>
          </div>

          {/* Nasıl alınır */}
          {keysList.length > 0 ? (
            <details className="bg-surface-container-lowest border border-surface-variant rounded-lg">
              <summary className="cursor-pointer px-3 py-2 font-mono text-label-sm text-primary-container uppercase tracking-widest flex items-center gap-2">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                  help
                </span>
                Yeni Key Nasıl Alınır?
              </summary>
              <ol className="px-3 pb-3 space-y-2 font-body text-body-md text-on-surface-variant list-decimal list-outside pl-8">
                <li>
                  <Link
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-container underline hover:text-primary"
                  >
                    aistudio.google.com/apikey
                  </Link>
                </li>
                <li>Google hesabınla giriş yap</li>
                <li>&quot;Create API key&quot; butonuna tıkla</li>
                <li>Key&apos;i kopyala, yukarıdaki kutuya yapıştır ve Ekle&apos;ye bas</li>
              </ol>
            </details>
          ) : (
            <div className="bg-surface-container-lowest border border-primary-container/30 rounded-lg p-md">
              <div className="flex items-start gap-2 mb-3">
                <span
                  className="material-symbols-outlined text-primary-container flex-shrink-0"
                  style={{ fontSize: 20 }}
                >
                  help
                </span>
                <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest">
                  API Key Nasıl Alırım? · 1 Dakika
                </p>
              </div>
              <ol className="space-y-3 font-body text-body-md text-on-surface list-none">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container/15 border border-primary-container/40 text-primary-container font-mono text-label-sm flex items-center justify-center font-bold">
                    1
                  </span>
                  <span>
                    <Link
                      href="https://aistudio.google.com/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-container underline hover:text-primary font-semibold"
                    >
                      aistudio.google.com/apikey
                    </Link>{" "}
                    adresine git
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container/15 border border-primary-container/40 text-primary-container font-mono text-label-sm flex items-center justify-center font-bold">
                    2
                  </span>
                  <span>Google hesabınla giriş yap (Gmail yeter)</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container/15 border border-primary-container/40 text-primary-container font-mono text-label-sm flex items-center justify-center font-bold">
                    3
                  </span>
                  <span>
                    Sağ üstteki{" "}
                    <strong className="text-primary-container">
                      &quot;Create API key&quot;
                    </strong>{" "}
                    butonuna tıkla
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary-container/15 border border-primary-container/40 text-primary-container font-mono text-label-sm flex items-center justify-center font-bold">
                    4
                  </span>
                  <span>
                    Çıkan key&apos;i kopyala (AIzaSy... ile başlar), kutuya yapıştır ve Ekle&apos;ye tıkla
                  </span>
                </li>
              </ol>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-md border-t border-surface-variant bg-surface-container-lowest">
          <button
            type="button"
            onClick={onClose}
            className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-6 py-2.5 rounded-lg transition-all font-bold"
          >
            Kapat
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Navbar'a yerleştirilen tetikleyici buton — key var/yok durumuna göre renk değiştirir.
 * Quota event'ini dinleyip dialogu otomatik açar.
 */
export function ApiKeyButton() {
  const [open, setOpen] = useState(false);
  const [keySet, setKeySet] = useState(false);
  const [quotaMsg, setQuotaMsg] = useState<string | undefined>(undefined);
  const [byQuota, setByQuota] = useState(false);

  useEffect(() => {
    setKeySet(hasUserApiKey());
    function onKeyChanged() {
      setKeySet(hasUserApiKey());
    }
    function onQuotaExceeded(e: Event) {
      const ce = e as CustomEvent<string>;
      setQuotaMsg(typeof ce.detail === "string" ? ce.detail : undefined);
      setByQuota(true);
      setOpen(true);
    }
    window.addEventListener("lostick:api-key-changed", onKeyChanged);
    window.addEventListener("lostick:quota-exceeded", onQuotaExceeded);
    return () => {
      window.removeEventListener("lostick:api-key-changed", onKeyChanged);
      window.removeEventListener("lostick:quota-exceeded", onQuotaExceeded);
    };
  }, []);

  function handleOpen() {
    setByQuota(false);
    setQuotaMsg(undefined);
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title={keySet ? "API key kayıtlı" : "API key ekle"}
        aria-label="API key ayarları"
        className={`w-9 h-9 flex items-center justify-center rounded transition-colors ${
          keySet
            ? "text-primary-container hover:bg-primary-container/10"
            : "text-on-surface-variant hover:text-primary-container hover:bg-surface-container-high"
        }`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
          {keySet ? "key" : "key_off"}
        </span>
      </button>
      <ApiKeyDialog
        open={open}
        onClose={() => setOpen(false)}
        triggeredByQuota={byQuota}
        quotaMessage={quotaMsg}
      />
    </>
  );
}
