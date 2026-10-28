"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

import { getAuthUser } from "@/lib/auth";
import {
  addConcept,
  createFolder,
  deleteCard,
  deleteFolder,
  listCards,
  listFolders,
  type KavramKart,
  type KavramKlasor,
} from "@/lib/kavram";

type Toast = { type: "success" | "error" | "warning"; msg: string };

function formatRelative(ts: number): string {
  const diff = Date.now() - ts * 1000;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "az önce";
  if (min < 60) return `${min} dk önce`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} saat önce`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} gün önce`;
  return new Date(ts * 1000).toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Fisher-Yates karıştırma — kopya döner. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Klasördeki kavram sayısına göre seçilebilir test boyutları (en fazla = toplam). */
function buildTestCountOptions(total: number): number[] {
  const presets = [5, 10, 15, 20, 30, 50].filter((n) => n < total);
  presets.push(total);
  return Array.from(new Set(presets)).sort((a, b) => a - b);
}

export default function KavramView() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<KavramKlasor[]>([]);
  const [activeFolder, setActiveFolder] = useState<KavramKlasor | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(type: Toast["type"], msg: string) {
    setToast({ type, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  useEffect(() => {
    setAuthed(getAuthUser() !== null);
    function onAuth() {
      setAuthed(getAuthUser() !== null);
    }
    window.addEventListener("lostick:auth-changed", onAuth);
    return () => window.removeEventListener("lostick:auth-changed", onAuth);
  }, []);

  // Klasörleri yükle
  useEffect(() => {
    if (!authed) return;
    listFolders()
      .then(setFolders)
      .catch((e) => showToast("error", e instanceof Error ? e.message : "Klasörler yüklenemedi."));
  }, [authed]);

  async function refreshFolders() {
    try {
      setFolders(await listFolders());
    } catch {
      /* ignore */
    }
  }

  if (authed === null) {
    return (
      <div className="min-h-[calc(100vh-65px)] bg-surface flex items-center justify-center">
        <span className="w-6 h-6 border-2 border-surface-variant border-t-primary-container rounded-full animate-spin" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="min-h-[calc(100vh-65px)] bg-surface flex items-center justify-center px-margin-mobile">
        <div className="max-w-md text-center bg-surface-container-low border border-surface-variant rounded-xl p-lg">
          <div className="w-14 h-14 rounded-lg bg-primary-container/15 border border-primary-container/30 flex items-center justify-center mx-auto mb-md">
            <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 28 }}>
              lock
            </span>
          </div>
          <h2 className="font-headline text-headline-md text-on-surface mb-2">Giriş Gerekli</h2>
          <p className="font-body text-body-md text-on-surface-variant mb-md">
            Kavram Kütüphanesi kişiseldir — klasörlerin ve kavram kartların hesabında kalıcı
            olarak saklanır. Devam etmek için giriş yap.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary transition-all font-bold"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>login</span>
            Giriş Yap
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-65px)] bg-surface">
      <div className="max-w-7xl mx-auto px-margin-mobile md:px-margin-desktop py-lg">
        <header className="mb-lg">
          <div className="inline-flex items-center gap-2 px-3 py-1 border border-outline-variant/50 rounded-full bg-surface-container-highest/50 backdrop-blur-sm mb-4">
            <span
              className="material-symbols-outlined text-primary-container"
              style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}
            >
              library_books
            </span>
            <span className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest">
              Kavram Kütüphanesi
            </span>
          </div>
          <h1 className="font-display text-headline-lg-mobile md:text-display-lg text-on-surface tracking-tight mb-2">
            Kendi <span className="text-primary-container">Kavram Sözlüğün</span>
          </h1>
          <p className="font-body text-body-lg text-on-surface-variant max-w-2xl">
            Konularına göre klasörler aç, merak ettiğin kavramları yaz; Lostick AI jilet
            gibi net tanımları kartlara dizsin. Hepsi hesabında kalıcı kalır.
          </p>
        </header>

        {activeFolder ? (
          <FolderDetail
            folder={activeFolder}
            onBack={() => {
              setActiveFolder(null);
              refreshFolders();
            }}
            showToast={showToast}
            onCardCountChange={refreshFolders}
          />
        ) : (
          <FolderList
            folders={folders}
            onOpen={setActiveFolder}
            onChanged={refreshFolders}
            showToast={showToast}
          />
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 max-w-sm rounded-xl shadow-2xl px-4 py-3 flex items-start gap-3 border z-[10000] ${
            toast.type === "success"
              ? "bg-surface-container-high border-emerald-500/40"
              : toast.type === "warning"
              ? "bg-surface-container-high border-primary-container/50"
              : "bg-surface-container-high border-error/50"
          }`}
        >
          <span
            className={`material-symbols-outlined flex-shrink-0 ${
              toast.type === "success"
                ? "text-emerald-400"
                : toast.type === "warning"
                ? "text-primary-container"
                : "text-error"
            }`}
            style={{ fontSize: 20 }}
          >
            {toast.type === "success" ? "check_circle" : toast.type === "warning" ? "warning" : "error"}
          </span>
          <p className="font-mono text-label-sm text-on-surface flex-1 leading-relaxed">{toast.msg}</p>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Kapat"
            className="text-on-surface-variant hover:text-on-surface flex-shrink-0"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Klasör listesi ───────────────────────────────────────────────────

function FolderList({
  folders,
  onOpen,
  onChanged,
  showToast,
}: {
  folders: KavramKlasor[];
  onOpen: (f: KavramKlasor) => void;
  onChanged: () => void;
  showToast: (t: Toast["type"], m: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const ad = newName.trim();
    if (!ad || busy) return;
    setBusy(true);
    try {
      await createFolder(ad);
      setNewName("");
      setCreating(false);
      onChanged();
      showToast("success", `"${ad}" klasörü oluşturuldu.`);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Klasör oluşturulamadı.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteFolder(id);
      setConfirmDeleteId(null);
      onChanged();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Klasör silinemedi.");
    }
  }

  return (
    <div className="space-y-md">
      {/* Yeni klasör */}
      {creating ? (
        <form
          onSubmit={handleCreate}
          className="bg-surface-container-low border border-primary-container/40 rounded-xl p-md flex items-center gap-2"
        >
          <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 20 }}>
            create_new_folder
          </span>
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Klasör adı (örn: Bilgisayar Ağları, Vize 1 Konuları)"
            maxLength={80}
            className="flex-1 bg-transparent border-none outline-none font-body text-body-md text-on-surface placeholder:text-on-surface-variant/50"
          />
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
            className="font-mono text-label-sm text-on-surface-variant hover:text-on-surface px-3 py-1.5 rounded transition-colors"
          >
            Vazgeç
          </button>
          <button
            type="submit"
            disabled={!newName.trim() || busy}
            className="bg-primary-container text-on-primary-container font-mono text-label-sm px-4 py-1.5 rounded-lg hover:bg-primary disabled:opacity-40 transition-all font-bold"
          >
            Oluştur
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full border border-dashed border-outline-variant hover:border-primary-container bg-surface-container-lowest hover:bg-surface-container-low rounded-xl py-4 flex items-center justify-center gap-2 transition-colors"
        >
          <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 22 }}>
            create_new_folder
          </span>
          <span className="font-mono text-label-sm text-primary-container uppercase tracking-wider">
            Yeni Klasör Oluştur
          </span>
        </button>
      )}

      {folders.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-xl gap-2">
          <span className="material-symbols-outlined text-on-surface-variant/40" style={{ fontSize: 44 }}>
            folder_open
          </span>
          <p className="font-body text-body-md text-on-surface-variant">
            Henüz klasörün yok. Bir konu klasörü açarak başla.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {folders.map((f) => {
            const isConfirming = confirmDeleteId === f.id;
            return (
              <li
                key={f.id}
                className="group bg-surface-container-low border border-surface-variant hover:border-primary-container/50 rounded-xl p-md transition-all"
              >
                <button
                  type="button"
                  onClick={() => onOpen(f)}
                  className="w-full flex items-center gap-3 text-left"
                >
                  <div className="w-11 h-11 rounded-lg bg-primary-container/10 border border-primary-container/30 flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 22 }}>
                      folder
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-headline text-base text-on-surface font-semibold truncate" title={f.ad}>
                      {f.ad}
                    </p>
                    <p className="font-mono text-label-sm text-on-surface-variant/60">
                      {f.kart_sayisi} kavram · {formatRelative(f.created_at)}
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-on-surface-variant group-hover:text-primary-container group-hover:translate-x-1 transition-all flex-shrink-0" style={{ fontSize: 20 }}>
                    arrow_forward
                  </span>
                </button>

                {isConfirming ? (
                  <div className="mt-3 pt-3 border-t border-surface-variant flex items-center justify-between gap-2">
                    <p className="font-mono text-label-sm text-error">Klasör ve tüm kartları silinsin mi?</p>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="font-mono text-label-sm text-on-surface-variant hover:text-on-surface px-2.5 py-1 rounded transition-colors"
                      >
                        Vazgeç
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(f.id)}
                        className="font-mono text-label-sm text-error border border-error/50 hover:bg-error/15 px-2.5 py-1 rounded transition-colors"
                      >
                        Sil
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 pt-3 border-t border-surface-variant flex justify-end">
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(f.id)}
                      aria-label="Klasörü sil"
                      className="font-mono text-label-sm text-on-surface-variant/60 hover:text-error flex items-center gap-1 transition-colors"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                      Sil
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Klasör detayı (arama + accordion kartlar) ────────────────────────

function FolderDetail({
  folder,
  onBack,
  showToast,
  onCardCountChange,
}: {
  folder: KavramKlasor;
  onBack: () => void;
  showToast: (t: Toast["type"], m: string) => void;
  onCardCountChange: () => void;
}) {
  const [cards, setCards] = useState<KavramKart[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<KavramKart | null>(null); // modalde açık kart
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  // Test (kendini sınama) state'i
  const [testConfigOpen, setTestConfigOpen] = useState(false);
  const [testCount, setTestCount] = useState<number>(0);
  const [activeTest, setActiveTest] = useState<KavramKart[] | null>(null);

  function openTestConfig() {
    const opts = buildTestCountOptions(cards.length);
    setTestCount(opts[opts.length - 1] ?? cards.length); // varsayılan: tümü
    setTestConfigOpen(true);
  }

  function startTest() {
    const n = Math.max(1, Math.min(testCount, cards.length));
    setActiveTest(shuffle(cards).slice(0, n));
    setTestConfigOpen(false);
  }

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    listCards(folder.id)
      .then(setCards)
      .catch((e) => showToast("error", e instanceof Error ? e.message : "Kartlar yüklenemedi."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id]);

  // Modal açıkken Escape ile kapat
  useEffect(() => {
    if (!selected) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const kavram = query.trim();
    if (!kavram || adding) return;
    setAdding(true);
    try {
      const sonuc = await addConcept(folder.id, kavram);
      if (!sonuc.gecerli) {
        showToast("warning", sonuc.mesaj);
        return;
      }
      setCards((prev) => [sonuc.kart, ...prev]);
      setQuery("");
      setSelected(sonuc.kart); // yeni eklenen kartı modalde hemen göster
      onCardCountChange();
      showToast("success", `"${sonuc.kart.kavram}" kütüphanene eklendi.`);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Kavram eklenemedi.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteCard(id);
      setCards((prev) => prev.filter((c) => c.id !== id));
      setConfirmDeleteId(null);
      setSelected((cur) => (cur && cur.id === id ? null : cur));
      onCardCountChange();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Kart silinemedi.");
    }
  }

  return (
    <div className="space-y-md">
      {/* Üst bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Klasörlere dön"
          className="w-9 h-9 flex items-center justify-center rounded-lg border border-surface-variant text-on-surface-variant hover:text-primary-container hover:border-primary-container transition-colors flex-shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>arrow_back</span>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 22 }}>
            folder_open
          </span>
          <h2 className="font-headline text-headline-md text-on-surface truncate" title={folder.ad}>
            {folder.ad}
          </h2>
          <span className="font-mono text-label-sm text-on-surface-variant/50 flex-shrink-0">
            · {cards.length} kavram
          </span>
        </div>

        {/* Test Oluştur — en az 1 kavram varsa */}
        {cards.length > 0 && (
          <button
            type="button"
            onClick={openTestConfig}
            className="ml-auto flex-shrink-0 flex items-center gap-1.5 bg-primary-container/15 hover:bg-primary-container/25 text-primary-container border border-primary-container/40 font-mono text-label-sm px-4 py-2 rounded-lg transition-colors font-bold"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>fact_check</span>
            Test Oluştur
          </button>
        )}
      </div>

      {/* Arama / kavram ekleme çubuğu */}
      <form
        onSubmit={handleAdd}
        className="bg-surface-container-low border border-surface-variant focus-within:border-primary-container/60 rounded-xl p-2 flex items-center gap-2 transition-colors"
      >
        <span className="material-symbols-outlined text-on-surface-variant/60 pl-2 flex-shrink-0" style={{ fontSize: 20 }}>
          search
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Eklemek istediğiniz kavramı yazın... (örn: DNS nedir?, Polimorfizm)"
          maxLength={200}
          disabled={adding}
          className="flex-1 bg-transparent border-none outline-none font-body text-body-md text-on-surface placeholder:text-on-surface-variant/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!query.trim() || adding}
          className="bg-primary-container text-on-primary-container font-mono text-label-sm px-4 py-2 rounded-lg hover:bg-primary disabled:opacity-40 disabled:cursor-not-allowed transition-all font-bold flex items-center gap-1.5 flex-shrink-0"
        >
          {adding ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-on-surface-variant/30 border-t-on-primary-container rounded-full animate-spin" />
              Ekleniyor
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Kavram Ekle
            </>
          )}
        </button>
      </form>

      {/* Kart ızgarası — yan yana minimalist kartlar */}
      {loading ? (
        <div className="flex justify-center py-lg">
          <span className="w-6 h-6 border-2 border-surface-variant border-t-primary-container rounded-full animate-spin" />
        </div>
      ) : cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-xl gap-2">
          <span className="material-symbols-outlined text-on-surface-variant/40" style={{ fontSize: 44 }}>
            quiz
          </span>
          <p className="font-body text-body-md text-on-surface-variant">
            Bu klasör boş. Yukarıdaki çubuğa bir kavram yazarak ilk kartını ekle.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {cards.map((card) => {
            const isConfirming = confirmDeleteId === card.id;
            return (
              <li key={card.id} className="group relative">
                {/* Minimalist kart — tıklayınca modal açılır */}
                <button
                  type="button"
                  onClick={() => setSelected(card)}
                  className="w-full h-full min-h-[7.5rem] bg-surface-container-low border border-surface-variant hover:border-primary-container/60 hover:bg-surface-container rounded-xl p-md flex flex-col text-left transition-all"
                >
                  <span
                    className="material-symbols-outlined text-primary-container/70 mb-2"
                    style={{ fontSize: 20 }}
                  >
                    quiz
                  </span>
                  <span className="font-headline text-base md:text-lg text-on-surface font-semibold leading-snug [overflow-wrap:anywhere] line-clamp-3">
                    {card.kavram}
                  </span>
                  <span className="mt-auto pt-2 flex items-center gap-1 font-mono text-[10px] text-on-surface-variant/60 group-hover:text-primary-container uppercase tracking-wider transition-colors">
                    Tanımı gör
                    <span className="material-symbols-outlined group-hover:translate-x-0.5 transition-transform" style={{ fontSize: 14 }}>
                      open_in_full
                    </span>
                  </span>
                </button>

                {/* Köşedeki çöp kutusu */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteId(card.id);
                  }}
                  aria-label="Kavramı sil"
                  className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant/40 hover:text-error hover:bg-surface-container-high opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                </button>

                {/* Silme onayı — kartı kaplayan katman */}
                {isConfirming && (
                  <div className="absolute inset-0 bg-surface-container-high/95 backdrop-blur-sm border border-error/40 rounded-xl flex flex-col items-center justify-center gap-2 p-3 text-center">
                    <p className="font-mono text-label-sm text-error">Bu kavram silinsin mi?</p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="font-mono text-label-sm text-on-surface-variant hover:text-on-surface px-3 py-1.5 rounded transition-colors"
                      >
                        Vazgeç
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(card.id)}
                        className="font-mono text-label-sm text-error border border-error/50 hover:bg-error/15 px-3 py-1.5 rounded transition-colors"
                      >
                        Sil
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Tanım modalı (lightbox) */}
      {mounted && selected &&
        createPortal(
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-md flex items-center justify-center p-margin-mobile"
            style={{ zIndex: 9998 }}
            onClick={() => setSelected(null)}
          >
            <div
              className="w-full max-w-xl bg-surface-container-low border border-primary-container/30 rounded-2xl shadow-card-elevated flex flex-col max-h-[calc(100vh-3rem)]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Başlık */}
              <div className="flex items-start justify-between gap-3 p-lg pb-md border-b border-surface-variant">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-primary-container/15 border border-primary-container/30 flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-primary-container" style={{ fontSize: 22 }}>
                      quiz
                    </span>
                  </div>
                  <h3 className="font-headline text-headline-md text-on-surface leading-snug [overflow-wrap:anywhere]">
                    {selected.kavram}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Kapat"
                  className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>

              {/* Tanım */}
              <div className="p-lg overflow-y-auto">
                <p className="font-mono text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-2">
                  Tanım
                </p>
                <p className="font-body text-body-lg text-on-surface leading-relaxed [overflow-wrap:anywhere]">
                  {selected.tanim}
                </p>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Test konfigürasyon modalı */}
      {mounted && testConfigOpen &&
        createPortal(
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-md flex items-center justify-center p-margin-mobile"
            style={{ zIndex: 9998 }}
            onClick={() => setTestConfigOpen(false)}
          >
            <div
              className="w-full max-w-md bg-surface-container-low border border-surface-variant rounded-2xl shadow-card-elevated flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 px-lg pt-lg pb-md">
                <div className="min-w-0">
                  <p className="font-mono text-label-sm text-primary-container uppercase tracking-widest mb-1">
                    Kendini Sına
                  </p>
                  <h3 className="font-headline text-headline-md text-on-surface">Test Oluştur</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setTestConfigOpen(false)}
                  aria-label="Kapat"
                  className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>

              <div className="px-lg pb-md">
                <p className="font-body text-body-md text-on-surface-variant mb-3">
                  Bu klasördeki <span className="text-primary-container font-semibold">{cards.length}</span> kavramdan
                  kaç tanesi karşına çıksın? Kartı çevirip tanımı gör, sonra bilip bilmediğini işaretle.
                </p>
                <p className="font-mono text-label-sm text-on-surface-variant uppercase tracking-widest mb-2">
                  Kavram Sayısı
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {buildTestCountOptions(cards.length).map((n) => {
                    const active = testCount === n;
                    const isAll = n === cards.length;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setTestCount(n)}
                        className={`py-3 rounded-lg border font-mono text-label-sm transition-all ${
                          active
                            ? "bg-primary-container/15 border-primary-container text-primary-container"
                            : "bg-surface-container-low border-surface-variant text-on-surface-variant hover:border-primary-container/50 hover:text-on-surface"
                        }`}
                      >
                        {isAll ? `${n} (Tümü)` : n}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 p-lg pt-md border-t border-surface-variant">
                <button
                  type="button"
                  onClick={() => setTestConfigOpen(false)}
                  className="border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all"
                >
                  Vazgeç
                </button>
                <button
                  type="button"
                  onClick={startTest}
                  className="bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary transition-all font-bold flex items-center gap-2"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>play_arrow</span>
                  Testi Başlat
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Test çalıştırıcı — tam ekran */}
      {mounted && activeTest &&
        createPortal(
          <div className="fixed inset-0 bg-background flex flex-col" style={{ zIndex: 9999 }}>
            <KavramTestRunner
              cards={activeTest}
              folderName={folder.ad}
              onExit={() => setActiveTest(null)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── Test çalıştırıcı (kendini sınama, AI yok) ────────────────────────

function KavramTestRunner({
  cards,
  folderName,
  onExit,
}: {
  cards: KavramKart[];
  folderName: string;
  onExit: () => void;
}) {
  const total = cards.length;
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]); // sırayla doğru/yanlış
  const [finished, setFinished] = useState(false);

  const card = cards[index];
  const correct = answers.filter(Boolean).length;

  function answer(known: boolean) {
    const next = [...answers];
    next[index] = known;
    setAnswers(next);
    if (index < total - 1) {
      setFlipped(false);
      setIndex((i) => i + 1);
    } else {
      setFinished(true);
    }
  }

  function restart() {
    setIndex(0);
    setFlipped(false);
    setAnswers([]);
    setFinished(false);
  }

  // Klavye: boşluk/enter çevir, esc çık
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onExit();
      else if (!finished && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setFlipped((f) => !f);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  // ─── Sonuç ekranı ───
  if (finished) {
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const mesaj =
      pct >= 80
        ? "Harika! Bu konuya neredeyse tam hâkimsin."
        : pct >= 50
        ? "Fena değil — eksik kaldığın kavramları tekrar et."
        : "Biraz daha çalışmalısın. Bilmediğin kavramları gözden geçir.";
    const renk =
      pct >= 80 ? "text-emerald-400" : pct >= 50 ? "text-primary-container" : "text-error";
    return (
      <div className="flex flex-col h-full items-center justify-center p-md">
        <div className="w-full max-w-md text-center">
          <span className="material-symbols-outlined text-primary-container mb-3" style={{ fontSize: 48 }}>
            military_tech
          </span>
          <h2 className="font-headline text-headline-lg text-on-surface mb-1">Test Bitti</h2>
          <p className="font-mono text-label-sm text-on-surface-variant/70 mb-lg uppercase tracking-widest">
            {folderName}
          </p>

          <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-lg mb-md">
            <p className={`font-display text-5xl font-extrabold mb-1 ${renk}`}>%{pct}</p>
            <p className="font-body text-body-lg text-on-surface">
              {total} kavramdan <span className="text-emerald-400 font-semibold">{correct}</span> tanesini bildin
            </p>
            <p className="font-body text-body-md text-on-surface-variant mt-3">{mesaj}</p>
          </div>

          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={restart}
              className="flex items-center gap-1.5 border border-outline-variant text-on-surface hover:border-primary-container hover:text-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>replay</span>
              Tekrar Çöz
            </button>
            <button
              type="button"
              onClick={onExit}
              className="flex items-center gap-1.5 bg-primary-container text-on-primary-container font-mono text-label-sm px-5 py-2.5 rounded-lg hover:bg-primary transition-all font-bold"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check</span>
              Bitir
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Kart ekranı ───
  return (
    <div className="flex flex-col h-full">
      {/* Üst bar */}
      <div className="flex items-center justify-between gap-3 px-md py-3 border-b border-surface-variant bg-surface-container-low">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-primary-container flex-shrink-0" style={{ fontSize: 18 }}>fact_check</span>
          <span className="font-mono text-label-sm text-on-surface-variant truncate">{folderName}</span>
          <span className="font-mono text-label-sm text-on-surface-variant/50 flex-shrink-0">· {index + 1} / {total}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-label-sm text-emerald-400 flex items-center gap-1">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>
            {correct}
          </span>
          <button
            type="button"
            onClick={onExit}
            aria-label="Çıkış"
            className="w-9 h-9 flex items-center justify-center rounded text-on-surface-variant hover:text-error hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>
      </div>

      {/* İlerleme çubuğu */}
      <div className="h-1 bg-surface-variant">
        <div
          className="h-full bg-primary-container transition-all duration-300"
          style={{ width: `${(index / total) * 100}%` }}
        />
      </div>

      {/* Kart */}
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center p-md">
          <div className="w-full max-w-2xl">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setFlipped((f) => !f)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFlipped((f) => !f);
                }
              }}
              className="cursor-pointer select-none w-full"
              style={{ perspective: "1600px" }}
            >
              <div
                style={{
                  display: "grid",
                  transformStyle: "preserve-3d",
                  transition: "transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)",
                  transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
                  minHeight: "20rem",
                }}
              >
                {/* ÖN — kavram */}
                <div
                  className="bg-surface-container-low border border-surface-variant rounded-2xl p-lg flex flex-col items-center justify-center text-center gap-4"
                  style={{ gridArea: "1 / 1", backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
                >
                  <span className="font-mono text-label-sm text-primary-container uppercase tracking-widest">
                    Kavram {index + 1}
                  </span>
                  <p className="font-headline text-2xl md:text-3xl text-on-surface leading-snug [overflow-wrap:anywhere]">
                    {card.kavram}
                  </p>
                  <p className="font-body text-body-md text-on-surface-variant max-w-md">
                    Bu kavramın ne olduğunu biliyor musun? Aklından geçir, sonra cevabı görmek için karta tıkla.
                  </p>
                  <div className="flex items-center gap-1.5 mt-2 text-on-surface-variant/50">
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>touch_app</span>
                    <span className="font-mono text-label-sm">Cevap için karta tıkla</span>
                  </div>
                </div>

                {/* ARKA — tanım + "biliyor muydun?" */}
                <div
                  className="bg-surface-container border border-primary-container/30 rounded-2xl p-lg flex flex-col"
                  style={{ gridArea: "1 / 1", backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
                >
                  <p className="font-body text-base text-on-surface/80 font-semibold mb-2 [overflow-wrap:anywhere]">
                    {card.kavram}
                  </p>
                  <div className="h-px bg-surface-variant mb-3" />
                  <p className="font-mono text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-1.5">
                    Tanım
                  </p>
                  <p className="font-body text-body-lg text-on-surface leading-relaxed [overflow-wrap:anywhere]">
                    {card.tanim}
                  </p>

                  {/* Soru + cevap butonları (kartın içinde) */}
                  <div className="mt-auto pt-5">
                    <p className="font-body text-body-md text-on-surface text-center mb-3 font-semibold">
                      Bu kavramı biliyor muydun?
                    </p>
                    <div className="flex items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          answer(false);
                        }}
                        className="flex items-center gap-1.5 border border-error/50 text-error hover:bg-error/15 font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all font-bold"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                        Bilmiyordum
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          answer(true);
                        }}
                        className="flex items-center gap-1.5 bg-emerald-500/15 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/25 font-mono text-label-sm px-5 py-2.5 rounded-lg transition-all font-bold"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check</span>
                        Biliyordum
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
