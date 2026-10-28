"use client";

/**
 * Akıllı Doküman Çevirisi kartı (Features grid'inde 5. kart).
 * Yalnızca tetikleyicidir: tıklayınca `lostick:open-ceviri` event'i yayar.
 * Asıl modal + arka plan polling, layout'a mount edilen TranslationCenter'da yaşar
 * (böylece çeviri sürerken kullanıcı sayfalarda gezinebilir).
 */
import Link from "next/link";

export default function TranslationCard() {
  return (
    <Link
      href="/ceviri"
      className="text-left bg-surface-container-low border border-surface-variant rounded-xl p-md hover:border-primary-container/50 transition-colors group flex flex-col h-full w-full"
    >
      {/* Icon Area - Same as ModuleCard */}
      <div className="w-12 h-12 bg-surface-container-highest rounded-lg flex items-center justify-center mb-md group-hover:bg-primary-container/20 transition-colors flex-shrink-0">
        <span className="material-symbols-outlined text-primary-container text-2xl">translate</span>
      </div>

      {/* Title */}
      <h3 className="font-headline text-headline-md text-on-surface mb-2">Akıllı Doküman Çevirisi</h3>

      {/* Description */}
      <p className="font-body text-body-md text-on-surface-variant flex-grow">
        Yabancı dildeki dökümanları, akademik dili ve biçimlendirmeyi bozmadan istediğiniz dile çevirir; görseller ve tablolar
        korunur. Çeviri arka planda sürer — sen sitede gezinebilirsin.
      </p>

      {/* Sub-card — Same as ModuleCard */}
      <div className="mt-md bg-surface-container-lowest border border-surface-variant group-hover:border-primary-container rounded-lg p-sm flex items-center gap-3 transition-colors w-full">
        <div className="bg-primary-container/15 border border-primary-container/30 px-2 py-1 rounded font-mono text-[10px] text-primary-container uppercase tracking-wider flex-shrink-0">
          Çeviri Modu
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-1 text-primary-container">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            arrow_forward
          </span>
          <span className="font-mono text-label-sm">Dökümanını Çevir</span>
        </div>
        <span className="material-symbols-outlined text-primary-container group-hover:translate-x-1 transition-transform flex-shrink-0" style={{ fontSize: 18 }}>
          arrow_forward
        </span>
      </div>
    </Link>
  );
}
