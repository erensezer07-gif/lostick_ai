"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/apiKey";
import {
  cancelTranslation,
  downloadTranslation,
  getTranslationStatus,
  startTranslation,
  type CeviriDurum,
} from "@/lib/ceviri";

type Step = "idle" | "translating" | "done" | "error";

const ACTIVE_JOB_KEY = "lostick.activeCeviriJob";
const OPEN_EVENT = "lostick:open-ceviri";
const MAX_MB = 30; // backend _CEVIRI_MAX_MB ile uyumlu

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

const GLOSSARY_PRESETS: Record<string, string> = {
  tip: "adverse effect -> yan etki\nhypercalcemia -> hiperkalsemi\nmyocardial infarction -> miyokard enfarktüsü\nrenal failure -> böbrek yetmezliği\nbenign -> iyi huylu\nmalignant -> kötü huylu\npathology -> patoloji\nsymptom -> semptom / belirti",
  hukuk: "jurisdiction -> yetki / yargı alanı\nliability -> hukuki sorumluluk\ndue diligence -> durum tespiti / özen borcu\nplaintiff -> davacı\ndefendant -> davalı\ncontractual obligation -> sözleşmesel yükümlülük\nforce majeure -> mücbir sebep\nindemnity -> tazminat",
  muhendislik: "transformer -> model yapısı / dönüştürücü\nneural network -> yapay sinir ağı\nbackpropagation -> geriye yayılım\nloss function -> kayıp fonksiyonu\noverfitting -> aşırı öğrenme / aşırı uyum\nunderfitting -> yetersiz öğrenme\nmachine learning -> makine öğrenmesi\nfeature extraction -> öznitelik çıkarımı",
};

const LANGUAGES = [
  { code: "tr", name: "Türkçe", flag: "🇹🇷" },
  { code: "en", name: "İngilizce", flag: "🇺🇸" },
  { code: "de", name: "Almanca", flag: "🇩🇪" },
  { code: "fr", name: "Fransızca", flag: "🇫🇷" },
  { code: "es", name: "İspanyolca", flag: "🇪🇸" },
  { code: "ru", name: "Rusça", flag: "🇷🇺" },
];

/**
 * Global Çeviri Merkezi — kök layout'a mount edilir, sayfa değişse de UNMOUNT OLMAZ.
 * Böylece çeviri arka planda devam ederken kullanıcı sitede gezinebilir; ilerleme ve
 * "hazır" bildirimi her sayfada yüzen bir kartta görünür. Karttan `lostick:open-ceviri`
 * event'i ile modal açılır.
 */
