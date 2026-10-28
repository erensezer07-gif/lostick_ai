"use client";

import { useEffect, useRef, useState, ChangeEvent } from "react";
import { createPortal } from "react-dom";

import { apiFetch } from "@/lib/apiKey";
import { getAuthUser } from "@/lib/auth";
import {
  deleteSavedFlashcards,
  getSavedFlashcards,
  saveFlashcards,
  type Flashcard,
  type SavedFlashcardSet,
} from "@/lib/savedFlashcards";
import {
  exportFlashcardsAsDOCX,
  exportFlashcardsAsJSON,
  exportFlashcardsAsPDF,
} from "@/lib/flashcardExport";

type Step = "idle" | "modal" | "active";
type ModalTab = "yeni" | "gecmis";
type CardMode = "betimlemeli" | "spot";
type UploadedFile = { name: string; hash: string; chars: number };

const ACTIVE_JOB_KEY = "lostick.activeKartJob";
const MAX_FILES = 10;

const ACCEPTED_EXTENSIONS = [
  // PDF
  ".pdf",
  // Word & OpenDocument Text & RTF & Ebooks
  ".docx", ".docm", ".dotx", ".doc", ".odt", ".rtf", ".epub",
  // PowerPoint
  ".pptx", ".pptm", ".potx", ".ppsx", ".ppt",
  // Excel & Spreadsheets
  ".xlsx", ".xlsm", ".xltx", ".xls", ".csv", ".tsv",
  // Apple iWork
  ".pages", ".key", ".numbers",
  // Text & Notebooks
  ".txt", ".md", ".ipynb",
  // Images
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg",
  // Code & Web
  ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift", ".sql", ".sh", ".bat",
  ".html", ".css", ".scss", ".xml", ".yaml", ".yml", ".json", ".r", ".scala",
  ".pl", ".lua", ".dart", ".vue",
];
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",");

