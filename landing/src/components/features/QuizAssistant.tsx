"use client";

import { useEffect, useRef, useState, ChangeEvent } from "react";
import { createPortal } from "react-dom";
import QuizView, { QuizQuestion } from "@/components/chat/QuizView";

import { apiFetch } from "@/lib/apiKey";
import { getAuthUser } from "@/lib/auth";
import {
  deleteSavedQuiz,
  getSavedQuizzes,
  saveQuiz,
  type SavedQuiz,
  type SoruTipi,
  type Zorluk,
} from "@/lib/savedQuizzes";
import {
  exportQuizAsDOCX,
  exportQuizAsJSON,
  exportQuizAsPDF,
} from "@/lib/quizExport";

type Step = "idle" | "modal" | "active";
type ModalTab = "yeni" | "gecmis";
type UploadedFile = { name: string; hash: string; chars: number };

// Arka planda çalışan test job'unun bilgisi burada tutulur. F5/sekme kapatma sonrası
// bu kayıttan job'a tekrar bağlanıp polling'e devam ederiz (sunucu üretmeye devam eder).
const ACTIVE_JOB_KEY = "lostick.activeTestJob";

// Maksimum dosya sayısı (backend MAX_FILES ile uyumlu olmalı)
const MAX_FILES = 10;

// Desteklenen dosya uzantıları (backend _extract_documents ile uyumlu)
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

const COUNT_OPTIONS = [3, 5, 7, 10, 15, 20, 30];
const DIFFICULTY_OPTIONS: Zorluk[] = ["Kolay", "Orta", "Zor"];
const SIK_OPTIONS: number[] = [3, 4, 5];
const SORU_TIPI_OPTIONS: { id: SoruTipi; label: string; description: string }[] = [
  { id: "klasik", label: "Klasik", description: "Sadece çoktan seçmeli" },
  { id: "karma", label: "Karma", description: "ÇS + Boşluk + Doğru/Yanlış" },
];

const DIFFICULTY_CHIP: Record<Zorluk, string> = {
  Kolay: "bg-emerald-500/15 border-emerald-500/40 text-emerald-200",
  Orta: "bg-primary-container/15 border-primary-container/40 text-primary-container",
  Zor: "bg-error/15 border-error/40 text-error",
};

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

