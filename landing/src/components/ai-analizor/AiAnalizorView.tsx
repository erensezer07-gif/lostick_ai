"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiKey";

interface SentenceAnalysis {
  metin: string;
  yapay_zeka_orani: number;
}

interface ParagraphAnalysis {
  metin: string;
  yapay_zeka_orani: number;
  insan_orani: number;
  cumleler: SentenceAnalysis[];
}

interface PlagiarismSource {
  kaynak: string;
  url: string;
  benzerlik: number;
}

interface TextMetrics {
  perplexity: string;
  perplexity_aciklama: string;
  burstiness: string;
  burstiness_aciklama: string;
  okunabilirlik_skor: number;
  okunabilirlik_etiket: string;
}

interface AnalysisResponse {
  genel_yapay_zeka_orani: number;
  intihal_orani: number;
  intihal_kaynaklari: PlagiarismSource[];
  metrikler: TextMetrics;
  paragraflar: ParagraphAnalysis[];
}

export default function AiAnalizorView() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [activeTab, setActiveTab] = useState<"ozgunluk" | "intihal">("ozgunluk");
  
  // Loading metni rotasyonu için stateler
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);
  const loadingTexts = [
    "Metin derinlemesine taranıyor...",
    "Hugging Face RoBERTa-Base NLP modeli yükleniyor...",
    "Akademik veri tabanlarında semantik intihal kontrolü yapılıyor...",
    "Paragraflar ve cümleler yapay zeka tespiti için işleniyor...",
    "Ateşman Türkçe okunabilirlik indeksi hesaplanıyor...",
    "Özgünlük, intihal ve yazım metrikleri raporu oluşturuluyor..."
  ];

  // Yükleme durumu dönerken metinleri döndür
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isAnalyzing) {
      timer = setInterval(() => {
        setLoadingTextIndex((prev) => (prev + 1) % loadingTexts.length);
      }, 3000);
    } else {
      setLoadingTextIndex(0);
    }
    return () => clearInterval(timer);
  }, [isAnalyzing]);

  // Yapay Zeka Analizini Başlat
  async function handleAnalyze() {
    if (!rawText.trim() || rawText.trim().length < 10) {
      setError("Lütfen analiz için en az 10 karakter içeren bir metin girin.");
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setAnalysisResult(null);

    try {
      const res = await apiFetch("/api/v1/yapay-zeka-analiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metin: rawText }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Analiz sırasında hata oluştu.");
      }

      const data: AnalysisResponse = await res.json();
      setAnalysisResult(data);
    } catch (err: any) {
      setError(err.message || "Bir hata oluştu.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  // Dairesel Progress Bar Hesaplamaları
  const radius = 80;
  const strokeWidth = 14;
  const circumference = 2 * Math.PI * radius;
  const overallPercentage = analysisResult ? analysisResult.genel_yapay_zeka_orani : 0;
  const strokeDashoffset = circumference - (overallPercentage / 100) * circumference;

  const intihalPercentage = analysisResult ? analysisResult.intihal_orani : 0;
  const intihalDashoffset = circumference - (intihalPercentage / 100) * circumference;

  // İstatistikleri hesapla
  const totalCharacters = analysisResult 
    ? analysisResult.paragraflar.reduce((acc, p) => acc + p.metin.length, 0)
    : 0;
  const totalParagraphs = analysisResult ? analysisResult.paragraflar.length : 0;
  
  const totalSentences = analysisResult 
    ? analysisResult.paragraflar.reduce((acc, p) => acc + p.cumleler.length, 0)
    : 0;
  const aiSentences = analysisResult
    ? analysisResult.paragraflar.reduce((acc, p) => acc + p.cumleler.filter(s => s.yapay_zeka_orani > 60).length, 0)
    : 0;
  const humanSentences = totalSentences - aiSentences;

  return (
    <div className="flex-1 min-h-[calc(100vh-65px)] bg-background text-on-background flex flex-col p-4 md:p-8">
      
      {/* Üst Bilgi Barı */}
      <div className="max-w-7xl mx-auto w-full mb-6">
        <h1 className="font-headline text-headline-lg-mobile md:text-headline-lg text-on-surface flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>
            fingerprint
          </span>
          Yapay Zeka Analizörü
        </h1>
        <p className="font-body text-body-md text-on-surface-variant max-w-3xl mt-1.5">
          Ödev, tez veya makale metinlerinizi yapıştırarak yapay zeka tarafından yazılıp yazılmadığını yüzde oranıyla anında tespit edin.
        </p>
      </div>

      <div className="max-w-7xl mx-auto w-full flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        
        {/* SOL PANEL (7 Kolon): Kopyala-Yapıştır ve Metin Akışı */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          
          {/* Giriş Alanı Kartı */}
          <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-outline-variant/20 pb-3">
              <h2 className="font-body text-body-md font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-container">edit_note</span>
                Analiz Edilecek Metin
              </h2>
              {rawText.length > 0 && (
                <button
                  onClick={() => {
                    setRawText("");
                    setAnalysisResult(null);
                    setError(null);
                  }}
                  className="font-mono text-[10px] text-error hover:underline flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[12px]">clear_all</span>
                  Temizle
                </button>
              )}
            </div>

            {/* Metin Giriş Alanı */}
            <div className="flex flex-col gap-3">
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Analiz etmek istediğiniz ödev, makale veya rapor metnini buraya yapıştırın (en az 10 karakter)..."
                className="w-full h-48 p-4 rounded-xl bg-surface-container-lowest border border-outline-variant/30 text-on-surface font-body text-sm focus:outline-none focus:border-primary/50 transition-colors resize-none leading-relaxed"
                disabled={isAnalyzing}
              />
              <div className="flex justify-between items-center px-1">
                <span className="font-mono text-[10px] text-on-surface-variant/60">
                  {rawText.length.toLocaleString()} karakter girildi
                </span>
              </div>
            </div>

            {/* Hata Mesajı */}
            {error && (
              <div className="bg-error-container/10 border border-error/30 text-error text-xs rounded-lg p-3 flex items-center gap-2">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
                <span>{error}</span>
              </div>
            )}

            {/* Analiz Tetikleme Butonu */}
            <button
              onClick={handleAnalyze}
              disabled={isAnalyzing || rawText.trim().length < 10}
              className={`w-full py-3.5 rounded-xl font-mono text-label-sm font-bold tracking-wider uppercase transition-all flex items-center justify-center gap-2 ${
                isAnalyzing || rawText.trim().length < 10
                  ? "bg-surface-container-highest text-on-surface-variant/40 cursor-not-allowed border border-outline-variant/10"
                  : "bg-primary-container text-on-primary-container hover:bg-primary shadow-gold-glow hover:shadow-gold-glow-lg"
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                fact_check
              </span>
              {isAnalyzing ? "Analiz Ediliyor..." : "Yapay Zeka Analizini Başlat"}
            </button>
          </div>

          {/* Analiz Sonuçları ve Metin Alanı */}
          <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-6 flex-1 flex flex-col gap-4 min-h-[400px]">
            <div className="flex items-center justify-between border-b border-outline-variant/20 pb-3">
              <h2 className="font-body text-body-md font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary-container">article</span>
                Belge Metni ve AI İşaretlemeleri
              </h2>
              {analysisResult && (
                <span className="font-mono text-[10px] uppercase tracking-wider bg-primary-container/10 text-primary border border-primary-container/20 px-2 py-0.5 rounded">
                  Analiz Tamamlandı
                </span>
              )}
            </div>

            {/* Metin Gösterim Gövdesi */}
            <div className="flex-1 overflow-y-auto max-h-[550px] pr-2 space-y-4 font-body text-body-md leading-relaxed text-on-surface-variant">
              {isAnalyzing ? (
                <div className="h-full flex flex-col items-center justify-center gap-4 py-20 text-center">
                  <div className="w-12 h-12 border-4 border-primary-container/30 border-t-primary-container rounded-full animate-spin" />
                  <div className="space-y-1">
                    <p className="font-mono text-label-sm text-primary font-bold animate-pulse">
                      {loadingTexts[loadingTextIndex]}
                    </p>
                    <p className="text-[10px] text-on-surface-variant/60">
                      İlk yüklemede modeller yüklendiğinden bu işlem biraz sürebilir.
                    </p>
                  </div>
                </div>
              ) : analysisResult ? (
                <div className="bg-surface-container-lowest/40 border border-outline-variant/10 rounded-xl p-4 sm:p-5 shadow-inner space-y-4">
                  {analysisResult.paragraflar.map((p, i) => {
                    return (
                      <p key={i} className="text-xs sm:text-sm leading-relaxed text-on-surface-variant font-body">
                        {p.cumleler.map((s, sIdx) => {
                          const isAi = s.yapay_zeka_orani >= 80;
                          const isMediumAi = s.yapay_zeka_orani >= 50 && s.yapay_zeka_orani < 80;
                          
                          return (
                            <span
                              key={sIdx}
                              className={`relative group/s inline rounded px-0.5 mx-0.5 transition-all duration-200 ${
                                isAi
                                  ? "bg-error/15 border-b-2 border-error/40 hover:bg-error/25 cursor-help"
                                  : isMediumAi
                                  ? "bg-amber-500/15 border-b-2 border-amber-500/40 hover:bg-amber-500/25 cursor-help"
                                  : "hover:bg-surface-container-highest/30 cursor-help"
                              }`}
                            >
                              {s.metin}{" "}
                              
                              {/* Glowing Tooltip */}
                              <span className="absolute left-1/2 -top-10 -translate-x-1/2 bg-surface-container-highest border border-outline-variant/60 px-2.5 py-1 rounded-lg shadow-xl pointer-events-none opacity-0 group-hover/s:opacity-100 transition-opacity duration-200 z-30 flex items-center gap-1.5 whitespace-nowrap text-[10px] font-mono text-on-surface">
                                <span className={`w-2 h-2 rounded-full ${
                                  isAi 
                                    ? "bg-error" 
                                    : isMediumAi 
                                    ? "bg-amber-500" 
                                    : "bg-success"
                                }`} style={{ backgroundColor: (!isAi && !isMediumAi) ? "#10b981" : undefined }} />
                                AI Oranı: <strong className={isAi ? "text-error" : isMediumAi ? "text-amber-500" : "text-success"} style={{ color: (!isAi && !isMediumAi) ? "#10b981" : undefined }}>
                                  %{s.yapay_zeka_orani.toFixed(0)}
                                </strong>
                              </span>
                            </span>
                          );
                        })}
                      </p>
                    );
                  })}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center py-20 text-on-surface-variant/40">
                  <span className="material-symbols-outlined text-5xl mb-3">policy</span>
                  <p className="text-xs">
                    Analiz başlatılmadı. Metninizi yukarıdaki alana yapıştırın ve <strong className="text-primary-container">"Yapay Zeka Analizini Başlat"</strong> butonuna tıklayın.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* SAĞ PANEL (5 Kolon): SVG circular progress ve döküman istatistikleri */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          
          {/* Genel Analiz Grafiği Kartı */}
          <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-6 flex flex-col items-center gap-6 text-center">
            
            {/* Sekmeler (Tabs) */}
            <div className="w-full flex bg-surface-container-lowest border border-outline-variant/20 rounded-xl p-1 mb-2">
              <button
                onClick={() => setActiveTab("ozgunluk")}
                className={`flex-1 py-2 px-3 rounded-lg font-mono text-[10px] font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
                  activeTab === "ozgunluk"
                    ? "bg-primary-container text-on-primary-container shadow-md"
                    : "text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-highest/30"
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">analytics</span>
                Özgünlük Raporu
              </button>
              <button
                onClick={() => setActiveTab("intihal")}
                className={`flex-1 py-2 px-3 rounded-lg font-mono text-[10px] font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
                  activeTab === "intihal"
                    ? "bg-primary-container text-on-primary-container shadow-md"
                    : "text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-highest/30"
                }`}
              >
                <span className="material-symbols-outlined text-[16px]">policy</span>
                İntihal Raporu
              </button>
            </div>

            {/* SVG Dairesel Grafik */}
            <div className="relative w-48 h-48 flex items-center justify-center my-2">
              <svg className="w-full h-full transform -rotate-90">
                {/* Arka Plan Dairesi */}
                <circle
                  cx="96"
                  cy="96"
                  r={radius}
                  className="stroke-surface-container-highest"
                  strokeWidth={strokeWidth}
                  fill="transparent"
                />
                {/* Ön Plan Dairesi (Renkli Progress) */}
                <circle
                  cx="96"
                  cy="96"
                  r={radius}
                  className={
                    activeTab === "ozgunluk"
                      ? overallPercentage > 70 ? "stroke-error" : "stroke-primary-container"
                      : intihalPercentage > 25 ? "stroke-error" : ""
                  }
                  style={{
                    stroke: activeTab === "intihal" && intihalPercentage <= 25 ? "#10b981" : undefined,
                    strokeWidth: strokeWidth,
                    fill: "transparent",
                    strokeDasharray: circumference,
                    strokeDashoffset: activeTab === "ozgunluk" ? strokeDashoffset : intihalDashoffset,
                    strokeLinecap: "round",
                    transition: "stroke-dashoffset 1s ease-out, stroke 0.3s ease",
                  }}
                />
              </svg>

              {/* Daire İçindeki Metin */}
              <div className="absolute flex flex-col items-center justify-center">
                <span className={`font-display text-4xl font-extrabold tracking-tight ${
                  activeTab === "ozgunluk"
                    ? overallPercentage > 70 ? "text-error" : "text-primary"
                    : intihalPercentage > 25 ? "text-error" : "text-success"
                }`} style={{
                  color: activeTab === "intihal" && intihalPercentage <= 25 ? "#10b981" : undefined
                }}>
                  %{activeTab === "ozgunluk" ? overallPercentage.toFixed(0) : intihalPercentage.toFixed(0)}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-widest text-on-surface-variant/70 mt-1">
                  {activeTab === "ozgunluk" ? "YAPAY ZEKA (AI)" : "İNTİHAL (PLAGIARISM)"}
                </span>
              </div>
            </div>

            {/* TAB 1: ÖZGÜNLÜK İÇERİĞİ */}
            {activeTab === "ozgunluk" && (
              <>
                {/* Risk Değerlendirme Metni */}
                {analysisResult ? (
                  <div className="w-full p-4 rounded-xl bg-surface-container-lowest/80 border border-outline-variant/30 flex items-start gap-3 text-left">
                    <span className={`material-symbols-outlined mt-0.5 ${overallPercentage > 70 ? "text-error" : "text-success"}`} style={{ fontSize: 22, color: overallPercentage > 70 ? "" : "#10b981" }}>
                      {overallPercentage > 70 ? "gpp_maybe" : "verified"}
                    </span>
                    <div>
                      <h4 className="font-body text-xs font-bold text-on-surface">
                        {overallPercentage > 70 ? "Yüksek AI Riski" : "Düşük AI Riski / Doğal Yazım"}
                      </h4>
                      <p className="text-[11px] leading-relaxed text-on-surface-variant/80 mt-1">
                        {overallPercentage > 70 
                          ? "Belgenin büyük bir bölümü yapay zeka tarafından yazılmış olabilir. Akademik kurallara uyum için dökümanı gözden geçirin."
                          : "Dökümanın yapay zeka tarafından yazılma olasılığı düşüktür. İnsan kalemi ve özgün anlatım hakimdir."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-on-surface-variant/60 italic">
                    Analiz tamamlandığında genel yapay zeka riski ve rapor burada sergilenecektir.
                  </p>
                )}

                {/* İki Renkli Gösterge Barı */}
                <div className="w-full flex items-center gap-2 px-2 text-xs font-mono">
                  <div className="flex-1 flex items-center gap-1.5 justify-center">
                    <span className="w-3 h-3 rounded-full bg-error" />
                    <span className="text-on-surface-variant">Yapay Zeka: <strong className="text-on-surface">%{overallPercentage.toFixed(0)}</strong></span>
                  </div>
                  <div className="w-px h-4 bg-outline-variant/40" />
                  <div className="flex-1 flex items-center gap-1.5 justify-center">
                    <span className="w-3 h-3 rounded-full bg-success" style={{ backgroundColor: "#10b981" }} />
                    <span className="text-on-surface-variant">İnsan: <strong className="text-on-surface">%{(100 - overallPercentage).toFixed(0)}</strong></span>
                  </div>
                </div>

                {/* Gelişmiş Yazım Metrikleri */}
                {analysisResult && (
                  <div className="w-full mt-2 border-t border-outline-variant/20 pt-4 flex flex-col gap-3 text-left">
                    <h3 className="font-body text-xs font-bold text-on-surface flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px] text-primary">psychology</span>
                      Gelişmiş Yazım Metrikleri
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      {/* Perplexity */}
                      <div className="bg-surface-container-lowest/50 border border-outline-variant/20 p-3 rounded-xl flex flex-col justify-between">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                          <span className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant/70">Perplexity</span>
                        </div>
                        <span className="font-display text-xs font-bold text-on-surface">{analysisResult.metrikler.perplexity}</span>
                        <p className="text-[8px] text-on-surface-variant/80 mt-1 leading-normal">{analysisResult.metrikler.perplexity_aciklama}</p>
                      </div>
                      {/* Burstiness */}
                      <div className="bg-surface-container-lowest/50 border border-outline-variant/20 p-3 rounded-xl flex flex-col justify-between">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                          <span className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant/70">Burstiness</span>
                        </div>
                        <span className="font-display text-xs font-bold text-on-surface">{analysisResult.metrikler.burstiness}</span>
                        <p className="text-[8px] text-on-surface-variant/80 mt-1 leading-normal">{analysisResult.metrikler.burstiness_aciklama}</p>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* TAB 2: İNTİHAL İÇERİĞİ */}
            {activeTab === "intihal" && (
              <>
                {/* Risk Değerlendirme Metni */}
                {analysisResult ? (
                  <div className="w-full p-4 rounded-xl bg-surface-container-lowest/80 border border-outline-variant/30 flex items-start gap-3 text-left">
                    <span className={`material-symbols-outlined mt-0.5 ${intihalPercentage > 25 ? "text-error" : "text-success"}`} style={{ fontSize: 22, color: intihalPercentage > 25 ? "" : "#10b981" }}>
                      {intihalPercentage > 25 ? "gpp_maybe" : "verified"}
                    </span>
                    <div>
                      <h4 className="font-body text-xs font-bold text-on-surface">
                        {intihalPercentage > 25 ? "İntihal Riski Bulundu" : "Özgün Anlatım (Kopya Yok)"}
                      </h4>
                      <p className="text-[11px] leading-relaxed text-on-surface-variant/80 mt-1">
                        {intihalPercentage > 25 
                          ? "Metin içinde bazı kısımlar internetteki veya akademik literatürdeki kaynaklarla eşleşiyor. Referanslarınızı kontrol etmeniz önerilir."
                          : "İnternette veya literatürde bu metinle eşleşen doğrudan bir kopyalama bulunamadı. Metniniz son derece özgündür."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-on-surface-variant/60 italic">
                    Analiz tamamlandığında intihal tespiti ve muhtemel kaynaklar burada sergilenecektir.
                  </p>
                )}

                {/* İntihal Kaynakları Eşleşme Listesi */}
                {analysisResult && (
                  <div className="w-full mt-2 border-t border-outline-variant/20 pt-4 flex flex-col gap-3 text-left">
                    <h3 className="font-body text-xs font-bold text-on-surface flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px] text-primary">link</span>
                      Eşleşen Benzer Kaynaklar
                    </h3>
                    {analysisResult.intihal_kaynaklari.length > 0 ? (
                      <div className="flex flex-col gap-2 max-h-[160px] overflow-y-auto pr-1">
                        {analysisResult.intihal_kaynaklari.map((src, idx) => (
                          <a
                            key={idx}
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bg-surface-container-lowest/50 hover:bg-surface-container-lowest border border-outline-variant/20 p-2 rounded-xl flex items-center justify-between gap-3 group transition-colors"
                          >
                            <div className="flex flex-col gap-0.5 overflow-hidden">
                              <span className="font-body text-[10px] font-bold text-on-surface truncate">{src.kaynak}</span>
                              <span className="font-mono text-[8px] text-on-surface-variant/60 truncate">{src.url}</span>
                            </div>
                            <div className="flex items-center gap-1 bg-error-container/10 text-error border border-error-container/20 px-2 py-0.5 rounded font-mono text-[9px] font-bold whitespace-nowrap shrink-0">
                              %{src.benzerlik.toFixed(0)}
                            </div>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[10px] text-on-surface-variant/60 italic">
                        Semantik taramada eşleşen kopyalanmış bir kaynak bulunamadı.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

          </div>

          {/* Döküman İstatistik Kartları */}
          <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-6 flex flex-col gap-4">
            <h2 className="font-body text-body-md font-bold text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-container">query_stats</span>
              Metin Analiz İstatistikleri
            </h2>

            <div className="grid grid-cols-2 gap-4">
              
              {/* İstatistik 1: Toplam Karakter */}
              <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col justify-between">
                <span className="material-symbols-outlined text-on-surface-variant/40 text-xl">abc</span>
                <div className="mt-2">
                  <p className="font-mono text-[9px] tracking-wider text-on-surface-variant/60 uppercase">Karakter Sayısı</p>
                  <p className="font-display text-lg font-bold text-on-surface mt-0.5">
                    {totalCharacters.toLocaleString()}
                  </p>
                </div>
              </div>

              {/* İstatistik 2: Okunabilirlik Durumu */}
              <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col justify-between">
                <span className="material-symbols-outlined text-on-surface-variant/40 text-xl">chrome_reader_mode</span>
                <div className="mt-2">
                  <p className="font-mono text-[9px] tracking-wider text-on-surface-variant/60 uppercase">Okunabilirlik</p>
                  <p className="font-display text-xs font-bold text-on-surface mt-1 truncate" title={analysisResult?.metrikler.okunabilirlik_etiket || "-"}>
                    {analysisResult ? analysisResult.metrikler.okunabilirlik_etiket.split(" (")[0] : "-"}
                  </p>
                </div>
              </div>

              {/* İstatistik 3: AI Cümlesi */}
              <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col justify-between">
                <span className="material-symbols-outlined text-error/40 text-xl">smart_toy</span>
                <div className="mt-2">
                  <p className="font-mono text-[9px] tracking-wider text-on-surface-variant/60 uppercase">AI Cümlesi</p>
                  <p className="font-display text-lg font-bold text-error mt-0.5">
                    {aiSentences} <span className="text-[10px] text-on-surface-variant font-normal">/ {totalSentences}</span>
                  </p>
                </div>
              </div>

              {/* İstatistik 4: İnsan Cümlesi */}
              <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col justify-between">
                <span className="material-symbols-outlined text-on-surface-variant/40 text-xl" style={{ color: "#10b981" }}>person</span>
                <div className="mt-2">
                  <p className="font-mono text-[9px] tracking-wider text-on-surface-variant/60 uppercase">İnsan Cümlesi</p>
                  <p className="font-display text-lg font-bold text-on-surface mt-0.5" style={{ color: analysisResult ? "#10b981" : undefined }}>
                    {humanSentences} <span className="text-[10px] text-on-surface-variant font-normal">/ {totalSentences}</span>
                  </p>
                </div>
              </div>

            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
