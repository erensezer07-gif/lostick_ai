# Lostick Landing Page

Next.js 14 (App Router) + Tailwind CSS — PDF tabanlı öğrenme platformu landing sayfası.

## Çalıştırma

```bash
cd landing
npm install
npm run dev
```

Tarayıcıda: http://localhost:3000

## Yapı

```
src/
├── app/
│   ├── layout.tsx       # Root layout, fontlar, meta
│   ├── page.tsx         # Ana sayfa (component compose)
│   └── globals.css      # Tailwind + global stiller
└── components/
    ├── Navbar.tsx       # Sticky üst navigasyon (mobile menü dahil)
    ├── Hero.tsx         # Ana giriş bölümü
    ├── Features.tsx     # Bento grid özellik kartları
    └── Footer.tsx       # Alt bilgi
```

## Design System

`../DESIGN.md` dosyasındaki tokenlar `tailwind.config.ts` içinde tanımlıdır:

- **Renkler**: M3 tabanlı dark palette (surface tier'ları + altın aksanı)
- **Tipografi**: Hanken Grotesk (display), Inter (body), JetBrains Mono (label)
- **Spacing**: 8px base — xs/sm/md/lg/xl + gutter, desktop/mobile margin
- **Border radius**: sm 0.125 / DEFAULT 0.25 / md 0.375 / lg 0.5 / xl 0.75 rem

## Notlar

- Mobile-first responsive: `md:` breakpoint üstü desktop görünüm.
- Material Symbols Outlined `globals.css` üzerinden Google Fonts'tan yüklenir.
- Stitch demosundaki harici görseller yerine düşük maliyetli CSS placeholder'lar kullanıldı; production'da gerçek görsellerle değiştirin.
