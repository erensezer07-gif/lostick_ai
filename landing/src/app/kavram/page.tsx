import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import KavramView from "@/components/kavram/KavramView";

export const metadata: Metadata = {
  title: "Kavram Kütüphanesi — Lostick AI",
  description:
    "Konularına göre klasörler aç, merak ettiğin kavramları sor; Lostick AI jilet gibi net tanımları kartlara dizsin. Hepsi hesabında kalıcı kalır.",
};

export default function KavramPage() {
  return (
    <>
      <Navbar />
      <KavramView />
    </>
  );
}
