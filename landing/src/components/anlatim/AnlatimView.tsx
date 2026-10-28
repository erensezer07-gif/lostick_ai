"use client";

import {
  ChangeEvent,
  isValidElement,
  ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

import { apiFetch } from "@/lib/apiKey";
import { getAuthUser } from "@/lib/auth";
import {
  deleteSavedAnlatim,
  getSavedAnlatim,
  saveAnlatim,
  type AnlatimMod,
  type AnlatimUzunluk,
  type SavedAnlatim,
} from "@/lib/savedAnlatim";
import {
  exportAnlatimAsDOCX,
  exportAnlatimAsJSON,
  exportAnlatimAsPDF,
} from "@/lib/anlatimExport";

// Mermaid ve SvgBlock'u sadece tarayıcıda lazy yükle (DOM API kullanır)
const MermaidBlock = dynamic(
  () => import("@/components/markdown/MermaidBlock"),
  { ssr: false },
);
const SvgBlock = dynamic(
  () => import("@/components/markdown/SvgBlock"),
  { ssr: false },
);

// ─── Sabitler ─────────────────────────────────────────────────────────

const ACTIVE_JOB_KEY = "lostick.activeAnlatimJob";
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

const DEFAULT_KONU_BASLIGI =
  "Tüm belgenin genel özeti, ana mantığı ve en temel kavramları";

const UZUNLUK_OPTIONS: { id: AnlatimUzunluk; label: string; description: string }[] = [
  { id: "kisa", label: "Kısa", description: "Tüm konulara değinen özlü özet" },
  { id: "orta", label: "Orta", description: "Tüm konuları kapsayan dengeli anlatım" },
  { id: "uzun", label: "Uzun", description: "Her konunun detaylı ve kapsamlı anlatımı" },
];

const MOD_OPTIONS: { id: AnlatimMod; label: string; description: string }[] = [
  {
    id: "ogretici",
    label: "Öğretici",
    description: "Sıfırdan, benzetmeler ve örneklerle",
  },
  {
    id: "sinav_odakli",
    label: "Sınav Odaklı",
    description: "Maddeler, tanımlar, örnek sorular",
  },
];

const UZUNLUK_LABEL: Record<AnlatimUzunluk, string> = {
  kisa: "Kısa",
  orta: "Orta",
  uzun: "Uzun",
};

const MOD_LABEL: Record<AnlatimMod, string> = {
  ogretici: "Öğretici",
  sinav_odakli: "Sınav Odaklı",
};

const UZUNLUK_CHIP: Record<AnlatimUzunluk, string> = {
  kisa: "bg-emerald-500/15 border-emerald-500/40 text-emerald-200",
  orta: "bg-primary-container/15 border-primary-container/40 text-primary-container",
  uzun: "bg-error/15 border-error/40 text-error",
};

// ─── Tipler ───────────────────────────────────────────────────────────

type UploadedFile = { name: string; hash: string; chars: number };
type Tab = "yeni" | "gecmis";
type Step = "config" | "ready";

interface CodeElementProps {
  className?: string;
  children?: React.ReactNode;
}

function extractCodeByLanguage(
  node: React.ReactNode,
  language: string,
): string | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<CodeElementProps>;
  const className = el.props.className ?? "";
  const match = /language-(\w+)/.exec(className);
  if (match?.[1] !== language) return null;
  return String(el.props.children ?? "").trim();
}

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

// ─── Ana component ────────────────────────────────────────────────────

