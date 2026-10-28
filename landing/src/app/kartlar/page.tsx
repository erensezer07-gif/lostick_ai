import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import FlashcardAssistant from "@/components/features/FlashcardAssistant";

export const metadata: Metadata = {
  title: "İnteraktif Öğrenme Kartları — Lostick AI",
  description:
    "Belgenden otomatik flashcard'lar üret. Her kartın önünde soru, arkasında Betimlemeli ve Spot modlarıyla cevap.",
};

export default function KartlarPage() {
  return (
    <>
      <Navbar />
      <FlashcardAssistant />
    </>
  );
}
