"use client";

import { useEffect, useRef, useState } from "react";
import MessageBubble, { ChatMessage } from "./MessageBubble";
import ChatInput from "./ChatInput";
import { apiFetch } from "@/lib/apiKey";

const ACCEPTED_EXTENSIONS = [
  // PDF
  ".pdf",
  // Word & OpenDocument Text & RTF & Ebooks
  ".docx", ".docm", ".dotx", ".doc", ".odt", ".rtf", ".epub",
  // PowerPoint
  ".pptx", ".pptm", ".potx", ".ppsx", ".ppt",
  // Excel & Spreadsheets
  ".xlsx", ".xlsm", ".xltx", ".xls", ".csv", ".tsv",
  // Apple iWork
  ".pages", ".key", ".numbers",
  // Text & Notebooks
  ".txt", ".md", ".ipynb",
  // Images
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg",
  // Code & Web
  ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".go", ".rb", ".php", ".rs", ".kt", ".swift", ".sql", ".sh", ".bat",
  ".html", ".css", ".scss", ".xml", ".yaml", ".yml", ".json", ".r", ".scala",
  ".pl", ".lua", ".dart", ".vue",
];

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Merhaba! Ben Lostick AI. Benimle serbest sohbet edebilir ya da ataç ikonundan desteklenen herhangi bir dosyayı (PDF, Word, PPT, Görsel, Kod vb.) yükleyip belge üzerine soru sorabilirsin.",
    createdAt: Date.now(),
  },
];

export interface ChatSlot {
  id: string;
  title: string;
  messages: ChatMessage[];
  isPdfMode: boolean;
  pdfName: string | null;
  createdAt: number;
}

