import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import AnlatimView from "@/components/anlatim/AnlatimView";

export const metadata: Metadata = {
  title: "Akıllı Konu Anlatımı — Lostick AI",
  description:
    "PDF'ini yükle, Lostick AI içeriği sıfırdan, mantığıyla ve adım adım sana anlatsın.",
};

export default function AnlatimPage() {
  return (
    <>
      <Navbar />
      <AnlatimView />
    </>
  );
}
