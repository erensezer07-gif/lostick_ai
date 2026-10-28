import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import ChatView from "@/components/chat/ChatView";

export const metadata: Metadata = {
  title: "Sohbet — Lostick AI",
  description: "Lostick AI ile PDF'leriniz üzerine sohbet edin.",
};

export default function ChatPage() {
  return (
    <>
      <Navbar />
      <ChatView />
    </>
  );
}