export default function AnlatimView() {
  const [step, setStep] = useState<Step>("config");
  const [activeTab, setActiveTab] = useState<Tab>("yeni");

  // Dosya yönetimi
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [removingHash, setRemovingHash] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Konfigürasyon
  const [uzunluk, setUzunluk] = useState<AnlatimUzunluk>("orta");
  const [mod, setMod] = useState<AnlatimMod>("ogretici");
  const [konuBasligi, setKonuBasligi] = useState("");

  // Üretim state'i
  const [isStarting, setIsStarting] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [anlatim, setAnlatim] = useState<string | null>(null);
  const [currentSaved, setCurrentSaved] = useState<SavedAnlatim | null>(null);

  // Arka plan job
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  // Geçmiş
  const [savedList, setSavedList] = useState<SavedAnlatim[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportMenuId, setExportMenuId] = useState<string | null>(null);
  const [exportMenuPos, setExportMenuPos] = useState<{
    x: number;
    y: number;
    openUpwards: boolean;
  } | null>(null);

  // Top-of-article export menüsü
  const [topExportOpen, setTopExportOpen] = useState(false);
  const [topExportPos, setTopExportPos] = useState<{ x: number; y: number } | null>(null);

  // Toast
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const topExportMenuRef = useRef<HTMLDivElement>(null);

  function showToast(type: "success" | "error" | "info", msg: string) {
    setToast({ type, msg });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 6000);
  }

  function clearJob() {
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_JOB_KEY);
    setActiveJobId(null);
  }

  // ─── Mount + initial load ───
  useEffect(() => {
    setMounted(true);
    syncDosyalar();
  }, []);

  // ─── Geçmiş listesini yükle + değişiklikleri dinle ───
  useEffect(() => {
    function refresh() {
      const user = getAuthUser();
      setSavedList(getSavedAnlatim(user?.id ?? null));
    }
    refresh();
    window.addEventListener("lostick:saved-anlatim-changed", refresh);
    window.addEventListener("lostick:auth-changed", refresh);
    return () => {
      window.removeEventListener("lostick:saved-anlatim-changed", refresh);
      window.removeEventListener("lostick:auth-changed", refresh);
    };
  }, []);

  // ─── Devam eden job'a tekrar bağlan (F5 dayanıklılığı) ───
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const meta = JSON.parse(raw);
        if (meta?.jobId) {
          setActiveJobId(meta.jobId);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // ─── Export menüsü dış-tıkla kapatma ───
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

  useEffect(() => {
    if (!topExportOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (
        topExportMenuRef.current &&
        !topExportMenuRef.current.contains(e.target as Node)
      ) {
        setTopExportOpen(false);
      }
    }
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [topExportOpen]);

  // ─── Backend dosyalar API ───
  function applyDosyalar(data: { dosyalar?: UploadedFile[] }) {
    if (Array.isArray(data.dosyalar)) setUploadedFiles(data.dosyalar);
  }

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

  // ─── Anlatım üretimi (job-based) ───
  async function handleStart() {
    if (uploadedFiles.length === 0 || isStarting || activeJobId) return;
    setIsStarting(true);
    setGenError(null);

    const aktifKonu = konuBasligi.trim() || DEFAULT_KONU_BASLIGI;

    try {
      const response = await apiFetch("/api/anlatim-baslat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          konu_basligi: aktifKonu,
          uzunluk,
          mod,
        }),
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

      const data: {
        status?: string;
        job_id?: string;
        anlatim?: string;
        cached?: boolean;
      } = await response.json();

      // Cache hit — hemen kaydet ve göster
      if (data.status === "done" && data.anlatim) {
        finalizeAnlatim(data.anlatim);
        return;
      }

      if (!data.job_id) throw new Error("Anlatım üretimi başlatılamadı.");

      const ilkAd = uploadedFiles[0]?.name ?? "Bilinmeyen";
      const etiket =
        uploadedFiles.length > 1
          ? `${ilkAd} +${uploadedFiles.length - 1} dosya`
          : ilkAd;

      const meta = { jobId: data.job_id, pdfName: etiket, uzunluk, mod, konuBasligi: aktifKonu };
      localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(meta));
      setActiveJobId(data.job_id);
      showToast("info", "Anlatım arka planda hazırlanıyor — istersen gezinebilirsin.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bilinmeyen hata";
      setGenError(msg);
    } finally {
      setIsStarting(false);
    }
  }

  // Cache hit veya job tamamlandığında ortak nokta
  function finalizeAnlatim(markdown: string) {
    let pdfName = uploadedFiles[0]?.name ?? "Bilinmeyen";
    if (uploadedFiles.length > 1) {
      pdfName = `${pdfName} +${uploadedFiles.length - 1} dosya`;
    }
    // Job metadata'sını oku (F5 sonrası state sıfırlanmış olabilir)
    let metaUzunluk = uzunluk;
    let metaMod = mod;
    let metaKonu = konuBasligi.trim() || DEFAULT_KONU_BASLIGI;
    try {
      const raw = localStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const m = JSON.parse(raw);
        if (m?.pdfName) pdfName = m.pdfName;
        if (m?.uzunluk) metaUzunluk = m.uzunluk;
        if (m?.mod) metaMod = m.mod;
        if (m?.konuBasligi) metaKonu = m.konuBasligi;
      }
    } catch {
      /* ignore */
    }

    const user = getAuthUser();
    const saved = saveAnlatim({
      userId: user?.id ?? null,
      pdfName,
      konuBasligi: metaKonu,
      uzunluk: metaUzunluk,
      mod: metaMod,
      markdown,
    });

    setCurrentSaved(saved);
    setAnlatim(markdown);
    setStep("ready");
  }

  // ─── Job polling ───
  useEffect(() => {
    if (!activeJobId) return;

    async function poll() {
      try {
        const res = await apiFetch(`/api/anlatim-durum/${activeJobId}`);
        if (res.status === 404) {
          clearJob();
          showToast(
            "error",
            "Anlatım bulunamadı (sunucu yeniden başlamış olabilir). Tekrar dene.",
          );
          return;
        }
        if (!res.ok) return;

        const data = await res.json();
        if (data.status === "running") {
          // sadece bekle
        } else if (data.status === "done") {
          const markdown: string = data.anlatim ?? "";
          if (!markdown) {
            clearJob();
            showToast("error", "Boş anlatım döndü, tekrar dene.");
            return;
          }
          finalizeAnlatim(markdown);  // Önce metadata oku (localStorage'dan pdfName, uzunluk, mod)
          clearJob();                  // Sonra temizle
          showToast("success", "Anlatım hazır!");
        } else if (data.status === "error") {
          clearJob();
          showToast("error", data.error || "Anlatım üretilemedi, tekrar dene.");
        } else if (data.status === "cancelled") {
          clearJob();
        }
      } catch {
        /* ağ hatası — sonraki tick */
      }
    }

    poll();
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  // ─── Job iptal ───
  async function handleCancelJob() {
    const jobId = activeJobId;
    clearJob();
    if (jobId) {
      try {
        await apiFetch(`/api/anlatim-iptal/${jobId}`, { method: "POST" });
      } catch {
        /* yine de client tarafı temizlendi */
      }
      showToast("info", "Anlatım üretimi iptal edildi.");
    }
  }

  // ─── Geçmişten devam ───
  function handleResumeSaved(s: SavedAnlatim) {
    setCurrentSaved(s);
    setAnlatim(s.markdown);
    setStep("ready");
  }

  function handleDeleteSaved(id: string) {
    deleteSavedAnlatim(id);
    setConfirmDeleteId(null);
  }

  // ─── Yeni anlatıma dön ───
  function handleNewAnlatim() {
    setAnlatim(null);
    setCurrentSaved(null);
    setStep("config");
    setActiveTab("yeni");
    setGenError(null);
  }

  // ─── Export menü işleyicileri ───
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

  function openTopExport(e: React.MouseEvent<HTMLButtonElement>) {
    if (topExportOpen) {
      setTopExportOpen(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setTopExportPos({ x: rect.right - 200, y: rect.bottom + 8 });
    setTopExportOpen(true);
  }

  async function handleExport(s: SavedAnlatim, format: "pdf" | "docx" | "json") {
    setExportMenuId(null);
    setTopExportOpen(false);
    try {
      if (format === "pdf") exportAnlatimAsPDF(s);
      else if (format === "docx") await exportAnlatimAsDOCX(s);
      else if (format === "json") exportAnlatimAsJSON(s);
    } catch (err) {
      console.error("Anlatım export failed:", err);
      alert("İndirme başarısız oldu. Tarayıcı konsolunu kontrol et.");
    }
  }

  // ─── Render ───

  if (step === "ready" && anlatim && currentSaved) {
    return (
      <ArticleView
        anlatim={anlatim}
        saved={currentSaved}
        onNew={handleNewAnlatim}
        onExport={openTopExport}
      />
    );
  }

  return (
    <div className="min-h-[calc(100vh-65px)] bg-surface">
      <div className="max-w-4xl mx-auto px-margin-mobile md:px-margin-desktop py-lg">
        <header className="mb-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-outline-variant/50 rounded-full bg-surface-container-highest/50 backdrop-blur-sm mb-4">
            <span
              className="material-symbols-outlined text-primary-container"
              style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}
            >
              menu_book
            </span>
            <span className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
              Akıllı Konu Anlatımı Modülü
            </span>
          </div>
          <h1 className="font-display text-headline-lg-mobile md:text-display-lg text-on-surface tracking-tight mb-2">
            Akıllı{" "}
            <span className="text-primary-container">Konu Anlatımı</span>
          </h1>
          <p className="font-body text-body-lg text-on-surface-variant max-w-2xl">
            Dosyalarını yükle, uzunluğu ve modu seç — Lostick AI sana özel konu
            anlatımını üretsin.
          </p>
        </header>

        {/* Tab strip */}
        <div className="border-b border-surface-variant mb-md">
          <div role="tablist" className="flex gap-1">
            <button
              role="tab"
              aria-selected={activeTab === "yeni"}
              type="button"
              onClick={() => setActiveTab("yeni")}
              disabled={isUploading || isStarting}
              className={`relative px-4 py-2.5 font-mono text-label-sm uppercase tracking-wider transition-colors disabled:opacity-40 ${
                activeTab === "yeni"
                  ? "text-primary-container"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                  add_circle
                </span>
                Yeni Anlatım
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
              disabled={isUploading || isStarting || savedList.length === 0}
              className={`relative px-4 py-2.5 font-mono text-label-sm uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
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
        {activeTab === "yeni" ? (
          <NewAnlatimPanel
            uploadedFiles={uploadedFiles}
            isUploading={isUploading}
            isStarting={isStarting}
            removingHash={removingHash}
            uploadError={uploadError}
            uzunluk={uzunluk}
            setUzunluk={setUzunluk}
            mod={mod}
            setMod={setMod}
            konuBasligi={konuBasligi}
            setKonuBasligi={setKonuBasligi}
            genError={genError}
            activeJobId={activeJobId}
            fileInputRef={fileInputRef}
            onFileChange={handleFileChange}
            onRemoveFile={handleRemoveFile}
            onStart={handleStart}
            onCancelJob={handleCancelJob}
          />
        ) : (
          <HistoryPanel
            savedList={savedList}
            confirmDeleteId={confirmDeleteId}
            exportMenuId={exportMenuId}
            onConfirmDelete={setConfirmDeleteId}
            onDelete={handleDeleteSaved}
            onResume={handleResumeSaved}
            onOpenExportMenu={openExportMenu}
            onSwitchToNew={() => setActiveTab("yeni")}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Export dropdown — geçmişteki kartlardan */}
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

      {/* Top export menu — makale görünümünde */}
      {mounted && topExportOpen && topExportPos && currentSaved &&
        createPortal(
          <div
            ref={topExportMenuRef}
            className="min-w-[200px] bg-surface-container-high border border-surface-variant rounded-lg shadow-2xl overflow-hidden"
            style={{
              position: "fixed",
              left: topExportPos.x,
              top: topExportPos.y,
              zIndex: 10000,
            }}
          >
            <ExportMenuItem icon="picture_as_pdf" label="PDF" onClick={() => handleExport(currentSaved, "pdf")} />
            <ExportMenuItem icon="description" label="DOCX (Word)" onClick={() => handleExport(currentSaved, "docx")} divider />
            <ExportMenuItem icon="data_object" label="JSON · Ham Veri" onClick={() => handleExport(currentSaved, "json")} divider />
          </div>,
          document.body,
        )}

      {/* Arka plan job göstergesi */}
      {mounted && activeJobId && step === "ready" &&
        createPortal(
          <div
            className="fixed bottom-4 right-4 max-w-xs bg-surface-container-high border border-primary-container/40 rounded-xl shadow-2xl p-3 flex items-center gap-3"
            style={{ zIndex: 10001 }}
          >
            <span className="w-5 h-5 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-label-sm text-on-surface">Anlatım hazırlanıyor</p>
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
            style={{ zIndex: 10002, marginBottom: activeJobId && step === "ready" ? "5rem" : 0 }}
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

// ─── Yeni Anlatım Paneli ──────────────────────────────────────────────

interface NewAnlatimPanelProps {
  uploadedFiles: UploadedFile[];
  isUploading: boolean;
  isStarting: boolean;
  removingHash: string | null;
  uploadError: string | null;
  uzunluk: AnlatimUzunluk;
  setUzunluk: (u: AnlatimUzunluk) => void;
  mod: AnlatimMod;
  setMod: (m: AnlatimMod) => void;
  konuBasligi: string;
  setKonuBasligi: (k: string) => void;
  genError: string | null;
  activeJobId: string | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (hash: string) => void;
  onStart: () => void;
  onCancelJob: () => void;
}

function NewAnlatimPanel({
  uploadedFiles,
  isUploading,
  isStarting,
  removingHash,
  uploadError,
  uzunluk,
  setUzunluk,
  mod,
  setMod,
  konuBasligi,
  setKonuBasligi,
  genError,
  activeJobId,
  fileInputRef,
  onRemoveFile,
  onStart,
  onCancelJob,
}: NewAnlatimPanelProps) {
  return (
    <div className="bg-surface-container-low border border-surface-variant rounded-xl p-md md:p-lg space-y-md">
      {/* 1 · Dosyalar */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
            1 · Dosyalar
          </p>
          <span className="font-mono text-label-sm text-on-surface-variant/60">
            {uploadedFiles.length}/{MAX_FILES}
          </span>
        </div>

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
                  onClick={() => onRemoveFile(f.hash)}
                  disabled={isStarting || removingHash === f.hash}
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

        {uploadedFiles.length < MAX_FILES && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || isStarting}
            className={`w-full border border-dashed border-outline-variant hover:border-primary-container bg-surface-container-lowest hover:bg-surface-container-low rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
              uploadedFiles.length === 0 ? "p-lg flex-col" : "py-2.5"
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
                <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 32 }}>
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
      </section>

      {/* 2 · Uzunluk */}
      <fieldset
        disabled={uploadedFiles.length === 0 || isStarting}
        className="space-y-2"
      >
        <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
          2 · Uzunluk
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {UZUNLUK_OPTIONS.map((u) => {
            const active = uzunluk === u.id;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setUzunluk(u.id)}
                className={`py-2.5 px-2 rounded-lg border font-mono text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? "bg-primary-container/15 border-primary-container text-primary-container"
                    : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                }`}
              >
                <p className="text-label-sm font-bold uppercase tracking-wider">{u.label}</p>
                <p className="text-[10px] mt-0.5 opacity-80">{u.description}</p>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* 3 · Mod */}
      <fieldset
        disabled={uploadedFiles.length === 0 || isStarting}
        className="space-y-2"
      >
        <legend className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
          3 · Anlatım Modu
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {MOD_OPTIONS.map((m) => {
            const active = mod === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setMod(m.id)}
                className={`py-2.5 px-3 rounded-lg border font-mono text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  active
                    ? "bg-primary-container/15 border-primary-container text-primary-container"
                    : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                }`}
              >
                <p className="text-label-sm font-bold uppercase tracking-wider">{m.label}</p>
                <p className="text-[10px] mt-0.5 opacity-80">{m.description}</p>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* 4 · Konu Başlığı */}
      <div className="space-y-2">
        <label htmlFor="konu-basligi-input" className="block font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
          4 · Açıklanmasını İstediğin Özel Bir Konu (Opsiyonel)
        </label>
        <div className="relative">
          <input
            id="konu-basligi-input"
            type="text"
            value={konuBasligi}
            onChange={(e) => setKonuBasligi(e.target.value)}
            disabled={uploadedFiles.length === 0 || isStarting}
            placeholder="Örn: TCP Üçlü El Sıkışması, Fotosentez Evreleri, Mercekler... (Boş bırakılırsa tüm belgenin özeti çıkarılır)"
            className="w-full bg-surface-container-low border border-surface-variant rounded-lg px-4 py-3 font-body text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          />
          {konuBasligi && (
            <button
              type="button"
              onClick={() => setKonuBasligi("")}
              disabled={uploadedFiles.length === 0 || isStarting}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                close
              </span>
            </button>
          )}
        </div>
      </div>

      {genError && (
        <div className="flex items-start gap-2 bg-error-container/20 border border-error/40 rounded-lg p-3">
          <span
            className="material-symbols-outlined text-error flex-shrink-0"
            style={{ fontSize: 18 }}
          >
            error
          </span>
          <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">
            {genError}
          </p>
        </div>
      )}

      {/* Aksiyon */}
      <div className="flex items-center justify-end gap-2 pt-md border-t border-surface-variant">
        <button
          type="button"
          onClick={onCancelJob}
          disabled={!activeJobId}
          className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {activeJobId ? "İptal Et" : "Vazgeç"}
        </button>
        <button
          type="button"
          onClick={onStart}
          disabled={uploadedFiles.length === 0 || isStarting || isUploading || !!activeJobId}
          className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-2 min-w-[180px] justify-center"
        >
          {activeJobId ? (
            <>
              <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
              Hazırlanıyor
            </>
          ) : isStarting ? (
            <>
              <span className="w-4 h-4 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin" />
              Başlatılıyor
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                auto_awesome
              </span>
              Anlatımı Başlat
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Geçmiş Paneli ────────────────────────────────────────────────────

interface HistoryPanelProps {
  savedList: SavedAnlatim[];
  confirmDeleteId: string | null;
  exportMenuId: string | null;
  onConfirmDelete: (id: string | null) => void;
  onDelete: (id: string) => void;
  onResume: (s: SavedAnlatim) => void;
  onOpenExportMenu: (id: string, e: React.MouseEvent<HTMLButtonElement>) => void;
  onSwitchToNew: () => void;
}

function HistoryPanel({
  savedList,
  confirmDeleteId,
  exportMenuId,
  onConfirmDelete,
  onDelete,
  onResume,
  onOpenExportMenu,
  onSwitchToNew,
}: HistoryPanelProps) {
  if (savedList.length === 0) {
    return (
      <div className="bg-surface-container-low border border-surface-variant rounded-xl p-lg flex flex-col items-center justify-center text-center gap-2">
        <span
          className="material-symbols-outlined text-on-surface-variant/40"
          style={{ fontSize: 40 }}
        >
          history
        </span>
        <p className="font-body text-body-md text-on-surface-variant">
          Henüz kaydedilmiş anlatım yok
        </p>
        <button
          type="button"
          onClick={onSwitchToNew}
          className="font-mono text-label-sm text-primary-container hover:text-primary transition-colors uppercase tracking-wider"
        >
          İlk anlatımını oluştur →
        </button>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {savedList.map((s) => {
        const isConfirming = confirmDeleteId === s.id;
        return (
          <li
            key={s.id}
            className="group relative bg-surface-container-low border border-surface-variant hover:border-primary-container/50 rounded-xl p-3 transition-all"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary-container/10 border border-primary-container/30 flex items-center justify-center flex-shrink-0">
                <span
                  className="material-symbols-outlined text-primary-container"
                  style={{ fontSize: 20 }}
                >
                  menu_book
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className="font-body text-sm text-on-surface font-semibold truncate"
                  title={s.pdfName}
                >
                  {s.pdfName.replace(/\.pdf$/i, "")}
                </p>
                {s.konuBasligi && s.konuBasligi !== DEFAULT_KONU_BASLIGI && (
                  <p className="font-mono text-[11px] text-primary-container mt-0.5 truncate">
                    Konu: <span className="font-semibold text-on-surface-variant/90">{s.konuBasligi}</span>
                  </p>
                )}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span
                    className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${UZUNLUK_CHIP[s.uzunluk]}`}
                  >
                    {UZUNLUK_LABEL[s.uzunluk]}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border bg-primary-container/15 border-primary-container/40 text-primary-container">
                    {MOD_LABEL[s.mod]}
                  </span>
                  <span className="font-mono text-label-sm text-on-surface-variant/50">
                    · {formatRelative(s.createdAt)}
                  </span>
                </div>
              </div>
            </div>

            {isConfirming ? (
              <div className="mt-3 pt-3 border-t border-surface-variant flex items-center justify-between gap-2">
                <p className="font-mono text-label-sm text-error">
                  Bu anlatımı silmek istiyor musun?
                </p>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => onConfirmDelete(null)}
                    className="font-mono text-label-sm text-on-surface-variant hover:text-on-surface px-3 py-1.5 rounded transition-colors"
                  >
                    Vazgeç
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(s.id)}
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
                    onClick={() => onConfirmDelete(s.id)}
                    aria-label="Bu anlatımı sil"
                    className="font-mono text-label-sm text-on-surface-variant/70 hover:text-error flex items-center gap-1 transition-colors"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      delete
                    </span>
                    Sil
                  </button>
                  <button
                    type="button"
                    onClick={(e) => onOpenExportMenu(s.id, e)}
                    aria-label="Bu anlatımı indir"
                    aria-expanded={exportMenuId === s.id}
                    className="font-mono text-label-sm text-on-surface-variant/70 hover:text-primary-container flex items-center gap-1 transition-colors"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      download
                    </span>
                    İndir
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                      expand_more
                    </span>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onResume(s)}
                  className="bg-primary-container/15 hover:bg-primary-container/25 text-primary-container border border-primary-container/40 font-mono text-label-sm px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors font-bold"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                    visibility
                  </span>
                  Aç
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── Makale Görünümü ──────────────────────────────────────────────────

interface ArticleViewProps {
  anlatim: string;
  saved: SavedAnlatim;
  onNew: () => void;
  onExport: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function ArticleView({ anlatim, saved, onNew, onExport }: ArticleViewProps) {
  return (
    <div className="min-h-[calc(100vh-65px)] bg-surface">
      <div className="max-w-4xl mx-auto px-margin-mobile md:px-margin-desktop py-lg">
        <article>
          {/* Üst meta + aksiyonlar */}
          <div className="flex items-center justify-between gap-3 mb-md pb-md border-b border-outline-variant/30 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className="material-symbols-outlined text-primary-container flex-shrink-0"
                style={{ fontSize: 18 }}
              >
                description
              </span>
              <span className="font-mono text-label-sm text-on-surface-variant truncate" title={saved.pdfName}>
                {saved.pdfName}
              </span>
              <span className="font-mono text-label-sm text-on-surface-variant/40 flex-shrink-0">·</span>
              <span
                className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border flex-shrink-0 ${UZUNLUK_CHIP[saved.uzunluk]}`}
              >
                {UZUNLUK_LABEL[saved.uzunluk]}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border bg-primary-container/15 border-primary-container/40 text-primary-container flex-shrink-0">
                {MOD_LABEL[saved.mod]}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={onExport}
                className="font-mono text-label-sm text-on-surface-variant hover:text-primary-container transition-colors flex items-center gap-1 px-3 py-1.5 border border-surface-variant rounded hover:border-primary-container"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
                İndir
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>expand_more</span>
              </button>
              <button
                type="button"
                onClick={onNew}
                className="font-mono text-label-sm text-on-surface-variant hover:text-primary-container transition-colors flex items-center gap-1 px-3 py-1.5 border border-surface-variant rounded hover:border-primary-container"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
                <span className="hidden sm:inline">Yeni Anlatım</span>
              </button>
            </div>
          </div>

          {saved.konuBasligi && saved.konuBasligi !== DEFAULT_KONU_BASLIGI && (
            <div className="mb-md bg-gradient-to-r from-primary-container/10 via-primary-container/5 to-transparent border border-primary-container/30 rounded-xl p-4 flex items-center gap-3">
              <span className="material-symbols-outlined text-primary-container flex-shrink-0 animate-pulse" style={{ fontSize: 24 }}>
                auto_awesome
              </span>
              <div className="min-w-0">
                <p className="font-mono text-[10px] text-primary-container uppercase tracking-widest font-semibold">Odaklanılan Özel Konu Anlatımı</p>
                <h2 className="font-headline text-lg font-bold text-on-surface truncate mt-0.5">{saved.konuBasligi}</h2>
              </div>
            </div>
          )}

          {/* Markdown içeriği */}
          <div className="bg-surface-container-low border border-surface-variant rounded-xl p-md md:p-lg">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={articleMarkdownComponents}
            >
              {typeof anlatim === "string"
                ? anlatim
                : typeof anlatim === "object" && anlatim !== null
                ? (anlatim as any).anlatim || (anlatim as any).cevap || JSON.stringify(anlatim, null, 2)
                : String(anlatim ?? "")}
            </ReactMarkdown>
          </div>
        </article>
      </div>
    </div>
  );
}

// ─── Export Menu Item ─────────────────────────────────────────────────

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
      <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 16 }}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

// ─── Markdown component map (makale stili) ────────────────────────────

const articleMarkdownComponents = {
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-6 overflow-x-auto rounded-xl border border-surface-variant bg-surface-container-lowest">
      <table className="w-full border-collapse text-left text-sm text-on-surface">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-surface-container-high font-mono text-[11px] uppercase tracking-wider text-primary-container border-b border-surface-variant">
      {children}
    </thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <tbody className="divide-y divide-surface-variant/40">
      {children}
    </tbody>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="hover:bg-surface-container-high/40 transition-colors">
      {children}
    </tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-4 py-3 font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-4 py-3 font-body text-body-md text-on-surface-variant leading-relaxed">
      {children}
    </td>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="font-display text-3xl md:text-4xl font-extrabold text-on-surface mt-lg mb-sm first:mt-0 tracking-tight leading-tight">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="font-headline text-2xl font-bold text-on-surface mt-lg mb-sm first:mt-0 pb-2 border-b border-surface-variant">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="font-headline text-xl font-semibold text-on-surface mt-md mb-2 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="font-headline text-base font-semibold text-on-surface mt-md mb-2 first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="font-body text-body-lg text-on-surface leading-relaxed mb-4 last:mb-0 [overflow-wrap:anywhere]">
      {children}
    </p>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-primary-container">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic text-on-surface-variant">{children}</em>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-outside pl-6 space-y-2 mb-4 marker:text-primary-container">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-outside pl-6 space-y-2 mb-4 marker:text-primary-container">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="font-body text-body-md text-on-surface leading-relaxed pl-1">
      {children}
    </li>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="font-mono text-sm bg-surface-container-high text-primary-container px-1.5 py-0.5 rounded">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => {
    const mermaidCode = extractCodeByLanguage(children, "mermaid");
    if (mermaidCode) {
      return <MermaidBlock code={mermaidCode} />;
    }
    const svgCode = extractCodeByLanguage(children, "svg");
    if (svgCode) {
      return <SvgBlock code={svgCode} />;
    }
    return (
      <pre className="font-mono text-sm bg-surface-container-lowest border border-surface-variant rounded-lg p-4 my-4 overflow-x-auto text-on-surface">
        {children}
      </pre>
    );
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-4 border-primary-container/60 pl-4 my-4 text-on-surface-variant italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-surface-variant my-6" />,
  a: ({
    children,
    href,
  }: {
    children?: React.ReactNode;
    href?: string;
  }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-container underline hover:text-primary transition-colors"
    >
      {children}
    </a>
  ),
  // eslint-disable-next-line @next/next/no-img-element
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <figure className="my-6 bg-surface-container-lowest border border-surface-variant rounded-lg overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        className="block w-full max-h-[500px] object-contain bg-white/95 p-2"
      />
      {alt && (
        <figcaption className="px-md py-2 text-center font-mono text-label-sm text-on-surface-variant border-t border-surface-variant">
          {alt}
        </figcaption>
      )}
    </figure>
  ),
};