const COUNT_OPTIONS = [5, 10, 15, 20, 30];

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "az önce";
  if (min < 60) return `${min} dk önce`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} saat önce`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} gün önce`;
  return new Date(ts).toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function FlashcardAssistant() {
  const [step, setStep] = useState<Step>("idle");
  const [activeTab, setActiveTab] = useState<ModalTab>("yeni");
  const [mounted, setMounted] = useState(false);

  // Dosyalar
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [removingHash, setRemovingHash] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Konfigürasyon
  const [kartSayisi, setKartSayisi] = useState<number>(15);
  const [isCreating, setIsCreating] = useState(false);
  const [kartError, setKartError] = useState<string | null>(null);

  // Aktif deste (görüntüleme)
  const [cards, setCards] = useState<Flashcard[] | null>(null);

  // Arka plan job
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // Geçmiş
  const [savedList, setSavedList] = useState<SavedFlashcardSet[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportMenuId, setExportMenuId] = useState<string | null>(null);
  const [exportMenuPos, setExportMenuPos] = useState<{
    x: number;
    y: number;
    openUpwards: boolean;
  } | null>(null);

  // Toast
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  function showToast(type: "success" | "error" | "info", msg: string) {
    setToast({ type, msg });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 6000);
  }

  function clearJob() {
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_JOB_KEY);
    setActiveJobId(null);
  }

  useEffect(() => {
    setMounted(true);
    syncDosyalar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Geçmiş listesi
  useEffect(() => {
    function refresh() {
      const user = getAuthUser();
      setSavedList(getSavedFlashcards(user?.id ?? null));
    }
    refresh();
    window.addEventListener("lostick:saved-flashcards-changed", refresh);
    window.addEventListener("lostick:auth-changed", refresh);
    return () => {
      window.removeEventListener("lostick:saved-flashcards-changed", refresh);
      window.removeEventListener("lostick:auth-changed", refresh);
    };
  }, []);

  // Devam eden job'a tekrar bağlan (F5)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const meta = JSON.parse(raw);
        if (meta?.jobId) setActiveJobId(meta.jobId);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Export menü dış-tıkla kapat
  useEffect(() => {
    if (!exportMenuId) return;
    function onClickOutside(e: MouseEvent) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuId(null);
      }
    }
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [exportMenuId]);

  function closeAll() {
    setStep("idle");
    setCards(null);
    setUploadError(null);
    setKartError(null);
    setIsUploading(false);
    setIsCreating(false);
    setConfirmDeleteId(null);
  }

  // ─── Dosyalar ───
  function applyDosyalar(data: { dosyalar?: UploadedFile[] }) {
    if (Array.isArray(data.dosyalar)) setUploadedFiles(data.dosyalar);
  }

  async function syncDosyalar() {
    try {
      const res = await apiFetch("/api/dosyalar");
      if (res.ok) applyDosyalar(await res.json());
    } catch {
      /* ignore */
    }
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const secilenler = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (secilenler.length === 0) return;

    setUploadError(null);
    setIsUploading(true);
    try {
      for (const file of secilenler) {
        const lower = file.name.toLowerCase();
        const okExt = ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
        if (!okExt) {
          if (lower.endsWith(".doc") || lower.endsWith(".ppt")) {
            setUploadError(`${file.name}: Eski .doc/.ppt desteklenmiyor — .docx/.pptx olarak kaydet.`);
          } else {
            setUploadError(`${file.name}: Desteklenmeyen dosya tipi.`);
          }
          continue;
        }
        const formData = new FormData();
        formData.append("file", file);
        const response = await apiFetch("/api/pdf-yukle", { method: "POST", body: formData });
        if (!response.ok) {
          let detail = `${response.status}`;
          try {
            const j = await response.json();
            detail = j.detail ?? detail;
          } catch {
            /* ignore */
          }
          setUploadError(`${file.name}: ${detail}`);
          continue;
        }
        applyDosyalar(await response.json());
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleRemoveFile(hash: string) {
    setRemovingHash(hash);
    try {
      const res = await apiFetch(`/api/dosya-sil/${hash}`, { method: "POST" });
      if (res.ok) applyDosyalar(await res.json());
    } catch {
      /* ignore */
    } finally {
      setRemovingHash(null);
    }
  }

  // ─── Kart üretimi ───
  async function handleStart() {
    if (uploadedFiles.length === 0 || isCreating || activeJobId) return;
    setIsCreating(true);
    setKartError(null);

    try {
      const response = await apiFetch("/api/kart-olustur", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kart_sayisi: kartSayisi }),
      });
      if (!response.ok) {
        let detail = `${response.status}`;
        try {
          const errJson = await response.json();
          detail = errJson.detail ?? detail;
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      const data: { job_id?: string } = await response.json();
      if (!data.job_id) throw new Error("Kart üretimi başlatılamadı.");

      const ilkAd = uploadedFiles[0]?.name ?? "Bilinmeyen";
      const etiket =
        uploadedFiles.length > 1 ? `${ilkAd} +${uploadedFiles.length - 1} dosya` : ilkAd;

      const meta = { jobId: data.job_id, pdfName: etiket, count: kartSayisi };
      localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(meta));
      setActiveJobId(data.job_id);
      showToast("info", "Kartlar arka planda hazırlanıyor — istersen gezinebilirsin.");
    } catch (err) {
      setKartError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleCancelJob() {
    const jobId = activeJobId;
    clearJob();
    if (jobId) {
      try {
        await apiFetch(`/api/kart-iptal/${jobId}`, { method: "POST" });
      } catch {
        /* ignore */
      }
      showToast("info", "Kart üretimi iptal edildi.");
    }
  }

  function handleVazgec() {
    if (activeJobId) handleCancelJob();
    closeAll();
  }

  // Job polling
  useEffect(() => {
    if (!activeJobId) return;

    async function poll() {
      try {
        const res = await apiFetch(`/api/kart-durum/${activeJobId}`);
        if (res.status === 404) {
          clearJob();
          showToast("error", "Kart bulunamadı (sunucu yeniden başlamış olabilir). Tekrar dene.");
          return;
        }
        if (!res.ok) return;

        const data = await res.json();
        if (data.status === "done") {
          const kartlar: Flashcard[] = Array.isArray(data.kartlar) ? data.kartlar : [];
          let meta: { pdfName?: string } = {};
          try {
            const raw = localStorage.getItem(ACTIVE_JOB_KEY);
            if (raw) meta = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          clearJob();
          if (kartlar.length === 0) {
            showToast("error", "Boş deste döndü, tekrar dene.");
            return;
          }
          const user = getAuthUser();
          saveFlashcards({
            userId: user?.id ?? null,
            pdfName: meta.pdfName ?? "Bilinmeyen",
            count: kartlar.length,
            cards: kartlar,
          });
          showToast("success", `${kartlar.length} kart hazır! "Geçmiş" sekmesine eklendi.`);
        } else if (data.status === "error") {
          clearJob();
          showToast("error", data.error || "Kart üretilemedi, tekrar dene.");
        } else if (data.status === "cancelled") {
          clearJob();
        }
      } catch {
        /* ignore */
      }
    }

    poll();
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  // ─── Geçmiş aksiyonları ───
  function handleResumeSaved(s: SavedFlashcardSet) {
    setCards(s.cards);
    setStep("active");
  }

  function handleDeleteSaved(id: string) {
    deleteSavedFlashcards(id);
    setConfirmDeleteId(null);
  }

  function openExportMenu(id: string, e: React.MouseEvent<HTMLButtonElement>) {
    if (exportMenuId === id) {
      setExportMenuId(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const menuHeight = 160;
    const openUpwards = rect.top > menuHeight + 16;
    setExportMenuPos({
      x: rect.left,
      y: openUpwards ? rect.top - 8 : rect.bottom + 8,
      openUpwards,
    });
    setExportMenuId(id);
  }

  async function handleExport(s: SavedFlashcardSet, format: "pdf" | "docx" | "json") {
    setExportMenuId(null);
    try {
      if (format === "pdf") exportFlashcardsAsPDF(s);
      else if (format === "docx") await exportFlashcardsAsDOCX(s);
      else if (format === "json") exportFlashcardsAsJSON(s);
    } catch (err) {
      console.error("Flashcard export failed:", err);
      alert("İndirme başarısız oldu. Tarayıcı konsolunu kontrol et.");
    }
  }

  return (
    <div className="min-h-[calc(100vh-65px)] bg-surface">
      <div className="max-w-3xl mx-auto px-margin-mobile md:px-margin-desktop py-lg">
        <header className="mb-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-outline-variant/50 rounded-full bg-surface-container-highest/50 backdrop-blur-sm mb-4">
            <span
              className="material-symbols-outlined text-primary-container"
              style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}
            >
              style
            </span>
            <span className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
              İnteraktif Öğrenme Kartları Modülü
            </span>
          </div>
          <h1 className="font-display text-headline-lg-mobile md:text-display-lg text-on-surface tracking-tight mb-2">
            İnteraktif <span className="text-primary-container">Öğrenme Kartları</span>
          </h1>
          <p className="font-body text-body-lg text-on-surface-variant max-w-2xl">
            Belgelerini yükle; her kartın önünde soru, arkasında Betimlemeli ve
            Spot modlarıyla cevap. Tek anahtarla anında mod değiştir.
          </p>
        </header>

        {step !== "active" && (
          <div className="w-full bg-surface-container-low border border-surface-variant rounded-xl overflow-hidden flex flex-col">
            {/* Tab strip */}
            <div className="px-md border-b border-surface-variant">
                <div role="tablist" className="flex gap-1">
                  <button
                    role="tab"
                    aria-selected={activeTab === "yeni"}
                    type="button"
                    onClick={() => setActiveTab("yeni")}
                    disabled={isUploading || isCreating}
                    className={`relative px-3 py-2.5 font-mono text-label-sm uppercase tracking-wider transition-colors disabled:opacity-40 ${
                      activeTab === "yeni" ? "text-primary-container" : "text-on-surface-variant hover:text-on-surface"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add_circle</span>
                      Yeni Deste
                    </span>
                    {activeTab === "yeni" && (
                      <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-primary-container rounded-t" />
                    )}
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === "gecmis"}
                    type="button"
                    onClick={() => setActiveTab("gecmis")}
                    disabled={isUploading || isCreating || savedList.length === 0}
                    className={`relative px-3 py-2.5 font-mono text-label-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      activeTab === "gecmis" ? "text-primary-container" : "text-on-surface-variant hover:text-on-surface"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>history</span>
                      Geçmiş
                      {savedList.length > 0 && (
                        <span className="ml-0.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary-container/15 border border-primary-container/30 text-primary-container text-[10px] font-bold">
                          {savedList.length}
                        </span>
                      )}
                    </span>
                    {activeTab === "gecmis" && (
                      <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-primary-container rounded-t" />
                    )}
                  </button>
                </div>
              </div>

              {/* Tab content */}
              <div className="p-md overflow-y-auto">
                {activeTab === "gecmis" ? (
                  savedList.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center py-lg gap-2">
                      <span className="material-symbols-outlined text-on-surface-variant/40" style={{ fontSize: 40 }}>
                        history
                      </span>
                      <p className="font-body text-body-md text-on-surface-variant">
                        Henüz kaydedilmiş deste yok
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveTab("yeni")}
                        className="font-mono text-label-sm text-primary-container hover:text-primary transition-colors uppercase tracking-wider"
                      >
                        İlk desteni oluştur →
                      </button>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {savedList.map((s) => {
                        const isConfirming = confirmDeleteId === s.id;
                        return (
                          <li
                            key={s.id}
                            className="group relative bg-surface-container-lowest border border-surface-variant hover:border-primary-container/50 rounded-xl p-3 transition-all"
                          >
                            <div className="flex items-start gap-3">
                              <div className="w-10 h-10 rounded-lg bg-primary-container/10 border border-primary-container/30 flex items-center justify-center flex-shrink-0">
                                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 20 }}>
                                  style
                                </span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-body text-sm text-on-surface font-semibold truncate" title={s.pdfName}>
                                  {s.pdfName.replace(/\.pdf$/i, "")}
                                </p>
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                  <span className="font-mono text-label-sm text-on-surface-variant/80">
                                    {s.count} kart
                                  </span>
                                  <span className="font-mono text-label-sm text-on-surface-variant/50">
                                    · {formatRelative(s.createdAt)}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {isConfirming ? (
                              <div className="mt-3 pt-3 border-t border-surface-variant flex items-center justify-between gap-2">
                                <p className="font-mono text-label-sm text-error">Bu desteyi silmek istiyor musun?</p>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="font-mono text-label-sm text-on-surface-variant hover:text-on-surface px-3 py-1.5 rounded transition-colors"
                                  >
                                    Vazgeç
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteSaved(s.id)}
                                    className="font-mono text-label-sm text-error border border-error/50 hover:bg-error/15 px-3 py-1.5 rounded transition-colors"
                                  >
                                    Sil
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-3 pt-3 border-t border-surface-variant flex items-center justify-between gap-2">
                                <div className="flex items-center gap-3">
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(s.id)}
                                    aria-label="Bu desteyi sil"
                                    className="font-mono text-label-sm text-on-surface-variant/70 hover:text-error flex items-center gap-1 transition-colors"
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                                    Sil
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => openExportMenu(s.id, e)}
                                    aria-label="Bu desteyi indir"
                                    aria-expanded={exportMenuId === s.id}
                                    className="font-mono text-label-sm text-on-surface-variant/70 hover:text-primary-container flex items-center gap-1 transition-colors"
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                                    İndir
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>expand_more</span>
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleResumeSaved(s)}
                                  className="bg-primary-container/15 hover:bg-primary-container/25 text-primary-container border border-primary-container/40 font-mono text-label-sm px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors font-bold"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>play_arrow</span>
                                  Çalış
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : (
                  <div className="space-y-md">
                    {/* Dosya yükleme */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
                          1 · Dosyalar
                        </p>
                        <span className="font-mono text-label-sm text-on-surface-variant/60">
                          {uploadedFiles.length}/{MAX_FILES}
                        </span>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPT_ATTR}
                        multiple
                        onChange={handleFileChange}
                        className="hidden"
                      />

                      {uploadedFiles.length > 0 && (
                        <div className="space-y-1.5">
                          {uploadedFiles.map((f) => (
                            <div
                              key={f.hash}
                              className="flex items-center gap-2 bg-primary-container/10 border border-primary-container/40 rounded-lg px-3 py-2"
                            >
                              <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 18 }}>
                                description
                              </span>
                              <p className="flex-1 min-w-0 font-body text-sm text-on-surface truncate" title={f.name}>
                                {f.name}
                              </p>
                              <button
                                type="button"
                                onClick={() => handleRemoveFile(f.hash)}
                                disabled={isCreating || removingHash === f.hash}
                                aria-label="Dosyayı kaldır"
                                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors disabled:opacity-40"
                              >
                                {removingHash === f.hash ? (
                                  <span className="w-3.5 h-3.5 border-2 border-on-surface-variant/30 border-t-error rounded-full animate-spin" />
                                ) : (
                                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                                )}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {uploadedFiles.length < MAX_FILES && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isUploading || isCreating}
                          className={`w-full border border-dashed border-outline-variant hover:border-primary-container bg-surface-container-lowest hover:bg-surface-container-low rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                            uploadedFiles.length === 0 ? "p-md flex-col" : "py-2.5"
                          }`}
                        >
                          {isUploading ? (
                            <>
                              <span className="w-5 h-5 border-2 border-surface-variant border-t-primary-container rounded-full animate-spin" />
                              <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest">Yükleniyor</p>
                            </>
                          ) : uploadedFiles.length === 0 ? (
                            <>
                              <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 28 }}>upload_file</span>
                              <p className="font-body text-body-md text-on-surface">Dosya Seç</p>
                            </>
                          ) : (
                            <>
                              <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 18 }}>add</span>
                              <p className="font-mono text-label-sm text-primary-container">Dosya Ekle</p>
                            </>
                          )}
                        </button>
                      )}

                      {uploadedFiles.length >= MAX_FILES && (
                        <p className="font-mono text-label-sm text-on-surface-variant/60 text-center">
                          Maksimum {MAX_FILES} dosyaya ulaşıldı. Yeni eklemek için birini kaldır.
                        </p>
                      )}

                      {uploadError && (
                        <div className="flex items-start gap-2 bg-error-container/20 border border-error/40 rounded-lg p-3">
                          <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 18 }}>error</span>
                          <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{uploadError}</p>
                        </div>
                      )}
                    </div>

                    {/* Kart sayısı */}
                    <fieldset disabled={uploadedFiles.length === 0 || isCreating} className="space-y-2">
                      <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
                        2 · Kart Sayısı
                      </legend>
                      <div className="grid grid-cols-5 gap-2">
                        {COUNT_OPTIONS.map((n) => {
                          const active = kartSayisi === n;
                          return (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setKartSayisi(n)}
                              className={`py-3 rounded-lg border font-mono text-label-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                                active
                                  ? "bg-primary-container/15 border-primary-container text-primary-container"
                                  : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                              }`}
                            >
                              {n}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>

                    <div className="bg-surface-container-lowest border border-surface-variant rounded-lg p-3 flex items-start gap-2">
                      <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 18 }}>info</span>
                      <p className="font-mono text-[11px] text-on-surface-variant/80 leading-relaxed">
                        Her kart hem <span className="text-primary-container">Betimlemeli</span> (tanım + benzetme) hem de{" "}
                        <span className="text-primary-container">Spot</span> (sınav maddeleri) modunda hazırlanır.
                        Kart görünümünde üstteki anahtardan modu anında değiştirebilirsin.
                      </p>
                    </div>

                    {kartError && (
                      <div className="flex items-start gap-2 bg-error-container/20 border border-error/40 rounded-lg p-3">
                        <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 18 }}>error</span>
                        <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{kartError}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              {activeTab === "yeni" ? (
                <div className="flex items-center justify-end gap-2 p-md border-t border-surface-variant bg-surface-container-lowest">
                  <button
                    type="button"
                    onClick={handleVazgec}
                    disabled={isUploading}
                    className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all disabled:opacity-40"
                  >
                    {activeJobId ? "İptal Et" : "Vazgeç"}
                  </button>
                  <button
                    type="button"
                    onClick={handleStart}
                    disabled={uploadedFiles.length === 0 || isCreating || isUploading || !!activeJobId}
                    className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-2 min-w-[160px] justify-center"
                  >
                    {activeJobId ? (
                      <>
                        <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                        Hazırlanıyor
                      </>
                    ) : isCreating ? (
                      <>
                        <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                        Başlatılıyor
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>style</span>
                        Kartları Oluştur
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-end gap-2 p-md border-t border-surface-variant bg-surface-container-lowest">
                  <button
                    type="button"
                    onClick={closeAll}
                    className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all"
                  >
                    Kapat
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("yeni")}
                    className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary transition-all font-bold flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add</span>
                    Yeni Deste
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

      {/* Tam ekran kart çalışma görünümü */}
      {mounted && step === "active" && cards &&
        createPortal(
          <div className="fixed inset-0 bg-background flex flex-col" style={{ zIndex: 9999 }}>
            <CardViewer cards={cards} onExit={closeAll} />
          </div>,
          document.body,
        )}

      {/* İndirme menüsü */}
      {mounted && exportMenuId && exportMenuPos &&
        (() => {
          const s = savedList.find((q) => q.id === exportMenuId);
          if (!s) return null;
          return createPortal(
            <div
              ref={exportMenuRef}
              className="min-w-[200px] bg-surface-container-high border border-surface-variant rounded-lg shadow-2xl overflow-hidden"
              style={{
                position: "fixed",
                left: exportMenuPos.x,
                top: exportMenuPos.y,
                transform: exportMenuPos.openUpwards ? "translateY(-100%)" : "translateY(0)",
                zIndex: 10000,
              }}
            >
              <ExportMenuItem icon="picture_as_pdf" label="PDF" onClick={() => handleExport(s, "pdf")} />
              <ExportMenuItem icon="description" label="DOCX (Word)" onClick={() => handleExport(s, "docx")} divider />
              <ExportMenuItem icon="data_object" label="JSON · Ham Veri" onClick={() => handleExport(s, "json")} divider />
            </div>,
            document.body,
          );
        })()}

      {/* Arka plan job göstergesi */}
      {mounted && activeJobId && step !== "modal" &&
        createPortal(
          <div
            className="fixed bottom-4 right-4 max-w-xs bg-surface-container-high border border-primary-container/40 rounded-xl shadow-2xl p-3 flex items-center gap-3"
            style={{ zIndex: 10001 }}
          >
            <span className="w-5 h-5 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-label-sm text-on-surface">Kartlar hazırlanıyor</p>
              <p className="font-mono text-[10px] text-on-surface-variant/70">Bitince &quot;Geçmiş&quot;e eklenecek</p>
            </div>
            <button
              type="button"
              onClick={handleCancelJob}
              className="font-mono text-label-sm text-error border border-error/50 hover:bg-error/15 px-2.5 py-1 rounded transition-colors flex-shrink-0"
            >
              İptal
            </button>
          </div>,
          document.body,
        )}

      {/* Toast */}
      {mounted && toast &&
        createPortal(
          <div
            className={`fixed bottom-4 right-4 max-w-sm rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3 border ${
              toast.type === "success"
                ? "bg-surface-container-high border-emerald-500/40"
                : toast.type === "error"
                ? "bg-surface-container-high border-error/50"
                : "bg-surface-container-high border-primary-container/40"
            }`}
            style={{ zIndex: 10002, marginBottom: activeJobId && step !== "modal" ? "5rem" : 0 }}
          >
            <span
              className={`material-symbols-outlined flex-shrink-0 ${
                toast.type === "success" ? "text-emerald-400" : toast.type === "error" ? "text-error" : "text-primary-container"
              }`}
              style={{ fontSize: 20 }}
            >
              {toast.type === "success" ? "check_circle" : toast.type === "error" ? "error" : "info"}
            </span>
            <p className="font-mono text-label-sm text-on-surface flex-1">{toast.msg}</p>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Kapat"
              className="text-on-surface-variant hover:text-on-surface flex-shrink-0"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── Export menu item ─────────────────────────────────────────────────
function ExportMenuItem({
  icon,
  label,
  onClick,
  divider,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  divider?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 font-mono text-label-sm text-on-surface hover:bg-surface-container-highest transition-colors text-left ${
        divider ? "border-t border-surface-variant" : ""
      }`}
    >
      <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

// ─── Kart çalışma görünümü (flip + mod toggle + navigasyon) ───────────
function CardViewer({ cards, onExit }: { cards: Flashcard[]; onExit: () => void }) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [mode, setMode] = useState<CardMode>("betimlemeli");

  const total = cards.length;
  const card = cards[index];

  function goNext() {
    if (index < total - 1) {
      setFlipped(false);
      setIndex((i) => i + 1);
    }
  }
  function goPrev() {
    if (index > 0) {
      setFlipped(false);
      setIndex((i) => i - 1);
    }
  }

  // Klavye: ← → gez, boşluk/enter çevir, esc çık
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") goNext();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "Escape") onExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, total]);

  return (
    <div className="flex flex-col h-full">
      {/* Üst bar */}
      <div className="flex items-center justify-between gap-3 px-md py-3 border-b border-surface-variant bg-surface-container-low flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 18 }}>style</span>
          <span className="font-mono text-label-sm text-on-surface-variant">
            Öğrenme Kartları
          </span>
          <span className="font-mono text-label-sm text-on-surface-variant/50">
            · {index + 1} / {total}
          </span>
        </div>

        {/* Mod toggle */}
        <div className="flex items-center gap-1 bg-surface-container-lowest border border-surface-variant rounded-lg p-1">
          <button
            type="button"
            onClick={() => setMode("betimlemeli")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-label-sm transition-all ${
              mode === "betimlemeli"
                ? "bg-primary-container/20 text-primary-container border border-primary-container/40"
                : "text-on-surface-variant hover:text-on-surface border border-transparent"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>palette</span>
            Betimlemeli
          </button>
          <button
            type="button"
            onClick={() => setMode("spot")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-mono text-label-sm transition-all ${
              mode === "spot"
                ? "bg-primary-container/20 text-primary-container border border-primary-container/40"
                : "text-on-surface-variant hover:text-on-surface border border-transparent"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>bolt</span>
            Spot
          </button>
        </div>

        <button
          type="button"
          onClick={onExit}
          aria-label="Çıkış"
          className="w-9 h-9 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
        </button>
      </div>

      {/* Kart alanı — kısa kartta ortalanır, uzun kartta sayfa kayar (kart içi scroll yok) */}
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center p-md">
        <div className="w-full max-w-2xl">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setFlipped((f) => !f)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setFlipped((f) => !f);
              }
            }}
            className="cursor-pointer select-none w-full"
            style={{ perspective: "1600px" }}
          >
            <div
              style={{
                display: "grid",
                transformStyle: "preserve-3d",
                transition: "transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)",
                transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
                minHeight: "20rem",
              }}
            >
              {/* ÖN YÜZ — soru */}
              <div
                className="bg-surface-container-low border border-surface-variant rounded-2xl p-lg flex flex-col items-center justify-center text-center gap-4"
                style={{ gridArea: "1 / 1", backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
              >
                <span className="font-mono text-label-sm text-primary-container uppercase tracking-widest">
                  Soru {index + 1}
                </span>
                <p className="font-headline text-2xl md:text-3xl text-on-surface leading-snug [overflow-wrap:anywhere]">
                  {card.soru}
                </p>
                <div className="flex items-center gap-1.5 mt-2 text-on-surface-variant/60">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>touch_app</span>
                  <span className="font-mono text-label-sm">Cevap için karta tıkla</span>
                </div>
              </div>

              {/* ARKA YÜZ — moda göre içerik */}
              <div
                className="bg-surface-container border border-primary-container/30 rounded-2xl p-lg flex flex-col"
                style={{
                  gridArea: "1 / 1",
                  backfaceVisibility: "hidden",
                  WebkitBackfaceVisibility: "hidden",
                  transform: "rotateY(180deg)",
                }}
              >
                <p className="font-body text-base text-on-surface/80 font-semibold mb-3 [overflow-wrap:anywhere]">
                  {card.soru}
                </p>
                <div className="h-px bg-surface-variant mb-4" />

                {mode === "betimlemeli" ? (
                  <div className="space-y-4">
                    {/* Aşama 1: net tanım */}
                    <div>
                      <p className="font-mono text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-1.5">
                        Tanım
                      </p>
                      <p className="font-body text-body-lg text-on-surface leading-relaxed [overflow-wrap:anywhere]">
                        {card.tanim}
                      </p>
                    </div>
                    {/* Aşama 2: betimleme kutusu */}
                    {card.betimleme && (
                      <div className="bg-primary-container/10 border border-primary-container/30 rounded-xl p-4 flex items-start gap-3">
                        <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 20 }}>
                          lightbulb
                        </span>
                        <div>
                          <p className="font-mono text-[10px] text-primary-container uppercase tracking-widest mb-1">
                            Betimleme
                          </p>
                          <p className="font-body text-body-md text-on-surface-variant italic leading-relaxed [overflow-wrap:anywhere]">
                            {card.betimleme}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="font-mono text-[10px] text-primary-container uppercase tracking-widest mb-3 flex items-center gap-1.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>bolt</span>
                      Sınavda Çıkacak Noktalar
                    </p>
                    <ul className="space-y-2.5">
                      {card.spot.map((b, i) => (
                        <li key={i} className="flex items-start gap-2.5">
                          <span className="material-symbols-outlined text-primary-container flex-shrink-0 mt-0.5" style={{ fontSize: 18 }}>
                            check_circle
                          </span>
                          <span className="font-body text-body-lg text-on-surface font-semibold leading-relaxed [overflow-wrap:anywhere]">
                            {b}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex items-center gap-1.5 mt-auto pt-4 text-on-surface-variant/50">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>flip</span>
                  <span className="font-mono text-label-sm">Soruya dönmek için tıkla</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* Alt navigasyon */}
      <div className="flex items-center justify-between gap-3 px-md py-3 border-t border-surface-variant bg-surface-container-low">
        <button
          type="button"
          onClick={goPrev}
          disabled={index === 0}
          className="flex items-center gap-1.5 border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-4 py-2 rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>chevron_left</span>
          Önceki
        </button>

        {/* İlerleme noktaları */}
        <div className="flex items-center gap-1.5 overflow-x-auto max-w-[40%] px-2">
          {cards.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setFlipped(false);
                setIndex(i);
              }}
              aria-label={`Kart ${i + 1}`}
              className={`flex-shrink-0 rounded-full transition-all ${
                i === index
                  ? "w-2.5 h-2.5 bg-primary-container"
                  : "w-2 h-2 bg-surface-variant hover:bg-on-surface-variant/50"
              }`}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={goNext}
          disabled={index === total - 1}
          className="flex items-center gap-1.5 bg-primary-container text-on-primary-container font-mono text-label-sm px-4 py-2 rounded-lg hover:bg-primary disabled:opacity-30 disabled:cursor-not-allowed transition-all font-bold"
        >
          Sonraki
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>chevron_right</span>
        </button>
      </div>
    </div>
  );
}
