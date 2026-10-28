import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import CeviriView from "@/components/features/CeviriView";

export const metadata: Metadata = {
  title: "Akıllı Doküman Çevirisi — Lostick AI",
  description: "Dökümanlarınızı orijinal mizanpajı ve akademik dil bütünlüğünü bozmadan istediğiniz dile çevirin.",
};

export default function CeviriPage() {
  return (
    <>
      <Navbar />
      <CeviriView />
    </>
  );
}