export default function TranslationCenter() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  const [step, setStep] = useState<Step>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [durum, setDurum] = useState<CeviriDurum | null>(null);
  const [resultName, setResultName] = useState<string>("ceviri-TR.pdf");
  const [uyari, setUyari] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false); // yüzen bildirim kapatıldı mı

  const [targetLang, setTargetLang] = useState<string>("tr");
  const [showGlossary, setShowGlossary] = useState<boolean>(false);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [customGlossary, setCustomGlossary] = useState<string>("");
  
  // Parallel reader states
  const [readerOpen, setReaderOpen] = useState<boolean>(false);
  const [originalUrl, setOriginalUrl] = useState<string>("");
  const [translatedUrl, setTranslatedUrl] = useState<string>("");
  const [originalType, setOriginalType] = useState<"pdf" | "image" | "text" | "other">("pdf");
  const [originalText, setOriginalText] = useState<string>("");
  const [loadingReader, setLoadingReader] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Object URL cleanup to prevent memory leaks
  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    };
  }, [originalUrl, translatedUrl]);

  useEffect(() => setMounted(true), []);

  // F5/yeni sayfa: devam eden bir çeviri varsa polling'e geri bağlan (modal AÇMADAN, arka planda)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const meta = JSON.parse(raw);
        if (meta?.jobId) {
          setJobId(meta.jobId);
          setStep("translating");
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Karttan gelen "aç" event'i — modalı aç (çeviri sürüyorsa ilerlemeyi, değilse temiz formu göster)
  useEffect(() => {
    function onOpen() {
      setDismissed(false);
      setStep((s) => {
        if (s === "translating") return s; // sürüyorsa ilerlemeyi koru
        // değilse temiz başla
        setFile(null);
        setDurum(null);
        setErrorMsg(null);
        setUyari(null);
        setDragOver(false);
        return "idle";
      });
      setOpen(true);
    }
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  function clearActiveMarker() {
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_JOB_KEY);
  }

  function resetForm() {
    setStep("idle");
    setFile(null);
    setDurum(null);
    setErrorMsg(null);
    setUyari(null);
    setDragOver(false);
  }

  // ─── Polling — jobId varken ve "translating" iken; sayfa değişse de sürer (layout'ta) ───
  useEffect(() => {
    if (!jobId || step !== "translating") return;

    async function poll() {
      try {
        const d = await getTranslationStatus(jobId!);
        setDurum(d);
        if (d.status === "done") {
          clearActiveMarker();
          setResultName(d.filename || "ceviri-TR.pdf");
          setUyari(d.uyari ?? null);
          setStep("done"); // jobId KORUNUR (indirme için)
        } else if (d.status === "error") {
          clearActiveMarker();
          setErrorMsg(d.error || "Çeviri sırasında bir hata oluştu.");
          setStep("error");
        } else if (d.status === "cancelled") {
          clearActiveMarker();
          setJobId(null);
          resetForm();
        }
      } catch (e) {
        if (e instanceof Error && e.message === "404") {
          clearActiveMarker();
          setErrorMsg("Çeviri bulunamadı (sunucu yeniden başlamış olabilir). Tekrar dene.");
          setStep("error");
        }
        /* geçici ağ hatası → sonraki tick */
      }
    }

    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, step]);

  function pickFile(f: File | null) {
    if (!f) return;
    const lower = f.name.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      if (lower.endsWith(".doc") || lower.endsWith(".ppt")) {
        setErrorMsg("Eski .doc/.ppt desteklenmiyor — .docx/.pptx olarak kaydedip yükle.");
      } else {
        setErrorMsg("Desteklenmeyen dosya tipi. PDF, Word, PowerPoint, görsel, kod veya metin yükle.");
      }
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setErrorMsg(`Dosya çok büyük (maks. ${MAX_MB} MB). Lütfen daha küçük bir dosya seç veya belgeyi böl.`);
      return;
    }
    setErrorMsg(null);
    setFile(f);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    pickFile(e.target.files?.[0] ?? null);
    e.target.value = "";
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    pickFile(e.dataTransfer.files?.[0] ?? null);
  }

  async function handleStart() {
    if (!file || step === "translating") return;
    setStep("translating");
    setErrorMsg(null);
    setDurum(null);
    setDismissed(false);
    try {
      const id = await startTranslation(file, targetLang, customGlossary);
      localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify({ jobId: id, name: file.name }));
      setJobId(id);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Çeviri başlatılamadı.");
      setStep("error");
    }
  }

  async function handleCancel() {
    const id = jobId;
    clearActiveMarker();
    setJobId(null);
    resetForm();
    if (id) await cancelTranslation(id);
  }

  async function handleDownload() {
    if (!jobId) return;
    try {
      await downloadTranslation(jobId, resultName);
    } catch (e) {
      alert(e instanceof Error ? e.message : "İndirme başarısız oldu.");
    }
  }

  function handleAnalyze() {
    setOpen(false);
    setDismissed(true);
    router.push("/anlatim");
  }

  async function openParallelReader() {
    if (!jobId) return;
    setLoadingReader(true);
    setErrorMsg(null);
    
    try {
      // 1) Get translated PDF
      const res = await apiFetch(`/api/v1/ceviri-indir/${jobId}`);
      if (!res.ok) throw new Error("Çevrilmiş döküman indirilemedi.");
      const transBlob = await res.blob();
      const transUrl = URL.createObjectURL(transBlob);
      setTranslatedUrl(transUrl);

      // 2) Prepare original file
      if (file) {
        const origUrl = URL.createObjectURL(file);
        setOriginalUrl(origUrl);

        const nameLower = file.name.toLowerCase();
        if (nameLower.endsWith(".pdf")) {
          setOriginalType("pdf");
        } else if (
          nameLower.endsWith(".png") ||
          nameLower.endsWith(".jpg") ||
          nameLower.endsWith(".jpeg") ||
          nameLower.endsWith(".webp") ||
          nameLower.endsWith(".gif") ||
          nameLower.endsWith(".bmp")
        ) {
          setOriginalType("image");
        } else if (
          nameLower.endsWith(".txt") ||
          nameLower.endsWith(".py") ||
          nameLower.endsWith(".js") ||
          nameLower.endsWith(".ts") ||
          nameLower.endsWith(".tsx") ||
          nameLower.endsWith(".jsx") ||
          nameLower.endsWith(".json") ||
          nameLower.endsWith(".md") ||
          nameLower.endsWith(".yaml") ||
          nameLower.endsWith(".yml") ||
          nameLower.endsWith(".xml") ||
          nameLower.endsWith(".sh") ||
          nameLower.endsWith(".html") ||
          nameLower.endsWith(".css")
        ) {
          setOriginalType("text");
          // Read text content
          const reader = new FileReader();
          reader.onload = (e) => {
            setOriginalText(e.target?.result as string || "");
          };
          reader.readAsText(file);
        } else {
          setOriginalType("other");
        }
      } else {
        setOriginalType("other");
      }

      setReaderOpen(true);
      setOpen(false); // Close modal
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Çift panelli okuyucu yüklenemedi.");
    } finally {
      setLoadingReader(false);
    }
  }

  function closeParallelReader() {
    setReaderOpen(false);
    if (originalUrl) {
      URL.revokeObjectURL(originalUrl);
      setOriginalUrl("");
    }
    if (translatedUrl) {
      URL.revokeObjectURL(translatedUrl);
      setTranslatedUrl("");
    }
    setOriginalText("");
    setOpen(true); // Re-open modal
  }

  const pct = durum && durum.total > 0 ? Math.round((durum.progress / durum.total) * 100) : 0;

  if (!mounted) return null;

  return (
    <>
      {/* ─── MODAL ─── */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-md flex items-center justify-center p-margin-mobile"
            style={{ zIndex: 9998 }}
            onClick={() => step !== "translating" && setOpen(false)}
          >
            <div
              className="w-full max-w-lg bg-surface-container-low border border-surface-variant rounded-xl overflow-hidden flex flex-col"
              style={{ maxHeight: "calc(100vh - 2rem)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 px-md pt-md pb-3 border-b border-surface-variant">
                <div className="min-w-0">
                  <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest mb-1">
                    Yapay Zeka Çeviri Merkezi
                  </p>
                  <h2 className="font-headline text-headline-md text-on-surface">Akıllı Doküman Çevirisi</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Kapat"
                  className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>

              <div className="p-md overflow-y-auto">
                {step === "idle" && (
                  <>
                    <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleFileChange} className="hidden" />
                    
                    {/* Hedef Dil Seçimi */}
                    <div className="mb-4">
                      <label className="block font-mono text-[11px] text-primary-container uppercase tracking-wider mb-2">
                        Hedef Dil Seçimi
                      </label>
                      <div className="relative">
                        <select
                          value={targetLang}
                          onChange={(e) => setTargetLang(e.target.value)}
                          className="w-full bg-surface-container-lowest border border-outline-variant hover:border-primary-container focus:border-primary-container text-on-surface font-mono text-body-md py-3 px-4 rounded-xl outline-none appearance-none cursor-pointer transition-all duration-200"
                        >
                          {LANGUAGES.map((lang) => (
                            <option key={lang.code} value={lang.code} className="bg-surface-container-low text-on-surface">
                              {lang.flag} {lang.name}
                            </option>
                          ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-on-surface-variant">
                          <span className="material-symbols-outlined">expand_more</span>
                        </div>
                      </div>
                    </div>

                    {/* Terim & Sözlük Entegrasyonu */}
                    <div className="mb-4 border border-outline-variant/60 rounded-xl bg-surface-container-lowest overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setShowGlossary(!showGlossary)}
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-container-low transition-colors"
                      >
                        <div className="flex items-center gap-2 text-on-surface">
                          <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 18 }}>book</span>
                          <span className="font-mono text-label-md uppercase tracking-wider">Akademik Sözlük & Terim Kontrolü</span>
                        </div>
                        <span className="material-symbols-outlined text-on-surface-variant transition-transform duration-200" style={{ transform: showGlossary ? 'rotate(180deg)' : 'rotate(0deg)', fontSize: 20 }}>
                          expand_more
                        </span>
                      </button>
                      {showGlossary && (
                        <div className="p-4 border-t border-outline-variant/40 flex flex-col gap-4">
                          {/* Açıklama Kutusu */}
                          <div className="bg-surface-container-low border border-outline-variant/40 p-3 rounded-lg flex gap-2">
                            <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 16 }}>info</span>
                            <p className="font-mono text-[11px] text-on-surface-variant leading-relaxed">
                              Bu özellik, belgenizdeki teknik terimlerin yapay zeka tarafından yanlış (örneğin "transformer" kelimesinin "trafo" olarak) çevrilmesini önler ve alana özel %100 doğru kelimelerin kullanılmasını sağlar.
                            </p>
                          </div>

                          <div>
                            <p className="font-mono text-[10px] text-on-surface-variant/70 mb-2.5 uppercase tracking-wider">LÜTFEN DÖKÜMAN ALANINIZI SEÇİN</p>
                            <div className="flex gap-2">
                              {["tip", "hukuk", "muhendislik"].map((preset) => (
                                <button
                                  key={preset}
                                  type="button"
                                  onClick={() => {
                                    if (selectedPreset === preset) {
                                      setSelectedPreset("");
                                      setCustomGlossary("");
                                    } else {
                                      setSelectedPreset(preset);
                                      setCustomGlossary(GLOSSARY_PRESETS[preset]);
                                    }
                                  }}
                                  className={`flex-1 py-2 px-3 rounded-lg font-mono text-[11px] border transition-all duration-200 text-center ${
                                    selectedPreset === preset
                                      ? "bg-primary-container/20 border-primary-container text-primary-container font-bold"
                                      : "bg-surface-container-lowest border-outline-variant text-on-surface hover:border-primary-container hover:bg-surface-container-low"
                                  }`}
                                >
                                  {preset === "tip" ? "Tıp" : preset === "hukuk" ? "Hukuk" : "Mühendislik / AI"}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      className={`cursor-pointer border-2 border-dashed rounded-xl p-lg flex flex-col items-center justify-center gap-3 text-center transition-colors ${
                        dragOver ? "border-primary-container bg-primary-container/10" : "border-outline-variant hover:border-primary-container bg-surface-container-lowest hover:bg-surface-container-low"
                      }`}
                    >
                      <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 36 }}>
                        {file ? "description" : "cloud_upload"}
                      </span>
                      {file ? (
                        <>
                          <p className="font-body text-body-md text-on-surface [overflow-wrap:anywhere]">{file.name}</p>
                          <p className="font-mono text-label-sm text-on-surface-variant/60">Farklı bir dosya için tıkla veya sürükle</p>
                        </>
                      ) : (
                        <>
                          <p className="font-body text-body-md text-on-surface">Dosya Seç</p>
                          <p className="font-mono text-[10px] text-on-surface-variant/50">Maks. {MAX_MB} MB</p>
                        </>
                      )}
                    </div>
                    {errorMsg && (
                      <div className="mt-3 flex items-start gap-2 bg-error-container/20 border border-error/40 rounded-lg p-3">
                        <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 18 }}>error</span>
                        <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere]">{errorMsg}</p>
                      </div>
                    )}
                  </>
                )}

                {step === "translating" && (
                  <div className="flex flex-col items-center text-center gap-4 py-md">
                    <div className="relative w-14 h-14">
                      <div className="absolute inset-0 rounded-full border-4 border-surface-variant" />
                      <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-primary-container animate-spin" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 22 }}>translate</span>
                      </div>
                    </div>
                    <div>
                      <p className="font-headline text-on-surface font-semibold mb-1">
                        {durum && durum.total > 0 ? `Çevriliyor · ${durum.progress}/${durum.total} bölüm` : "Döküman hazırlanıyor..."}
                      </p>
                      <p className="font-body text-body-md text-on-surface-variant max-w-sm">
                        Çeviri arka planda yapılıyor — bu pencereyi kapatıp sitede gezinebilirsin,
                        işlem devam eder. Ücretsiz mod: sayfalar istek sınırına takılmamak için zamana yayılır.
                      </p>
                    </div>
                    <div className="w-full max-w-sm">
                      <div className="h-2 bg-surface-variant rounded-full overflow-hidden">
                        <div className="h-full bg-primary-container transition-all duration-500" style={{ width: `${durum && durum.total > 0 ? pct : 8}%` }} />
                      </div>
                      {durum && durum.total > 0 && <p className="font-mono text-label-sm text-on-surface-variant/60 mt-1.5">%{pct}</p>}
                    </div>
                  </div>
                )}

                {step === "done" && (
                  <div className="flex flex-col items-center text-center gap-3 py-md">
                    <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
                      <span className="material-symbols-outlined text-emerald-400" style={{ fontSize: 28 }}>check_circle</span>
                    </div>
                    <p className="font-headline text-on-surface font-semibold">Çeviri tamamlandı!</p>
                    <p className="font-body text-body-md text-on-surface-variant max-w-sm">
                      Çevrilmiş dökümanın hazır. İndirebilir ya da doğrudan Lostick AI ile analiz etmeye başlayabilirsin.
                    </p>
                    <p className="font-mono text-label-sm text-on-surface-variant/60 [overflow-wrap:anywhere]">{resultName}</p>
                    {uyari && (
                      <div className="mt-1 flex items-start gap-2 bg-primary-container/10 border border-primary-container/30 rounded-lg p-2.5 text-left">
                        <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 16 }}>info</span>
                        <p className="font-mono text-[11px] text-on-surface-variant leading-relaxed">{uyari}</p>
                      </div>
                    )}
                  </div>
                )}

                {step === "error" && (
                  <div className="flex flex-col items-center text-center gap-3 py-md">
                    <div className="w-14 h-14 rounded-full bg-error/15 border border-error/40 flex items-center justify-center">
                      <span className="material-symbols-outlined text-error" style={{ fontSize: 28 }}>error</span>
                    </div>
                    <p className="font-headline text-on-surface font-semibold">Bir sorun çıktı</p>
                    <p className="font-mono text-label-sm text-error [overflow-wrap:anywhere] max-w-sm">{errorMsg ?? "Bilinmeyen hata."}</p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 p-md border-t border-surface-variant bg-surface-container-lowest">
                {step === "idle" && (
                  <>
                    <button type="button" onClick={() => setOpen(false)} className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all">
                      Vazgeç
                    </button>
                    <button type="button" onClick={handleStart} disabled={!file} className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary disabled:bg-surface-container-high disabled:text-on-surface-variant/40 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>translate</span>
                      Çeviriyi Başlat
                    </button>
                  </>
                )}
                {step === "translating" && (
                  <>
                    <button type="button" onClick={() => setOpen(false)} className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all">
                      Arka Planda Çalışsın
                    </button>
                    <button type="button" onClick={handleCancel} className="border border-error/50 text-error hover:bg-error/15 font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all">
                      İptal Et
                    </button>
                  </>
                )}
                {step === "done" && (
                  <>
                    <button
                      type="button"
                      onClick={openParallelReader}
                      disabled={loadingReader}
                      className="border border-primary-container/50 text-primary-container hover:bg-primary-container/15 font-mono text-label-sm px-4 py-2.5 rounded-lg transition-all font-bold flex items-center gap-2"
                    >
                      {loadingReader ? (
                        <>
                          <span className="w-4 h-4 border-2 border-primary-container/30 border-t-primary-container rounded-full animate-spin" />
                          Hazırlanıyor...
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>vertical_split</span>
                          Yan Yana Oku
                        </>
                      )}
                    </button>
                    <button type="button" onClick={handleDownload} className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-4 py-2.5 rounded-lg transition-all font-bold flex items-center gap-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
                      Dökümanı İndir
                    </button>
                    <button type="button" onClick={handleAnalyze} className="bg-primary-container text-on-primary-container font-mono text-label-sm px-4 py-2.5 rounded-lg hover:bg-primary transition-all font-bold flex items-center gap-2">
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>auto_awesome</span>
                      Lostick AI ile Analiz Et
                    </button>
                  </>
                )}
                {step === "error" && (
                  <button type="button" onClick={resetForm} className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary transition-all font-bold flex items-center gap-2">
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>restart_alt</span>
                    Tekrar Dene
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ─── YÜZEN BİLDİRİM (modal kapalıyken her sayfada) ─── */}
      {!open && step === "translating" &&
        createPortal(
          <div className="fixed bottom-4 right-4 max-w-xs bg-surface-container-high border border-primary-container/40 rounded-xl shadow-2xl p-3 flex items-center gap-3" style={{ zIndex: 10001 }}>
            <span className="w-5 h-5 border-2 border-on-surface-variant/30 border-t-primary-container rounded-full animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-label-sm text-on-surface">
                {durum && durum.total > 0 ? `Çevriliyor ${durum.progress}/${durum.total}` : "Çeviri hazırlanıyor"}
              </p>
              <p className="font-mono text-[10px] text-on-surface-variant/70">Arka planda — gezinebilirsin</p>
            </div>
            <button type="button" onClick={() => setOpen(true)} className="font-mono text-label-sm text-primary-container border border-primary-container/50 hover:bg-primary-container/15 px-2.5 py-1 rounded transition-colors flex-shrink-0">
              Aç
            </button>
          </div>,
          document.body,
        )}

      {!open && step === "done" && !dismissed &&
        createPortal(
          <div className="fixed bottom-4 right-4 max-w-sm bg-surface-container-high border border-emerald-500/40 rounded-xl shadow-2xl p-3" style={{ zIndex: 10001 }}>
            <div className="flex items-start gap-2.5">
              <span className="material-symbols-outlined text-emerald-400 flex-shrink-0" style={{ fontSize: 20 }}>check_circle</span>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-label-sm text-on-surface">Çeviri hazır!</p>
                <p className="font-mono text-[10px] text-on-surface-variant/70 truncate">{resultName}</p>
              </div>
              <button type="button" onClick={() => setDismissed(true)} aria-label="Kapat" className="text-on-surface-variant hover:text-on-surface flex-shrink-0">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
              </button>
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                type="button"
                onClick={openParallelReader}
                disabled={loadingReader}
                className="flex-1 border border-primary-container/50 text-primary-container hover:bg-primary-container/15 font-mono text-[11px] py-1.5 rounded-lg transition-all font-bold flex items-center justify-center gap-1"
              >
                {loadingReader ? "..." : (
                  <>
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>vertical_split</span>
                    Yan Yana
                  </>
                )}
              </button>
              <button type="button" onClick={handleDownload} className="flex-1 border border-outline-variant text-on-surface hover:text-primary-container font-mono text-[11px] py-1.5 rounded-lg transition-all font-bold flex items-center justify-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
                İndir
              </button>
              <button type="button" onClick={handleAnalyze} className="flex-1 bg-primary-container text-on-primary-container font-mono text-[11px] py-1.5 rounded-lg hover:bg-primary transition-all font-bold flex items-center justify-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_awesome</span>
                Analiz
              </button>
            </div>
          </div>,
          document.body,
        )}

      {!open && step === "error" && !dismissed &&
        createPortal(
          <div className="fixed bottom-4 right-4 max-w-sm bg-surface-container-high border border-error/50 rounded-xl shadow-2xl p-3 flex items-start gap-2.5" style={{ zIndex: 10001 }}>
            <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: 20 }}>error</span>
            <p className="font-mono text-label-sm text-on-surface flex-1 leading-relaxed">{errorMsg ?? "Çeviri başarısız."}</p>
            <button type="button" onClick={() => setDismissed(true)} aria-label="Kapat" className="text-on-surface-variant hover:text-on-surface flex-shrink-0">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>,
          document.body,
        )}
      {/* ─── ÇİFT PANELLİ KARŞILAŞTIRMALI OKUYUCU OVERLAY ─── */}
      {readerOpen &&
        createPortal(
          <div className="fixed inset-0 bg-[#0d0d0d] flex flex-col" style={{ zIndex: 9999 }}>
            {/* Reader Header */}
            <div className="h-16 border-b border-surface-variant bg-[#131313] px-md flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-primary-container/10 border border-primary-container/30 flex items-center justify-center">
                  <span className="material-symbols-outlined text-primary-container">chrome_reader_mode</span>
                </div>
                <div className="min-w-0">
                  <h3 className="font-headline text-body-lg text-on-surface font-semibold truncate">
                    {file?.name || "Döküman Karşılaştırmalı Okuyucu"}
                  </h3>
                  <p className="font-mono text-[10px] text-primary-container tracking-wider uppercase">
                    Lostick AI Çift Panelli Karşılaştırma
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="bg-primary-container text-on-primary-container font-mono text-label-sm px-4 py-2 rounded-lg hover:bg-primary transition-all font-bold flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>download</span>
                  Çeviriyi İndir
                </button>
                <button
                  type="button"
                  onClick={closeParallelReader}
                  className="w-10 h-10 flex items-center justify-center rounded-lg border border-outline-variant text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
                </button>
              </div>
            </div>

            {/* Reader Viewport */}
            <div className="flex-1 flex min-h-0 bg-[#131313]">
              {/* Left Pane: Original */}
              <div className="flex-1 flex flex-col min-w-0 border-r border-surface-variant relative">
                <div className="h-9 bg-[#1a1a1a] border-b border-surface-variant px-4 flex items-center justify-between text-on-surface-variant">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant/70">
                    Orijinal Döküman
                  </span>
                  <span className="font-mono text-[10px] bg-surface-container-high px-2 py-0.5 rounded text-on-surface-variant/60">
                    {originalType === "pdf" ? "PDF" : originalType === "image" ? "Görsel" : originalType === "text" ? "Metin" : "Desteklenmeyen"}
                  </span>
                </div>
                <div className="flex-1 min-h-0 relative bg-[#1c1c1c]">
                  {originalType === "pdf" && originalUrl && (
                    <iframe src={originalUrl} className="w-full h-full border-none bg-[#1c1c1c]" />
                  )}
                  {originalType === "image" && originalUrl && (
                    <div className="w-full h-full flex items-center justify-center p-6 overflow-auto">
                      <img src={originalUrl} alt="Orijinal" className="max-w-full max-h-full object-contain rounded shadow-2xl" />
                    </div>
                  )}
                  {originalType === "text" && originalText && (
                    <div className="w-full h-full p-6 overflow-auto font-mono text-body-sm text-on-surface bg-[#1c1c1c] whitespace-pre-wrap selection:bg-primary-container/30">
                      {originalText}
                    </div>
                  )}
                  {originalType === "other" && (
                    <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center gap-4">
                      <span className="material-symbols-outlined text-on-surface-variant" style={{ fontSize: 48 }}>draft</span>
                      <div className="max-w-sm">
                        <p className="font-headline text-body-lg text-on-surface font-semibold mb-1">
                          Önizleme Desteklenmiyor
                        </p>
                        <p className="font-body text-body-sm text-on-surface-variant mb-4">
                          Bu dosya formatı tarayıcıda doğrudan önizlenemiyor ya da sayfa yenilendiği için orijinal dosyaya erişilemiyor. Çevrilmiş PDF çıktısını sağ panelde görebilirsiniz.
                        </p>
                        {originalUrl && (
                          <a
                            href={originalUrl}
                            download={file?.name || "orijinal"}
                            className="inline-flex items-center gap-1.5 font-mono text-label-sm text-primary-container hover:underline"
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                            Orijinali İndir
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Pane: Translated */}
              <div className="flex-1 flex flex-col min-w-0 relative">
                <div className="h-9 bg-[#1a1a1a] border-b border-surface-variant px-4 flex items-center justify-between text-on-surface-variant">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-primary-container font-semibold">
                    Lostick AI Çevirisi
                  </span>
                  <span className="font-mono text-[10px] bg-primary-container/10 border border-primary-container/30 px-2 py-0.5 rounded text-primary-container">
                    PDF
                  </span>
                </div>
                <div className="flex-1 min-h-0 relative bg-[#1c1c1c]">
                  {translatedUrl && (
                    <iframe src={translatedUrl} className="w-full h-full border-none bg-[#1c1c1c]" />
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
