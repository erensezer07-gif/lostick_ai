"use client";

import { useEffect } from "react";

export default function CeviriView() {
  // Sayfa açıldığında global çeviri panelini otomatik olarak aç
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent("lostick:open-ceviri"));
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  function handleOpenCeviri() {
    window.dispatchEvent(new CustomEvent("lostick:open-ceviri"));
  }

  return (
    <div className="flex-1 min-h-[calc(100vh-65px)] bg-background text-on-background flex flex-col justify-center items-center p-4 md:p-8 relative overflow-hidden">
      
      {/* Arka Plan Glow Efektleri */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-[radial-gradient(circle,rgba(255,193,7,0.05),transparent_60%)]" />
      </div>

      <div className="max-w-3xl w-full bg-surface-container-low border border-surface-variant rounded-2xl p-6 md:p-10 shadow-2xl relative z-10 flex flex-col items-center text-center gap-8">
        
        {/* Büyük İkon */}
        <div className="w-20 h-20 bg-primary-container/10 border border-primary-container/30 rounded-2xl flex items-center justify-center shadow-gold-glow animate-pulse">
          <span className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
            translate
          </span>
        </div>

        {/* Başlık ve Açıklama */}
        <div className="space-y-3">
          <h1 className="font-headline text-headline-lg md:text-display-sm text-on-surface">
            Akıllı Doküman Çevirisi
          </h1>
          <p className="font-body text-body-md text-on-surface-variant max-w-xl mx-auto leading-relaxed">
            Yabancı dildeki akademik makalelerinizi ve ders notlarınızı, orijinal sayfa düzenini, tablolarını ve terim bütünlüğünü bozmadan saniyeler içinde dilediğiniz dile çevirin.
          </p>
        </div>

        {/* Tetikleme Butonu */}
        <button
          onClick={handleOpenCeviri}
          className="px-8 py-4 bg-primary-container text-on-primary-container hover:bg-primary font-mono text-label-md font-bold rounded-xl shadow-gold-glow hover:shadow-gold-glow-lg transition-all duration-300 flex items-center gap-3 uppercase tracking-wider"
        >
          <span className="material-symbols-outlined text-[20px]">
            upload_file
          </span>
          Akıllı Çeviri Panelini Başlat
        </button>

        {/* 3 Sütunlu Bilgi Kartları */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full mt-4 text-left">
          
          <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col gap-2">
            <span className="material-symbols-outlined text-primary text-xl">
              layers
            </span>
            <h4 className="font-body text-xs font-bold text-on-surface">Orijinal Düzeni Korur</h4>
            <p className="text-[10px] text-on-surface-variant/80 leading-normal">
              Dökümanınızdaki tablolar, şemalar, görseller ve sayfa mizanpajı kayma olmadan birebir korunur.
            </p>
          </div>

          <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col gap-2">
            <span className="material-symbols-outlined text-primary text-xl">
              g_translate
            </span>
            <h4 className="font-body text-xs font-bold text-on-surface">Çok Dilli Çeviri</h4>
            <p className="text-[10px] text-on-surface-variant/80 leading-normal">
              Sadece Türkçe değil; İngilizce, Almanca, Fransızca, İspanyolca gibi diller arasında çapraz çeviri yapabilirsiniz.
            </p>
          </div>

          <div className="bg-surface-container-lowest border border-outline-variant/20 p-4 rounded-xl flex flex-col gap-2">
            <span className="material-symbols-outlined text-primary text-xl">
              menu_book
            </span>
            <h4 className="font-body text-xs font-bold text-on-surface">Terim Sözlüğü Desteği</h4>
            <p className="text-[10px] text-on-surface-variant/80 leading-normal">
              Tıp, Hukuk, Mühendislik gibi alanların teknik terimlerini yapay zekaya sözlükle bildirerek hatasız çeviri sağlayın.
            </p>
          </div>

        </div>

      </div>
    </div>
  );
}
