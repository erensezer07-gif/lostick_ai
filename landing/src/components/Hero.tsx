import Link from "next/link";

export default function Hero() {
  return (
    <section className="relative pt-xl pb-lg px-margin-mobile md:px-margin-desktop overflow-hidden border-b border-surface-variant">
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,193,7,0.08),transparent_50%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,rgba(255,193,7,0.04)_50%,transparent_100%)]" />
        <div className="absolute inset-0 bg-gradient-to-b from-background via-background/90 to-background" />
      </div>

      <div className="max-w-7xl mx-auto relative z-10 flex flex-col md:flex-row items-center gap-xl">
        <div className="w-full md:w-3/5 space-y-md">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-outline-variant/50 rounded-full bg-surface-container-highest/50 backdrop-blur-sm">
            <span
              className="material-symbols-outlined text-primary-container text-sm"
              style={{ fontSize: 16 }}
            >
              auto_awesome
            </span>
            <span className="font-mono text-label-sm text-on-surface-variant">
              Yapay Zeka Destekli Öğrenim
            </span>
          </div>

          <h1 className="font-display text-headline-lg-mobile md:text-display-lg text-on-surface">
            PDF&apos;lerinizi{" "}
            <span className="text-primary-container">Akıllı Bir Öğretmene</span>{" "}
            Dönüştürün
          </h1>

          <p className="font-body text-body-md md:text-body-lg text-on-surface-variant max-w-2xl leading-relaxed">
            Lostick, ders notlarınızı ve dökümanlarınızı yapay zeka destekli akıllı bir öğrenim merkezine dönüştürür. 
            Akıllı konu anlatımıyla dökümanlarınızdan ders özetleri çıkarın, soru çözüm asistanıyla anında deneme sınavları üretin, interaktif öğrenme kartlarıyla ezberinizi kalıcı hale getirin, kendi kavram kütüphanenizi oluşturun, dökümanlarınızı anında istediğiniz dile çevirin ve yapay zeka analizörüyle özgünlüklerini denetleyin.
          </p>

          {/* Gerçek ve Çekici Özellik Listesi (Hizalı ve Şık - 6 Elemanlı Grid) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 pt-6 max-w-2xl border-t border-outline-variant/20">
            {/* 1 · Akıllı Konu Anlatımı */}
            <div className="flex items-start gap-3 group">
              <span className="material-symbols-outlined text-primary text-[20px] bg-primary/10 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-300">
                menu_book
              </span>
              <div>
                <h3 className="font-body text-body-md font-bold text-on-surface">Akıllı Konu Anlatımı</h3>
                <p className="text-xs text-on-surface-variant/80 mt-0.5 leading-relaxed">
                  Ders notlarınızı ve dökümanlarınızı yapay zeka analiz eder; konuyu sınav odaklı bir dille ve görsellerle baştan sona detaylıca anlatır.
                </p>
              </div>
            </div>

            {/* 2 · Soru Çözüm Asistanı */}
            <div className="flex items-start gap-3 group">
              <span className="material-symbols-outlined text-primary text-[20px] bg-primary/10 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-300">
                quiz
              </span>
              <div>
                <h3 className="font-body text-body-md font-bold text-on-surface">Soru Çözüm Asistanı</h3>
                <p className="text-xs text-on-surface-variant/80 mt-0.5 leading-relaxed">
                  Yüklediğiniz dökümanlardan anında çoktan seçmeli, doğru/yanlış veya açık uçlu sınav kağıtları hazırlayın.
                </p>
              </div>
            </div>

            {/* 3 · İnteraktif Öğrenme Kartları */}
            <div className="flex items-start gap-3 group">
              <span className="material-symbols-outlined text-primary text-[20px] bg-primary/10 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-300">
                style
              </span>
              <div>
                <h3 className="font-body text-body-md font-bold text-on-surface">İnteraktif Öğrenme Kartları</h3>
                <p className="text-xs text-on-surface-variant/80 mt-0.5 leading-relaxed">
                  Kavramları hızlı ve kalıcı şekilde hafızanıza kazıyacak, dökümana özel akıllı kelime ve spot ezber kartları oluşturun.
                </p>
              </div>
            </div>

            {/* 4 · Kavram Kütüphanesi */}
            <div className="flex items-start gap-3 group">
              <span className="material-symbols-outlined text-primary text-[20px] bg-primary/10 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-300">
                library_books
              </span>
              <div>
                <h3 className="font-body text-body-md font-bold text-on-surface">Kavram Kütüphanesi</h3>
                <p className="text-xs text-on-surface-variant/80 mt-0.5 leading-relaxed">
                  Konularınıza göre klasörler açın; merak ettiğiniz tüm kavramları Lostick AI tanımlasın ve akıllı kartlara dizsin.
                </p>
              </div>
            </div>

            {/* 5 · Akıllı Doküman Çevirisi */}
            <div className="flex items-start gap-3 group">
              <span className="material-symbols-outlined text-primary text-[20px] bg-primary/10 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-300">
                g_translate
              </span>
              <div>
                <h3 className="font-body text-body-md font-bold text-on-surface">Akıllı Doküman Çevirisi</h3>
                <p className="text-xs text-on-surface-variant/80 mt-0.5 leading-relaxed">
                  Yabancı dildeki akademik makale ve döküman notlarınızı, orijinal sayfa düzenini ve terminolojiyi koruyarak istediğiniz dile çevirin.
                </p>
              </div>
            </div>

            {/* 6 · Yapay Zeka Analizörü */}
            <div className="flex items-start gap-3 group">
              <span className="material-symbols-outlined text-primary text-[20px] bg-primary/10 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-300">
                fingerprint
              </span>
              <div>
                <h3 className="font-body text-body-md font-bold text-on-surface">Yapay Zeka Analizörü</h3>
                <p className="text-xs text-on-surface-variant/80 mt-0.5 leading-relaxed">
                  Dökümanlarınızdan yapay zeka tespiti yapın, cümle bazlı ısı haritası ve semantik intihal taraması gerçekleştirin.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="w-full md:w-2/5">
          <div className="bg-surface-container-high rounded-xl border border-surface-variant overflow-hidden shadow-card-elevated relative">
            <div className="bg-surface-container-highest p-3 border-b border-surface-variant flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-surface-variant" />
              <div className="w-3 h-3 rounded-full bg-surface-variant" />
              <div className="w-3 h-3 rounded-full bg-surface-variant" />
            </div>

            <div className="p-6 relative min-h-[280px]">
              <div className="space-y-3">
                <div className="h-3 rounded bg-surface-variant/50 w-4/5" />
                <div className="h-3 rounded bg-surface-variant/50 w-full" />
                <div className="h-3 rounded bg-surface-variant/50 w-3/4" />
                <div className="h-3 rounded bg-primary-container/40 w-2/3" />
                <div className="h-3 rounded bg-surface-variant/50 w-5/6" />
                <div className="h-3 rounded bg-surface-variant/50 w-full" />
                <div className="h-3 rounded bg-surface-variant/50 w-1/2" />
                <div className="h-3 rounded bg-surface-variant/50 w-4/5" />
              </div>

              <div className="absolute bottom-4 right-4 left-4 sm:left-auto bg-surface-container-lowest/95 backdrop-blur-md border border-primary-container/30 p-4 rounded-lg shadow-lg flex items-start gap-3 sm:max-w-[260px]">
                <span
                  className="material-symbols-outlined text-primary-container mt-0.5"
                  style={{ fontSize: 20 }}
                >
                  smart_toy
                </span>
                <div>
                  <p className="font-mono text-label-sm text-primary-container mb-1">
                    Lostick AI
                  </p>
                  <p className="font-body text-[13px] leading-snug text-on-surface-variant">
                    Bu paragraf, kuantum mekaniğinin temel ilkelerini özetliyor.
                    Detaylı analiz ister misin?
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
