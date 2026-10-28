import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import AiAnalizorView from "@/components/ai-analizor/AiAnalizorView";

export const metadata: Metadata = {
  title: "Yapay Zeka Analizörü — Lostick AI",
  description: "Dökümanlarınızın yapay zeka tarafından yazılıp yazılmadığını tespit edin.",
};

export default function AiAnalizorPage() {
  return (
    <>
      <Navbar />
      <AiAnalizorView />
    </>
  );
}
