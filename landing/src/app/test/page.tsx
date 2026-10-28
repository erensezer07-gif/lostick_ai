import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import QuizAssistant from "@/components/features/QuizAssistant";

export const metadata: Metadata = {
  title: "Soru Çözüm Asistanı — Lostick AI",
  description:
    "Yüklediğin belgelerden çoktan seçmeli veya karma sınavlar üret; zorluğu, soru ve şık sayısını seç, testi çöz.",
};

export default function TestPage() {
  return (
    <>
      <Navbar />
      <QuizAssistant />
    </>
  );
}
