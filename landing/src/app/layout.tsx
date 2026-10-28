import type { Metadata } from "next";
import { Hanken_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import "katex/dist/katex.min.css";
import TranslationCenter from "@/components/features/TranslationCenter";
import ToastNotification from "@/components/ToastNotification";


const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-hanken",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lostick — PDF'lerinizi Akıllı Bir Öğretmene Dönüştürün",
  description:
    "Lostick ile dokümanlarınızdan anında konu anlatımı çıkarın, yapay zeka destekli soru çözümleriyle eksiklerinizi tamamlayın.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="tr"
      className={`dark ${hanken.variable} ${inter.variable} ${jetbrains.variable}`}
    >
      <head>
        {/* Material Symbols ikon fontu. display=block → font yüklenene kadar ligature
            adı (örn. "menu_book") metin olarak görünmez; ikon hazır olunca belirir. */}
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
        />
      </head>
      <body className="bg-background text-on-background antialiased min-h-screen flex flex-col">
        {children}
        {/* Global Çeviri Merkezi — sayfa değişse de çeviri arka planda sürer + bildirim gösterir */}
        <TranslationCenter />
        {/* Global Toast Bildirimleri — tüm sayfalar genelinde dynamic toast tetikler */}
        <ToastNotification />

        {/* Google Identity Services — Sign in with Google */}
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