const DEFAULT_CHATS: ChatSlot[] = [
  { id: "chat_1", title: "Sohbet 1", messages: INITIAL_MESSAGES, isPdfMode: false, pdfName: null, createdAt: Date.now() },
  { id: "chat_2", title: "Sohbet 2", messages: INITIAL_MESSAGES, isPdfMode: false, pdfName: null, createdAt: Date.now() + 1 },
  { id: "chat_3", title: "Sohbet 3", messages: INITIAL_MESSAGES, isPdfMode: false, pdfName: null, createdAt: Date.now() + 2 },
  { id: "chat_4", title: "Sohbet 4", messages: INITIAL_MESSAGES, isPdfMode: false, pdfName: null, createdAt: Date.now() + 3 },
  { id: "chat_5", title: "Sohbet 5", messages: INITIAL_MESSAGES, isPdfMode: false, pdfName: null, createdAt: Date.now() + 4 },
];

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ChatView() {
  const [chats, setChats] = useState<ChatSlot[]>(DEFAULT_CHATS);
  const [activeChatId, setActiveChatId] = useState<string>("chat_1");
  const [isLoaded, setIsLoaded] = useState(false);

  // Masaüstünde varsayılan olarak açık, mobilde kapalı başlatmak için kontrol
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isThinking, setIsThinking] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Inline edit state'leri
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);

  // Mount anında localStorage'dan verileri çekip hydration sarmalamasını önlüyoruz
  useEffect(() => {
    const savedChats = window.localStorage.getItem("lostick.chats");
    if (savedChats) {
      try {
        setChats(JSON.parse(savedChats));
      } catch (e) {
        console.error("Error parsing saved chats:", e);
      }
    }
    const savedActive = window.localStorage.getItem("lostick.activeChatId");
    if (savedActive) {
      setActiveChatId(savedActive);
    }
    setIsLoaded(true);

    if (window.innerWidth < 1024) {
      setIsSidebarOpen(false);
    }
  }, []);

  // Aktif sohbet odası türetilmiş state'leri
  const activeChat = chats.find(c => c.id === activeChatId) || chats[0] || DEFAULT_CHATS[0];
  const messages = activeChat.messages;
  const isPdfMode = activeChat.isPdfMode;
  const pdfName = activeChat.pdfName;

  // LocalStorage senkronizasyonları (Sadece veri yüklendikten sonra çalışır)
  useEffect(() => {
    if (!isLoaded) return;
    try {
      window.localStorage.setItem("lostick.chats", JSON.stringify(chats));
    } catch (e) {
      console.error("LocalStorage chats sync failed:", e);
    }
  }, [chats, isLoaded]);

  useEffect(() => {
    if (!isLoaded) return;
    try {
      window.localStorage.setItem("lostick.activeChatId", activeChatId);
    } catch (e) {
      console.error("LocalStorage activeChatId sync failed:", e);
    }
  }, [activeChatId, isLoaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  // Yardımcı State Sarmalayıcıları (Geriye dönük uyumluluk ve minimum refaktör için)
  function setMessages(msgs: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
    setChats(prev => prev.map(c => {
      if (c.id === activeChatId) {
        const nextMsgs = typeof msgs === "function" ? msgs(c.messages) : msgs;
        return { ...c, messages: nextMsgs };
      }
      return c;
    }));
  }

  function setIsPdfMode(val: boolean | ((prev: boolean) => boolean)) {
    setChats(prev => prev.map(c => {
      if (c.id === activeChatId) {
        const nextVal = typeof val === "function" ? val(c.isPdfMode) : val;
        return { ...c, isPdfMode: nextVal };
      }
      return c;
    }));
  }

  function setPdfName(val: string | null | ((prev: string | null) => string | null)) {
    setChats(prev => prev.map(c => {
      if (c.id === activeChatId) {
        const nextVal = typeof val === "function" ? val(c.pdfName) : val;
        return { ...c, pdfName: nextVal };
      }
      return c;
    }));
  }

  function appendMessage(msg: Omit<ChatMessage, "id" | "createdAt">) {
    setMessages((prev) => [
      ...prev,
      { ...msg, id: generateId(), createdAt: Date.now() },
    ]);
  }

  async function handleSend(text: string) {
    const sonMesajlar = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-4)
      .map(
        (m) => `${m.role === "user" ? "Öğrenci" : "AI"}: ${m.content}`,
      )
      .join("\n");

    appendMessage({ role: "user", content: text });
    setIsThinking(true);

    const endpoint = isPdfMode ? "/api/soru-sor" : "/api/genel-sohbet";

    try {
      const response = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soru: text,
          gecmis: sonMesajlar,
        }),
      });

      if (!response.ok) {
        throw new Error(`Sunucu hatası (${response.status})`);
      }

      const data: { cevap?: string; sources?: any[] } = await response.json();

      appendMessage({
        role: "assistant",
        content: data.cevap ?? "Boş yanıt alındı.",
        sources: data.sources,
      });
    } catch (error) {
      console.error("API Bağlantı Hatası:", error);
      const errorText =
        error instanceof Error ? error.message : "Bilinmeyen hata";
      appendMessage({
        role: "assistant",
        content: `⚠️ Bağlantı koptu: ${errorText}\n\nBackend'in çalıştığından emin ol (http://127.0.0.1:8000).`,
      });
    } finally {
      setIsThinking(false);
    }
  }

  async function handleUpload(file: File) {
    const lower = file.name.toLowerCase();
    const okExt = ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
    if (!okExt) {
      appendMessage({
        role: "system",
        tone: "error",
        content: `${file.name}: Desteklenmeyen dosya tipi.`,
      });
      return;
    }

    setIsUploading(true);
    appendMessage({
      role: "system",
      tone: "info",
      content: `${file.name} yükleniyor ve indeksleniyor...`,
    });

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await apiFetch("/api/pdf-yukle", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Yükleme başarısız (${response.status}): ${detail}`);
      }

      const data: { durum?: string; mesaj?: string } = await response.json();

      setIsPdfMode(true);
      setPdfName(file.name);
      appendMessage({
        role: "system",
        tone: "success",
        content:
          data.mesaj ??
          "Dosya başarıyla eklendi. Artık sorularınızı bu belge üzerinden yanıtlayacağım.",
      });
    } catch (error) {
      console.error("Dosya Yükleme Hatası:", error);
      const errorText =
        error instanceof Error ? error.message : "Bilinmeyen hata";
      appendMessage({
        role: "system",
        tone: "error",
        content: `Dosya yüklenemedi: ${errorText}`,
      });
    } finally {
      setIsUploading(false);
    }
  }

  function handleReset() {
    clearChat(activeChatId);
  }

  function handleExitPdfMode() {
    setIsPdfMode(false);
    setPdfName(null);
    appendMessage({
      role: "system",
      tone: "info",
      content: "Belge modundan çıkıldı. Genel sohbete geri dönüldü.",
    });
  }

  // Sohbet odası yönetim fonksiyonları
  function clearChat(id: string) {
    setChats(prev => prev.map(c => c.id === id ? {
      ...c,
      messages: INITIAL_MESSAGES,
      isPdfMode: false,
      pdfName: null
    } : c));
  }

  function handleRenameSubmit(id: string) {
    if (editingTitle.trim()) {
      setChats(prev => prev.map(c => c.id === id ? { ...c, title: editingTitle.trim() } : c));
    }
    setEditingChatId(null);
  }

  const userMessageCount = messages.filter((m) => m.role === "user").length;

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-65px)] bg-background">
        <div className="flex flex-col items-center gap-3">
          <span className="w-10 h-10 border-4 border-surface-variant border-t-primary-container rounded-full animate-spin" />
          <p className="font-mono text-label-sm text-on-surface-variant">Lostick AI yükleniyor...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-65px)] overflow-hidden bg-background">
      {/* Mobil Yan Menü Arka Plan Kapatıcısı (Overlay) */}
      {isSidebarOpen && (
        <div
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 bg-black/40 z-40 lg:hidden animate-fade-in"
        />
      )}

      {/* 5 Sohbet Odası Yan Menüsü (Sidebar) */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-[260px] flex-shrink-0 border-r border-outline-variant/20 bg-surface-container-low flex flex-col h-full transition-all duration-300 ${
          isSidebarOpen ? "translate-x-0 lg:ml-0" : "-translate-x-full lg:-ml-[260px]"
        }`}
      >
        {/* Sidebar Başlığı */}
        <div className="p-4 border-b border-outline-variant/20 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 20 }}>
              chat_bubble
            </span>
            <span className="font-headline font-semibold text-on-surface text-sm">
              Sohbet Odaları
            </span>
          </div>
          {/* Sol menüyü kapatma butonu */}
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="text-on-surface-variant hover:text-on-surface transition-colors p-1 rounded hover:bg-surface-container-highest flex items-center justify-center"
            title="Paneli Kapat"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
              menu_open
            </span>
          </button>
        </div>

        {/* Sohbet Listesi */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {chats.map((chat) => {
            const isActive = chat.id === activeChatId;
            const isEditing = editingChatId === chat.id;

            return (
              <div
                key={chat.id}
                className={`group flex items-center justify-between p-2.5 rounded-lg transition-all border ${
                  isActive
                    ? "bg-primary-container/10 border-primary-container/25 text-primary-container"
                    : "bg-transparent border-transparent hover:bg-surface-container-high/60 text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {isEditing ? (
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => handleRenameSubmit(chat.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSubmit(chat.id);
                      if (e.key === "Escape") setEditingChatId(null);
                    }}
                    autoFocus
                    className="flex-1 bg-surface-container border border-primary-container/40 rounded px-1.5 py-0.5 text-xs text-on-surface font-body focus:outline-none focus:ring-1 focus:ring-primary-container"
                  />
                ) : (
                  <button
                    onClick={() => {
                      setActiveChatId(chat.id);
                      if (typeof window !== "undefined" && window.innerWidth < 1024) {
                        setIsSidebarOpen(false); // Mobilde seçince otomatik kapat
                      }
                    }}
                    className="flex-1 min-w-0 text-left flex items-center gap-2.5 font-mono text-label-md font-medium"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        isActive ? "bg-primary-container animate-pulse-gold" : "bg-on-surface-variant/30"
                      }`}
                    />
                    <span className="truncate">{chat.title}</span>
                  </button>
                )}

                {/* Aksiyon Butonları (Aktifken görünür veya hover durumunda) */}
                {!isEditing && (
                  <div
                    className={`flex items-center gap-0.5 flex-shrink-0 transition-opacity ${
                      isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingChatId(chat.id);
                        setEditingTitle(chat.title);
                      }}
                      className="p-1 text-on-surface-variant hover:text-primary-container rounded hover:bg-surface-container-highest transition-all"
                      title="Sohbet Odasını Yeniden Adlandır"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                        edit
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`"${chat.title}" odasındaki tüm geçmiş ve dökümanlar temizlensin mi?`)) {
                          clearChat(chat.id);
                        }
                      }}
                      className="p-1 text-on-surface-variant hover:text-error rounded hover:bg-surface-container-highest transition-all"
                      title="Sohbet Odasını Sıfırla"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                        refresh
                      </span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Ana Sohbet Ekranı */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Topbar */}
        <div className="border-b border-outline-variant/20 bg-surface-container-lowest flex-shrink-0">
          <div className="max-w-4xl mx-auto px-margin-mobile md:px-margin-desktop py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* Sol Menü Açma/Kapatma Hamburger Butonu */}
              <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="w-8 h-8 rounded border border-surface-variant hover:border-primary-container text-on-surface-variant hover:text-on-surface flex items-center justify-center transition-colors flex-shrink-0"
                title={isSidebarOpen ? "Paneli Gizle" : "Paneli Göster"}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                  {isSidebarOpen ? "menu_open" : "menu"}
                </span>
              </button>

              <div className="w-2 h-2 rounded-full bg-primary-container animate-pulse-gold flex-shrink-0" />
              <div className="min-w-0">
                <div className="font-headline font-semibold text-on-surface text-sm flex items-center gap-1.5 flex-wrap">
                  <span>Lostick AI Sohbet</span>
                  
                  {/* Tıklanabilir ve Yeniden Adlandırılabilir Topbar Rozeti */}
                  {editingChatId === activeChat.id ? (
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => handleRenameSubmit(activeChat.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit(activeChat.id);
                        if (e.key === "Escape") setEditingChatId(null);
                      }}
                      autoFocus
                      className="bg-surface-container border border-primary-container/40 rounded px-2 py-0.5 text-[11px] text-on-surface font-body focus:outline-none focus:ring-1 focus:ring-primary-container max-w-[120px]"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setEditingChatId(activeChat.id);
                        setEditingTitle(activeChat.title);
                      }}
                      className="font-mono text-[10px] bg-primary-container/10 border border-primary-container/20 hover:bg-primary-container/20 text-primary-container px-2 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all"
                      title="Sohbet ismini değiştirmek için tıklayın"
                    >
                      {activeChat.title}
                      <span className="material-symbols-outlined" style={{ fontSize: 10 }}>
                        edit
                      </span>
                    </button>
                  )}
                </div>
                <p className="font-mono text-label-sm text-on-surface-variant/70 mt-0.5">
                  {userMessageCount} mesaj
                  {isPdfMode && pdfName ? ` · Belge: ${pdfName}` : ""}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {isPdfMode && (
                <button
                  onClick={handleExitPdfMode}
                  className="font-mono text-label-sm text-on-surface-variant hover:text-error transition-colors flex items-center gap-1 px-3 py-1 border border-surface-variant rounded hover:border-error"
                  title="Belge modundan çık"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                    close
                  </span>
                  <span className="hidden sm:inline">Belgeyi Kaldır</span>
                </button>
              )}
              <button
                onClick={handleReset}
                className="font-mono text-label-sm text-on-surface-variant hover:text-primary-container transition-colors flex items-center gap-1 px-3 py-1 border border-surface-variant rounded hover:border-primary-container"
                title="Bu sohbet odasını sıfırla"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                  refresh
                </span>
                <span className="hidden sm:inline">Odayı Sıfırla</span>
              </button>
            </div>
          </div>
        </div>

        {/* Mesaj Listesi */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-margin-mobile md:px-margin-desktop py-md space-y-md">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}

            {isThinking && (
              <div className="flex gap-3 items-start">
                <div className="w-9 h-9 rounded-lg bg-surface-container-highest border border-outline-variant/40 flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 18 }}>
                    smart_toy
                  </span>
                </div>
                <div className="bg-surface-container-low border border-surface-variant rounded-lg px-4 py-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary-container animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-2 h-2 rounded-full bg-primary-container animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-2 h-2 rounded-full bg-primary-container animate-bounce" />
                  <span className="font-mono text-label-sm text-on-surface-variant ml-2">
                    Düşünüyor...
                  </span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Mesaj Girdi Alanı */}
        <ChatInput
          onSend={handleSend}
          onUpload={handleUpload}
          disabled={isThinking || isUploading}
          isUploading={isUploading}
          isPdfMode={isPdfMode}
        />
      </div>
    </div>
  );
}
