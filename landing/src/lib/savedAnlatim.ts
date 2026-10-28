/**
 * Saved anlatim — localStorage tabanlı, kullanıcıya scope'lu kalıcı konu anlatımları.
 *
 * - Tüm kayıtlar `lostick.savedAnlatim` anahtarında JSON dizisi olarak tutulur
 * - Her kayıt `userId` taşır; UI yalnızca aktif kullanıcının (veya anonim/null) kayıtlarını gösterir
 * - Değişiklikler `lostick:saved-anlatim-changed` event'i ile aynı sekme içinde yayılır
 */

export type AnlatimUzunluk = "kisa" | "orta" | "uzun";
export type AnlatimMod = "ogretici" | "sinav_odakli";

export interface SavedAnlatim {
  id: string;
  createdAt: number;
  userId: number | null;
  pdfName: string;       // "x +N dosya" formatı çoklu dosyada
  konuBasligi: string;   // istenilen konu / "Genel Özet"
  uzunluk: AnlatimUzunluk;
  mod: AnlatimMod;
  markdown: string;      // anlatımın ham markdown'u (görseller dahil)
}

const STORAGE_KEY = "lostick.savedAnlatim";
const CHANGE_EVENT = "lostick:saved-anlatim-changed";
const MAX_ENTRIES_PER_USER = 50;

function readAll(): SavedAnlatim[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedAnlatim[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SavedAnlatim[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function getSavedAnlatim(userId: number | null): SavedAnlatim[] {
  return readAll()
    .filter((a) => (a.userId ?? null) === (userId ?? null))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface SaveAnlatimInput {
  userId: number | null;
  pdfName: string;
  konuBasligi: string;
  uzunluk: AnlatimUzunluk;
  mod: AnlatimMod;
  markdown: string;
}

export function saveAnlatim(input: SaveAnlatimInput): SavedAnlatim {
  const entry: SavedAnlatim = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `anlatim_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    userId: input.userId,
    pdfName: input.pdfName,
    konuBasligi: input.konuBasligi,
    uzunluk: input.uzunluk,
    mod: input.mod,
    markdown: input.markdown,
  };

  const all = readAll();
  all.push(entry);

  // Per-user kayıt sayısı sınırı — localStorage taşmasın
  const sameUser = all.filter((a) => (a.userId ?? null) === (input.userId ?? null));
  if (sameUser.length > MAX_ENTRIES_PER_USER) {
    sameUser.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sameUser.slice(0, sameUser.length - MAX_ENTRIES_PER_USER);
    const removeIds = new Set(toRemove.map((a) => a.id));
    const trimmed = all.filter((a) => !removeIds.has(a.id));
    writeAll(trimmed);
  } else {
    writeAll(all);
  }

  return entry;
}

export function deleteSavedAnlatim(id: string): void {
  const all = readAll();
  const next = all.filter((a) => a.id !== id);
  if (next.length !== all.length) {
    writeAll(next);
  }
}
