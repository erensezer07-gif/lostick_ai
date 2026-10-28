/** @type {import('next').NextConfig} */
const nextConfig = {
  // reactStrictMode dev'de bileşenleri iki kez render/mount eder. App Router dev
  // modunda bu çift-render, CSS chunk enjeksiyonuyla yarışıp soft-navigation'da
  // sayfanın anlık stilsiz görünmesine (FOUC) katkıda bulunabiliyor. Kapatmak
  // YALNIZCA dev davranışını etkiler — production tamamen aynı kalır.
  reactStrictMode: false,
};

module.exports = nextConfig;