export default function QuizAssistant() {
  const [step, setStep] = useState<Step>("idle");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [removingHash, setRemovingHash] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [soruSayisi, setSoruSayisi] = useState<number>(5);
  const [zorluk, setZorluk] = useState<Zorluk>("Orta");
  const [sikSayisi, setSikSayisi] = useState<number>(4);
  const [soruTipi, setSoruTipi] = useState<SoruTipi>("klasik");
  const [isCreating, setIsCreating] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);
  const [quizData, setQuizData] = useState<QuizQuestion[] | null>(null);
  const [savedList, setSavedList] = useState<SavedQuiz[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportMenuId, setExportMenuId] = useState<string | null>(null);
  const [exportMenuPos, setExportMenuPos] = useState<{
    x: number;
    y: number;
    openUpwards: boolean;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<ModalTab>("yeni");
  const [mounted, setMounted] = useState(false);
  // Arka plan test üretimi
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<{ progress: number; hedef: number } | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(type: "success" | "error" | "info", msg: string) {
    setToast({ type, msg });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 6000);
  }

  function clearJob() {
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_JOB_KEY);
    setActiveJobId(null);
    setJobProgress(null);
  }

  function openExportMenu(id: string, e: React.MouseEvent<HTMLButtonElement>) {
    // Aynı butona tekrar tıklandıysa kapat (toggle)
    if (exportMenuId === id) {
      setExportMenuId(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // Menü, butonun ÜSTÜNE açılır; üstte yer yoksa altına aç.
    const menuHeight = 220; // 5 satır × ~44px
    const openUpwards = rect.top > menuHeight + 16;
    setExportMenuPos({
      x: rect.left,
      y: openUpwards ? rect.top - 8 : rect.bottom + 8,
      openUpwards,
    });
    setExportMenuId(id);
  }

  // Portal için: client-side mount sonrası body'ye yazabilelim + sunucudaki dosyaları çek
  useEffect(() => {
    setMounted(true);
    syncDosyalar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kullanıcıya scope'lu kayıt listesini yükle + değişiklikleri dinle
  useEffect(() => {
    function refresh() {
      const user = getAuthUser();
      setSavedList(getSavedQuizzes(user?.id ?? null));
    }
    refresh();
    window.addEventListener("lostick:saved-quizzes-changed", refresh);
    window.addEventListener("lostick:auth-changed", refresh);
    return () => {
      window.removeEventListener("lostick:saved-quizzes-changed", refresh);
      window.removeEventListener("lostick:auth-changed", refresh);
    };
  }, []);

  function closeAll() {
    // Not: uploadedFiles'ı sıfırlamıyoruz — dosyalar sunucuda kalıcı, modal tekrar
    // açıldığında syncDosyalar ile geri yüklenir.
    setStep("idle");
    setQuizData(null);
    setUploadError(null);
    setQuizError(null);
    setIsUploading(false);
    setIsCreating(false);
    setConfirmDeleteId(null);
  }

  function handleResumeSaved(quiz: SavedQuiz) {
    setQuizData(quiz.questions);
    setStep("active");
  }

  function handleDeleteSaved(id: string) {
    deleteSavedQuiz(id);
    setConfirmDeleteId(null);
  }

  // Export menüsü dışına tıklayınca kapat
  useEffect(() => {
    if (!exportMenuId) return;
    function onClickOutside(e: MouseEvent) {
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(e.target as Node)
      ) {
        setExportMenuId(null);
      }
    }
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [exportMenuId]);

  async function handleExport(
    quiz: SavedQuiz,
    format: "pdf-q" | "pdf-a" | "docx-q" | "docx-a" | "json",
  ) {
    setExportMenuId(null);
    try {
      if (format === "pdf-q") exportQuizAsPDF(quiz, false);
      else if (format === "pdf-a") exportQuizAsPDF(quiz, true);
      else if (format === "docx-q") await exportQuizAsDOCX(quiz, false);
      else if (format === "docx-a") await exportQuizAsDOCX(quiz, true);
      else if (format === "json") exportQuizAsJSON(quiz);
    } catch (err) {
      console.error("Quiz export failed:", err);
      alert("İndirme başarısız oldu. Tarayıcı konsolunu kontrol et.");
    }
  }

  // Backend'in dönen dosya listesini state'e uygula
  function applyDosyalar(data: { dosyalar?: UploadedFile[] }) {
    if (Array.isArray(data.dosyalar)) setUploadedFiles(data.dosyalar);
  }

  // Sunucudaki güncel dosya listesini çek (modal açılışında / mount'ta senkron)
  async function syncDosyalar() {
    try {
      const res = await apiFetch("/api/dosyalar");
      if (res.ok) applyDosyalar(await res.json());
    } catch {
      /* sessizce geç */
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
        const response = await apiFetch("/api/pdf-yukle", {
          method: "POST",
          body: formData,
        });
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

  async function handleStartTest() {
    if (uploadedFiles.length === 0 || isCreating || activeJobId) return;
    setIsCreating(true);
    setQuizError(null);

    try {
      const response = await apiFetch("/api/test-olustur", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soru_sayisi: soruSayisi,
          zorluk,
          sik_sayisi: sikSayisi,
          soru_tipi: soruTipi,
        }),
      });

      if (!response.ok) {
        let detail = `${response.status}`;
        try {
          const errJson = await response.json();
          detail = errJson.detail ?? detail;
        } catch {
          /* fall through */
        }
        throw new Error(detail);
      }

      const data: { job_id?: string } = await response.json();
      if (!data.job_id) throw new Error("Test üretimi başlatılamadı.");

      // Çoklu dosyada geçmiş etiketi: tek dosya → adı, birden fazla → "ilk +N dosya"
      const ilkAd = uploadedFiles[0]?.name ?? "Bilinmeyen";
      const etiket =
        uploadedFiles.length > 1
          ? `${ilkAd} +${uploadedFiles.length - 1} dosya`
          : ilkAd;

      // Job metadata'sını sakla — F5/sekme kapatma sonrası geçmişe doğru kaydetmek için
      const meta = {
        jobId: data.job_id,
        pdfName: etiket,
        count: soruSayisi,
        difficulty: zorluk,
        sikSayisi,
        soruTipi,
      };
      localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(meta));
      setActiveJobId(data.job_id);
      setJobProgress({ progress: 0, hedef: soruSayisi });
      showToast("info", "Test arka planda hazırlanıyor — istediğin gibi gezebilirsin.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bilinmeyen hata";
      setQuizError(msg);
    } finally {
      setIsCreating(false);
    }
  }

  // Arka plan job'unu iptal et (kullanıcı 'Vazgeç' dediğinde)
  async function handleCancelJob() {
    const jobId = activeJobId;
    clearJob();
    if (jobId) {
      try {
        await apiFetch(`/api/test-iptal/${jobId}`, { method: "POST" });
      } catch {
        /* iptal isteği başarısız olsa da client tarafı temizlendi */
      }
      showToast("info", "Test üretimi iptal edildi.");
    }
  }

  // Footer "Vazgeç": job aktifse iptal et, değilse formu temizle
  function handleVazgec() {
    if (activeJobId) {
      handleCancelJob();
    }
    closeAll();
  }

  // Arka plan job'unu poll et — durum 'done' olunca geçmişe kaydet + toast
  useEffect(() => {
    if (!activeJobId) return;

    async function poll() {
      try {
        const res = await apiFetch(`/api/test-durum/${activeJobId}`);
        if (res.status === 404) {
          clearJob();
          showToast("error", "Test bulunamadı (sunucu yeniden başlamış olabilir). Tekrar dene.");
          return;
        }
        if (!res.ok) return; // geçici hata, sonraki tick'te tekrar denenir

        const data = await res.json();
        if (data.status === "running") {
          setJobProgress({ progress: data.progress ?? 0, hedef: data.hedef ?? 0 });
        } else if (data.status === "done") {
          const test: QuizQuestion[] = Array.isArray(data.test) ? data.test : [];
          // localStorage metadata'yı oku (F5 sonrası state sıfırlanmış olabilir)
          let meta: {
            pdfName?: string;
            difficulty?: Zorluk;
            sikSayisi?: number;
            soruTipi?: SoruTipi;
          } = {};
          try {
            const raw = localStorage.getItem(ACTIVE_JOB_KEY);
            if (raw) meta = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          clearJob();
          if (test.length === 0) {
            showToast("error", "Boş test döndü, tekrar dene.");
            return;
          }
          const user = getAuthUser();
          saveQuiz({
            userId: user?.id ?? null,
            pdfName: meta.pdfName ?? "Bilinmeyen PDF",
            count: test.length,
            difficulty: meta.difficulty ?? "Orta",
            sikSayisi: meta.sikSayisi,
            soruTipi: meta.soruTipi,
            questions: test,
          });
          showToast("success", `Test hazır! ${test.length} soru "Geçmiş" sekmesine eklendi.`);
        } else if (data.status === "error") {
          clearJob();
          showToast("error", data.error || "Test üretilemedi, tekrar dene.");
        } else if (data.status === "cancelled") {
          clearJob();
        }
      } catch {
        /* ağ hatası — sonraki tick'te tekrar denenir */
      }
    }

    poll(); // hemen bir kez
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  // Sayfa açıldığında devam eden bir job var mı? Varsa polling'e geri bağlan (F5 dayanıklılığı)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const meta = JSON.parse(raw);
        if (meta?.jobId) {
          setActiveJobId(meta.jobId);
          setJobProgress({ progress: 0, hedef: meta.count ?? 0 });
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="min-h-[calc(100vh-65px)] bg-surface">
      <div className="max-w-3xl mx-auto px-margin-mobile md:px-margin-desktop py-lg">
        <header className="mb-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-outline-variant/50 rounded-full bg-surface-container-highest/50 backdrop-blur-sm mb-4">
            <span
              className="material-symbols-outlined text-primary-container"
              style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}
            >
              quiz
            </span>
            <span className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
              Soru Çözüm Asistanı Modülü
            </span>
          </div>
          <h1 className="font-display text-headline-lg-mobile md:text-display-lg text-on-surface tracking-tight mb-2">
            Soru Çözüm <span className="text-primary-container">Asistanı</span>
          </h1>
          <p className="font-body text-body-lg text-on-surface-variant max-w-2xl">
            Belgelerini yükle, sınav ayarlarını seç; çoktan seçmeli veya karma
            testini saniyeler içinde üret ve çöz.
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
                    activeTab === "yeni"
                      ? "text-primary-container"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      add_circle
                    </span>
                    Yeni Test
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
                    activeTab === "gecmis"
                      ? "text-primary-container"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      history
                    </span>
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
                    <span
                      className="material-symbols-outlined text-on-surface-variant/40"
                      style={{ fontSize: 40 }}
                    >
                      history
                    </span>
                    <p className="font-body text-body-md text-on-surface-variant">
                      Henüz kaydedilmiş test yok
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab("yeni")}
                      className="font-mono text-label-sm text-primary-container hover:text-primary transition-colors uppercase tracking-wider"
                    >
                      İlk testini oluştur →
                    </button>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {savedList.map((sq) => {
                      const isConfirming = confirmDeleteId === sq.id;
                      return (
                        <li
                          key={sq.id}
                          className="group relative bg-surface-container-lowest border border-surface-variant hover:border-primary-container/50 rounded-xl p-3 transition-all"
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-lg bg-primary-container/10 border border-primary-container/30 flex items-center justify-center flex-shrink-0">
                              <span
                                className="material-symbols-outlined text-primary-container"
                                style={{ fontSize: 20 }}
                              >
                                quiz
                              </span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p
                                className="font-body text-sm text-on-surface font-semibold truncate"
                                title={sq.pdfName}
                              >
                                {sq.pdfName.replace(/\.pdf$/i, "")}
                              </p>
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                <span className="font-mono text-label-sm text-on-surface-variant/80">
                                  {sq.count} soru
                                </span>
                                <span
                                  className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${DIFFICULTY_CHIP[sq.difficulty]}`}
                                >
                                  {sq.difficulty}
                                </span>
                                {sq.soruTipi && (
                                  <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border bg-primary-container/15 border-primary-container/40 text-primary-container">
                                    {sq.soruTipi}
                                  </span>
                                )}
                                {typeof sq.sikSayisi === "number" && (
                                  <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border bg-surface-variant/30 border-surface-variant text-on-surface-variant">
                                    {sq.sikSayisi} şık
                                  </span>
                                )}
                                <span className="font-mono text-label-sm text-on-surface-variant/50">
                                  · {formatRelative(sq.createdAt)}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Aksiyon satırı — kart altında */}
                          {isConfirming ? (
                            <div className="mt-3 pt-3 border-t border-surface-variant flex items-center justify-between gap-2">
                              <p className="font-mono text-label-sm text-error">
                                Bu testi silmek istiyor musun?
                              </p>
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
                                  onClick={() => handleDeleteSaved(sq.id)}
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
                                  onClick={() => setConfirmDeleteId(sq.id)}
                                  aria-label="Bu testi sil"
                                  className="font-mono text-label-sm text-on-surface-variant/70 hover:text-error flex items-center gap-1 transition-colors"
                                >
                                  <span
                                    className="material-symbols-outlined"
                                    style={{ fontSize: 16 }}
                                  >
                                    delete
                                  </span>
                                  Sil
                                </button>

                                {/* İndir butonu — dropdown portal'da render edilir (aşağıda) */}
                                <button
                                  type="button"
                                  onClick={(e) => openExportMenu(sq.id, e)}
                                  aria-label="Bu testi indir"
                                  aria-expanded={exportMenuId === sq.id}
                                  className="font-mono text-label-sm text-on-surface-variant/70 hover:text-primary-container flex items-center gap-1 transition-colors"
                                >
                                  <span
                                    className="material-symbols-outlined"
                                    style={{ fontSize: 16 }}
                                  >
                                    download
                                  </span>
                                  İndir
                                  <span
                                    className="material-symbols-outlined"
                                    style={{ fontSize: 14 }}
                                  >
                                    expand_more
                                  </span>
                                </button>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleResumeSaved(sq)}
                                className="bg-primary-container/15 hover:bg-primary-container/25 text-primary-container border border-primary-container/40 font-mono text-label-sm px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors font-bold"
                              >
                                <span
                                  className="material-symbols-outlined"
                                  style={{ fontSize: 16 }}
                                >
                                  play_arrow
                                </span>
                                Başlat
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
              {/* Dosya yükleme alanı */}
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

                {/* Yüklenmiş dosya listesi */}
                {uploadedFiles.length > 0 && (
                  <div className="space-y-1.5">
                    {uploadedFiles.map((f) => (
                      <div
                        key={f.hash}
                        className="flex items-center gap-2 bg-primary-container/10 border border-primary-container/40 rounded-lg px-3 py-2"
                      >
                        <span
                          className="material-symbols-outlined text-primary-container flex-shrink-0"
                          style={{ fontSize: 18 }}
                        >
                          description
                        </span>
                        <p
                          className="flex-1 min-w-0 font-body text-sm text-on-surface truncate"
                          title={f.name}
                        >
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
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                              close
                            </span>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Ekleme alanı */}
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
                        <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest">
                          Yükleniyor
                        </p>
                      </>
                    ) : uploadedFiles.length === 0 ? (
                      <>
                        <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 28 }}>
                          upload_file
                        </span>
                        <p className="font-body text-body-md text-on-surface">Dosya Seç</p>
                      </>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 18 }}>
                          add
                        </span>
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
                    <span
                      className="material-symbols-outlined text-error flex-shrink-0"
                      style={{ fontSize: 18 }}
                    >
                      error
                    </span>
                    <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">
                      {uploadError}
                    </p>
                  </div>
                )}
              </div>

              {/* Soru sayısı */}
              <fieldset
                disabled={uploadedFiles.length === 0 || isCreating}
                className="space-y-2"
              >
                <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
                  2 · Soru Sayısı
                </legend>
                <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
                  {COUNT_OPTIONS.map((n) => {
                    const active = soruSayisi === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setSoruSayisi(n)}
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

              {/* Zorluk */}
              <fieldset
                disabled={uploadedFiles.length === 0 || isCreating}
                className="space-y-2"
              >
                <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
                  3 · Zorluk
                </legend>
                <div className="grid grid-cols-3 gap-2">
                  {DIFFICULTY_OPTIONS.map((z) => {
                    const active = zorluk === z;
                    return (
                      <button
                        key={z}
                        type="button"
                        onClick={() => setZorluk(z)}
                        className={`py-3 rounded-lg border font-mono text-label-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                          active
                            ? "bg-primary-container/15 border-primary-container text-primary-container"
                            : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                        }`}
                      >
                        {z}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {/* Şık sayısı */}
              <fieldset
                disabled={uploadedFiles.length === 0 || isCreating}
                className="space-y-2"
              >
                <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
                  4 · Şık Sayısı
                </legend>
                <div className="grid grid-cols-3 gap-2">
                  {SIK_OPTIONS.map((n) => {
                    const active = sikSayisi === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setSikSayisi(n)}
                        className={`py-3 rounded-lg border font-mono text-label-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                          active
                            ? "bg-primary-container/15 border-primary-container text-primary-container"
                            : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                        }`}
                      >
                        {n} Şık
                      </button>
                    );
                  })}
                </div>
                {soruTipi === "karma" && (
                  <p className="font-mono text-label-sm text-on-surface-variant/70 mt-1">
                    Doğru/Yanlış sorularda her zaman 2 şık olur. Bu ayar diğer tipler için geçerlidir.
                  </p>
                )}
              </fieldset>

              {/* Soru tipi */}
              <fieldset
                disabled={uploadedFiles.length === 0 || isCreating}
                className="space-y-2"
              >
                <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
                  5 · Soru Tipi
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {SORU_TIPI_OPTIONS.map((t) => {
                    const active = soruTipi === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSoruTipi(t.id)}
                        className={`py-2 px-3 rounded-lg border font-mono text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                          active
                            ? "bg-primary-container/15 border-primary-container text-primary-container"
                            : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                        }`}
                      >
                        <p className="text-label-sm font-bold uppercase tracking-wider">
                          {t.label}
                        </p>
                        <p className="text-[10px] mt-0.5 opacity-80">
                          {t.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {quizError && (
                <div className="flex items-start gap-2 bg-error-container/20 border border-error/40 rounded-lg p-3">
                  <span
                    className="material-symbols-outlined text-error flex-shrink-0"
                    style={{ fontSize: 18 }}
                  >
                    error
                  </span>
                  <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">
                    {quizError}
                  </p>
                </div>
              )}
                </div>
              )}
            </div>

            {/* Footer — sadece Yeni Test sekmesinde aksiyon butonları gösterilsin */}
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
                  onClick={handleStartTest}
                  disabled={uploadedFiles.length === 0 || isCreating || isUploading || !!activeJobId}
                  className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-2 min-w-[160px] justify-center"
                >
                  {activeJobId ? (
                    <>
                      <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                      {jobProgress && jobProgress.hedef > 0
                        ? `Hazırlanıyor ${jobProgress.progress}/${jobProgress.hedef}`
                        : "Hazırlanıyor"}
                    </>
                  ) : isCreating ? (
                    <>
                      <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
                      Başlatılıyor
                    </>
                  ) : (
                    <>
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 18 }}
                      >
                        quiz
                      </span>
                      Testi Başlat
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
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                    add
                  </span>
                  Yeni Test
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tam ekran sınav — Portal ile body'ye gönder; parent stacking context'lerini bypass eder */}
      {mounted && step === "active" && quizData &&
        createPortal(
          <div
            className="fixed inset-0 bg-background flex flex-col"
            style={{ zIndex: 9999 }}
          >
            <QuizView quiz={quizData} onExit={closeAll} />
          </div>,
          document.body,
        )}

      {/* İndirme menüsü — portal ile body'ye, modal'ın overflow:hidden'ı tarafından kesilmesin diye */}
      {mounted && exportMenuId && exportMenuPos &&
        (() => {
          const sq = savedList.find((q) => q.id === exportMenuId);
          if (!sq) return null;
          return createPortal(
            <div
              ref={exportMenuRef}
              className="min-w-[230px] bg-surface-container-high border border-surface-variant rounded-lg shadow-2xl overflow-hidden"
              style={{
                position: "fixed",
                left: exportMenuPos.x,
                top: exportMenuPos.y,
                transform: exportMenuPos.openUpwards ? "translateY(-100%)" : "translateY(0)",
                zIndex: 10000,
              }}
            >
              <button
                type="button"
                onClick={() => handleExport(sq, "pdf-q")}
                className="w-full flex items-center gap-2 px-3 py-2 font-mono text-label-sm text-on-surface hover:bg-surface-container-highest transition-colors text-left"
              >
                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>
                  picture_as_pdf
                </span>
                <span className="flex-1">PDF · Sadece Sorular</span>
              </button>
              <button
                type="button"
                onClick={() => handleExport(sq, "pdf-a")}
                className="w-full flex items-center gap-2 px-3 py-2 font-mono text-label-sm text-on-surface hover:bg-surface-container-highest transition-colors text-left border-t border-surface-variant"
              >
                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>
                  picture_as_pdf
                </span>
                <span className="flex-1">PDF · Cevap Anahtarlı</span>
              </button>
              <button
                type="button"
                onClick={() => handleExport(sq, "docx-q")}
                className="w-full flex items-center gap-2 px-3 py-2 font-mono text-label-sm text-on-surface hover:bg-surface-container-highest transition-colors text-left border-t border-surface-variant"
              >
                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>
                  description
                </span>
                <span className="flex-1">DOCX · Sadece Sorular</span>
              </button>
              <button
                type="button"
                onClick={() => handleExport(sq, "docx-a")}
                className="w-full flex items-center gap-2 px-3 py-2 font-mono text-label-sm text-on-surface hover:bg-surface-container-highest transition-colors text-left border-t border-surface-variant"
              >
                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>
                  description
                </span>
                <span className="flex-1">DOCX · Cevap Anahtarlı</span>
              </button>
              <button
                type="button"
                onClick={() => handleExport(sq, "json")}
                className="w-full flex items-center gap-2 px-3 py-2 font-mono text-label-sm text-on-surface hover:bg-surface-container-highest transition-colors text-left border-t border-surface-variant"
              >
                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>
                  data_object
                </span>
                <span className="flex-1">JSON · Ham Veri</span>
              </button>
            </div>,
            document.body,
          );
        })()}

      {/* Arka plan test üretimi göstergesi — modal kapalıyken her sayfada görünür, buradan iptal edilebilir */}
      {mounted && activeJobId && step !== "modal" &&
        createPortal(
          <div
            className="fixed bottom-4 right-4 max-w-xs bg-surface-container-high border border-primary-container/40 rounded-xl shadow-2xl p-3 flex items-center gap-3"
            style={{ zIndex: 10001 }}
          >
            <span className="w-5 h-5 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-label-sm text-on-surface">
                Test hazırlanıyor
              </p>
              <p className="font-mono text-[10px] text-on-surface-variant/70">
                Bitince &quot;Geçmiş&quot;e eklenecek
              </p>
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

      {/* Toast bildirimi */}
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
                toast.type === "success"
                  ? "text-emerald-400"
                  : toast.type === "error"
                  ? "text-error"
                  : "text-primary-container"
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
