import Link from "next/link";
import TranslationCard from "./features/TranslationCard";

export default function Features() {
  return (
    <section
      id="how-it-works"
      className="py-xl px-margin-mobile md:px-margin-desktop bg-surface"
    >
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-lg">
          <h2 className="font-headline text-headline-lg-mobile md:text-headline-lg text-on-surface mb-sm">
            Gelişmiş Analiz Araçları
          </h2>
          <p className="font-body text-body-md text-on-surface-variant max-w-2xl mx-auto">
            Derinlemesine döküman incelemesi ve anında geri bildirim ile akademik
            ve profesyonel süreçlerinizi hızlandırın.
          </p>
        </div>

        {/* Eşit alanlı 2x2 modül ızgarası — her kart tıklanabilir, kendi sayfasına gider */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter">
          <ModuleCard
            icon="menu_book"
            title="Akıllı Konu Anlatımı"
            description="Yüklediğin ders notlarını yapay zeka analiz eder; konuyu kısa, orta veya uzun şekilde, öğretici ya da sınav odaklı bir dille ve görsellerle baştan sona anlatır."
            href="/anlatim"
            tag="Anlatım Modu"
            action="Anlatımı Başlat"
          />

          <ModuleCard
            icon="psychology"
            title="Soru Çözüm Asistanı"
            description="Yüklediğin dökümanlardan çoktan seçmeli veya karma sınavlar üretir. Soru sayısını, zorluğu ve şık sayısını sen seçersin; testi çözüp cevap anahtarını görürsün."
            href="/test"
            tag="Test Modu"
            action="Test Oluştur"
          />

          <ModuleCard
            icon="style"
            title="İnteraktif Öğrenme Kartları"
            description="Dökümanınızdan otomatik flashcard'lar üretir. Her kartın önünde soru, arkasında iki mod: Betimlemeli (tanım + benzetme) ve Spot (sınav maddeleri). Tek anahtarla anında mod değiştir."
            href="/kartlar"
            tag="Kart Modu"
            action="Kart Oluştur"
          />

          <ModuleCard
            icon="library_books"
            title="Kavram Kütüphanesi"
            description="Konularına göre klasörler aç, merak ettiğin kavramları sor; Lostick AI tanımları kartlara dizsin. Üstelik kendini sınamak için test çözebilirsin."
            href="/kavram"
            tag="Kütüphane Modu"
            action="Kavram Ekle"
          />

          {/* 5 · Akıllı Doküman Çevirisi — modal açar */}
          <TranslationCard />

          {/* 6 · Yapay Zeka Analizörü — yönlendirir */}
          <ModuleCard
            icon="fingerprint"
            title="Yapay Zeka Analizörü"
            description="Yüklediğiniz ödev, tez veya raporları analiz eder; gelişmiş AI tespit modeliyle yapay zeka tarafından yazılıp yazılmadığını yüzde oranıyla tespit eder."
            href="/ai-analizor"
            tag="Analiz Modu"
            action="Dökümanını Analiz Et"
          />
        </div>
      </div>
    </section>
  );
}

interface ModuleCardProps {
  icon: string;
  title: string;
  description: string;
  href: string;
  tag: string;
  action: string;
}

/** Tüm modüller için ortak, eşit yükseklikte, tıklanabilir kart şablonu (sub-card'lı). */
function ModuleCard({ icon, title, description, href, tag, action }: ModuleCardProps) {
  return (
    <Link
      href={href}
      className="bg-surface-container-low border border-surface-variant rounded-xl p-md hover:border-primary-container/50 transition-colors group flex flex-col h-full"
    >
      <div className="w-12 h-12 bg-surface-container-highest rounded-lg flex items-center justify-center mb-md group-hover:bg-primary-container/20 transition-colors">
        <span className="material-symbols-outlined text-primary-container text-2xl">
          {icon}
        </span>
      </div>
      <h3 className="font-headline text-headline-md text-on-surface mb-2">
        {title}
      </h3>
      <p className="font-body text-body-md text-on-surface-variant flex-grow">
        {description}
      </p>

      {/* Sub-card — tüm kartlarda tutarlı */}
      <div className="mt-md bg-surface-container-lowest border border-surface-variant group-hover:border-primary-container rounded-lg p-sm flex items-center gap-3 transition-colors">
        <div className="bg-primary-container/15 border border-primary-container/30 px-2 py-1 rounded font-mono text-[10px] text-primary-container uppercase tracking-wider flex-shrink-0">
          {tag}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 text-primary-container">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              arrow_forward
            </span>
            <span className="font-mono text-label-sm">{action}</span>
          </div>
        </div>
        <span
          className="material-symbols-outlined text-primary-container group-hover:translate-x-1 transition-transform flex-shrink-0"
          style={{ fontSize: 18 }}
        >
          arrow_forward
        </span>
      </div>
    </Link>
  );
}
